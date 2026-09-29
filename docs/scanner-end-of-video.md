# Finishing OCR after sample playback ends

Natural video completion now enters an explicit finishing state. The UI displays “Video tamat. Memproses baki bacaan — senarai akan dikemas kini.” The Stop action is labelled “Batal pemprosesan” during this state; natural playback completion does not cancel OCR.

The previous end timer stopped the scanning effect after at most five seconds, discarding later asynchronous results. Normal crop expiry and live-camera crop age limits could also reject final-frame evidence before queued OCR reached it.

Changes:

- Retain buffered crop pixels during a bounded 15-second admission window after playback ends.
- Wait for processing of the final media frame and all active detector/OCR jobs. Reaching the admission deadline stops new work, but does not discard already running results.
- Process unread buffered source frames even if they are older than the most recently attempted crop. Stop repeatedly retrying exhausted frozen evidence.
- Allow the saved single crop from a brief clip into OCR without waiting for another crop that cannot arrive.
- Keep publication confidence rules: at least 90%, with the existing stricter 95% single-read path. A cyan box is only a detection candidate and cannot guarantee an accepted reading.
- Require exact-text temporal votes for publication. BNC115 and BNC1115 no longer confirm one another.
- Remove residual OCR ranking bonuses for longer strings and penalties for valid one/two-digit standard registrations. No hardcoded correction from BNC1115 to BNC115 is made.

Validation: 213 tests pass; TypeScript and Webpack production build pass. Regression tests cover two delayed OCR completions, final-frame admission, expired-crop retention/release, frozen-frame retry limits, exact-text consensus, and insertion-biased candidate ranking. These are automated code tests, not an interactive replay of Samples 2 and 16 or a measured accuracy claim for those clips.

Explicit cancellation or selecting another source still invalidates old work, preventing stale readings from entering the new session.
