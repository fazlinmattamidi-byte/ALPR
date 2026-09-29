/**
 * PlateQ — Crop Quality Assessment Module
 * 
 * Evaluates image crops before passing them to the OCR pipeline:
 * - Blur detection (Laplacian variance)
 * - Brightness evaluation
 * - Contrast & dynamic range
 * - Reflection & glare detection
 * - Motion blur estimation
 * - Sharpness score
 * - Aspect ratio / Perspective score
 */

import { checkCropCompleteness } from './imageProcessor';

export interface CropQualityReport {
  overallScore: number;       // 0.0 to 1.0
  isBlurry: boolean;
  isPartialCrop: boolean;     // True if border clipping or incomplete plate detected
  blurScore: number;          // Laplacian variance
  brightnessScore: number;    // 0.0 to 1.0 (0.5 is ideal)
  contrastScore: number;      // 0.0 to 1.0
  glareScore: number;         // 0.0 (no glare) to 1.0 (heavy glare)
  motionBlurScore: number;    // 0.0 (crisp) to 1.0 (heavy motion blur)
  sharpnessScore: number;     // 0.0 to 1.0
  aspectRatioScore: number;   // 0.0 to 1.0 (plate-like ratio evaluation)
  recommendation: 'PASS' | 'MARGINAL' | 'REJECT';
  reason?: string;
}

/**
 * Fast 3x3 Laplacian variance sharpness calculator (discrete laplacian convolution).
 * Returns image variance score (higher = crisp focus, lower = blurry).
 */
export function computeLaplacianVariance(cropCanvas: HTMLCanvasElement): number {
  const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || cropCanvas.width === 0 || cropCanvas.height === 0) return 0;
  const { width, height } = cropCanvas;
  const imgData = ctx.getImageData(0, 0, width, height);
  const { data } = imgData;
  const totalPixels = width * height;
  const lumaArray = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    lumaArray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  let laplacianSum = 0;
  let laplacianSqSum = 0;
  let sampleCount = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const lap =
        lumaArray[idx - width] +
        lumaArray[idx + width] +
        lumaArray[idx - 1] +
        lumaArray[idx + 1] -
        4 * lumaArray[idx];

      laplacianSum += lap;
      laplacianSqSum += lap * lap;
      sampleCount++;
    }
  }

  const meanLap = laplacianSum / (sampleCount || 1);
  return sampleCount > 0 ? (laplacianSqSum / sampleCount) - (meanLap * meanLap) : 0;
}

/**
 * Analyze an HTMLCanvasElement image crop and return a comprehensive quality assessment.
 */
export function assessCropQuality(cropCanvas: HTMLCanvasElement): CropQualityReport {
  const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || cropCanvas.width === 0 || cropCanvas.height === 0) {
    return {
      overallScore: 0,
      isBlurry: true,
      isPartialCrop: false,
      blurScore: 0,
      brightnessScore: 0,
      contrastScore: 0,
      glareScore: 1,
      motionBlurScore: 1,
      sharpnessScore: 0,
      aspectRatioScore: 0,
      recommendation: 'REJECT',
      reason: 'Invalid canvas dimensions',
    };
  }

  const { width, height } = cropCanvas;
  const imgData = ctx.getImageData(0, 0, width, height);
  const { data } = imgData;
  const totalPixels = width * height;

  // 1. Grayscale luminance array & stats
  let sumLuma = 0;
  let minLuma = 255;
  let maxLuma = 0;
  let blownOutPixels = 0; // Overexposed (glare)
  let brightPixels = 0;
  let darkPixels = 0;
  const lumaArray = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    lumaArray[i] = luma;

    sumLuma += luma;
    if (luma < minLuma) minLuma = luma;
    if (luma > maxLuma) maxLuma = luma;
    if (luma > 245) blownOutPixels++;
    if (luma > 205) brightPixels++;
    if (luma < 40) darkPixels++;
  }

  const avgLuma = sumLuma / totalPixels;

  // Brightness score (0.0 to 1.0, ideal around 128 / 0.5)
  const normalizedLuma = avgLuma / 255.0;
  const brightnessScore = Math.max(0, 1.0 - Math.abs(normalizedLuma - 0.5) * 2);

  // Contrast score
  const contrastScore = Math.min(1.0, (maxLuma - minLuma) / 200.0);

  // Glare score (ratio of blown out pixels)
  const glareRatio = blownOutPixels / totalPixels;
  const brightRatio = brightPixels / totalPixels;
  const darkRatio = darkPixels / totalPixels;
  const likelyWhitePlate = brightRatio > 0.42 && darkRatio > 0.025 && contrastScore > 0.22;
  const glareScore = likelyWhitePlate
    ? Math.min(1.0, Math.max(0, glareRatio - 0.10) * 3.0)
    : Math.min(1.0, glareRatio * 3.5);

  // 2. Laplacian Variance (Blur Detection)
  let laplacianSum = 0;
  let laplacianSqSum = 0;
  let sampleCount = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      // 3x3 Laplacian kernel: [[0, 1, 0], [1, -4, 1], [0, 1, 0]]
      const center = lumaArray[idx];
      const lap =
        lumaArray[idx - width] +
        lumaArray[idx + width] +
        lumaArray[idx - 1] +
        lumaArray[idx + 1] -
        4 * center;

      laplacianSum += lap;
      laplacianSqSum += lap * lap;
      sampleCount++;
    }
  }

  const meanLap = laplacianSum / (sampleCount || 1);
  const blurScore = sampleCount > 0 ? (laplacianSqSum / sampleCount) - (meanLap * meanLap) : 0;
  const isBlurry = blurScore < 80.0; // Threshold for acceptable focus

  // Sharpness score (normalized blurScore up to 500)
  const sharpnessScore = Math.min(1.0, blurScore / 350.0);

  // 3. Motion Blur Estimation (ratio of horizontal vs vertical gradients)
  let dxSum = 0;
  let dySum = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const idx = y * width + x;
      const dx = Math.abs(lumaArray[idx + 1] - lumaArray[idx]);
      const dy = Math.abs(lumaArray[idx + width] - lumaArray[idx]);
      dxSum += dx;
      dySum += dy;
    }
  }
  const gradRatio = dxSum / Math.max(1, dySum);
  // High directional imbalance indicates motion blur
  const motionBlurScore = gradRatio > 2.5 || gradRatio < 0.4 ? 0.7 : 0.1;

  // 4. Aspect Ratio Score
  const aspect = width / Math.max(1, height);
  // Malaysian plates include long single-line, square/two-line rear, motorcycle,
  // commercial, and JPJePlate crops. Only penalize truly implausible geometry.
  let aspectRatioScore = 1.0;
  if (aspect < 0.65 || aspect > 7.2) {
    aspectRatioScore = 0.3;
  } else if (aspect < 0.85 || aspect > 6.3) {
    aspectRatioScore = 0.7;
  }

  // 5. Calculate Overall Score
  // Note: motionBlurScore weight is kept low (0.05) because the best-frame selector
  // already picks the sharpest frame available — we should not double-penalize.
  const overallScore = Math.min(
    1.0,
    Math.max(
      0.0,
      sharpnessScore * 0.40 +
      contrastScore * 0.25 +
      brightnessScore * 0.20 +
      (1.0 - glareScore) * 0.10 +
      aspectRatioScore * 0.05 -
      motionBlurScore * 0.05   // Was 0.15 — handheld frames were over-penalized
    )
  );

  let recommendation: 'PASS' | 'MARGINAL' | 'REJECT' = 'PASS';
  let reason = 'High quality image crop';

  // Blur is evidence for ranking frames, not a reason to discard image
  // evidence. A learned recognizer may still read a moderately degraded crop;
  // a runtime filter cannot reconstruct characters that are not present.
  // Invalid canvases are rejected above, but usable crops remain marginal so
  // the OCR pipeline can try the original pixels.
  if (overallScore < 0.25) {
    recommendation = 'MARGINAL';
    reason = isBlurry ? 'Severe blur; retain as a lower-priority OCR observation' : 'Low image quality score';
  } else if (overallScore < 0.50 || glareScore > 0.6) {
    recommendation = 'MARGINAL';
    reason = glareScore > 0.6 ? 'Glare / reflection detected' : 'Moderate blur or contrast';
  }

  const completeness = checkCropCompleteness(cropCanvas);
  const isPartialCrop = completeness.isPartialCrop;

  if (isPartialCrop && recommendation === 'PASS') {
    recommendation = 'MARGINAL';
    reason = `PARTIAL_CROP: ${completeness.reasons.join(', ')}`;
  }

  return {
    overallScore: Math.round(overallScore * 100) / 100,
    isBlurry,
    isPartialCrop,
    blurScore: Math.round(blurScore * 10) / 10,
    brightnessScore: Math.round(brightnessScore * 100) / 100,
    contrastScore: Math.round(contrastScore * 100) / 100,
    glareScore: Math.round(glareScore * 100) / 100,
    motionBlurScore: Math.round(motionBlurScore * 100) / 100,
    sharpnessScore: Math.round(sharpnessScore * 100) / 100,
    aspectRatioScore: Math.round(aspectRatioScore * 100) / 100,
    recommendation,
    reason,
  };
}
