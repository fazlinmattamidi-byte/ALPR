#!/usr/bin/env python3
"""
PlateQ — Real AI Detector Fine-Tuning Pipeline
==================================================
1. Extracts keyframes from local Malaysian video clips.
2. Generates verified YOLO 1-class bounding box annotations.
3. Partitions into Train (Clips 1-7), Val (Clips 8-9), and Held-Out Test (Clips 10-12).
4. Applies augmentations and fine-tunes YOLOv8n for 15 epochs.
5. Saves best PyTorch checkpoint (.pt) and exports to ONNX (opset 17).
6. Evaluates Baseline vs Fine-Tuned detector on Held-Out Test set.
"""

import os
import sys
import time
import shutil
import json
from pathlib import Path
import cv2
import numpy as np
import torch
import onnxruntime as ort
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
VIDEO_DIR = ROOT / "public" / "train-video"
DATASET_DIR = ROOT / "datasets" / "malaysian-yolo"
BASELINE_DETECTOR = ROOT / "public" / "models" / "plate-detector.onnx"
OUTPUT_MODELS_DIR = ROOT / "public" / "models"

# Video Split Allocation
TRAIN_VIDEOS = [
    "WhatsApp Video 2026-09-15 at 15.10.37.mp4", # Clip 1
    "WhatsApp Video 2026-09-15 at 15.10.38.mp4", # Clip 2
    "WhatsApp Video 2026-09-15 at 15.10.40.mp4", # Clip 3
    "WhatsApp Video 2026-09-15 at 15.10.43.mp4", # Clip 4
    "WhatsApp Video 2026-09-15 at 15.10.45.mp4", # Clip 5
    "WhatsApp Video 2026-09-15 at 15.10.48.mp4", # Clip 6
    "WhatsApp Video 2026-09-15 at 15.10.51.mp4", # Clip 7
]

VAL_VIDEOS = [
    "WhatsApp Video 2026-09-18 at 11.05.48.mp4", # Clip 8
    "WhatsApp Video 2026-09-18 at 11.05.50.mp4", # Clip 9
]

HELD_OUT_TEST_VIDEOS = [
    "WhatsApp Video 2026-09-18 at 11.05.54.mp4", # Clip 10
    "WhatsApp Video 2026-09-18 at 11.05.56.mp4", # Clip 11
    "WhatsApp Video 2026-09-18 at 11.05.59.mp4", # Clip 12
]

class BaselineONNXDetector:
    def __init__(self, model_path: Path):
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def detect(self, frame: np.ndarray, conf_thresh: float = 0.22):
        height, width = frame.shape[:2]
        scale = min(640 / width, 640 / height)
        draw_w, draw_h = round(width * scale), round(height * scale)
        pad_x, pad_y = round((640 - draw_w) / 2), round((640 - draw_h) / 2)
        
        letterbox = np.full((640, 640, 3), 127, dtype=np.uint8)
        resized = cv2.resize(frame, (draw_w, draw_h), interpolation=cv2.INTER_LINEAR)
        letterbox[pad_y:pad_y + draw_h, pad_x:pad_x + draw_w] = resized
        
        tensor = letterbox[:, :, ::-1].astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        outputs = self.session.run(None, {self.input_name: tensor})[0][0]
        
        if outputs.shape[0] <= outputs.shape[1]:
            outputs = outputs.T

        boxes = []
        for row in outputs:
            score = float(row[4])
            if score >= conf_thresh:
                cx, cy, w, h = row[0:4]
                box_x = max(0, (cx - pad_x - w / 2) / scale)
                box_y = max(0, (cy - pad_y - h / 2) / scale)
                box_w = min(width - box_x, w / scale)
                box_h = min(height - box_y, h / scale)
                if box_w >= 16 and box_h >= 6:
                    boxes.append({
                        "x": float(box_x),
                        "y": float(box_y),
                        "w": float(box_w),
                        "h": float(box_h),
                        "conf": score
                    })
        return boxes

def locate_best_pt():
    possible_paths = [
        Path("/Users/rylin/plate/runs/detect/runs/detect/plateq-malaysian/weights/best.pt"),
        ROOT / "runs" / "detect" / "plateq-malaysian" / "weights" / "best.pt",
        ROOT / "runs" / "detect" / "weights" / "best.pt",
    ]
    for candidate in possible_paths:
        if candidate.exists():
            return candidate

    found = list(ROOT.rglob("best.pt"))
    if found:
        return found[0]

    raise FileNotFoundError("Could not locate best.pt PyTorch checkpoint file!")

def export_to_onnx(best_pt: Path):
    print("\n--- Step 6: Exporting Trained Checkpoint to ONNX ---")
    model = YOLO(str(best_pt))
    exported_path = model.export(
        format="onnx",
        imgsz=640,
        opset=17,
        dynamic=False,
        simplify=False
    )
    
    exported_onnx = Path(exported_path)
    final_target = OUTPUT_MODELS_DIR / "plate-detector-v2.onnx"
    shutil.copy2(exported_onnx, final_target)
    print(f"Exported Versioned ONNX Model: {final_target} ({final_target.stat().st_size} bytes)")
    return final_target

def evaluate_detectors(base_onnx: Path, finetuned_onnx: Path):
    print("\n--- Step 4: Evaluating Baseline vs Fine-Tuned Detector on Held-Out Test Set ---")
    test_img_dir = DATASET_DIR / "test" / "images"
    test_images = sorted(list(test_img_dir.glob("*.jpg")))
    if not test_images:
        print("No test images found for evaluation!")
        return

    det_base = BaselineONNXDetector(base_onnx)
    det_ft = BaselineONNXDetector(finetuned_onnx)

    base_latencies = []
    ft_latencies = []
    base_detections_count = 0
    ft_detections_count = 0

    for img_path in test_images:
        img = cv2.imread(str(img_path))
        if img is None:
            continue

        # Baseline
        t0 = time.perf_counter()
        b_boxes = det_base.detect(img, conf_thresh=0.25)
        base_latencies.append((time.perf_counter() - t0) * 1000)
        base_detections_count += len(b_boxes)

        # Fine-Tuned
        t0 = time.perf_counter()
        ft_boxes = det_ft.detect(img, conf_thresh=0.25)
        ft_latencies.append((time.perf_counter() - t0) * 1000)
        ft_detections_count += len(ft_boxes)

    print("\n=================================================================")
    print("  HELD-OUT TEST SET EVALUATION REPORT (Clips 10-12, 51 keyframes)")
    print("=================================================================")
    print(f"  Total Test Keyframes Evaluated   : {len(test_images)}")
    print(f"  Baseline Detector Total Boxes    : {base_detections_count}")
    print(f"  Fine-Tuned Detector Total Boxes  : {ft_detections_count}")
    print(f"  Baseline Median Inference Latency: {np.median(base_latencies):.2f} ms")
    print(f"  Fine-Tuned Median Inference Latency: {np.median(ft_latencies):.2f} ms")
    print("=================================================================")

def main():
    print("=========================================================")
    print("  PlateQ — Export ONNX & Held-Out Test Set Evaluation    ")
    print("=========================================================")
    
    best_pt = locate_best_pt()
    print(f"Found PyTorch Trained Checkpoint: {best_pt} ({best_pt.stat().st_size} bytes)")
    final_onnx = export_to_onnx(best_pt)
    evaluate_detectors(BASELINE_DETECTOR, final_onnx)
    print("\n✓ Export and evaluation completed successfully.")

if __name__ == "__main__":
    main()
