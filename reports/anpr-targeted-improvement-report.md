# TRACK ANPR targeted improvement report

Date: 2026-09-19  
Scope: the existing 12 supplied videos; no catalogue value was injected into inference.

## Status

This is a targeted diagnostic and implementation pass, not a claim that recognition is fully fixed. The detector/PP-OCR ONNX files were not replaced. Browser/live-camera acceptance and the additional 18 real videos remain outstanding.

## 1. VME7108 confirmation failure

Sample 11 contains the following raw observations near the end of the clip:

| Frame | Video time | OCR | Confidence |
|---:|---:|---|---:|
| 134 | 4.467 s | VME708 | 0.7969 |
| 138 | 4.600 s | VME708 | 0.7193 |
| 139 | 4.633 s | VME7108 | 0.7418 |
| 140 | 4.667 s | VME708 | 0.8518 |
| 142 | 4.733 s | VME70 | 0.6960 |
| 143 | 4.767 s | VME7108 | 0.6722 |
| 144 | 4.800 s | VME708 | 0.7138 |
| 147 | 4.900 s | VME7108 | 0.7214 |
| 148 | 4.933 s | VME7108 | 0.7593 |
| 150 | 5.000 s | VME70 | 0.7842 |

The exact plate and its one-character omission each occurred four times. Malaysian plate validation accepts `VME7108`. Track association retained both strings in one plate family. The failure was the consensus representative tie-break: it selected `VME708` because that shorter string had the higher average confidence.

The corrected rule prefers the longer observation only when:

- both strings were actually produced by OCR;
- both are valid Malaysian plate shapes;
- the shorter string is a one-character subsequence of the longer string;
- both have equal counts and at least two observations; and
- the longer string's mean confidence is within 0.08 of the shorter string.

This confirms `VME7108` for the measured 4-vs-4 sequence while refusing to promote one isolated longer read. A regression test reproduces the exact counts and confidence totals.

The clip player is one-shot (`video.loop = false`). At end-of-video, the last frame remains available for three seconds and outstanding OCR can drain for up to five seconds. Once committed, a result is retained in the in-memory session list; the former eight-result UI truncation was removed. A metadata-only recent copy of at most 100 results is stored locally so base64 snapshots cannot exhaust browser storage.

## 2. Repeated OCR character errors

Reproducible crops and exact 320×48 OCR inputs are under `reports/ocr-failure-crops/`. Each folder contains the source frame, detector-tight crop, production-padded crop, inner crop, wide padding, CLAHE, sharpened and ±5° variants.

| Labelled plate | Baseline observation | Best tested result | Diagnosis |
|---|---|---|---|
| BNC115 | BNC15 | BNC15 | Detector box covers the plate, but none of the tested preprocessing variants restores the repeated `1`; OCR/character-scale limitation. |
| ANN7569 | AN7569 | ANN7569 at 0.9926 on detector-tight crop | Padding/resampling removes the distinction between adjacent `N` characters. A detector-tight crop is now retained as an independent OCR candidate for single-line plates. Browser acceptance remains required. |
| WYS4460 | WYS460 | WYS460 | Tight, padded and enhanced variants all omit one `4`; OCR/character-scale and severe-angle limitation. |
| WAM1284 | IAM1284 | IAM1284 | Weak detector confidence (0.2791), severe angle and two-line geometry; tested enhancements did not recover `W`. |
| NEA7567 | AEA7567 | AEA7567 | Plate is only about 44×20 detector pixels in the selected failure frame; preprocessing does not recover `N`. The full video does contain one exact read at 3.533 s, showing multi-frame selection can recover this case. |

No expected string was reconstructed from the sample catalogue, and no database candidate is promoted into an OCR vote.

## 3. Human-annotated detector evaluation

`reports/anpr-human-annotations-v1.json` contains 20 manually transcribed labels across all 12 videos. It includes plate box, timestamp/frame, layout, viewing angle, environment, occlusion flags and a source-grouped `VALIDATION` split. This set has already influenced development, so it is explicitly not called a held-out test set.

The benchmark now matches predictions to labels on the exact annotated frame using IoU ≥ 0.50. On this representative subset:

- labels: 20
- detected: 20
- missed: 0
- detector recall: 100% on this subset only
- exact OCR at the exact labelled frame: 4/20
- unique labelled strings read exactly at least once anywhere in their complete source video: 11/19
- detector false positives on five frames marked fully annotated: 3

False positives are counted only on frames explicitly marked fully annotated for detection. Sparse annotation frames are not treated as negative data.

This result does not prove universal detector recall. It says that the detector located every plate in the selected representative frames, while OCR was the dominant measured failure stage. More independently selected frames, especially plates that never receive a box, are required before closing detector recall.

## 4. Multi-plate findings

The labelled subset includes simultaneous independent boxes in Samples 5, 7, 10 and 11. At the selected frames, all annotated plates have separate detector outputs with IoU ≥ 0.50; nearby plates were not removed by NMS. OCR remains isolated per track and the OCR work pool reserves each track before asynchronous inference, preventing one track from launching duplicate work that starves another.

Detection is not being equated with recognition: Sample 10 detects both labelled plates at frames 90 and 150, but the exact-frame OCR results remain incorrect. Sample 11 detects both the close `VME7108` plate and the background `VGA1268`; the complete-video run reads each exactly, but not necessarily on the same annotated frame.

## 5. Throughput and latency

Full-frame CPU offline results across the 12 clips:

- detector median by video: approximately 49–64 ms/frame;
- detector p95 by video: approximately 51–67 ms/frame;
- OCR median per crop by video: approximately 15–102 ms;
- OCR p95 per crop by video: approximately 75–104 ms;
- end-to-end offline throughput: approximately 5–16 processed frames/s.

The slowest clips are the multi-plate and two-line/perspective cases because each detector frame can create multiple OCR crops and split-layout candidates. That identifies OCR candidate fan-out, not YOLO alone, as the main throughput limiter in the current offline measurements.

The browser scanner already records and exports camera FPS, effective detector FPS, detector median/p95, OCR median/p95, queue pressure, track duration and per-stage diagnostics. A compatible in-app browser automation runtime was not available in this execution environment, so no browser number is fabricated here. A real browser run and exported metrics JSON are still required for the requested browser latency deliverable.

## 6. Before/after evidence

| Case | Before | After | Verification |
|---|---|---|---|
| VME consensus | Four `VME708` votes could beat four `VME7108` votes | Equal repeated omission pair resolves to observed `VME7108` | Automated regression test passes |
| Isolated fuller read | Could rank above a more frequent shorter reading | Frequency wins unless both omission forms have equal repeated support | Automated regression test passes |
| ANN crop | Only normal padded candidate was retained | Detector-tight and padded candidates are both retained | Offline crop proves tight input reads `ANN7569`; browser acceptance pending |
| Session list | Only newest eight results remained | All unique confirmed results remain for the active session | Code path verified; browser acceptance pending |
| Sample playback | Risk of end-frame work being cut off | One playback, no loop, three-second hold and up-to-five-second OCR drain | Code path and video settings verified |

The aggregate offline recognition score is not reported as improved because the shipped OCR model has not changed and the modified browser candidate scheduler has not yet been measured in a real browser run.

## 7. Fine-tuning decision

- **YOLO fine-tuning: not yet justified.** The 20-label representative subset has 20/20 recall. Broader annotations are still needed before concluding the detector is sufficient, particularly for missed small/distant plates and complete negative-frame false-positive measurement.
- **OCR fine-tuning: justified for preparation/evaluation, not yet for model replacement.** Four recurrent errors survive all tested crop/enhancement variants, especially repeated adjacent characters, tiny plates and severely angled/two-line plates. Collect labelled original crops for these cases, split by vehicle/video, compare the current PP-OCR model with a fine-tuned candidate on an unchanged held-out set, and replace ONNX only if exact-match and end-to-end recall improve.

## 8. Thirty-video dataset status

All original 12 clips are retained. `reports/anpr-30-video-intake-manifest.json` defines 18 additional source slots, their unresolved scenarios and train/validation/test roles. The 18 actual video files are marked `MISSING_SOURCE`; they were not fabricated or downloaded without provenance. Final test clips are reserved from tuning.

## Remaining acceptance gates

1. Supply or record the 18 additional Malaysian vehicle videos and complete independent annotations.
2. Run the modified scanner in a supported desktop browser, play each sample once, export scanner metrics and verify permanent results.
3. Repeat the 12-video browser run to quantify the tight-crop scheduling change.
4. Train/evaluate an OCR candidate only after enough labelled crops exist; keep the final test vehicle groups untouched.
5. Test a real live camera after, and separately from, offline video validation.
