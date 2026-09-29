import { BoundingBox } from './tracker';
import { PlateLayout } from '../db/types';

export type PreprocessVariant =
  | 'ORIGINAL'
  | 'GRAYSCALE'
  | 'DEFAULT_CONTRAST'
  | 'INVERTED'
  | 'CLAHE'
  | 'SHARPEN'
  | 'DARK_BG'
  | 'NOISE_REDUCED';

export interface MultiCropResult {
  variant: PreprocessVariant;
  canvas: HTMLCanvasElement;
  qualityScore: number;
  layout: PlateLayout;
  isTwoLine: boolean;
  topLineCanvas?: HTMLCanvasElement;
  bottomLineCanvas?: HTMLCanvasElement;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function releaseCanvasMemory(canvas?: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function getSourceDimensions(sourceCanvas: HTMLCanvasElement | HTMLVideoElement): { width: number; height: number } {
  if (typeof HTMLVideoElement !== 'undefined' && sourceCanvas instanceof HTMLVideoElement) {
    return {
      width: sourceCanvas.videoWidth || sourceCanvas.width || 0,
      height: sourceCanvas.videoHeight || sourceCanvas.height || 0,
    };
  }

  return {
    width: sourceCanvas.width || 0,
    height: sourceCanvas.height || 0,
  };
}

function getAdaptiveCropTargetSize(
  bbox: BoundingBox,
  targetWidth: number,
  targetHeight: number
): { width: number; height: number } {
  const rawAspect = bbox.width / Math.max(1, bbox.height);
  const aspect = Number.isFinite(rawAspect) ? clamp(rawAspect, 0.8, 6.5) : 3.3;

  if (aspect < 2.3) {
    const width = aspect < 1.6 ? 256 : 320;
    return {
      width,
      height: clamp(Math.round(width / aspect), 128, 260),
    };
  }

  return {
    width: targetWidth,
    height: clamp(Math.round(targetWidth / aspect), 56, targetHeight),
  };
}

/**
 * CV Heuristic Candidate Region Detection (Fallback when ONNX model is unavailable).
 */
export function detectPlateCandidatesCV(
  canvas: HTMLCanvasElement,
  minConfidence: number = 0.35,
  maxCandidates: number = 8
): { crop: BoundingBox; confidence: number }[] {
  const W = canvas.width;
  const H = canvas.height;

  if (W === 0 || H === 0) return [];

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  const candidates: BoundingBox[] = [];
  const plateAspectRatios = [4.5, 3.8, 3.2, 2.2, 1.6];
  const scanScales = [0.12, 0.18, 0.25, 0.35, 0.45, 0.55];

  for (const scale of scanScales) {
    const plateW = Math.round(W * scale);

    for (const ar of plateAspectRatios) {
      const plateH = Math.round(plateW / ar);
      if (plateH < 14 || plateW < 50) continue;

      const stepX = Math.max(Math.round(plateW * 0.35), 20);
      const stepY = Math.max(Math.round(plateH * 0.6), 12);

      for (let y = 0; y <= H - plateH; y += stepY) {
        for (let x = 0; x <= W - plateW; x += stepX) {
          const score = scorePlateCandidateRegion(ctx, x, y, plateW, plateH);
          if (score >= minConfidence) {
            candidates.push({
              x,
              y,
              width: plateW,
              height: plateH,
              confidence: score,
            });
          }
        }
      }
    }
  }

  const nmsResult = applyNMS(candidates, 0.30);
  const mergedResult = mergeAdjacentBoxes(nmsResult);
  mergedResult.sort((a, b) => b.confidence - a.confidence);
  return mergedResult.slice(0, 3).map((box) => ({
    crop: box,
    confidence: box.confidence,
  }));
}

/**
 * Merges horizontally aligned and adjacent candidate boxes (e.g. "YA" and "8055" on the same plate).
 */
function mergeAdjacentBoxes(boxes: BoundingBox[]): BoundingBox[] {
  if (boxes.length <= 1) return boxes;
  let result = [...boxes];
  let changed = true;

  while (changed) {
    changed = false;
    const nextList: BoundingBox[] = [];
    const mergedIndices = new Set<number>();

    for (let i = 0; i < result.length; i++) {
      if (mergedIndices.has(i)) continue;
      let cur = { ...result[i] };

      for (let j = i + 1; j < result.length; j++) {
        if (mergedIndices.has(j)) continue;
        const b = result[j];

        // Check vertical overlap (same row/line)
        const yOverlap = Math.max(0, Math.min(cur.y + cur.height, b.y + b.height) - Math.max(cur.y, b.y));
        const minH = Math.min(cur.height, b.height);
        const isVerticallyAligned = minH > 0 && (yOverlap / minH) > 0.4;

        // Check horizontal proximity (gap between boxes)
        const curRight = cur.x + cur.width;
        const bRight = b.x + b.width;
        const gap = Math.max(0, Math.max(cur.x, b.x) - Math.min(curRight, bRight));
        const maxW = Math.max(cur.width, b.width);
        const isHorizontallyClose = gap < maxW * 1.2;

        if (isVerticallyAligned && isHorizontallyClose) {
          const newX = Math.min(cur.x, b.x);
          const newY = Math.min(cur.y, b.y);
          const newW = Math.max(curRight, bRight) - newX;
          const newH = Math.max(cur.y + cur.height, b.y + b.height) - newY;
          
          // Verify aspect ratio of merged box is still realistic for a plate (0.8 to 6.5)
          const mergedAR = newW / Math.max(1, newH);
          if (mergedAR >= 0.8 && mergedAR <= 6.5) {
            cur = {
              x: newX,
              y: newY,
              width: newW,
              height: newH,
              confidence: Math.max(cur.confidence || 0, b.confidence || 0),
            };
            mergedIndices.add(j);
            changed = true;
          }
        }
      }
      mergedIndices.add(i);
      nextList.push(cur);
    }
    result = nextList;
  }

  return result;
}

/**
 * Scores candidate region for plate-like contrast, edge density, and horizontal bias.
 */
function scorePlateCandidateRegion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  const sampleStep = 3;
  const imgData = ctx.getImageData(x, y, w, h);
  const data = imgData.data;
  const totalPx = w * h;

  if (totalPx === 0) return 0;

  const gray: number[] = new Array(totalPx);
  for (let i = 0; i < totalPx; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  let edgeSum = 0;
  let edgeSamples = 0;
  for (let row = 1; row < h - 1; row += sampleStep) {
    for (let col = 1; col < w - 1; col += sampleStep) {
      const tl = gray[(row - 1) * w + (col - 1)];
      const t  = gray[(row - 1) * w + col];
      const tr = gray[(row - 1) * w + (col + 1)];
      const bl = gray[(row + 1) * w + (col - 1)];
      const b  = gray[(row + 1) * w + col];
      const br = gray[(row + 1) * w + (col + 1)];

      const gy = -tl - 2 * t - tr + bl + 2 * b + br;
      edgeSum += Math.abs(gy);
      edgeSamples++;
    }
  }

  const avgEdge = edgeSamples > 0 ? edgeSum / edgeSamples : 0;

  let mean = 0;
  const sampleCount = Math.floor(totalPx / sampleStep);
  for (let i = 0; i < totalPx; i += sampleStep) mean += gray[i];
  mean /= sampleCount;

  let variance = 0;
  for (let i = 0; i < totalPx; i += sampleStep) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  variance /= sampleCount;
  const stdDev = Math.sqrt(variance);

  let hEdge = 0, vEdge = 0;
  for (let row = 1; row < h - 1; row += sampleStep * 2) {
    for (let col = 1; col < w - 1; col += sampleStep * 2) {
      const c  = gray[row * w + col];
      const r  = gray[row * w + (col + 1)];
      const dn = gray[(row + 1) * w + col];
      hEdge += Math.abs(c - r);
      vEdge += Math.abs(c - dn);
    }
  }
  const hRatio = hEdge + vEdge > 0 ? hEdge / (hEdge + vEdge) : 0.5;

  const edgeScore     = Math.min(1.0, avgEdge / 40);
  const contrastScore = Math.min(1.0, stdDev / 80);
  const edgeRatioScore = Math.min(1.0, hRatio / 0.6);

  return Math.min(1.0, edgeScore * 0.45 + contrastScore * 0.35 + edgeRatioScore * 0.20);
}

/**
 * Non-Maximum Suppression
 */
export function applyNMS(boxes: BoundingBox[], iouThreshold: number = 0.4): BoundingBox[] {
  if (boxes.length === 0) return [];

  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const kept: BoundingBox[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(sorted[i]);

    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue;
      const iou = computeBoxIoU(sorted[i], sorted[j]);
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return kept;
}

function computeBoxIoU(a: BoundingBox, b: BoundingBox): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return inter / union;
}

/**
 * Generate 8 adaptive image preprocessing versions for OCR recognition:
 * - Original
 * - Grayscale
 * - Default Contrast (Binarized)
 * - Inverted (White background plates / JPJePlate)
 * - CLAHE (Histogram Contrast Stretch)
 * - Sharpened
 * - Dark Background (Black plate optimization)
 * - Noise Reduced
 */
export function generateAdaptiveCrops(
  sourceCanvas: HTMLCanvasElement | HTMLVideoElement,
  bbox: BoundingBox,
  targetWidth: number = 360,
  targetHeight: number = 108,
  variantsOverride?: PreprocessVariant[]
): MultiCropResult[] {
  const results: MultiCropResult[] = [];

  const ar = bbox.width / (bbox.height || 1);
  const isTwoLine = ar < 2.3;
  const layout: PlateLayout = isTwoLine ? (ar < 1.6 ? 'SQUARE' : 'TWO_LINE') : 'SINGLE_LINE';

  const variants: PreprocessVariant[] = variantsOverride ?? [
    'ORIGINAL',
    'GRAYSCALE',
    'DEFAULT_CONTRAST',
    'INVERTED',
    'CLAHE',
    'SHARPEN',
    'DARK_BG',
    'NOISE_REDUCED',
  ];

  for (const variant of variants) {
    const cropCanvas = document.createElement('canvas');
    const outputSize = getAdaptiveCropTargetSize(bbox, targetWidth, targetHeight);

    // Auto-upscale small plates from distant vehicles
    let scaleFactor = 1.0;
    if (bbox.width < 120 || bbox.height < 35) {
      scaleFactor = 1.6; // Upscale distant small plates
    }

    const scaledW = Math.round(outputSize.width * scaleFactor);
    const scaledH = Math.round(outputSize.height * scaleFactor);

    cropCanvas.width = scaledW;
    cropCanvas.height = scaledH;
    const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) continue;

    const padX = bbox.width * 0.08;
    const padY = bbox.height * 0.12;

    const srcX = Math.max(0, bbox.x - padX);
    const srcY = Math.max(0, bbox.y - padY);
    const srcW = Math.min(
      (sourceCanvas.width || (sourceCanvas as HTMLVideoElement).videoWidth) - srcX,
      bbox.width + padX * 2
    );
    const srcH = Math.min(
      (sourceCanvas.height || (sourceCanvas as HTMLVideoElement).videoHeight) - srcY,
      bbox.height + padY * 2
    );

    ctx.drawImage(sourceCanvas, srcX, srcY, srcW, srcH, 0, 0, scaledW, scaledH);

    // Apply specific preprocessing variant
    preprocessCropVariant(ctx, scaledW, scaledH, variant);

    const quality = calculateCropQualityScore(ctx, scaledW, scaledH);

    let topLineCanvas: HTMLCanvasElement | undefined;
    let bottomLineCanvas: HTMLCanvasElement | undefined;

    if (isTwoLine) {
      const lineCrops = splitTwoLineCrop(cropCanvas);
      topLineCanvas = lineCrops.top;
      bottomLineCanvas = lineCrops.bottom;
    }

    results.push({
      variant,
      canvas: cropCanvas,
      qualityScore: quality,
      layout,
      isTwoLine,
      topLineCanvas,
      bottomLineCanvas,
    });
  }

  results.sort((a, b) => b.qualityScore - a.qualityScore);
  return results;
}

/**
 * Applies specified preprocessing transformation variant to canvas context.
 */
export function preprocessCropVariant(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  variant: PreprocessVariant
): void {
  if (variant === 'ORIGINAL') return;

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  let minL = 255, maxL = 0;

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = gray;
    if (gray < minL) minL = gray;
    if (gray > maxL) maxL = gray;
  }

  const range = maxL - minL || 1;

  if (variant === 'GRAYSCALE') {
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  if (variant === 'DEFAULT_CONTRAST') {
    const threshold = minL + range * 0.48;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i] > threshold ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  } else if (variant === 'INVERTED') {
    // Inverted for White background plates (JPJePlate EV, Taxis) -> turn black text to white for OCR
    const threshold = minL + range * 0.52;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i] < threshold ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  } else if (variant === 'CLAHE') {
    for (let i = 0; i < data.length; i += 4) {
      const norm = Math.round(((data[i] - minL) / range) * 255);
      const v = norm > 128 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  } else if (variant === 'DARK_BG') {
    // Optimized for Standard Black Malaysian License Plates
    const threshold = minL + range * 0.60;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i] > threshold ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  } else if (variant === 'SHARPEN') {
    // Sharpening Kernel Filter
    ctx.putImageData(imgData, 0, 0);
    applySharpenKernel(ctx, width, height);
    return;
  } else if (variant === 'NOISE_REDUCED') {
    // 3x3 Box blur box filter
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        let avg = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            avg += data[((y + dy) * width + (x + dx)) * 4];
          }
        }
        data[idx] = data[idx + 1] = data[idx + 2] = Math.round(avg / 9);
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

function applySharpenKernel(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const imgData = ctx.getImageData(0, 0, width, height);
  const src = new Uint8ClampedArray(imgData.data);
  const dst = imgData.data;

  // Kernel: [[0, -1, 0], [-1, 5, -1], [0, -1, 0]]
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const c = src[idx] * 5;
      const top = src[((y - 1) * width + x) * 4];
      const bot = src[((y + 1) * width + x) * 4];
      const left = src[(y * width + (x - 1)) * 4];
      const right = src[(y * width + (x + 1)) * 4];

      const val = Math.min(255, Math.max(0, c - top - bot - left - right));
      dst[idx] = dst[idx + 1] = dst[idx + 2] = val;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

export function splitTwoLineCrop(
  sourceCanvas: HTMLCanvasElement
): { top: HTMLCanvasElement; bottom: HTMLCanvasElement } {
  const W = sourceCanvas.width;
  const H = sourceCanvas.height;
  const halfH = Math.round(H * 0.52);

  const top = document.createElement('canvas');
  top.width = W;
  top.height = Math.round(H * 0.55);
  const topCtx = top.getContext('2d', { willReadFrequently: true });
  if (topCtx) {
    topCtx.drawImage(sourceCanvas, 0, 0, W, halfH, 0, 0, W, top.height);
  }

  const bottom = document.createElement('canvas');
  bottom.width = W;
  bottom.height = Math.round(H * 0.55);
  const botCtx = bottom.getContext('2d', { willReadFrequently: true });
  if (botCtx) {
    botCtx.drawImage(sourceCanvas, 0, Math.round(H * 0.45), W, Math.round(H * 0.55), 0, 0, W, bottom.height);
  }

  return { top, bottom };
}

export function calculateCropQualityScore(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): number {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const totalPx = width * height;

  let mean = 0;
  for (let i = 0; i < data.length; i += 4) mean += data[i];
  mean /= totalPx;

  let variance = 0;
  for (let i = 0; i < data.length; i += 4) {
    const d = data[i] - mean;
    variance += d * d;
  }
  variance /= totalPx;

  return Math.min(1.0, Math.sqrt(variance) / 128);
}

export function cropCanvasRegion(
  sourceCanvas: HTMLCanvasElement | HTMLVideoElement,
  bbox: BoundingBox,
  targetWidth: number = 360,
  targetHeight: number = 108
): HTMLCanvasElement {
  const crops = generateAdaptiveCrops(sourceCanvas, bbox, targetWidth, targetHeight);
  return crops.length > 0 ? crops[0].canvas : document.createElement('canvas');
}

export function cropCanvasRegionFast(
  sourceCanvas: HTMLCanvasElement | HTMLVideoElement,
  bbox: BoundingBox,
  targetWidth: number = 360,
  targetHeight: number = 108
): HTMLCanvasElement {
  const cropCanvas = document.createElement('canvas');
  const outputSize = getAdaptiveCropTargetSize(bbox, targetWidth, targetHeight);

  let scaleFactor = 1.0;
  if (bbox.width < 120 || bbox.height < 35) {
    scaleFactor = 1.6;
  }

  const scaledW = Math.round(outputSize.width * scaleFactor);
  const scaledH = Math.round(outputSize.height * scaleFactor);
  cropCanvas.width = scaledW;
  cropCanvas.height = scaledH;

  const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return cropCanvas;

  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceCanvas);
  const padX = bbox.width * 0.08;
  const padY = bbox.height * 0.12;
  const srcX = Math.max(0, bbox.x - padX);
  const srcY = Math.max(0, bbox.y - padY);
  const srcW = Math.min(sourceWidth - srcX, bbox.width + padX * 2);
  const srcH = Math.min(sourceHeight - srcY, bbox.height + padY * 2);

  ctx.drawImage(sourceCanvas, srcX, srcY, srcW, srcH, 0, 0, scaledW, scaledH);
  return cropCanvas;
}

export function createInnerPlateTextCrop(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const output = document.createElement('canvas');
  output.width = sourceCanvas.width;
  output.height = sourceCanvas.height;

  const ctx = output.getContext('2d', { willReadFrequently: true });
  if (!ctx || sourceCanvas.width === 0 || sourceCanvas.height === 0) return output;

  const aspect = sourceCanvas.width / Math.max(1, sourceCanvas.height);
  const isTwoLine = aspect < 2.3;
  const marginX = isTwoLine ? 0.04 : 0.06;
  const marginY = isTwoLine ? 0.06 : 0.18;

  const srcX = Math.round(sourceCanvas.width * marginX);
  const srcY = Math.round(sourceCanvas.height * marginY);
  const srcW = Math.max(1, Math.round(sourceCanvas.width * (1 - marginX * 2)));
  const srcH = Math.max(1, Math.round(sourceCanvas.height * (1 - marginY * 2)));

  ctx.drawImage(sourceCanvas, srcX, srcY, srcW, srcH, 0, 0, output.width, output.height);
  return output;
}

export function prioritiseTracks(
  tracks: {
    trackId: string;
    bbox: BoundingBox;
    framesSeen: number;
    ocrState: string;
    lastOcrAttemptAt?: number;
    voteCount?: number;
  }[],
  frameWidth: number,
  frameHeight: number,
  maxOcrSlots: number = 3
): string[] {
  const frameCentreX = frameWidth / 2;
  const frameCentreY = frameHeight / 2;

  const scored = tracks
    .filter(t => t.ocrState !== 'COOLDOWN' && t.ocrState !== 'MATCHED' && !t.ocrState.startsWith('OCR_RUNNING'))
    .map(t => {
      const area = t.bbox.width * t.bbox.height;
      const plateCentreX = t.bbox.x + t.bbox.width / 2;
      const plateCentreY = t.bbox.y + t.bbox.height / 2;
      const distFromCentre = Math.sqrt(
        Math.pow(plateCentreX - frameCentreX, 2) + Math.pow(plateCentreY - frameCentreY, 2)
      );
      const frameArea = frameWidth * frameHeight;
      const distScore = 1 - Math.min(1, distFromCentre / Math.sqrt(frameArea));
      const areaScore = Math.min(1, area / (frameArea * 0.25));
      const stabilityScore = Math.min(1, t.framesSeen / 15);
      const confScore = t.bbox.confidence ?? 0.8;
      const lastAttemptAge = t.lastOcrAttemptAt ? Date.now() - t.lastOcrAttemptAt : 5000;
      const fairnessScore = Math.min(1, lastAttemptAge / 1200);
      const noVoteBoost = (t.voteCount ?? 0) === 0 ? 0.12 : 0;

      const priority =
        areaScore * 0.28 +
        confScore * 0.25 +
        distScore * 0.18 +
        stabilityScore * 0.12 +
        fairnessScore * 0.17 +
        noVoteBoost;
      return { trackId: t.trackId, priority };
    });

  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, maxOcrSlots).map(s => s.trackId);
}
