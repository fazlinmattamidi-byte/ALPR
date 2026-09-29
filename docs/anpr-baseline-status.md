# ANPR baseline status

Date: 2026-09-18

## What is measured now

An 8 FPS diagnostic pass was completed across all 12 supplied videos using:

- `public/models/plate-detector.onnx`
- `public/models/ppocr-rec.onnx`
- detector threshold `0.24`
- CPU ONNX Runtime in the offline runner

The detector produced at least one box in every video. Frame-level box coverage ranged from `37.3%` to `100%`; this is **not detector recall**, because representative human bounding-box labels did not yet exist. Maximum simultaneous post-NMS boxes ranged from 1 to 5.

The measured pass showed repeated near-reads and exact reads in several clips, which indicates that many current failures occur after detection—in crop selection or OCR—but it does not prove that every target plate was detected.

## Measured latency smoke check

Sample 11 was rerun at 2 FPS after the regression runner was made ground-truth independent:

| Metric | Result |
| --- | ---: |
| Source duration | 5.033 s |
| Sampled frames | 11 |
| Frames with boxes | 8 |
| Post-NMS boxes | 15 |
| Detector median | 49.75 ms/frame |
| Detector P95 | 58.10 ms/frame |
| OCR median | 71.81 ms/crop |
| OCR P95 | 85.14 ms/crop |
| Offline throughput | 7.19 sampled frames/s |

These figures describe this CPU test environment only. They are not WebGPU, browser, mobile or live-camera claims.

## Accuracy status

Detection recall, OCR exact-match accuracy, end-to-end recall and false-positive rate are currently **not measured**. Reporting those values before humans label frames and boxes would fabricate accuracy.

The next required action is to label representative frames in the Video Testing Lab, freeze the `TEST` split, export ground truth, and rerun the exact models and configuration. No model replacement or fine-tuning is justified until that report exists.

## Detector provenance found in the ONNX metadata

The detector is an Ultralytics YOLO detection model with a fixed `1×3×640×640` input and no embedded NMS. Its metadata references a local training data file named `plate-Q/_rf_tmp/data_abs.yaml`, but the actual training images and class distribution are not present in this repository. Therefore square Malaysian plate coverage, angle coverage and train/test leakage cannot yet be verified from the repository alone.
