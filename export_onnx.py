#!/usr/bin/env python3
"""
PlateQ — YOLOv8 Malaysian Plate Detector: Train + Export ONNX
==============================================================
Pipeline:
  1. Install ultralytics + onnx
  2. Train YOLOv8n on the downloaded dataset (_rf_tmp/)
  3. Export best.pt → plate-detector.onnx  (640×640, opset 17, float32)
  4. Copy to public/models/plate-detector.onnx
"""

import os
import sys
import shutil

# ─── Config ──────────────────────────────────────────────────────────────────
DATASET_YAML   = "_rf_tmp/data.yaml"
MODEL          = "yolov8n.pt"     # nano = fastest + smallest for browser
EPOCHS         = 30               # ~30 min on CPU / ~5 min on M1 GPU
IMG_SIZE       = 640
OPSET          = 17               # max supported by onnxruntime-web
OUTPUT_DIR     = "public/models"
FINAL_FILENAME = "plate-detector.onnx"
RUN_NAME       = "plateq-malaysia"
# ─────────────────────────────────────────────────────────────────────────────


def pkg_ok(name):
    try:
        __import__(name.replace("-", "_"))
        return True
    except ImportError:
        return False


def main():
    print("=" * 65)
    print("  PlateQ — YOLOv8n Train + ONNX Export")
    print("=" * 65)

    # ── Step 1: Install dependencies ──────────────────────────────────
    print("\n[1/4] Checking dependencies …")
    import subprocess
    missing = [p for p in ["ultralytics", "onnx"] if not pkg_ok(p)]
    if missing:
        print(f"      Installing: {' '.join(missing)}")
        subprocess.run(f"pip3 install {' '.join(missing)} --quiet", shell=True, check=True)
    else:
        print("      ultralytics + onnx already installed ✓")

    # ── Step 2: Fix data.yaml paths (make absolute) ───────────────────
    print("\n[2/4] Preparing dataset …")

    if not os.path.exists(DATASET_YAML):
        print(f"\n[ERROR] Dataset not found at {DATASET_YAML}")
        print("        Make sure _rf_tmp/ exists with the downloaded dataset.")
        sys.exit(1)

    dataset_abs = os.path.abspath("_rf_tmp")

    # Rewrite data.yaml with absolute paths so ultralytics can find it
    fixed_yaml = os.path.join(dataset_abs, "data_abs.yaml")
    with open(fixed_yaml, "w") as f:
        f.write(f"path: {dataset_abs}\n")
        f.write(f"train: train/images\n")
        f.write(f"val: valid/images\n")
        f.write(f"test: test/images\n")
        f.write(f"nc: 1\n")
        f.write(f"names:\n  0: License-Plate\n")

    print(f"      Dataset root : {dataset_abs}")

    # Count images
    train_dir = os.path.join(dataset_abs, "train", "images")
    valid_dir = os.path.join(dataset_abs, "valid", "images")
    n_train = len([f for f in os.listdir(train_dir) if f.endswith(('.jpg', '.jpeg', '.png'))]) if os.path.exists(train_dir) else 0
    n_valid = len([f for f in os.listdir(valid_dir) if f.endswith(('.jpg', '.jpeg', '.png'))]) if os.path.exists(valid_dir) else 0
    print(f"      Train images : {n_train}")
    print(f"      Valid images : {n_valid}")

    # ── Step 3: Train YOLOv8n ────────────────────────────────────────
    print(f"\n[3/4] Training YOLOv8n …")
    print(f"      Base model : {MODEL}")
    print(f"      Epochs     : {EPOCHS}")
    print(f"      Image size : {IMG_SIZE}×{IMG_SIZE}")
    print()
    print("  ⏳  This takes ~5-30 min depending on your hardware.")
    print("      M1/M2 Mac will use MPS GPU automatically.")
    print("      Intel Mac will use CPU (slower but works).")
    print()

    from ultralytics import YOLO

    model = YOLO(MODEL)  # downloads yolov8n.pt base weights (~6MB)
    results = model.train(
        data=fixed_yaml,
        epochs=EPOCHS,
        imgsz=IMG_SIZE,
        batch=16,
        name=RUN_NAME,
        project="runs/detect",
        exist_ok=True,
        pretrained=True,
        patience=10,       # early stop if no improvement after 10 epochs
        save=True,
        verbose=True,
        device="",         # auto-detect: MPS on M1, CUDA on NVIDIA, else CPU
    )

    # Find best.pt
    best_pt = f"runs/detect/{RUN_NAME}/weights/best.pt"
    if not os.path.exists(best_pt):
        # fallback to last.pt
        best_pt = f"runs/detect/{RUN_NAME}/weights/last.pt"

    if not os.path.exists(best_pt):
        print(f"\n[ERROR] Trained weights not found at runs/detect/{RUN_NAME}/weights/")
        sys.exit(1)

    size_mb = os.path.getsize(best_pt) / 1024 / 1024
    print(f"\n      ✓ Training complete!")
    print(f"      Best weights: {best_pt}  ({size_mb:.1f} MB)")

    # ── Step 4: Export to ONNX ────────────────────────────────────────
    print(f"\n[4/4] Exporting to ONNX …")
    print(f"      Opset   : {OPSET}")
    print(f"      Batch   : 1 (static — required for onnxruntime-web)")
    print(f"      Format  : float32 (no half-precision in browser WASM)")

    trained_model = YOLO(best_pt)
    exported = trained_model.export(
        format="onnx",
        imgsz=IMG_SIZE,
        opset=OPSET,
        simplify=True,
        dynamic=False,    # static batch=1 REQUIRED for browser
        half=False,       # float32 only for WASM/WebGL compatibility
        device="cpu",     # export always on CPU for portability
    )

    onnx_path = exported if isinstance(exported, str) else best_pt.replace(".pt", ".onnx")
    if not os.path.exists(onnx_path):
        print(f"\n[ERROR] ONNX export failed — file not found: {onnx_path}")
        sys.exit(1)

    onnx_mb = os.path.getsize(onnx_path) / 1024 / 1024
    print(f"      Exported: {onnx_path}  ({onnx_mb:.1f} MB)")

    # ── Copy to public/models/ ────────────────────────────────────────
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    dest = os.path.join(OUTPUT_DIR, FINAL_FILENAME)
    shutil.copy2(onnx_path, dest)
    final_mb = os.path.getsize(dest) / 1024 / 1024

    print(f"\n{'=' * 65}")
    print(f"  ✅  SELESAI!")
    print(f"  Model    : {dest}")
    print(f"  Saiz     : {final_mb:.1f} MB")
    print(f"  Input    : [1, 3, {IMG_SIZE}, {IMG_SIZE}]  (BCHW, float32, 0.0–1.0)")
    print(f"  Output   : [1, 5, 8400]  (cx cy w h conf × 8400 anchors)")
    print(f"{'=' * 65}")
    print()
    print("  Seterusnya:")
    print("  1.  npm run dev")
    print("  2.  Buka Scanner page")
    print("  3.  Model banner akan tunjuk  ● LOCAL ONNX  (hijau)")
    print()


if __name__ == "__main__":
    main()
