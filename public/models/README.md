# PlateQ Model Directory

This directory stores offline ONNX machine learning models for local browser inference.

## 1. YOLOv8 Malaysian Plate Detector (`plate-detector.onnx`)
- **Project:** `fyp-hq4ka/license-plate-malaysia-kqy48`
- **Format:** ONNX format (`640x640` input size)
- **Path:** `/models/plate-detector.onnx`

When `plate-detector.onnx` is present in this folder, PlateQ automatically loads it using `onnxruntime-web` for zero-latency local GPU/WASM detection.

The production scanner keeps this detector as the primary plate detector. Developer CV fallback is gated behind Developer Mode only.

## 2. PP-OCR Recognition Model
- **Path:** `/models/ppocr-rec.onnx`
- **Dictionary:** `/models/ppocr-dict.txt`

## 3. Environment Intelligence Model
- **Framework:** YOLOv8 Classification
- **Path:** `/models/environment-classifier.onnx`
- **Metadata:** `/models/environment-classifier.metadata.json`
- **Training dataset:** BDD100K
- **Classes:** `BACKLIGHT`, `DAY`, `FOG`, `GLARE`, `GOOD_CONDITION`, `HEAVY_RAIN`, `HIGHWAY`, `LOW_LIGHT`, `NIGHT`, `PARKING`, `RAIN`, `TRAFFIC`, `TUNNEL`

Train/export with:

```bash
npm run prepare:environment -- --bdd-root /path/to/bdd100k
npm run train:environment -- --data datasets/bdd100k-environment-cls
```

If this file is not present, the scanner uses a deterministic frame-stat heuristic until a trained classifier is exported. See `docs/environment-model-bdd100k.md`.

## 4. Plate Quality Assessment Model
- **Framework:** YOLOv8 Classification
- **Path:** `/models/plate-quality-classifier.onnx`
- **Metadata:** `/models/plate-quality-classifier.metadata.json`
- **Classes:** `GOOD`, `MOTION_BLUR`, `OUT_OF_FOCUS`, `TOO_SMALL`, `LOW_CONTRAST`, `OVEREXPOSED`, `UNDEREXPOSED`, `GLARE_REFLECTION`, `OCCLUDED`, `BAD_ANGLE`

This model does not read text. It only decides whether a plate crop should be admitted to OCR. If absent, the scanner uses the existing crop-quality heuristics.
The quality model receives cropped licence plates only. Do not use full-scene classes such as rain, night, day, highway, parking, or traffic here.

Train/export with reviewed Dataset Mode exports:

```bash
npm run prepare:quality -- --exports /path/to/track_dataset_export_*.json --clear
npm run train:quality -- --data datasets/plate-quality-cls
```

See `docs/plate-quality-model.md`.
