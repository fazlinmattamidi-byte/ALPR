# ANPR Video Testing Lab

The development-only lab is available at `/video-lab` while running `npm run dev`. It is intentionally not exposed as an operational production tool.

## Ground-truth workflow

1. Select one of the 12 supplied videos or upload several additional videos.
2. Pause and move one frame at a time with the arrow controls.
3. Drag a box around the complete plate.
4. Enter the plate only after visually verifying it. Predictions are never copied into the label form.
5. Record layout, angle, environment, occlusion and readability.
6. Assign the source video to `TRAIN`, `VALIDATION` or `TEST`. Every label from that source is moved together so one vehicle/video cannot leak across splits.
7. Export **Ground truth** to produce `track-anpr-video-ground-truth.json`.

Annotations are stored locally in the browser under `track_video_lab_annotations_v1`. Model predictions are kept separately in session state.

## Repeatable offline analysis

Choose a frame interval and detector threshold, then run one video or the full batch. The analyser pauses and seeks the video; processing speed never controls which timestamps are evaluated. Each selected timestamp completes detector and OCR inference before the next timestamp is admitted.

The lab displays cyan detector boxes, OCR text, detector/OCR latency, intermediate crops and failures classified as `DETECTOR` or `OCR`. Export **Regression report** for per-video predictions and aggregate metrics.

## Command-line regression

The Python runner uses the same shipped ONNX files and accepts only the human annotation export as truth:

```bash
npm run benchmark:videos -- \
  --sample-fps 8 \
  --confidence 0.24 \
  --annotations track-anpr-video-ground-truth.json \
  --diagnostics-dir .anpr-diagnostics \
  --output anpr-regression-report.json
```

Without `--annotations`, the runner reports detector/OCR observations and latency but does not claim recognition accuracy.

## Model-change gate

Do not replace or fine-tune either ONNX model until:

- the manually labelled test split is frozen;
- detector recall and OCR exact match are measured independently;
- a candidate model beats the baseline on the unchanged test split;
- regressions, false positives and latency are reviewed per video.

Only then should the validated ONNX artifact be integrated into the live scanner and real-time performance tested separately.
