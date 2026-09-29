#!/usr/bin/env python3
"""
PlateQ Environment Intelligence Model: YOLOv8 Classification Train + ONNX Export.

Input:
  datasets/bdd100k-environment-cls/
    train/BACKLIGHT/*.jpg
    train/DAY/*.jpg
    ...
    val/TUNNEL/*.jpg

Output:
  public/models/environment-classifier.onnx
  public/models/environment-classifier.metadata.json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train and export the PlateQ BDD100K environment YOLOv8 classification model."
    )
    parser.add_argument(
        "--data",
        default="datasets/bdd100k-environment-cls",
        help="YOLOv8 classification dataset root produced by scripts/prepare_bdd100k_environment_cls.py.",
    )
    parser.add_argument("--model", default="yolov8n-cls.pt", help="YOLOv8 classification base model.")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--imgsz", type=int, default=224)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--project", default="runs/classify")
    parser.add_argument("--name", default="plateq-bdd100k-environment")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--output", default="public/models/environment-classifier.onnx")
    parser.add_argument(
        "--weights",
        default="",
        help="Existing trained .pt weights to export without starting a new training run.",
    )
    parser.add_argument(
        "--device",
        default="",
        help="Ultralytics device selector. Empty means auto (CUDA/MPS/CPU).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    data_root = Path(args.data).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    print("=" * 72)
    print("PlateQ Environment Intelligence - YOLOv8 Classification")
    print("=" * 72)
    print(f"Data   : {data_root}")
    print(f"Model  : {args.model}")
    print(f"Output : {output_path}")
    print()

    validate_dataset(data_root)
    ensure_python_packages(["ultralytics", "onnx"])

    from ultralytics import YOLO

    if args.weights:
        best_pt = Path(args.weights).expanduser().resolve()
        if not best_pt.exists():
            raise SystemExit(f"Provided weights file does not exist: {best_pt}")
    else:
        model = YOLO(args.model)
        train_result = model.train(
            data=str(data_root),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            project=args.project,
            name=args.name,
            exist_ok=True,
            pretrained=True,
            patience=args.patience,
            save=True,
            verbose=True,
            device=args.device,
        )
        best_pt = find_trained_weights(args.project, args.name, train_result, model)

    print()
    print(f"Best weights: {best_pt}")
    trained_model = YOLO(str(best_pt))
    exported = trained_model.export(
        format="onnx",
        imgsz=args.imgsz,
        opset=args.opset,
        simplify=True,
        dynamic=False,
        half=False,
        device="cpu",
    )

    exported_path = Path(exported if isinstance(exported, str) else str(best_pt).replace(".pt", ".onnx"))
    if not exported_path.exists():
        raise SystemExit(f"ONNX export failed, file not found: {exported_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exported_path, output_path)

    classes = get_model_class_names(trained_model)
    metadata_path = output_path.with_name("environment-classifier.metadata.json")
    metadata = build_metadata(data_root, classes, args, best_pt, output_path)
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print()
    print("=" * 72)
    print("Done")
    print(f"ONNX     : {output_path}")
    print(f"Metadata : {metadata_path}")
    print(f"Classes  : {', '.join(classes)}")
    print("=" * 72)


def validate_dataset(data_root: Path) -> None:
    train_root = data_root / "train"
    val_root = data_root / "val"
    if not train_root.exists() or not val_root.exists():
        raise SystemExit(
            "Dataset must contain train/ and val/ directories. "
            "Run scripts/prepare_bdd100k_environment_cls.py first."
        )

    missing = []
    empty = []
    for class_name in ENVIRONMENT_CLASSES:
        train_class = train_root / class_name
        val_class = val_root / class_name
        if not train_class.exists() or not val_class.exists():
            missing.append(class_name)
            continue
        if count_images(train_class) == 0 or count_images(val_class) == 0:
            empty.append(class_name)

    if missing:
        raise SystemExit(f"Missing class directories: {', '.join(missing)}")
    if empty:
        print("Warning: classes with no train or val images:", ", ".join(empty))
        print("BDD100K derives some classes from image statistics; consider lowering thresholds or adding supplemental data.")


def count_images(path: Path) -> int:
    return sum(1 for item in path.iterdir() if item.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})


def ensure_python_packages(packages: list[str]) -> None:
    missing = []
    for package in packages:
        module = package.replace("-", "_")
        try:
            __import__(module)
        except ImportError:
            missing.append(package)

    if not missing:
        return

    print("Installing missing Python packages:", " ".join(missing))
    subprocess.run([sys.executable, "-m", "pip", "install", *missing], check=True)


def find_trained_weights(project: str, name: str, train_result: Any, model: Any) -> Path:
    candidate_dirs = []
    for source in (
        getattr(train_result, "save_dir", None),
        getattr(getattr(model, "trainer", None), "save_dir", None),
        Path(project) / name,
    ):
        if source:
            candidate_dirs.append(Path(source))

    for run_dir in candidate_dirs:
        for weight_name in ("best.pt", "last.pt"):
            weights_path = run_dir / "weights" / weight_name
            if weights_path.exists():
                return weights_path

    expected = Path(project) / name / "weights"
    searched = ", ".join(str(path / "weights") for path in candidate_dirs)
    raise SystemExit(f"Trained weights not found under {expected}. Searched: {searched}")


def get_model_class_names(model: Any) -> list[str]:
    names = getattr(model, "names", None) or {}
    if isinstance(names, dict):
        classes = [str(names[index]) for index in sorted(names)]
    elif isinstance(names, list):
        classes = [str(item) for item in names]
    else:
        classes = []

    return classes or ENVIRONMENT_CLASSES


def build_metadata(
    data_root: Path,
    classes: list[str],
    args: argparse.Namespace,
    weights_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    source_metadata_path = data_root / "metadata.json"
    source_metadata: dict[str, Any] = {}
    if source_metadata_path.exists():
        try:
            source_metadata = json.loads(source_metadata_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            source_metadata = {}

    return {
        "model": "PlateQ Environment Intelligence YOLOv8 Classification",
        "framework": "YOLOv8 Classification",
        "dataset": "BDD100K",
        "dataset_url": "https://bdd-data.berkeley.edu/",
        "dataset_github": "https://github.com/bdd100k/bdd100k",
        "classes": classes,
        "expected_classes": ENVIRONMENT_CLASSES,
        "imgsz": args.imgsz,
        "opset": args.opset,
        "base_model": args.model,
        "weights": display_metadata_path(weights_path),
        "onnx": display_metadata_path(output_path),
        "source_metadata": sanitize_metadata_paths(source_metadata),
    }


def sanitize_metadata_paths(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: sanitize_metadata_paths(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_metadata_paths(item) for item in value]
    if isinstance(value, str):
        return display_metadata_path(Path(value)) if value.startswith("/") else value
    return value


def display_metadata_path(path: Path) -> str:
    if not path.is_absolute():
        return path.as_posix()

    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        pass

    parts = path.parts
    for marker in ("bdd100k", "labels"):
        if marker in parts:
            index = len(parts) - 1 - list(reversed(parts)).index(marker)
            return Path(*parts[index:]).as_posix()

    return path.name


if __name__ == "__main__":
    main()
