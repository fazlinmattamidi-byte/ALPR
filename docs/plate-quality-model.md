# Plate Quality Model Training

The plate quality model is a YOLOv8 classification model that decides whether a detected plate crop is worth sending to OCR. It does not read plate text.

## Classes

```text
GOOD
STANDARD_RECTANGLE
SQUARE_PLATE
TWO_LINE_PLATE
EV_WHITE_PLATE
SLIGHT_ROTATION
PERSPECTIVE_DISTORTION
MOTION_BLUR
OUT_OF_FOCUS
TOO_SMALL
LOW_CONTRAST
OVEREXPOSED
UNDEREXPOSED
GLARE_REFLECTION
OCCLUDED
BAD_ANGLE
```

The browser runtime reads `/models/plate-quality-classifier.metadata.json` when present, so the ONNX output order stays aligned with the trained model.

## Collect Data

Use Scanner Dataset Mode during real testing. Exported JSON includes each original frame, plate crop, environment label, quality label, OCR result, and confidence values.

For production training, review and correct `qualityClass` before preparing the dataset. Scanner-assigned labels are useful bootstrapping labels, not a replacement for human review.

## Prepare Dataset

```bash
npm run prepare:quality -- \
  --exports /path/to/track_dataset_export_*.json \
  --output datasets/plate-quality-cls \
  --min-label-confidence 0.70 \
  --val-ratio 0.20 \
  --clear
```

Useful options:

```bash
--max-per-class 5000
--dry-run
```

This writes:

```text
datasets/plate-quality-cls/
  train/GOOD/*.jpg
  train/MOTION_BLUR/*.jpg
  val/GOOD/*.jpg
  val/MOTION_BLUR/*.jpg
  metadata.json
```

## Train and Export ONNX

```bash
npm run train:quality -- \
  --data datasets/plate-quality-cls \
  --model yolov8n-cls.pt \
  --epochs 50 \
  --imgsz 224
```

This writes:

```text
public/models/plate-quality-classifier.onnx
public/models/plate-quality-classifier.metadata.json
```

If the model is absent, the scanner continues using the deterministic crop-quality heuristic fallback.

## Metadata

The runtime supports this sidecar format:

```json
{
  "modelType": "yolov8-classification",
  "task": "plate-quality-assessment",
  "inputWidth": 224,
  "inputHeight": 224,
  "layout": "NCHW",
  "colorSpace": "RGB",
  "resizeMode": "letterbox",
  "normalization": {
    "scale": 0.00392156862745098
  },
  "classes": [
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
    "BAD_ANGLE"
  ]
}
```

## Recommended Labeling Rules

Use `GOOD` for crisp, readable crops when no more specific readable-layout label applies. Prefer the readable-layout labels below when they are known; they should pass OCR and help the model learn Malaysian plate diversity.

Use failure labels for the dominant reason OCR should be delayed, corrected, or skipped:

| Class | Meaning |
| --- | --- |
| `STANDARD_RECTANGLE` | Readable standard black plate or commercial plate in a normal single-line rectangle |
| `SQUARE_PLATE` | Readable square or near-square rear/motorcycle plate |
| `TWO_LINE_PLATE` | Readable two-line crop where prefix and number may be stacked |
| `EV_WHITE_PLATE` | Readable JPJePlate/EV-style white reflective background with black characters |
| `SLIGHT_ROTATION` | Readable plate with mild roll/tilt that perspective preprocessing can correct |
| `PERSPECTIVE_DISTORTION` | Readable or near-readable trapezoid/side-angle crop that should be rectified before OCR |
| `MOTION_BLUR` | Directional streaking from movement |
| `OUT_OF_FOCUS` | Defocused crop |
| `TOO_SMALL` | Plate text is too small for reliable OCR |
| `LOW_CONTRAST` | Washed-out, dark, or weak text/background separation |
| `OVEREXPOSED` | Washed-out crop or clipped highlights |
| `UNDEREXPOSED` | Plate is too dark |
| `GLARE_REFLECTION` | Glare or reflected light across text |
| `OCCLUDED` | Plate partly hidden |
| `BAD_ANGLE` | Severe skew or perspective distortion; label only when correction is unlikely to recover text |
