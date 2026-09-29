#!/usr/bin/env python3
"""
PlateQ Plate Quality Model: YOLOv8 Classification Train + ONNX Export.

Input:
  datasets/plate-quality-cls/
    train/GOOD/*.jpg
    train/MOTION_BLUR/*.jpg
    ...
    val/GLARE_REFLECTION/*.jpg

Output:
  public/models/plate-quality-classifier.onnx
  public/models/plate-quality-classifier.metadata.json
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train and export the PlateQ YOLOv8 plate-quality classification model."
    )
    parser.add_argument(
        "--data",
        default="datasets/plate-quality-cls",
        help="YOLOv8 classification dataset root produced by scripts/prepare_plate_quality_cls.py.",
    )
    parser.add_argument("--model", default="yolov8n-cls.pt", help="YOLOv8 classification base model.")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=224)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--patience", type=int, default=12)
    parser.add_argument("--project", default="runs/classify")
    parser.add_argument("--name", default="plateq-plate-quality")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--output", default="public/models/plate-quality-classifier.onnx")
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
    print("PlateQ Plate Quality - YOLOv8 Classification")
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
    metadata_path = output_path.with_name("plate-quality-classifier.metadata.json")
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
            "Run scripts/prepare_plate_quality_cls.py first."
        )

    train_counts = count_split_images(train_root)
    val_counts = count_split_images(val_root)
    populated_classes = sorted(set(train_counts) | set(val_counts))
    if len(populated_classes) < 2:
        raise SystemExit("Plate-quality training needs at least two populated classes.")

    missing_val = [class_name for class_name in populated_classes if val_counts.get(class_name, 0) == 0]
    if missing_val:
        print("Warning: classes with no val images:", ", ".join(missing_val))

    missing_expected = [
        class_name
        for class_name in PLATE_QUALITY_CLASSES
        if train_counts.get(class_name, 0) == 0 and val_counts.get(class_name, 0) == 0
    ]
    if missing_expected:
        print("Warning: expected classes absent from this dataset:", ", ".join(missing_expected))


def count_split_images(split_root: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for class_dir in split_root.iterdir():
        if not class_dir.is_dir():
            continue
        count = count_images(class_dir)
        if count > 0:
            counts[class_dir.name] = count
    return counts


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

    return classes or PLATE_QUALITY_CLASSES


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
        "modelType": "yolov8-classification",
        "task": "plate-quality-assessment",
        "inputWidth": args.imgsz,
        "inputHeight": args.imgsz,
        "layout": "NCHW",
        "colorSpace": "RGB",
        "resizeMode": "letterbox",
        "normalization": {
            "scale": 0.00392156862745098,
        },
        "model": "PlateQ Plate Quality YOLOv8 Classification",
        "framework": "YOLOv8 Classification",
        "dataset": "PlateQ Dataset Mode",
        "classes": classes,
        "expected_classes": PLATE_QUALITY_CLASSES,
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
        return path.name


if __name__ == "__main__":
    main()
