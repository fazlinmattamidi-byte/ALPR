# One-click startup and stalled OCR repair — September 26, 2026

Mula uses a preparation overlay (`Menyediakan imbasan…` / `Preparing scanner…`). Model initialization and benchmark completion are shared between overlapping callers. Already-ready engines are reused. Recorded video loads paused and waits for decoded pixels; the detector processes the first frame and captures track crops before playback begins and the overlay is dismissed. Live camera preparation also waits for decoded pixels. Cancel invalidates pending startup; a stale detector loop cannot start a newer source.

Selecting a sample or uploading a replacement now uses that same flow. Previously those handlers called play immediately and bypassed the first-frame preparation. The one-click guard stays active until the first detector frame completes. Playback failures clear preparation and stop the scanning state rather than silently continuing.

Two OCR blockers were repaired:

- Three attempts or 2500 ms permanently disabled a track, even with newer clearer crops. Exhausted tracks now accept fresh captured evidence, while repeated/frozen evidence remains bounded. Successful published tracks stop normally.
- Unsuccessful final attempts could mark a track MATCHED and exclude it from scheduling. They now return to collecting. A candidate is not marked committed before publication succeeds.

The first recognizer inference is also guaranteed an attempt even if crop preparation consumes the 800 ms variant budget. Only additional variants are cut off by that budget. The minimum publication confidence remains 90%.

Validation: 204 tests pass, TypeScript passes, and the Webpack production build passes. Tests include decoded-frame readiness, decode error/timeout, shared initialization, benchmark completion/reuse, fresh-evidence retry, frozen-evidence limits, and committed-track suppression.

This validation does not include an interactive browser replay or target-device latency measurement. Frame-zero capture means scanning does not deliberately skip the beginning of a sample; it does not mean inference completes in the first millisecond. The preparation overlay closes after detector/tracker processing, not after a guaranteed successful OCR result.
