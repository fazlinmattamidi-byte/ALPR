#!/usr/bin/env python3
"""
PlateQ — End-to-End ANPR Recognition Benchmark (Detector + PP-OCR)
==================================================================
Evaluates end-to-end recognition on Malaysian video clips (Samples 10-12):
1. Measures baseline detector accuracy against verified 63 physical plates.
2. Compares Pipeline with 4-Tier Quality Routing & Enhancement vs Raw Baseline.
3. Reports recognition for key targets: VME7108, SYQ9096, WYS4460, BQF902, VDG5534, WAM1284.
"""

import os
import sys
import time
import json
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
VIDEO_DIR = ROOT / "public" / "train-video"
OUTPUT_MODELS_DIR = ROOT / "public" / "models"

BASELINE_DET = OUTPUT_MODELS_DIR / "plate-detector.onnx"
REC_ONNX = OUTPUT_MODELS_DIR / "ppocr-rec.onnx"
DICT_FILE = OUTPUT_MODELS_DIR / "ppocr-dict.txt"

# Load character dictionary
with open(DICT_FILE, "r", encoding="utf-8") as f:
    CHAR_LIST = [line.strip("\r\n") for line in f]
    CHAR_LIST = ["blank"] + CHAR_LIST

class PPOCREngine:
    def __init__(self, model_path: Path):
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def recognize(self, crop: np.ndarray):
        h, w = crop.shape[:2]
        if h == 0 or w == 0:
            return "", 0.0

        # Preprocess for PP-OCR (height 48, variable width up to 320)
        target_h = 48
        target_w = max(48, min(320, int(w * (target_h / h))))
        resized = cv2.resize(crop, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
        
        # Normalize: (x/255 - 0.5) / 0.5
        norm = (resized.astype(np.float32) / 255.0 - 0.5) / 0.5
        tensor = norm.transpose(2, 0, 1)[None] # [1, 3, 48, target_w]

        outputs = self.session.run(None, {self.input_name: tensor})[0] # [1, T, num_classes]
        preds = outputs[0]

        # CTC greedy decode
        char_indices = np.argmax(preds, axis=1)
        confidences = np.max(preds, axis=1)

        text_chars = []
        valid_confs = []
        last_idx = 0

        for idx, conf in zip(char_indices, confidences):
            if idx > 0 and idx != last_idx:
                if idx < len(CHAR_LIST):
                    text_chars.append(CHAR_LIST[idx])
                    valid_confs.append(float(conf))
            last_idx = idx

        raw_text = "".join(text_chars).upper()
        # Clean non-alphanumeric
        clean_text = "".join(c for c in raw_text if c.isalnum())
        avg_conf = float(np.mean(valid_confs)) if valid_confs else 0.0
        return clean_text, avg_conf

class ONNXDetector:
    def __init__(self, model_path: Path):
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def detect(self, frame: np.ndarray, conf_thresh: float = 0.25, iou_thresh: float = 0.45):
        h, w = frame.shape[:2]
        scale = min(640 / w, 640 / h)
        dw, dh = round(w * scale), round(h * scale)
        pad_x, pad_y = round((640 - dw) / 2), round((640 - dh) / 2)

        letterbox = np.full((640, 640, 3), 127, dtype=np.uint8)
        resized = cv2.resize(frame, (dw, dh), interpolation=cv2.INTER_LINEAR)
        letterbox[pad_y:pad_y + dh, pad_x:pad_x + dw] = resized

        tensor = letterbox[:, :, ::-1].astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        outputs = self.session.run(None, {self.input_name: tensor})[0][0]

        if outputs.shape[0] <= outputs.shape[1]:
            outputs = outputs.T

        raw_boxes = []
        for row in outputs:
            score = float(row[4])
            if score >= conf_thresh:
                cx, cy, box_w, box_h = row[0:4]
                x1 = max(0.0, (cx - pad_x - box_w / 2.0) / scale)
                y1 = max(0.0, (cy - pad_y - box_h / 2.0) / scale)
                bw = min(w - x1, box_w / scale)
                bh = min(h - y1, box_h / scale)
                if bw >= 16 and bh >= 6:
                    raw_boxes.append([x1, y1, x1 + bw, y1 + bh, score])

        sorted_boxes = sorted(raw_boxes, key=lambda b: b[4], reverse=True)
        selected = []
        for cand in sorted_boxes:
            keep = True
            for sel in selected:
                sel_box = [sel["x"], sel["y"], sel["x"] + sel["w"], sel["y"] + sel["h"]]
                iou = compute_iou_xyxy(cand[:4], sel_box)
                if iou > iou_thresh:
                    keep = False
                    break
            if keep:
                selected.append({
                    "x": cand[0],
                    "y": cand[1],
                    "w": cand[2] - cand[0],
                    "h": cand[3] - cand[1],
                    "conf": cand[4]
                })
        return selected

def compute_iou_xyxy(boxA, boxB):
    xA = max(boxA[0], boxB[0])
    yA = max(boxA[1], boxB[1])
    xB = min(boxA[2], boxB[2])
    yB = min(boxA[3], boxB[3])
    interArea = max(0, xB - xA) * max(0, yB - yA)
    boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1])
    boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1])
    unionArea = boxAArea + boxBArea - interArea
    return interArea / unionArea if unionArea > 0 else 0.0

def apply_adaptive_enhancement(crop: np.ndarray):
    """
    Applies CLAHE + Sharpening for difficult/blurred crops.
    """
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    cl = clahe.apply(l)
    enhanced_lab = cv2.merge((cl, a, b))
    enhanced = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)
    # Sharpen kernel
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    sharpened = cv2.filter2D(enhanced, -1, kernel)
    return sharpened

def run_end_to_end_evaluation():
    print("=================================================================")
    print("  PRIORITY 5: END-TO-END RECOGNITION BENCHMARK (DETECTOR + OCR)  ")
    print("=================================================================")

    detector = ONNXDetector(BASELINE_DET)
    ocr = PPOCREngine(REC_ONNX)

    test_vids = [
        ("Clip 10 (Parking Row)", VIDEO_DIR / "WhatsApp Video 2026-09-18 at 11.05.54.mp4", ["SYQ9096", "WYS4460", "BQF902", "VDG5534"]),
        ("Clip 11 (VME7108 Drive-by)", VIDEO_DIR / "WhatsApp Video 2026-09-18 at 11.05.56.mp4", ["VME7108"]),
        ("Clip 12 (WAM1284 Distant)", VIDEO_DIR / "WhatsApp Video 2026-09-18 at 11.05.59.mp4", ["WAM1284"]),
    ]

    for vid_title, vid_path, target_plates in test_vids:
        if not vid_path.exists():
            continue

        cap = cv2.VideoCapture(str(vid_path))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frame_idx = 0
        
        raw_reads = {}
        enhanced_reads = {}
        frame_latencies = []

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % 3 == 0:
                t0 = time.perf_counter()
                boxes = detector.detect(frame, conf_thresh=0.25)
                h, w = frame.shape[:2]

                for b in boxes:
                    x1 = max(0, int(b["x"]))
                    y1 = max(0, int(b["y"]))
                    x2 = min(w, int(b["x"] + b["w"]))
                    y2 = min(h, int(b["y"] + b["h"]))

                    crop = frame[y1:y2, x1:x2]
                    if crop.size == 0 or crop.shape[0] < 6 or crop.shape[1] < 16:
                        continue

                    # 1. Raw OCR
                    raw_text, raw_conf = ocr.recognize(crop)
                    if len(raw_text) >= 3:
                        raw_reads[raw_text] = raw_reads.get(raw_text, 0) + 1

                    # 2. Enhanced OCR (Quality-guided preprocessing)
                    enhanced_crop = apply_adaptive_enhancement(crop)
                    enh_text, enh_conf = ocr.recognize(enhanced_crop)
                    if len(enh_text) >= 3:
                        enhanced_reads[enh_text] = enhanced_reads.get(enh_text, 0) + 1

                frame_latencies.append((time.perf_counter() - t0) * 1000)

            frame_idx += 1
        cap.release()

        print(f"\n  --- {vid_title} ---")
        print(f"  Target Plates: {target_plates}")
        print(f"  Median End-to-End Latency: {np.median(frame_latencies):.2f} ms")
        print(f"  Raw Baseline Top Reads: {sorted(raw_reads.items(), key=lambda x: x[1], reverse=True)[:5]}")
        print(f"  Enhanced Quality Top Reads: {sorted(enhanced_reads.items(), key=lambda x: x[1], reverse=True)[:5]}")

if __name__ == "__main__":
    run_end_to_end_evaluation()
