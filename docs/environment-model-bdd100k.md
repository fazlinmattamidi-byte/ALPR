# Environment Intelligence Model - BDD100K Training

This project trains the environment model as a YOLOv8 classification model from BDD100K.

Official sources:

- Dataset website: https://bdd-data.berkeley.edu/
- Toolkit repository: https://github.com/bdd100k/bdd100k
- Label format: https://github.com/ucbdrive/bdd100k/blob/master/doc/format.md

BDD100K frame annotations include:

- `attributes.weather`: `rainy`, `snowy`, `clear`, `overcast`, `partly cloudy`, `foggy`, `undefined`
- `attributes.scene`: `tunnel`, `residential`, `parking lot`, `city street`, `gas stations`, `highway`, `undefined`
- `attributes.timeofday`: `daytime`, `night`, `dawn/dusk`, `undefined`

## Classes

The PlateQ environment classifier uses these classes:

```text
BACKLIGHT
DAY
FOG
GLARE
GOOD_CONDITION
HEAVY_RAIN
HIGHWAY
LOW_LIGHT
NIGHT
PARKING
RAIN
TRAFFIC
TUNNEL
```

The order above is also the fallback ONNX output order used by the browser runtime. Training writes `public/models/environment-classifier.metadata.json`; the browser reads that sidecar so the ONNX output index order stays aligned with the trained model.

## BDD100K Mapping

The converter uses direct labels first, then derived labels:

| PlateQ Class | BDD100K Source |
| --- | --- |
| `TUNNEL` | `scene=tunnel` |
| `FOG` | `weather=foggy` |
| `RAIN` | `weather=rainy` |
| `HEAVY_RAIN` | `weather=rainy` plus low-visibility image statistics |
| `NIGHT` | `timeofday=night` |
| `LOW_LIGHT` | `timeofday=dawn/dusk` |
| `HIGHWAY` | `scene=highway` |
| `PARKING` | `scene=parking lot` |
| `GLARE` | high saturated-pixel ratio derived from image statistics |
| `BACKLIGHT` | glare plus bright upper frame / darker lower frame |
| `TRAFFIC` | road-user object count at or above `--min-traffic-objects` |
| `GOOD_CONDITION` | clear or partly cloudy daytime with normal brightness/contrast/glare |
| `DAY` | remaining daytime driving scenes |

## Prepare Dataset

Download BDD100K manually from the official website and unzip it so the repo can see:

```text
bdd100k/
  images/100k/train/
  images/100k/val/
  labels/det_20/det_train.json
  labels/det_20/det_val.json
```

Then convert it:

```bash
npm run prepare:environment -- \
  --bdd-root /path/to/bdd100k \
  --output datasets/bdd100k-environment-cls \
  --link-mode hardlink
```

Useful options:

```bash
--max-per-class 5000
--min-traffic-objects 8
--link-mode hardlink|symlink|copy
--dry-run
```

`hardlink` avoids duplicating the full image dataset when BDD100K and the output folder are on the same filesystem. It automatically falls back to copy if hardlinking fails.

## Train and Export ONNX

```bash
npm run train:environment -- \
  --data datasets/bdd100k-environment-cls \
  --model yolov8n-cls.pt \
  --epochs 40 \
  --imgsz 224
```

This writes:

```text
public/models/environment-classifier.onnx
public/models/environment-classifier.metadata.json
```

The scanner automatically loads the ONNX model. If the file is missing, it continues with the frame-stat heuristic fallback and shows that status in Developer Mode.

The runtime does not blindly apply every classifier result. YOLOv8 environment predictions must reach the configured classifier action confidence before they change detector cadence, OCR thresholds, crop buffers, or preprocessing variants. Low-confidence predictions are still counted in runtime metrics, but active scanner settings remain on the last trusted environment profile.

## Notes

BDD100K is broad enough for the first environment model, but some classes are derived rather than directly labeled. After field testing, improve `HEAVY_RAIN`, `GLARE`, `BACKLIGHT`, and `TRAFFIC` with PlateQ Dataset Mode exports from real Malaysian repossession-vehicle footage.
