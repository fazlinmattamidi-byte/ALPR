# Condition-model recovery fixes

The scanner ships four ONNX models: plate detector, PP-OCR recognizer, environment classifier, and plate-quality classifier. The quality model includes motion blur, focus, glare, exposure and angle classes; the environment model includes day/night plus scene classes. These classifiers select processing strategies. They do not themselves reconstruct missing characters.

## Confirmed integration problems and changes

1. Condition models loaded lazily after scanning began. Runtime preparation now waits for their initialization and warm-up as well as detector/OCR readiness. Their existing diagnostic status and heuristic fallback remain available on model failure.
2. Live-camera first reads were limited to one crop; inner crops also pushed enhancements outside the two-crop cap. Both live and sample sources now reserve a slot for the class-specific correction. Low-power devices put the correction first on retries.
3. Retry attempts repeatedly selected the same variants. The bounded plan now rotates through the class recommendations: left/right/automatic perspective for angles, sharpening/local contrast for blur, and exposure recovery for dark or reflective crops. Originals remain comparison evidence when the two-crop budget permits.
4. The `CLAHE` branch was binary thresholding. It now performs contrast-limited adaptive histogram equalization with interpolated tile maps, retaining grey detail and preserving flat/saturated regions.
5. Exposure recommendations only reached crops after a plate was found. Empty detector passes now get one photometric recovery pass, alternating with spatial tile recovery after continued misses. Coordinates remain those of the captured frame; OCR receives its original pixels.
6. Scene classes such as PARKING could hide night conditions. Brightness/glare measurements now supplement model labels when choosing recovery. A day/parking label does not disable dark-plate recovery.
7. Reprocessing the same frame previously discarded an improved OCR observation. A higher-confidence corrected read can replace that frame's old vote, without becoming another independent temporal vote.
8. Original-crop quality was multiplied into corrected OCR confidence. Quality now selects preprocessing; published confidence remains the recognizer's evidence. The minimum 90% publication gate and 95% single-read gate remain in force.
9. An 85% early-exit rule could end OCR before the correction ran. Difficult crops now require 95% for early exit, subject to the existing bounded inference deadline.

## Earlier classifier-integration verification and scope

- Regression coverage includes model preparation, class-specific routing, dark PARKING scenes, bounded candidate selection, retry rotation, local-contrast pixel output, and independent-frame vote replacement.
- `npm test -- --reporter=dot`: 195 tests pass.
- `npx tsc --noEmit` and `npx next build --webpack`: pass.
- Targeted ESLint on the recovery policy, local contrast implementation, environment classifier and recovery tests: passes.
- `python3 scripts/diagnose_condition_models.py` executes all four shipped ONNX models across all 20 samples at approximately 3 fps. Output: `reports/condition-model-diagnostic.json`.

Final diagnostic: 330 sampled frames; original detection produced boxes in 204 frames. Recovery produced boxes in 43 additional frames across 12 clips (247 frames with candidate boxes in total). Sample 14 gained 9 frames and Sample 20 gained 7. These counts describe detector candidates, not verified plates.

The Python diagnostic uses OpenCV approximations for photometric recovery and is not an exact browser replay. It does not evaluate perspective correction, temporal consensus, device latency, or labelled recognition accuracy. Additional detector boxes can include false positives. Each crop retains raw/enhanced text and confidence for inspection; higher confidence alone is not proof of a correct read.

No model weights were replaced or retrained. These changes connect the existing trained classifiers to usable recovery paths and repair preprocessing. Saturated highlights and severe motion blur can still remove character information; neither classifier labels nor successful unit tests establish perfect recognition at 20–50 km/h.

## Browser scanner follow-up: seven-plate sample

The operator confirmed seven Sample 11 plates from the supplied images:
`MCT8619`, `CFJ6611`, `VEQ8471`, `VNF3296`, `CCC769`, `VGA1268`, `VME7108`.
The final two-line number is **7108**, and the blue car is **CFJ6611**.
`trainingVideos.ts` now lists all seven as evaluation/display labels. Labels are
not supplied to detection, preprocessing, OCR or consensus.

Additional integration fixes:

- Serialize WebGPU inference across **all four models** in the shared ONNX runtime,
  including warm-up and benchmark calls. Normal WebGPU playback reproduced
  `Local ONNX inference failed: Session already started` and zero results while
  a standalone real-frame detector probe succeeded. Per-model locks alone did
  not prevent cross-model collisions. The previous OCR queue was also local to
  each invocation and did not prevent concurrent calls on its own session.
  Direct WASM retains per-model locks without the unnecessary cross-model wait.
- Validate OCR input responsiveness during preparation. The tested GPU OCR
  session produced identical blank probability tensors for distinct inputs,
  despite a successful warm-up. Reject that provider and fall back to WASM
  before releasing playback. No expected plate text is used by this probe.
- Benchmark warmed detector and condition-model inference on available providers, excluding
  queue wait and first shader compilation. Select the faster valid provider
  and release unused sessions; availability alone does not imply speed.
  On macOS, use direct WASM as a compatibility workaround for the observed
  Apple Metal OCR failure. The JSEP loader remained slower even after falling
  back to WASM, so this decision is made before loading the runtime. Other
  supported desktops retain validated GPU/provider selection.
- Hold the initial sample frame in the preparing phase until its first crop
  pass finishes (bounded at 1.5 seconds after crop admission). This avoids
  starting the clip while its first quality/OCR jobs are still competing with
  the next detector frame. Playback thereafter runs at source speed.
- Capture OCR pixels at source resolution from the same snapshot used by the
  detector. Only currently visible tracks receive a new crop; lost tracks keep
  their saved observations. Preserve tight, padded and geometry alternatives.
- Initialize the crop buffer before the first frame (12 bounded crop variants,
  five-second evidence lifetime). Preserve the newest observation, expose all
  retained variants to the drain, and try unread crop IDs after the first three
  attempts. Different variants of one frame still count as one temporal vote.
- Do not discard pending evidence merely because three OCR attempts completed.
  Evict completed/empty tracks before unread passing-vehicle evidence when the
  active-track limit is reached.
- Use image appearance plus consecutive overlapping geometry to retain a
  completed car. Require image consistency when associating an observed plate
  after a gap; duplicate merging cannot bypass that check or combine conflicting
  plate evidence. Merge source-frame evidence without counting it twice. Recent
  one-character fragments are coalesced only within a short capture-time window
  and overlapping saved-frame geometry; unrelated plate cards remain separate.
- Qualified OCR variants remain available for exact-string corroboration.
  Sub-90% observations no longer dilute later qualified reads. A repeated exact
  winner must beat every competing string and account for at least half the
  qualified source frames; tied competing strings remain unresolved.
- Keep the 90% publication floor. A single raw detector-tight crop needs 95%;
  a single padded/corrected observation needs 97%. Conflicting observations
  still require consensus. Published confidence belongs to the selected text.
- For difficult two-line crops, isolate glyph rows and compare bounded image
  scales. Require agreement within each row, without inserting expected digits.
  A row-corroborated read can publish from a single frame when both rows clear
  90% and no qualified competing text blocks consensus. This does not create
  extra temporal votes. Generated textual alternatives remain suggestions, not
  recognized evidence. Short numeric bodies containing narrow 1/7 strokes also compare three bounded
  horizontal resamplings; this recovered BNC115 from pixels without assuming
  that a shorter Malaysian registration must be wrong.

Reproduce the browser check with local Chrome and Python Playwright installed:

```sh
npm run dev
python3 scripts/replay_scanner_browser.py --clips 11 2 20 16 \
  --labels reports/scanner-replay-labels.json --output /tmp/scanner-replay
```

The script clicks Mula once, runs actual playback, waits for pending OCR to
finish, and retains screenshots, candidate logs and exact-label comparison.
`--backend wasm` deliberately checks the CPU fallback; `--backend auto` leaves
browser provider selection intact. These are desktop browser replays, not
validation of a moving camera at 20–50 km/h. Runtime load and sampled frames can
change results; one successful replay is not a reliability guarantee.


### Current browser verification — 26 September 2026

[Machine-readable replay results](../reports/scanner-browser-replay.json) retain
all observed outputs and exact comparisons, including failures. The normal
macOS Chrome path used direct WASM. Source code stayed unchanged during playback.

| Sample | First acceptance-run results | Exact-label result |
| --- | --- | --- |
| 11 | MCT8619, CFJ6611, VEQ8471, VNF3296, VGA1268, VME7108 | **6/7; CCC769 missing; no extra cards** |
| 2 | VNM1212, SWF3587 | Pass, both retained |
| 1 | BNC115 | Pass, no extra card |
| 3 | ANN7569 | Pass, no extra card |
| 20 | JRX9936, VGS3692 | Observed, not a complete labelled accuracy check |
| 16 | WA1420T | Observed from the short clip |
| 10 | BQF902, SYQ9096, VDG5534, WYS4460 | Observed, not a complete labelled accuracy check |

Decoded-frame counters now prevent advancing playback timestamps from counting
the same image twice. The final frame is considered processed when its decoded
image was already admitted, allowing the existing crop queue to finish. In this
run Sample 11 finished its drain about 1.3 seconds after playback ended; Sample 1
still reached the 15-second drain bound, so drain latency is not fully resolved.

CCC769 was detected and its saved crops were attempted, including after playback
ended. The qualified publication threshold was not lowered: repeated C glyphs
were confused with zeros and exact CCC769 observations stayed below 90% in this
run. Direct pixel probes of tight/inner crops, horizontal resampling, contrast,
sharpening, inversion and thresholding did not resolve that sampled frame.
Earlier replays sometimes reached seven correct plates, but that does not establish
reliable seven-plate recall. Difficult blur/glare/angles and road-speed performance
remain unverified; the condition models guide recovery rather than guarantee it.

A repeat of Sample 11, without source changes, returned only MCT8619, VNF3296,
VGA1268 and VME7108: **4/7, no extra cards**. CFJ6611 and VEQ8471 were additional
misses. This confirms that recall still depends on frame timing and track
fragmentation; the first six-plate run must not be presented as reliable recall.
The repeat is included in the report rather than discarded.

Final code checks: 240 tests across 23 files passed; TypeScript passed;
`next build --webpack` passed; focused ESLint checks for the new scheduling,
recovery, appearance, output-validation and crop helpers/tests passed;
`git diff --check` passed. The local development server was restarted on port 3000.
These checks validate code behavior/buildability, not seven-plate recognition accuracy.
