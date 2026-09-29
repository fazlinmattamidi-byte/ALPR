#!/usr/bin/env python3
"""
Prepare PlateQ Dataset Mode exports for YOLOv8 plate-quality classification.

Expected input:
  track_dataset_export_*.json from Scanner Dataset Mode.

The converter reads each sample's plateCropDataUrl and qualityClass, then writes:
  datasets/plate-quality-cls/
    train/GOOD/*.jpg
    val/GOOD/*.jpg
    ...
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

PLATE_QUALITY_CLASSES = [
    "GOOD",
    "STANDARD_RECTANGLE",
    "SQUARE_PLATE",
    "TWO_LINE_PLATE",
    "EV_WHITE_PLATE",
    "SLIGHT_ROTATION",
    "PERSPECTIVE_DISTORTION",
    "MOTION_BLUR",
    "OUT_OF_FOCUS",
    "TOO_SMALL",
    "LOW_CONTRAST",
    "OVEREXPOSED",
    "UNDEREXPOSED",
    "GLARE_REFLECTION",
    "OCCLUDED",
    "BAD_ANGLE",
]

DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$", re.DOTALL)
MIME_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert PlateQ Dataset Mode JSON exports into a YOLOv8 plate-quality dataset."
    )
    parser.add_argument(
        "--exports",
        nargs="+",
        required=True,
        help="One or more track_dataset_export_*.json files.",
    )
    parser.add_argument(
        "--output",
        default="datasets/plate-quality-cls",
        help="Output YOLOv8 classification dataset directory.",
    )
    parser.add_argument(
        "--min-label-confidence",
        type=float,
        default=0.70,
        help="Skip samples whose qualityConfidence is below this value.",
    )
    parser.add_argument(
        "--val-ratio",
        type=float,
        default=0.20,
        help="Deterministic validation split ratio.",
    )
    parser.add_argument(
        "--max-per-class",
        type=int,
        default=0,
        help="Optional cap per class per split. 0 means no cap.",
    )
    parser.add_argument(
        "--seed",
        default="plateq-quality",
        help="Stable split seed.",
    )
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Delete the output folder before writing.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Count samples without writing image files.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    export_paths = [Path(path).expanduser().resolve() for path in args.exports]
    output_root = Path(args.output).expanduser().resolve()
    val_ratio = min(0.45, max(0.05, args.val_ratio))
    min_label_confidence = min(1.0, max(0.0, args.min_label_confidence))
    max_per_class = max(0, args.max_per_class)

    for path in export_paths:
        if not path.exists():
            raise SystemExit(f"Dataset export does not exist: {path}")

    if args.clear and output_root.exists() and not args.dry_run:
        shutil.rmtree(output_root)

    if not args.dry_run:
        prepare_output_dirs(output_root)

    counts: dict[str, Counter[str]] = {"train": Counter(), "val": Counter()}
    skipped: Counter[str] = Counter()
    used_names: defaultdict[str, int] = defaultdict(int)

    print("=" * 72)
    print("PlateQ Plate Quality Classification Dataset Builder")
    print("=" * 72)
    print(f"Output : {output_root}")
    print(f"Classes: {', '.join(PLATE_QUALITY_CLASSES)}")
    print(f"Min label confidence: {min_label_confidence:.2f}")
    print()

    for export_path in export_paths:
        payload = load_json(export_path)
        samples = list(iter_samples(payload))
        if not samples:
            skipped["empty_export"] += 1
            continue

        for index, sample in enumerate(samples):
            label = normalize_label(sample.get("qualityClass"))
            if label not in PLATE_QUALITY_CLASSES:
                skipped["invalid_label"] += 1
                continue

            confidence = to_float(sample.get("qualityConfidence"), 1.0)
            if confidence < min_label_confidence:
                skipped[f"low_confidence_{label}"] += 1
                continue

            crop_data_url = sample.get("plateCropDataUrl") or sample.get("cropDataUrl")
            decoded = decode_data_url(crop_data_url)
            if decoded is None:
                skipped["missing_crop_data_url"] += 1
                continue

            sample_id = sanitize_id(str(sample.get("id") or f"{export_path.stem}-{index}"))
            split = choose_split(sample_id, args.seed, val_ratio)
            if max_per_class and counts[split][label] >= max_per_class:
                skipped[f"capped_{split}_{label}"] += 1
                continue

            counts[split][label] += 1
            if args.dry_run:
                continue

            image_bytes, extension = decoded
            unique_id = unique_sample_id(sample_id, used_names)
            destination = output_root / split / label / f"{unique_id}{extension}"
            destination.write_bytes(image_bytes)

    print_summary(counts, skipped)
    if not args.dry_run:
        metadata = build_metadata(export_paths, counts, skipped, min_label_confidence, val_ratio, max_per_class)
        metadata_path = output_root / "metadata.json"
        metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        print()
        print(f"Metadata written: {metadata_path}")
        print(f"YOLOv8 data root: {output_root}")


def prepare_output_dirs(output_root: Path) -> None:
    for split in ("train", "val"):
        for class_name in PLATE_QUALITY_CLASSES:
            (output_root / split / class_name).mkdir(parents=True, exist_ok=True)


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as err:
        raise SystemExit(f"Invalid JSON in {path}: {err}") from err


def iter_samples(payload: Any) -> Iterable[dict[str, Any]]:
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                yield item
        return

    if isinstance(payload, dict):
        samples = payload.get("samples")
        if isinstance(samples, list):
            for item in samples:
                if isinstance(item, dict):
                    yield item


def normalize_label(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().upper().replace(" ", "_").replace("-", "_")


def to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def decode_data_url(value: Any) -> tuple[bytes, str] | None:
    if not isinstance(value, str):
        return None

    match = DATA_URL_RE.match(value)
    if not match:
        return None

    mime = match.group("mime").lower()
    extension = MIME_EXTENSIONS.get(mime)
    if not extension:
        return None

    try:
        return base64.b64decode(match.group("data"), validate=True), extension
    except binascii.Error:
        return None


def choose_split(sample_id: str, seed: str, val_ratio: float) -> str:
    digest = hashlib.sha256(f"{seed}:{sample_id}".encode("utf-8")).hexdigest()
    bucket = int(digest[:8], 16) / 0xFFFFFFFF
    return "val" if bucket < val_ratio else "train"


def sanitize_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return cleaned[:120] or "sample"


def unique_sample_id(sample_id: str, used_names: defaultdict[str, int]) -> str:
    used_names[sample_id] += 1
    if used_names[sample_id] == 1:
        return sample_id
    return f"{sample_id}-{used_names[sample_id]}"


def print_summary(counts: dict[str, Counter[str]], skipped: Counter[str]) -> None:
    for split in ("train", "val"):
        print(f"[{split}]")
        for class_name in PLATE_QUALITY_CLASSES:
            print(f"  {class_name:<16} {counts[split][class_name]:>6}")
        print()

    if skipped:
        print("[skipped]")
        for reason, count in skipped.most_common():
            print(f"  {reason:<32} {count}")


def build_metadata(
    export_paths: list[Path],
    counts: dict[str, Counter[str]],
    skipped: Counter[str],
    min_label_confidence: float,
    val_ratio: float,
    max_per_class: int,
) -> dict[str, Any]:
    return {
        "source": "PlateQ Dataset Mode",
        "classes": PLATE_QUALITY_CLASSES,
        "class_mapping_order": [
            "human-reviewed or scanner-assigned qualityClass -> class folder",
        ],
        "exports": [display_path(path) for path in export_paths],
        "min_label_confidence": min_label_confidence,
        "val_ratio": val_ratio,
        "max_per_class": max_per_class,
        "splits": {
            split: {"counts": dict(counter)}
            for split, counter in counts.items()
        },
        "skipped": dict(skipped),
    }


def display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.name


if __name__ == "__main__":
    main()
