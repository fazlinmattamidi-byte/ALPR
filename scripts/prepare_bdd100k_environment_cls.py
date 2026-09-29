#!/usr/bin/env python3
"""
Prepare BDD100K for PlateQ Environment Intelligence YOLOv8 classification.

Expected BDD100K layout:
  <bdd-root>/images/100k/train/*.jpg
  <bdd-root>/images/100k/val/*.jpg
  <bdd-root>/labels/det_20/det_train.json
  <bdd-root>/labels/det_20/det_val.json

The converter uses official BDD100K frame attributes:
  - attributes.weather
  - attributes.scene
  - attributes.timeofday

BDD100K does not explicitly label GLARE, BACKLIGHT, HEAVY_RAIN, TRAFFIC,
or GOOD_CONDITION as separate attributes, so these are derived from image
statistics and object counts where possible.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

ENVIRONMENT_CLASSES = [
    "BACKLIGHT",
    "DAY",
    "FOG",
    "GLARE",
    "GOOD_CONDITION",
    "HEAVY_RAIN",
    "HIGHWAY",
    "LOW_LIGHT",
    "NIGHT",
    "PARKING",
    "RAIN",
    "TRAFFIC",
    "TUNNEL",
]

BDD_LABEL_CANDIDATES = {
    "train": [
        "labels/det_20/det_train.json",
        "labels/100k/train.json",
        "labels/bdd100k_labels_images_train.json",
    ],
    "val": [
        "labels/det_20/det_val.json",
        "labels/100k/val.json",
        "labels/bdd100k_labels_images_val.json",
    ],
}

BDD_IMAGE_CANDIDATES = {
    "train": ["images/100k/train", "images/train"],
    "val": ["images/100k/val", "images/val"],
}

VEHICLE_CATEGORIES = {"car", "truck", "bus", "motor", "bike", "train", "rider"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(frozen=True)
class ImageStats:
    brightness: float
    contrast: float
    glare_ratio: float
    top_brightness: float
    bottom_brightness: float
    blur_proxy: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert BDD100K labels into a YOLOv8 classification dataset for PlateQ."
    )
    parser.add_argument("--bdd-root", required=True, help="Path to the downloaded BDD100K root directory.")
    parser.add_argument(
        "--output",
        default="datasets/bdd100k-environment-cls",
        help="Output YOLOv8 classification dataset directory.",
    )
    parser.add_argument("--train-labels", default="", help="Override path to BDD100K train labels JSON.")
    parser.add_argument("--val-labels", default="", help="Override path to BDD100K val labels JSON.")
    parser.add_argument("--train-images", default="", help="Override path to BDD100K train images directory.")
    parser.add_argument("--val-images", default="", help="Override path to BDD100K val images directory.")
    parser.add_argument(
        "--link-mode",
        choices=["hardlink", "symlink", "copy"],
        default="hardlink",
        help="How to place images in the classification dataset. Hardlink falls back to copy.",
    )
    parser.add_argument(
        "--max-per-class",
        type=int,
        default=0,
        help="Optional cap per class per split. 0 means no cap.",
    )
    parser.add_argument(
        "--min-traffic-objects",
        type=int,
        default=8,
        help="Minimum visible road-user objects required to derive TRAFFIC.",
    )
    parser.add_argument(
        "--stats-sample-size",
        type=int,
        default=160,
        help="Image thumbnail size used for derived glare/backlight/heavy-rain/good-condition labels.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Only count mapped samples; do not write files.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    bdd_root = Path(args.bdd_root).expanduser().resolve()
    output_root = Path(args.output).expanduser().resolve()

    if not bdd_root.exists():
        raise SystemExit(f"BDD100K root does not exist: {bdd_root}")

    split_paths = {
        "train": {
            "labels": Path(args.train_labels).expanduser().resolve() if args.train_labels else find_existing(
                bdd_root, BDD_LABEL_CANDIDATES["train"], "train labels"
            ),
            "images": Path(args.train_images).expanduser().resolve() if args.train_images else find_existing(
                bdd_root, BDD_IMAGE_CANDIDATES["train"], "train images"
            ),
        },
        "val": {
            "labels": Path(args.val_labels).expanduser().resolve() if args.val_labels else find_existing(
                bdd_root, BDD_LABEL_CANDIDATES["val"], "val labels"
            ),
            "images": Path(args.val_images).expanduser().resolve() if args.val_images else find_existing(
                bdd_root, BDD_IMAGE_CANDIDATES["val"], "val images"
            ),
        },
    }

    print("=" * 72)
    print("PlateQ BDD100K Environment Classification Dataset Builder")
    print("=" * 72)
    print(f"BDD root : {bdd_root}")
    print(f"Output   : {output_root}")
    print(f"Classes  : {', '.join(ENVIRONMENT_CLASSES)}")
    print()
    ensure_pillow()

    if not args.dry_run:
        prepare_output_dirs(output_root)

    summary: dict[str, Any] = {
        "source": "BDD100K",
        "source_url": "https://bdd-data.berkeley.edu/",
        "source_github": "https://github.com/bdd100k/bdd100k",
        "classes": ENVIRONMENT_CLASSES,
        "class_mapping_order": [
            "scene=tunnel -> TUNNEL",
            "weather=foggy -> FOG",
            "weather=rainy + low visibility stats -> HEAVY_RAIN",
            "weather=rainy -> RAIN",
            "timeofday=night -> NIGHT",
            "timeofday=dawn/dusk -> LOW_LIGHT",
            "scene=highway -> HIGHWAY",
            "scene=parking lot -> PARKING",
            "image stats glare -> GLARE",
            "image stats backlight -> BACKLIGHT",
            "road-user count threshold -> TRAFFIC",
            "clear/partly cloudy daytime normal stats -> GOOD_CONDITION",
            "timeofday=daytime -> DAY",
        ],
        "splits": {},
    }

    for split, paths in split_paths.items():
        split_counts, skipped = process_split(
            split=split,
            labels_path=paths["labels"],
            images_dir=paths["images"],
            output_root=output_root,
            link_mode=args.link_mode,
            max_per_class=max(0, args.max_per_class),
            min_traffic_objects=max(1, args.min_traffic_objects),
            stats_sample_size=max(32, args.stats_sample_size),
            dry_run=args.dry_run,
        )
        summary["splits"][split] = {
            "labels": str(paths["labels"]),
            "images": str(paths["images"]),
            "counts": dict(split_counts),
            "skipped": dict(skipped),
        }
        print_split_summary(split, split_counts, skipped)

    if not args.dry_run:
        write_metadata(output_root, summary)
        print()
        print(f"Metadata written: {output_root / 'metadata.json'}")
        print(f"YOLOv8 data root: {output_root}")


def find_existing(root: Path, candidates: Iterable[str], label: str) -> Path:
    for rel in candidates:
        path = root / rel
        if path.exists():
            return path
    joined = "\n  - ".join(str(root / rel) for rel in candidates)
    raise SystemExit(f"Could not find BDD100K {label}. Tried:\n  - {joined}")


def ensure_pillow() -> None:
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Installing missing Python package: pillow")
        subprocess.run([sys.executable, "-m", "pip", "install", "pillow"], check=True)


def prepare_output_dirs(output_root: Path) -> None:
    for split in ("train", "val"):
        for class_name in ENVIRONMENT_CLASSES:
            (output_root / split / class_name).mkdir(parents=True, exist_ok=True)


def process_split(
    split: str,
    labels_path: Path,
    images_dir: Path,
    output_root: Path,
    link_mode: str,
    max_per_class: int,
    min_traffic_objects: int,
    stats_sample_size: int,
    dry_run: bool,
) -> tuple[Counter[str], Counter[str]]:
    with labels_path.open("r", encoding="utf-8") as handle:
        frames = json.load(handle)

    if not isinstance(frames, list):
        raise SystemExit(f"Expected list JSON in {labels_path}")

    counts: Counter[str] = Counter()
    skipped: Counter[str] = Counter()
    name_collisions: defaultdict[str, int] = defaultdict(int)

    for frame in frames:
        if not isinstance(frame, dict):
            skipped["invalid_frame"] += 1
            continue

        image_name = str(frame.get("name") or "")
        if not image_name:
            skipped["missing_name"] += 1
            continue

        image_path = images_dir / image_name
        if not image_path.exists():
            skipped["missing_image"] += 1
            continue

        if image_path.suffix.lower() not in IMAGE_SUFFIXES:
            skipped["unsupported_image_suffix"] += 1
            continue

        stats = estimate_image_stats(image_path, stats_sample_size)
        class_name = map_bdd_frame_to_environment(
            frame,
            stats=stats,
            min_traffic_objects=min_traffic_objects,
        )

        if class_name is None:
            skipped["unmapped"] += 1
            continue

        if max_per_class and counts[class_name] >= max_per_class:
            skipped[f"capped_{class_name}"] += 1
            continue

        counts[class_name] += 1
        if dry_run:
            continue

        destination_name = unique_destination_name(image_name, name_collisions)
        destination = output_root / split / class_name / destination_name
        place_image(image_path, destination, link_mode)

    return counts, skipped


def map_bdd_frame_to_environment(
    frame: dict[str, Any],
    stats: ImageStats | None,
    min_traffic_objects: int,
) -> str | None:
    attributes = frame.get("attributes") or {}
    weather = normalize_label(attributes.get("weather"))
    scene = normalize_label(attributes.get("scene"))
    timeofday = normalize_label(attributes.get("timeofday"))
    vehicle_count = count_road_users(frame.get("labels") or [])

    if scene == "tunnel":
        return "TUNNEL"
    if weather == "foggy":
        return "FOG"
    if weather == "rainy":
        if stats and is_low_visibility_rain(stats):
            return "HEAVY_RAIN"
        return "RAIN"
    if timeofday == "night":
        return "NIGHT"
    if timeofday == "dawn/dusk":
        return "LOW_LIGHT"
    if scene == "highway":
        return "HIGHWAY"
    if scene == "parking lot":
        return "PARKING"
    if stats and is_glare(stats):
        return "GLARE"
    if stats and is_backlight(stats):
        return "BACKLIGHT"
    if vehicle_count >= min_traffic_objects:
        return "TRAFFIC"
    if timeofday == "daytime":
        if weather in {"clear", "partly cloudy"} and (stats is None or is_good_condition(stats)):
            return "GOOD_CONDITION"
        return "DAY"

    if weather in {"overcast", "clear", "partly cloudy"}:
        return "DAY"

    return None


def normalize_label(value: Any) -> str:
    return str(value or "").strip().lower()


def count_road_users(labels: list[Any]) -> int:
    count = 0
    for label in labels:
        if not isinstance(label, dict):
            continue
        if normalize_label(label.get("category")) in VEHICLE_CATEGORIES:
            count += 1
    return count


def estimate_image_stats(path: Path, sample_size: int) -> ImageStats | None:
    try:
        from PIL import Image, ImageFilter, ImageStat
    except ImportError:
        return None

    try:
        with Image.open(path) as image:
            image = image.convert("RGB")
            image.thumbnail((sample_size, sample_size))
            grayscale = image.convert("L")
            stat = ImageStat.Stat(grayscale)
            brightness = stat.mean[0] / 255.0
            contrast = stat.stddev[0] / 96.0
            histogram = grayscale.histogram()
            total = max(1, grayscale.width * grayscale.height)
            glare_ratio = sum(histogram[242:]) / total
            top = grayscale.crop((0, 0, grayscale.width, max(1, grayscale.height // 2)))
            bottom = grayscale.crop((0, grayscale.height // 2, grayscale.width, grayscale.height))
            top_brightness = ImageStat.Stat(top).mean[0] / 255.0
            bottom_brightness = ImageStat.Stat(bottom).mean[0] / 255.0
            edges = grayscale.filter(ImageFilter.FIND_EDGES)
            blur_proxy = ImageStat.Stat(edges).mean[0] / 64.0

            return ImageStats(
                brightness=clamp01(brightness),
                contrast=clamp01(contrast),
                glare_ratio=clamp01(glare_ratio),
                top_brightness=clamp01(top_brightness),
                bottom_brightness=clamp01(bottom_brightness),
                blur_proxy=clamp01(blur_proxy),
            )
    except Exception:
        return None


def is_low_visibility_rain(stats: ImageStats) -> bool:
    return (
        stats.brightness < 0.32
        or stats.contrast < 0.18
        or stats.blur_proxy < 0.12
        or (stats.glare_ratio > 0.06 and stats.contrast < 0.28)
    )


def is_glare(stats: ImageStats) -> bool:
    return stats.glare_ratio >= 0.10 and stats.brightness >= 0.48


def is_backlight(stats: ImageStats) -> bool:
    vertical_imbalance = stats.top_brightness - stats.bottom_brightness
    return stats.glare_ratio >= 0.035 and stats.brightness >= 0.46 and vertical_imbalance >= 0.14


def is_good_condition(stats: ImageStats) -> bool:
    return (
        0.38 <= stats.brightness <= 0.78
        and stats.contrast >= 0.24
        and stats.glare_ratio < 0.035
        and stats.blur_proxy >= 0.14
    )


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def unique_destination_name(image_name: str, collisions: defaultdict[str, int]) -> str:
    source = Path(image_name)
    key = source.name
    collisions[key] += 1
    if collisions[key] == 1:
        return key
    return f"{source.stem}_{collisions[key]}{source.suffix}"


def place_image(source: Path, destination: Path, link_mode: str) -> None:
    if destination.exists():
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    if link_mode == "copy":
        shutil.copy2(source, destination)
        return

    if link_mode == "symlink":
        try:
            destination.symlink_to(source)
            return
        except OSError:
            shutil.copy2(source, destination)
            return

    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def write_metadata(output_root: Path, summary: dict[str, Any]) -> None:
    (output_root / "classes.txt").write_text("\n".join(ENVIRONMENT_CLASSES) + "\n", encoding="utf-8")
    (output_root / "metadata.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


def print_split_summary(split: str, counts: Counter[str], skipped: Counter[str]) -> None:
    print(f"[{split}]")
    for class_name in ENVIRONMENT_CLASSES:
        print(f"  {class_name:<15} {counts[class_name]:>7}")
    if skipped:
        print("  skipped:")
        for key, value in skipped.most_common():
            print(f"    {key:<28} {value}")
    print()


if __name__ == "__main__":
    main()
