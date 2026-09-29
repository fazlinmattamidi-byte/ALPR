# All 12 sample videos — full-frame baseline

Date: 2026-09-18

Configuration:

- Every source frame processed (30 FPS for 11 clips; 60 FPS for Sample 9)
- Detector threshold: `0.24`
- Detector: `public/models/plate-detector.onnx`
- OCR: `public/models/ppocr-rec.onnx`
- No expected text was supplied to detector or OCR inference

The reference plates below come from the existing sample catalogue and are used only to compare emitted OCR strings. This is a provisional string-occurrence check, not formal accuracy. Formal recall still requires human timestamp and bounding-box annotations from the Video Testing Lab.

| Sample | Frames | Frames with boxes | First box | Reference-only comparison | Raw OCR evidence | Status |
| ---: | ---: | ---: | ---: | --- | --- | --- |
| 1 | 198 | 110 (55.6%) | 0.167s | BNC115 | `BNC15` ×18 | No exact read |
| 2 | 68 | 68 (100%) | 0.000s | VNN1212, SWF3587 | `VN1212` ×2; `SWF3587` ×14 | 1 exact, 1 near-read |
| 3 | 106 | 53 (50.0%) | 1.567s | ANN7569 | `AN7569` ×22 | No exact read; missing N |
| 4 | 125 | 123 (98.4%) | 0.000s | VPM9310, WUY6243 | `VPM9310` ×15; `WUY6243` ×2 | Both exact |
| 5 | 125 | 111 (88.8%) | 0.000s | WTH931, VPX8709 | `WTH931` ×24; `VPX8709` ×5 | Both exact |
| 6 | 204 | 91 (44.6%) | 0.000s | ALC9189, VFT836 | near outputs including `AIC9189…`, `VFT136` | No exact read |
| 7 | 166 | 121 (72.9%) | 0.000s | SJC6080, NEA7567 | `SJC6080` ×8; `AEA7567` ×42 | 1 exact, 1 incorrect |
| 8 | 234 | 84 (35.9%) | 0.467s | WC5855E | fragmented and unrelated outputs | No exact read |
| 9 | 238 | 159 (66.8%) | 0.000s | AMA4588 | `AMA4588` ×43 | Exact read |
| 10 | 219 | 219 (100%) | 0.000s | SYQ9096, WYS4460, BQF902, VDG5534 | `SYQ9096` ×33; near reads `WYS460`, `BOF902`, `VOG534` | 1 exact, 3 incorrect/partial |
| 11 | 151 | 117 (77.5%) | 0.000s | VME7108 | `VME7108` ×4; `VME708` ×4 | Exact read in final-frame window |
| 12 | 125 | 50 (40.0%) | 0.000s | WAM1284 | `IAM1284` ×2; `IM1284` ×2 | No exact read |

Provisional comparison against the catalogue references: 9 exact plate strings out of 20. This must not be presented as final accuracy because labels have not yet been independently verified at representative timestamps and bounding boxes.

## Main observed bottleneck

The detector generated boxes in every clip. Most failures in this run are OCR character omission or confusion, including:

- repeated missing characters: `BNC15`, `AN7569`, `WYS460`;
- leading-letter confusion: `AEA7567`, `IAM1284`;
- character substitution: `BOF902`, `VOG534`;
- distant plate fragmentation in Samples 6 and 8.

This does not prove detector recall is sufficient: only human bounding-box annotations can identify target plates that YOLO never boxed.
