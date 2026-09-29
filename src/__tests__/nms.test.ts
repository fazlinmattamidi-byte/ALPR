import { describe, it, expect } from 'vitest';
import { calculateIoU, DetectedPlateBox } from '../lib/anpr/yoloDetector';
import { verifyPlateStrokeDensity } from '../lib/anpr/imageProcessor';

function applyNMS(boxes: DetectedPlateBox[], iouThreshold: number): DetectedPlateBox[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const selected: DetectedPlateBox[] = [];

  for (const box of sorted) {
    let keep = true;
    for (const sel of selected) {
      if (calculateIoU(box.bbox, sel.bbox) > iouThreshold) {
        keep = false;
        break;
      }
    }
    if (keep) {
      selected.push(box);
    }
  }

  return selected;
}

describe('Non-Maximum Suppression (NMS) Production Test Suite', () => {

  const NMS_THRESHOLD = 0.35;

  it('1. Two duplicate boxes for same plate -> suppresses lower confidence box', () => {
    const boxA: DetectedPlateBox = { bbox: { x: 100, y: 100, width: 200, height: 50 }, confidence: 0.90, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const boxB: DetectedPlateBox = { bbox: { x: 105, y: 102, width: 195, height: 48 }, confidence: 0.75, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const result = applyNMS([boxA, boxB], NMS_THRESHOLD);
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBe(0.90);
  });

  it('2. Three duplicate boxes for same plate -> suppresses down to single highest confidence box', () => {
    const boxA: DetectedPlateBox = { bbox: { x: 100, y: 100, width: 200, height: 50 }, confidence: 0.95, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const boxB: DetectedPlateBox = { bbox: { x: 102, y: 98,  width: 202, height: 52 }, confidence: 0.80, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const boxC: DetectedPlateBox = { bbox: { x: 98,  y: 101, width: 198, height: 49 }, confidence: 0.60, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const result = applyNMS([boxA, boxB, boxC], NMS_THRESHOLD);
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBe(0.95);
  });

  it('3. Nested box inside a larger plate box -> suppresses inner box', () => {
    const outerBox: DetectedPlateBox = { bbox: { x: 100, y: 100, width: 220, height: 60 }, confidence: 0.88, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const innerBox: DetectedPlateBox = { bbox: { x: 120, y: 105, width: 140, height: 48 }, confidence: 0.70, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const iou = calculateIoU(outerBox.bbox, innerBox.bbox);
    expect(iou).toBeGreaterThan(NMS_THRESHOLD);

    const result = applyNMS([outerBox, innerBox], NMS_THRESHOLD);
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBe(0.88);
  });

  it('4. Partial overlap exceeding threshold -> suppresses lower confidence box', () => {
    const boxA: DetectedPlateBox = { bbox: { x: 100, y: 100, width: 200, height: 50 }, confidence: 0.85, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const boxB: DetectedPlateBox = { bbox: { x: 150, y: 100, width: 200, height: 50 }, confidence: 0.65, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const result = applyNMS([boxA, boxB], NMS_THRESHOLD);
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBe(0.85);
  });

  it('5. Two legitimate adjacent physical plates (side-by-side) -> keeps BOTH plates!', () => {
    const plateLeft: DetectedPlateBox  = { bbox: { x: 100, y: 200, width: 180, height: 45 }, confidence: 0.92, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const plateRight: DetectedPlateBox = { bbox: { x: 310, y: 200, width: 180, height: 45 }, confidence: 0.89, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const iou = calculateIoU(plateLeft.bbox, plateRight.bbox);
    expect(iou).toBe(0); // Zero overlap

    const result = applyNMS([plateLeft, plateRight], NMS_THRESHOLD);
    expect(result.length).toBe(2);
  });

  it('6. Two separate physical plates with slight overlap (IoU < 0.35) -> keeps BOTH plates!', () => {
    const carA: DetectedPlateBox = { bbox: { x: 100, y: 200, width: 180, height: 45 }, confidence: 0.91, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const carB: DetectedPlateBox = { bbox: { x: 260, y: 200, width: 180, height: 45 }, confidence: 0.87, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const iou = calculateIoU(carA.bbox, carB.bbox);
    expect(iou).toBeLessThan(NMS_THRESHOLD);

    const result = applyNMS([carA, carB], NMS_THRESHOLD);
    expect(result.length).toBe(2);
  });

  it('7. Low-confidence duplicate below threshold -> preserved or filtered cleanly', () => {
    const highConf: DetectedPlateBox = { bbox: { x: 200, y: 300, width: 160, height: 40 }, confidence: 0.94, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const lowConf: DetectedPlateBox  = { bbox: { x: 202, y: 301, width: 158, height: 39 }, confidence: 0.36, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const result = applyNMS([highConf, lowConf], NMS_THRESHOLD);
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBe(0.94);
  });

  it('8. Edge-of-frame boxes -> correctly calculates IoU and preserves edge plates', () => {
    const edgeBoxA: DetectedPlateBox = { bbox: { x: 0, y: 0, width: 120, height: 35 }, confidence: 0.88, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };
    const edgeBoxB: DetectedPlateBox = { bbox: { x: 2, y: 1, width: 118, height: 34 }, confidence: 0.72, label: 'Plate', sourceEngine: 'LOCAL_ONNX' };

    const result = applyNMS([edgeBoxA, edgeBoxB], NMS_THRESHOLD);
    expect(result.length).toBe(1);
    expect(result[0].bbox.x).toBe(0);
  });
});

describe('plate candidate visual verification', () => {
  function fakeCanvas(
    width: number,
    height: number,
    pixel: (x: number, y: number) => [number, number, number]
  ): HTMLCanvasElement {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const [red, green, blue] = pixel(x, y);
        data[offset] = red;
        data[offset + 1] = green;
        data[offset + 2] = blue;
        data[offset + 3] = 255;
      }
    }

    return {
      width,
      height,
      getContext: () => ({ getImageData: () => ({ data }) }),
    } as unknown as HTMLCanvasElement;
  }

  it('rejects a red tail-lamp crop', () => {
    const canvas = fakeCanvas(80, 28, (x) => (x < 40 ? [210, 24, 30] : [130, 8, 15]));
    expect(verifyPlateStrokeDensity(canvas, { x: 0, y: 0, width: 80, height: 28 })).toBe(false);
  });

  it('rejects smooth bumper trim with only an outer edge', () => {
    const canvas = fakeCanvas(100, 24, (_x, y) => (y < 4 || y >= 20 ? [210, 210, 210] : [65, 65, 65]));
    expect(verifyPlateStrokeDensity(canvas, { x: 0, y: 0, width: 100, height: 24 })).toBe(false);
  });

  it('accepts repeated high-contrast character strokes', () => {
    const canvas = fakeCanvas(100, 28, (x, y) => {
      const characterStroke = x > 8 && x < 92 && y > 4 && y < 24 && x % 11 < 4;
      return characterStroke ? [235, 235, 235] : [18, 18, 18];
    });
    expect(verifyPlateStrokeDensity(canvas, { x: 0, y: 0, width: 100, height: 28 })).toBe(true);
  });
});
