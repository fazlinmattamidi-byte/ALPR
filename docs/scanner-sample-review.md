# Scanner review — 20 sample clips

Follow-up: see [condition-model recovery fixes](condition-model-recovery.md) for the subsequent classifier integration, preprocessing repairs, and four-model diagnostic.

## Changes

- Runtime readiness now waits for both detector and OCR warm-up. The existing preparation UI remains active during initialization.
- Recorded sources load paused. The scanner captures frame zero before starting playback; the initial 100 ms scheduling delay is removed.
- Full-frame detection runs first. Previously enabling small-plate recovery used only two tiled crops, increasing normal-frame work and potentially cutting large plates at tile boundaries. Tiles now run only when the full-frame pass finds no plate. This favors latency; smaller plates missed alongside an already-detected plate still require further detector work.
- Saved-crop OCR continues on an unchanged/final video frame without counting that frame as a new detector observation. OCR evidence cleanup now agrees with the 2500 ms job deadline.
- Publication requires a valid pattern and at least 90% confidence (or the higher configured threshold), including database matches and final attempts. Restored results use the same gate. One-read commits require 95%; timeouts do not relax thresholds.
- OCR votes stay attached to the exact observed string. Short readings no longer donate votes to longer strings, and length no longer wins crop selection or consensus ranking. Registrations with one or two digits are not rejected for being short.
- Reprocessing a source crop cannot add another independent vote. Unused source frames are prioritized for subsequent OCR attempts.
- Different tracks are deduplicated only by exact plate equality; same-event corrections can update an existing result. Fuzzy string similarity alone no longer replaces another vehicle's result.

## Observation coverage

| Samples | Code change / remaining limit |
| --- | --- |
| 1, 10 | Removed extra-character preference and vote transfer; short registrations accepted. The OCR model can still emit an incorrect high-confidence reading. |
| 2 | Restricted cross-track result merging; old confirmed vehicles remain in the session list. |
| 3, 4, 7, 8 | Strict publication gate and independent-frame evidence reduce noisy early entries. A model score is not calibrated accuracy. |
| 5, 6 | Full-frame-first detection restores complete scene coverage; existing OCR queue prioritizes unread tracks. Distant/slanted plates can still be missed. |
| 9, 15 | Included in offline model evaluation; no new quality claim. |
| 11, 16, 17, 19 | Engine preparation, frame-zero capture, immediate detector scheduling, and final-frame OCR draining. Under-100 ms end-to-end timing is not established. |
| 12, 13 | Reduced normal detector workload and end-of-video draining. Overlay alignment under real motion still needs browser/device validation. |
| 14, 18, 20 | Full-frame detection avoids tile-boundary loss. Darkness, glare, extreme perspective and blur remain model/capture limitations. |

## Verification

- `npm test -- --reporter=dot`: 181 tests across 14 files pass, including publication, extra-digit, source-frame independence and runtime readiness regressions.
- `npx tsc --noEmit`: passes.
- `npx next build --webpack`: passes. Default Turbopack build could not bind its internal port inside this sandbox.
- Targeted ESLint: no errors; existing/unused-code warnings remain.
- Real model diagnostic: `python3 scripts/benchmark_training_videos.py --sample-fps 3 --output reports/scanner-review-benchmark.json`.

The offline diagnostic samples at 3 fps, runs the shipped models in Python, and is not a browser pipeline test. It produced boxes somewhere in all 20 videos. Sample 20 first produced a box at 2.333 seconds; Samples 3 and 8 first produced boxes at 2.0 and 1.333 seconds. Raw OCR remains noisy on difficult clips. No ground-truth annotations were supplied to this run, so recall/accuracy cannot be calculated; zero `recognizedPlates` in the summary is an unpopulated labelled-evaluation count, not zero raw OCR output. See each video's `topRawOcr` field.

Browser playback, multi-car recall, overlay synchronization, and 20–50 km/h capture have not been measured with these changes. Replay the sample set on the intended device before using the road run to evaluate motion performance. Record missed vehicles, incorrect published plates, and detector/OCR P95 from the scanner metrics separately; passing synthetic tests does not establish field readiness.
