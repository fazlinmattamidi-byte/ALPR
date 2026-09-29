#!/usr/bin/env python3
"""Run the shipped detector and OCR models against real training-video frames.

This is an offline diagnostic, not a replacement for the browser acceptance test.
It intentionally mirrors the production model preprocessing closely enough to expose
detector coverage and raw OCR regressions on the bundled clips.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


ROOT = Path(__file__).resolve().parents[1]
VIDEO_DIR = ROOT / "public" / "train-video"
DETECTOR_PATH = ROOT / "public" / "models" / "plate-detector.onnx"
OCR_PATH = ROOT / "public" / "models" / "ppocr-rec.onnx"
DICT_PATH = ROOT / "public" / "models" / "ppocr-dict.txt"

def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def percentile(values: list[float], value: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(np.ceil(value * len(ordered))) - 1))
    return round(ordered[index], 2)


def box_iou(left: list[float], right: list[float]) -> float:
    """IoU for [x, y, width, height] boxes."""
    left_x2, left_y2 = left[0] + left[2], left[1] + left[3]
    right_x2, right_y2 = right[0] + right[2], right[1] + right[3]
    intersection_width = max(0.0, min(left_x2, right_x2) - max(left[0], right[0]))
    intersection_height = max(0.0, min(left_y2, right_y2) - max(left[1], right[1]))
    intersection = intersection_width * intersection_height
    union = left[2] * left[3] + right[2] * right[3] - intersection
    return intersection / union if union > 0 else 0.0


def nms(boxes: list[tuple[float, float, float, float, float]], threshold: float = 0.35):
    if not boxes:
        return []
    ordered = sorted(boxes, key=lambda item: item[4], reverse=True)
    selected = []
    for candidate in ordered:
        x1, y1, x2, y2, _ = candidate
        keep = True
        for chosen in selected:
            xx1, yy1 = max(x1, chosen[0]), max(y1, chosen[1])
            xx2, yy2 = min(x2, chosen[2]), min(y2, chosen[3])
            intersection = max(0.0, xx2 - xx1) * max(0.0, yy2 - yy1)
            union = max(1.0, (x2 - x1) * (y2 - y1) + (chosen[2] - chosen[0]) * (chosen[3] - chosen[1]) - intersection)
            if intersection / union > threshold:
                keep = False
                break
        if keep:
            selected.append(candidate)
    return selected[:12]


class Detector:
    def __init__(self):
        self.session = ort.InferenceSession(str(DETECTOR_PATH), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def detect(self, frame: np.ndarray, confidence: float):
        height, width = frame.shape[:2]
        scale = min(640 / width, 640 / height)
        draw_width, draw_height = round(width * scale), round(height * scale)
        pad_x, pad_y = round((640 - draw_width) / 2), round((640 - draw_height) / 2)
        letterbox = np.full((640, 640, 3), 127, dtype=np.uint8)
        resized = cv2.resize(frame, (draw_width, draw_height), interpolation=cv2.INTER_LINEAR)
        letterbox[pad_y : pad_y + draw_height, pad_x : pad_x + draw_width] = resized
        tensor = letterbox[:, :, ::-1].astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        output = self.session.run(None, {self.input_name: tensor})[0][0]
        if output.shape[0] <= output.shape[1]:
            output = output.T

        boxes = []
        above_confidence = 0
        rejected_min_size = 0
        rejected_aspect = 0
        for row in output:
            score = float(row[4])
            if score < confidence:
                continue
            above_confidence += 1
            cx, cy, box_width, box_height = map(float, row[:4])
            x1 = max(0.0, min(width, (cx - box_width / 2 - pad_x) / scale))
            y1 = max(0.0, min(height, (cy - box_height / 2 - pad_y) / scale))
            x2 = max(0.0, min(width, (cx + box_width / 2 - pad_x) / scale))
            y2 = max(0.0, min(height, (cy + box_height / 2 - pad_y) / scale))
            if x2 - x1 < max(24, width * 0.015) or y2 - y1 < max(7, height * 0.006):
                rejected_min_size += 1
                continue
            aspect = (x2 - x1) / max(1.0, y2 - y1)
            if not 0.65 <= aspect <= 7.5:
                rejected_aspect += 1
                continue
            boxes.append((x1, y1, x2, y2, score))
        selected = nms(boxes)
        return selected, {
            "aboveConfidence": above_confidence,
            "rejectedMinSize": rejected_min_size,
            "rejectedAspect": rejected_aspect,
            "preNms": len(boxes),
            "nmsSuppressed": max(0, len(boxes) - len(selected)),
            "final": len(selected),
        }


class Ocr:
    def __init__(self):
        self.session = ort.InferenceSession(str(OCR_PATH), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.characters = DICT_PATH.read_text(encoding="utf-8").splitlines() + [" "]

    def recognize(self, crop: np.ndarray):
        if crop.size == 0:
            return "", 0.0
        height, width = crop.shape[:2]
        scale = min(320 / max(1, width), 48 / max(1, height))
        draw_width, draw_height = max(1, round(width * scale)), max(1, round(height * scale))
        target = np.full((48, 320, 3), 127, dtype=np.uint8)
        resized = cv2.resize(crop, (draw_width, draw_height), interpolation=cv2.INTER_CUBIC)
        offset_y = round((48 - draw_height) / 2)
        target[offset_y : offset_y + draw_height, :draw_width] = resized
        tensor = target[:, :, ::-1].astype(np.float32) / 127.5 - 1.0
        tensor = tensor.transpose(2, 0, 1)[None]
        output = self.session.run(None, {self.input_name: tensor})[0][0]
        indices = output.argmax(axis=1)
        probabilities = output.max(axis=1)
        previous = 0
        text, scores = [], []
        for index, probability in zip(indices, probabilities):
            index = int(index)
            if index != 0 and index != previous and index - 1 < len(self.characters):
                char = self.characters[index - 1]
                if char and char != " ":
                    text.append(char)
                    scores.append(float(probability))
            previous = index
        normalized = "".join(char for char in "".join(text).upper() if char.isascii() and char.isalnum())
        return normalized, float(np.mean(scores)) if scores else 0.0

    def recognize_plate(self, crop: np.ndarray):
        """Mirror the browser's full/split/compact two-line OCR routing."""
        full_text, full_score = self.recognize(crop)
        candidates = [(full_text, full_score, "FULL")]
        height, width = crop.shape[:2]

        if width / max(1, height) < 2.3:
            line_specs = [
                (crop[: round(height * 0.58)], crop[round(height * 0.46) :], "SPLIT"),
                (
                    crop[: round(height * 0.55), round(width * 0.06) : round(width * 0.94)],
                    crop[
                        round(height * 0.40) : round(height * 0.90),
                        round(width * 0.22) : round(width * 0.78),
                    ],
                    "COMPACT_SPLIT",
                ),
            ]
            for top, bottom, layout in line_specs:
                top_text, top_score = self.recognize(top)
                bottom_text, bottom_score = self.recognize(bottom)
                merged = f"{top_text}{bottom_text}"
                candidates.append((merged, (top_score + bottom_score) / 2, layout))

        plausible = []
        for item in candidates:
            text = item[0]
            repeated_half = len(text) % 2 == 0 and text[: len(text) // 2] == text[len(text) // 2 :]
            malaysian_shape = re.fullmatch(r"[A-Z]{1,4}[0-9]{1,5}[A-Z]{0,2}", text)
            if malaysian_shape and not repeated_half:
                plausible.append(item)
        ranked = plausible or candidates
        return max(ranked, key=lambda item: (len(item[0]), item[1]))


def padded_crop(frame: np.ndarray, box):
    height, width = frame.shape[:2]
    x1, y1, x2, y2, _ = box
    box_width, box_height = x2 - x1, y2 - y1
    left = max(0, round(x1 - box_width * 0.09))
    top = max(0, round(y1 - box_height * 0.12))
    right = min(width, round(x2 + box_width * 0.09))
    bottom = min(height, round(y2 + box_height * 0.12))
    return frame[top:bottom, left:right]


def benchmark_video(
    path: Path,
    detector: Detector,
    ocr: Ocr,
    sample_fps: float,
    confidence: float,
    diagnostics_dir: Path | None = None,
    ground_truth: list[dict] | None = None,
):
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_seconds = frame_count / fps if frame_count else 0.0
    every = max(1, round(fps / sample_fps))
    frame_index = 0
    sampled = 0
    frames_with_detections = 0
    total_detections = 0
    max_simultaneous = 0
    reads: Counter[str] = Counter()
    expected = sorted(
        {
            re.sub(r"[^A-Z0-9]", "", str(item.get("plate", "")).upper())
            for item in (ground_truth or [])
            if not item.get("unreadable") and item.get("plate")
        }
    )
    exact_first_seen: dict[str, float] = {}
    exact_counts: Counter[str] = Counter()
    closest_reads: dict[str, dict] = {
        plate: {"text": "", "distance": len(plate), "timestampSeconds": None, "confidence": 0.0}
        for plate in expected
    }
    detector_latencies: list[float] = []
    ocr_latencies: list[float] = []
    first_scene_detection_seconds: float | None = None
    filter_totals = Counter()
    wall_started = time.perf_counter()
    diagnostic_records = []
    evaluation_predictions = []
    video_diagnostics_dir = diagnostics_dir / path.stem if diagnostics_dir else None
    if video_diagnostics_dir:
        video_diagnostics_dir.mkdir(parents=True, exist_ok=True)

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % every == 0:
            sampled += 1
            media_seconds = frame_index / fps
            detector_started = time.perf_counter()
            boxes, detector_diagnostics = detector.detect(frame, confidence)
            detector_latencies.append((time.perf_counter() - detector_started) * 1000)
            filter_totals.update(detector_diagnostics)
            if boxes:
                frames_with_detections += 1
                if first_scene_detection_seconds is None:
                    first_scene_detection_seconds = media_seconds
            total_detections += len(boxes)
            max_simultaneous = max(max_simultaneous, len(boxes))
            for box_index, box in enumerate(boxes):
                crop = padded_crop(frame, box)
                ocr_started = time.perf_counter()
                text, score, layout = ocr.recognize_plate(crop)
                ocr_latency_ms = (time.perf_counter() - ocr_started) * 1000
                ocr_latencies.append(ocr_latency_ms)
                x1, y1, x2, y2, detector_score = box
                evaluation_predictions.append(
                    {
                        "frameIndex": frame_index,
                        "timestampSeconds": round(media_seconds, 4),
                        "bbox": [x1, y1, x2 - x1, y2 - y1],
                        "detectorConfidence": detector_score,
                        "ocrText": text,
                        "ocrConfidence": score,
                        "totalLatencyMs": detector_latencies[-1] + ocr_latency_ms,
                    }
                )
                if text and score >= 0.20:
                    reads[text] += 1
                    for plate in expected:
                        distance = edit_distance(text, plate)
                        closest = closest_reads[plate]
                        is_better = distance < closest["distance"] or (
                            distance == closest["distance"] and score > closest["confidence"]
                        )
                        if is_better:
                            closest_reads[plate] = {
                                "text": text,
                                "distance": distance,
                                "timestampSeconds": round(media_seconds, 3),
                                "confidence": round(score, 4),
                            }
                            if video_diagnostics_dir:
                                crop_name = f"{plate}_closest_f{frame_index:04d}_{text or 'EMPTY'}.jpg"
                                cv2.imwrite(str(video_diagnostics_dir / crop_name), crop)
                        if text == plate:
                            exact_counts[plate] += 1
                            exact_first_seen.setdefault(plate, media_seconds)

                if video_diagnostics_dir:
                    diagnostic_records.append(
                        {
                            "frameIndex": frame_index,
                            "timestampSeconds": round(media_seconds, 3),
                            "boxIndex": box_index,
                            "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                            "detectorConfidence": round(detector_score, 4),
                            "ocrText": text,
                            "ocrConfidence": round(score, 4),
                            "ocrLayout": layout,
                            "ocrLatencyMs": round(ocr_latency_ms, 2),
                        }
                    )
        frame_index += 1
    capture.release()
    wall_elapsed_seconds = time.perf_counter() - wall_started

    plate_results = []
    for plate in expected:
        recognized_at = exact_first_seen.get(plate)
        plate_results.append(
            {
                "plate": plate,
                "recognized": recognized_at is not None,
                "firstExactReadSeconds": round(recognized_at, 3) if recognized_at is not None else None,
                "exactReadCount": exact_counts[plate],
                "closestRead": closest_reads[plate],
                "failureStage": None if recognized_at is not None else "OCR_OR_CROP",
            }
        )

    annotation_rows = []
    used_prediction_indexes: set[int] = set()
    annotated_frame_indexes: set[int] = set()
    fully_annotated_frame_indexes: set[int] = set()
    for annotation in ground_truth or []:
        annotation_frame = annotation.get("frameIndex")
        if annotation_frame is None:
            annotation_frame = round(float(annotation.get("timestampSeconds", 0)) * fps)
        annotation_frame = int(annotation_frame)
        annotated_frame_indexes.add(annotation_frame)
        if annotation.get("fullyAnnotatedForDetection"):
            fully_annotated_frame_indexes.add(annotation_frame)
        annotation_box = annotation.get("bbox", {})
        truth_box = [
            float(annotation_box.get("x", 0)),
            float(annotation_box.get("y", 0)),
            float(annotation_box.get("width", 0)),
            float(annotation_box.get("height", 0)),
        ]
        candidates = []
        for prediction_index, prediction in enumerate(evaluation_predictions):
            if prediction_index in used_prediction_indexes or prediction["frameIndex"] != annotation_frame:
                continue
            overlap = box_iou(truth_box, prediction["bbox"])
            if overlap >= 0.5:
                candidates.append((overlap, prediction["detectorConfidence"], prediction_index, prediction))
        candidates.sort(reverse=True, key=lambda item: (item[0], item[1]))
        match = candidates[0] if candidates else None
        if match:
            used_prediction_indexes.add(match[2])
        normalized_truth = re.sub(r"[^A-Z0-9]", "", str(annotation.get("plate", "")).upper())
        recognized = bool(
            match
            and (
                annotation.get("unreadable")
                or re.sub(r"[^A-Z0-9]", "", match[3]["ocrText"].upper()) == normalized_truth
            )
        )
        annotation_rows.append(
            {
                "annotationId": annotation.get("id"),
                "plate": normalized_truth,
                "frameIndex": annotation_frame,
                "timestampSeconds": annotation.get("timestampSeconds"),
                "detected": match is not None,
                "recognized": recognized,
                "failureStage": None if recognized else ("OCR" if match else "DETECTOR"),
                "iou": round(match[0], 4) if match else None,
                "prediction": match[3] if match else None,
            }
        )

    readable_annotation_rows = [
        row
        for row, annotation in zip(annotation_rows, ground_truth or [])
        if not annotation.get("unreadable")
    ]
    annotated_frame_predictions = [
        (index, prediction)
        for index, prediction in enumerate(evaluation_predictions)
        if prediction["frameIndex"] in fully_annotated_frame_indexes
    ]
    matched_latency = [
        row["prediction"]["totalLatencyMs"]
        for row in readable_annotation_rows
        if row["recognized"] and row["prediction"]
    ]
    detector_evaluation = {
        "annotationCount": len(annotation_rows),
        "detected": sum(row["detected"] for row in annotation_rows),
        "missed": sum(not row["detected"] for row in annotation_rows),
        "detectionRecall": round(sum(row["detected"] for row in annotation_rows) / len(annotation_rows), 4)
        if annotation_rows
        else None,
        "correctlyRecognized": sum(row["recognized"] for row in readable_annotation_rows),
        "endToEndRecall": round(
            sum(row["recognized"] for row in readable_annotation_rows) / len(readable_annotation_rows), 4
        )
        if readable_annotation_rows
        else None,
        "falsePositivesOnFullyAnnotatedFrames": sum(
            index not in used_prediction_indexes for index, _prediction in annotated_frame_predictions
        ),
        "fullyAnnotatedFrameCount": len(fully_annotated_frame_indexes),
        "latencyMs": {
            "average": round(float(np.mean(matched_latency)), 2) if matched_latency else None,
            "p50": percentile(matched_latency, 0.5) if matched_latency else None,
            "p95": percentile(matched_latency, 0.95) if matched_latency else None,
        },
        "rows": annotation_rows,
    }

    result = {
        "video": path.name,
        "durationSeconds": round(duration_seconds, 3),
        "sourceFps": round(fps, 3),
        "evaluationFps": round(fps / every, 3),
        "expectedPlates": expected,
        "sampledFrames": sampled,
        "framesWithDetections": frames_with_detections,
        "detectionCoverage": round(frames_with_detections / max(1, sampled), 3),
        "firstSceneDetectionSeconds": round(first_scene_detection_seconds, 3) if first_scene_detection_seconds is not None else None,
        "totalDetections": total_detections,
        "maxSimultaneous": max_simultaneous,
        "detectorDiagnostics": dict(filter_totals),
        "annotatedEvaluation": detector_evaluation,
        "plateResults": plate_results,
        "exactRecognitionRecall": (
            round(sum(item["recognized"] for item in plate_results) / len(plate_results), 3)
            if plate_results
            else None
        ),
        "latencyMs": {
            "detectorMedian": percentile(detector_latencies, 0.5),
            "detectorP95": percentile(detector_latencies, 0.95),
            "ocrMedianPerCrop": percentile(ocr_latencies, 0.5),
            "ocrP95PerCrop": percentile(ocr_latencies, 0.95),
        },
        "wallTimeSeconds": round(wall_elapsed_seconds, 2),
        "processingThroughputFps": round(sampled / max(0.001, wall_elapsed_seconds), 2),
        "topRawOcr": reads.most_common(12),
    }

    if video_diagnostics_dir:
        (video_diagnostics_dir / "detections.json").write_text(
            json.dumps(diagnostic_records, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        (video_diagnostics_dir / "summary.json").write_text(
            json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-fps", type=float, default=3.0)
    parser.add_argument("--confidence", type=float, default=0.24)
    parser.add_argument("--video", help="Optional filename substring")
    parser.add_argument(
        "--diagnostics-dir",
        type=Path,
        help="Optional directory for development-only crops and per-frame metadata",
    )
    parser.add_argument("--output", type=Path, help="Optional JSON report path")
    parser.add_argument(
        "--annotations",
        type=Path,
        help="Ground-truth JSON exported by the Video Testing Lab",
    )
    args = parser.parse_args()

    detector, ocr = Detector(), Ocr()
    videos = sorted(VIDEO_DIR.glob("*.mp4"))
    if args.video:
        videos = [path for path in videos if args.video.lower() in path.name.lower()]

    annotations_by_filename: dict[str, list[dict]] = {}
    if args.annotations:
        dataset = json.loads(args.annotations.read_text(encoding="utf-8"))
        source_filenames = {
            source.get("id"): str(source.get("filename") or Path(str(source.get("url", ""))).name)
            for source in dataset.get("sources", [])
        }
        for annotation in dataset.get("annotations", []):
            filename = source_filenames.get(annotation.get("sourceId"))
            if filename:
                annotations_by_filename.setdefault(filename, []).append(annotation)
    results = [
        benchmark_video(
            path,
            detector,
            ocr,
            args.sample_fps,
            args.confidence,
            args.diagnostics_dir,
            annotations_by_filename.get(path.name, []),
        )
        for path in videos
    ]
    report = {
        "configuration": {
            "sampleFps": args.sample_fps,
            "confidenceThreshold": args.confidence,
            "detectorModel": str(DETECTOR_PATH.relative_to(ROOT)),
            "ocrModel": str(OCR_PATH.relative_to(ROOT)),
            "groundTruthUse": "evaluation-only; expected values never enter inference",
            "annotations": str(args.annotations) if args.annotations else None,
        },
        "summary": {
            "videos": len(results),
            "expectedPlates": sum(len(item["expectedPlates"]) for item in results),
            "recognizedPlates": sum(
                sum(plate["recognized"] for plate in item["plateResults"]) for item in results
            ),
            "videosWithDetectorBoxes": sum(item["framesWithDetections"] > 0 for item in results),
            "humanAnnotated": {
                "labels": sum(item["annotatedEvaluation"]["annotationCount"] for item in results),
                "detected": sum(item["annotatedEvaluation"]["detected"] for item in results),
                "correctlyRecognized": sum(
                    item["annotatedEvaluation"]["correctlyRecognized"] for item in results
                ),
                "missed": sum(item["annotatedEvaluation"]["missed"] for item in results),
                "falsePositivesOnFullyAnnotatedFrames": sum(
                    item["annotatedEvaluation"]["falsePositivesOnFullyAnnotatedFrames"]
                    for item in results
                ),
            },
        },
        "results": results,
    }
    payload = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
