# PlateQ Model Directory

This directory stores offline ONNX machine learning models for local browser inference.

## 1. Roboflow YOLOv8 Malaysian Plate Detector (`plate-detector.onnx`)
- **Project:** `fyp-hq4ka/license-plate-malaysia-kqy48`
- **Format:** ONNX format (`640x640` input size)
- **Path:** `/models/plate-detector.onnx`

When `plate-detector.onnx` is present in this folder, PlateQ automatically loads it using `onnxruntime-web` for zero-latency local GPU/WASM detection.

If absent, PlateQ automatically uses the **Roboflow Hosted API** (with API key `QhgkpEMcagyM4hkiKOVl`) or the built-in **CV Heuristic Detector**.

## 2. OCR Models
Place any custom ONNX character recognition models (PP-OCR, CRNN) in this directory:
- `/models/crnn-malaysia.onnx`
- `/models/ppocr-rec.onnx`
