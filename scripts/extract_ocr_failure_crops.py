#!/usr/bin/env python3
"""Extract reproducible crop/input evidence for observed OCR failures.

The target strings are OCR outputs observed in the baseline, not expected plate
numbers. They are used only to locate the failing frames and never to alter OCR.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from benchmark_training_videos import Detector, Ocr


ROOT = Path(__file__).resolve().parents[1]
VIDEO_DIR = ROOT / "public" / "train-video"

OBSERVED_FAILURES = {
    "WhatsApp Video 2026-09-15 at 15.10.37.mp4": "BNC15",
    "WhatsApp Video 2026-09-15 at 15.10.40.mp4": "AN7569",
    "WhatsApp Video 2026-09-18 at 11.05.54.mp4": "WYS460",
    "WhatsApp Video 2026-09-18 at 11.05.59.mp4": "IAM1284",
    "WhatsApp Video 2026-09-15 at 15.10.51.mp4": "AEA7567",
}


def crop_with_padding(frame: np.ndarray, box, pad_x: float, pad_y: float) -> np.ndarray:
    height, width = frame.shape[:2]
    x1, y1, x2, y2, _ = box
    box_width, box_height = x2 - x1, y2 - y1
    left = max(0, round(x1 - box_width * pad_x))
    top = max(0, round(y1 - box_height * pad_y))
    right = min(width, round(x2 + box_width * pad_x))
    bottom = min(height, round(y2 + box_height * pad_y))
    return frame[top:bottom, left:right]


def make_ocr_input(crop: np.ndarray) -> np.ndarray:
    height, width = crop.shape[:2]
    scale = min(320 / max(1, width), 48 / max(1, height))
    draw_width, draw_height = max(1, round(width * scale)), max(1, round(height * scale))
    target = np.full((48, 320, 3), 127, dtype=np.uint8)
    resized = cv2.resize(crop, (draw_width, draw_height), interpolation=cv2.INTER_CUBIC)
    offset_y = round((48 - draw_height) / 2)
    target[offset_y : offset_y + draw_height, :draw_width] = resized
    return target


def rotate_crop(crop: np.ndarray, angle: float) -> np.ndarray:
    height, width = crop.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    return cv2.warpAffine(crop, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def inner_text_crop(crop: np.ndarray) -> np.ndarray:
    """Mirror createInnerPlateTextCrop used by the browser scanner."""
    height, width = crop.shape[:2]
    is_two_line = width / max(1, height) < 2.3
    margin_x, margin_y = (0.04, 0.06) if is_two_line else (0.06, 0.18)
    left, right = round(width * margin_x), round(width * (1 - margin_x))
    top, bottom = round(height * margin_y), round(height * (1 - margin_y))
    inner = crop[top:bottom, left:right]
    return cv2.resize(inner, (width, height), interpolation=cv2.INTER_CUBIC)


def image_variants(frame: np.ndarray, box) -> dict[str, np.ndarray]:
    tight = crop_with_padding(frame, box, 0.0, 0.0)
    padded = crop_with_padding(frame, box, 0.09, 0.12)
    wide = crop_with_padding(frame, box, 0.18, 0.20)
    gray = cv2.cvtColor(padded, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    sharpen = cv2.filter2D(padded, -1, np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32))
    return {
        "detector_tight": tight,
        "production_padded": padded,
        "production_inner": inner_text_crop(padded),
        "wide_padded": wide,
        "clahe": cv2.cvtColor(clahe, cv2.COLOR_GRAY2BGR),
        "sharpen": sharpen,
        "deskew_minus_5": rotate_crop(wide, -5),
        "deskew_plus_5": rotate_crop(wide, 5),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "ocr-failure-crops")
    parser.add_argument("--confidence", type=float, default=0.24)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    detector, ocr = Detector(), Ocr()
    summary = []

    for filename, observed_text in OBSERVED_FAILURES.items():
        path = VIDEO_DIR / filename
        capture = cv2.VideoCapture(str(path))
        fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
        frame_index = 0
        best = None

        while True:
            ok, frame = capture.read()
            if not ok:
                break
            boxes, _diagnostics = detector.detect(frame, args.confidence)
            for box in boxes:
                production_crop = crop_with_padding(frame, box, 0.09, 0.12)
                text, score, layout = ocr.recognize_plate(production_crop)
                if text == observed_text and (best is None or score > best["score"]):
                    best = {
                        "frame": frame.copy(),
                        "frameIndex": frame_index,
                        "timestampSeconds": frame_index / fps,
                        "box": box,
                        "score": score,
                        "layout": layout,
                    }
            frame_index += 1
        capture.release()

        record = {"video": filename, "observedText": observed_text, "found": best is not None}
        if best is None:
            summary.append(record)
            continue

        sample_dir = args.output / observed_text
        sample_dir.mkdir(parents=True, exist_ok=True)
        frame = best["frame"]
        box = best["box"]
        variants = image_variants(frame, box)
        comparisons = []

        annotated = frame.copy()
        x1, y1, x2, y2, detector_score = box
        cv2.rectangle(annotated, (round(x1), round(y1)), (round(x2), round(y2)), (255, 255, 0), 3)
        cv2.imwrite(str(sample_dir / "source_frame.jpg"), annotated)

        for name, crop in variants.items():
            text, score, layout = ocr.recognize_plate(crop)
            cv2.imwrite(str(sample_dir / f"{name}.jpg"), crop)
            cv2.imwrite(str(sample_dir / f"{name}_ocr_input_320x48.jpg"), make_ocr_input(crop))
            comparisons.append(
                {
                    "variant": name,
                    "cropSize": [int(crop.shape[1]), int(crop.shape[0])],
                    "ocrText": text,
                    "ocrConfidence": round(score, 4),
                    "layout": layout,
                }
            )

        record.update(
            {
                "frameIndex": best["frameIndex"],
                "timestampSeconds": round(best["timestampSeconds"], 4),
                "detectorConfidence": round(detector_score, 4),
                "bbox": [round(x1, 2), round(y1, 2), round(x2 - x1, 2), round(y2 - y1, 2)],
                "comparisons": comparisons,
            }
        )
        (sample_dir / "metadata.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        summary.append(record)

    (args.output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
