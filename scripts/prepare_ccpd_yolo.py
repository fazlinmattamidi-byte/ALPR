#!/usr/bin/env python3
"""Convert official CCPD filename annotations to a one-class YOLO dataset.

CCPD-Blur/FN/Rotate/Tilt are official evaluation subsets. This script places
them under eval/ and refuses to mix them into train/. Chinese plate text is
recorded only as source metadata and is never used for Malaysian OCR training.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path

import cv2


HARD_EVAL_SPLITS = ("ccpd_blur", "ccpd_fn", "ccpd_rotate", "ccpd_tilt")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ccpd-root", type=Path, required=True, help="Extracted CCPD2019 root.")
    parser.add_argument("--split-root", type=Path, required=True, help="Official CCPD repository split/ directory.")
    parser.add_argument("--output", type=Path, default=Path("datasets/ccpd-yolo"))
    parser.add_argument("--materialize", choices=("symlink", "hardlink", "copy"), default="symlink")
    parser.add_argument("--limit", type=int, default=0, help="Development-only maximum per split; 0 means all.")
    return parser.parse_args()


def parse_point(value: str) -> tuple[int, int]:
    x, y = value.split("&")
    return int(x), int(y)


def parse_ccpd_name(path: Path) -> dict:
    fields = path.stem.split("-")
    if len(fields) < 7:
        raise ValueError(f"Unexpected CCPD filename: {path.name}")
    upper_left, lower_right = (parse_point(value) for value in fields[2].split("_"))
    corners = [parse_point(value) for value in fields[3].split("_")]
    return {
        "bbox": [upper_left[0], upper_left[1], lower_right[0], lower_right[1]],
        "corners": corners,
        "encodedPlate": fields[4],
        "brightness": fields[5],
        "blur": fields[6],
    }


def read_split(path: Path, limit: int) -> list[str]:
    if not path.exists():
        raise SystemExit(f"Official split file is missing: {path}")
    items = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return items[:limit] if limit > 0 else items


def resolve_image(root: Path, relative: str) -> Path:
    candidates = [root / relative, root / "CCPD2019" / relative]
    for candidate in candidates:
        if candidate.exists() and candidate.suffix.lower() in IMAGE_SUFFIXES:
            return candidate.resolve()
    raise FileNotFoundError(relative)


def materialize(source: Path, destination: Path, mode: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        destination.unlink()
    if mode == "symlink":
        destination.symlink_to(source)
    elif mode == "hardlink":
        try:
            os.link(source, destination)
        except OSError:
            shutil.copy2(source, destination)
    else:
        shutil.copy2(source, destination)


def convert_split(
    ccpd_root: Path,
    split_file: Path,
    output_root: Path,
    output_split: str,
    materialize_mode: str,
    limit: int,
) -> dict:
    records = []
    missing = []
    for relative in read_split(split_file, limit):
        try:
            source = resolve_image(ccpd_root, relative)
        except FileNotFoundError:
            missing.append(relative)
            continue
        annotation = parse_ccpd_name(source)
        image = cv2.imread(str(source))
        if image is None:
            missing.append(relative)
            continue
        height, width = image.shape[:2]
        x1, y1, x2, y2 = annotation["bbox"]
        x1, x2 = sorted((max(0, x1), min(width, x2)))
        y1, y2 = sorted((max(0, y1), min(height, y2)))
        box_width, box_height = x2 - x1, y2 - y1
        if box_width <= 0 or box_height <= 0:
            continue

        safe_name = f"{Path(relative).parent.name}__{source.name}"
        image_destination = output_root / "images" / output_split / safe_name
        label_destination = output_root / "labels" / output_split / f"{Path(safe_name).stem}.txt"
        materialize(source, image_destination, materialize_mode)
        label_destination.parent.mkdir(parents=True, exist_ok=True)
        yolo = [
            0,
            ((x1 + x2) / 2) / width,
            ((y1 + y2) / 2) / height,
            box_width / width,
            box_height / height,
        ]
        label_destination.write_text(" ".join([str(yolo[0]), *(f"{value:.8f}" for value in yolo[1:])]) + "\n")
        records.append(
            {
                "source": relative,
                "output": str(image_destination.relative_to(output_root)),
                "width": width,
                "height": height,
                **annotation,
            }
        )

    metadata_path = output_root / "metadata" / f"{output_split.replace('/', '__')}.jsonl"
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records))
    return {"split": output_split, "converted": len(records), "missing": len(missing), "missingExamples": missing[:20]}


def main() -> None:
    args = parse_args()
    ccpd_root = args.ccpd_root.expanduser().resolve()
    split_root = args.split_root.expanduser().resolve()
    output_root = args.output.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    plan = [("train.txt", "train"), ("val.txt", "val")]
    plan.extend((f"{name}.txt", f"eval/{name}") for name in HARD_EVAL_SPLITS)
    summary = [
        convert_split(ccpd_root, split_root / split_name, output_root, output_split, args.materialize, args.limit)
        for split_name, output_split in plan
    ]

    yaml = (
        f"path: {output_root}\n"
        "train: images/train\n"
        "val: images/val\n"
        "names:\n  0: plate\n"
    )
    (output_root / "dataset.yaml").write_text(yaml, encoding="utf-8")
    (output_root / "preparation-summary.json").write_text(
        json.dumps(
            {
                "source": "CCPD official splits",
                "trainingSplits": ["train"],
                "validationSplits": ["val"],
                "evaluationOnlySplits": list(HARD_EVAL_SPLITS),
                "chineseTextUsedForMalaysianOcr": False,
                "splits": summary,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
