import type { PreprocessVariant } from './imageProcessor';
import { PLATE_QUALITY_CLASSES, PlateQualityClass } from './adaptiveConfig';
import { assessCropQuality, CropQualityReport } from './qualityAssessor';

export type PlateQualityBackend = 'webgpu' | 'wasm' | 'heuristic';
export type PlateQualityResizeMode = 'letterbox' | 'center-crop';
export type PlateQualityLayout = 'NCHW';
export type PlateQualityColorSpace = 'RGB';

export interface PlateQualityMetadata {
  modelType: string;
  task: 'plate-quality-assessment';
  inputWidth: number;
  inputHeight: number;
  layout: PlateQualityLayout;
  colorSpace: PlateQualityColorSpace;
  resizeMode: PlateQualityResizeMode;
  normalization: {
    scale: number;
    mean?: number[];
    std?: number[];
  };
  classes: PlateQualityClass[];
}

export interface PlateQualityMeasurements {
  detectorConfidence: number;
  cropWidth: number;
  cropHeight: number;
  aspectRatio: number;
  sharpnessScore: number;
  contrastScore: number;
  brightnessScore: number;
  clippingPercentage: number;
  darkPixelRatio: number;
  brightPixelRatio: number;
  edgeDensity: number;
  whitePlateLikelihood: number;
  perspectiveScore: number;
  occlusionEstimate: number;
  trackStability: number;
  cropAgeScore: number;
  aspectRatioScore: number;
  motionBlurScore: number;
}

export interface PlateQualityDecision {
  acceptableForOCR: boolean;
  qualityScore: number;
  rejectionReasons: string[];
  selectedPreprocessing: PreprocessVariant[];
  correctable: boolean;
}

export interface PlateQualityScoreInput {
  primaryClass: PlateQualityClass;
  confidence: number;
  probabilities: Record<string, number>;
  measurements: PlateQualityMeasurements;
  minQualityScore: number;
  goodConfidenceThreshold?: number;
  minimumClassifierConfidence?: number;
}

export interface PlateQualityDatasetSchema {
  task: 'plate-quality-assessment';
  classes: readonly PlateQualityClass[];
  modelPath: string;
  metadataPath: string;
}

export const DEFAULT_PLATE_QUALITY_METADATA: PlateQualityMetadata = {
  modelType: 'yolov8-classification',
  task: 'plate-quality-assessment',
  inputWidth: 224,
  inputHeight: 224,
  layout: 'NCHW',
  colorSpace: 'RGB',
  resizeMode: 'letterbox',
  normalization: {
    scale: 1 / 255,
  },
  classes: [...PLATE_QUALITY_CLASSES],
};

const HARD_REJECT_CLASSES = new Set<PlateQualityClass>([]);

const CORRECTABLE_CLASSES = new Set<PlateQualityClass>([
  'LOW_CONTRAST',
  'UNDEREXPOSED',
  'OVEREXPOSED',
  'GLARE_REFLECTION',
  'SLIGHT_ROTATION',
  'PERSPECTIVE_DISTORTION',
  'BAD_ANGLE',
  'MOTION_BLUR',
  'OUT_OF_FOCUS',
  'OCCLUDED',
  'TOO_SMALL',
]);

const READABLE_LAYOUT_CLASSES = new Set<PlateQualityClass>([
  'GOOD',
  'STANDARD_RECTANGLE',
  'SQUARE_PLATE',
  'TWO_LINE_PLATE',
  'EV_WHITE_PLATE',
  'SLIGHT_ROTATION',
]);

export function parsePlateQualityMetadata(value: unknown): PlateQualityMetadata {
  const input = typeof value === 'object' && value !== null ? value as Partial<PlateQualityMetadata> : {};
  const allowedClasses = new Set<string>(PLATE_QUALITY_CLASSES);
  const classes = Array.isArray(input.classes)
    ? input.classes.filter((item): item is PlateQualityClass => typeof item === 'string' && allowedClasses.has(item))
    : [];
  const normalization: Partial<PlateQualityMetadata['normalization']> =
    typeof input.normalization === 'object' && input.normalization !== null
      ? input.normalization
      : {};

  return {
    ...DEFAULT_PLATE_QUALITY_METADATA,
    modelType: typeof input.modelType === 'string' ? input.modelType : DEFAULT_PLATE_QUALITY_METADATA.modelType,
    task: 'plate-quality-assessment',
    inputWidth: clampInteger(input.inputWidth, 32, 1024, DEFAULT_PLATE_QUALITY_METADATA.inputWidth),
    inputHeight: clampInteger(input.inputHeight, 32, 1024, DEFAULT_PLATE_QUALITY_METADATA.inputHeight),
    layout: input.layout === 'NCHW' ? 'NCHW' : DEFAULT_PLATE_QUALITY_METADATA.layout,
    colorSpace: input.colorSpace === 'RGB' ? 'RGB' : DEFAULT_PLATE_QUALITY_METADATA.colorSpace,
    resizeMode: input.resizeMode === 'center-crop' ? 'center-crop' : 'letterbox',
    normalization: {
      scale: typeof normalization.scale === 'number' && Number.isFinite(normalization.scale)
        ? normalization.scale
        : DEFAULT_PLATE_QUALITY_METADATA.normalization.scale,
      mean: sanitizeVector(normalization.mean),
      std: sanitizeVector(normalization.std),
    },
    classes: classes.length > 0 ? classes : [...PLATE_QUALITY_CLASSES],
  };
}

export function createEmptyQualityProbabilities(
  classes: readonly PlateQualityClass[] = PLATE_QUALITY_CLASSES
): Record<string, number> {
  return classes.reduce((acc, className) => {
    acc[className] = 0;
    return acc;
  }, {} as Record<string, number>);
}

export function probabilitiesFromOutput(
  values: ArrayLike<number>,
  classes: readonly PlateQualityClass[]
): Record<string, number> {
  const raw = Array.from(values).slice(0, classes.length);
  const probabilities = createEmptyQualityProbabilities(classes);
  if (raw.length === 0) return probabilities;

  const alreadyProbabilities =
    raw.every((value) => value >= 0 && value <= 1) &&
    Math.abs(raw.reduce((sum, value) => sum + value, 0) - 1) < 0.25;
  const normalized = alreadyProbabilities ? raw : softmax(raw);

  classes.forEach((className, index) => {
    probabilities[className] = roundMetric(normalized[index] ?? 0);
  });
  return probabilities;
}

export function getPrimaryQualityClass(
  probabilities: Record<string, number>,
  classes: readonly PlateQualityClass[] = PLATE_QUALITY_CLASSES
): { primaryClass: PlateQualityClass; confidence: number } {
  let primaryClass = classes[0] ?? 'GOOD';
  let confidence = probabilities[primaryClass] ?? 0;

  classes.forEach((className) => {
    const value = probabilities[className] ?? 0;
    if (value > confidence) {
      primaryClass = className;
      confidence = value;
    }
  });

  return { primaryClass, confidence: roundMetric(confidence) };
}

export function getQualityPreprocessingPlan(primaryClass: PlateQualityClass): PreprocessVariant[] {
  switch (primaryClass) {
    case 'LOW_CONTRAST':
      return ['CLAHE', 'DEFAULT_CONTRAST'];
    case 'UNDEREXPOSED':
      return ['GAMMA_BRIGHTEN', 'CLAHE', 'DARK_BG'];
    case 'OVEREXPOSED':
      return ['HIGHLIGHT_REDUCED', 'GRAYSCALE', 'DEFAULT_CONTRAST'];
    case 'GLARE_REFLECTION':
      return ['HIGHLIGHT_REDUCED', 'GRAYSCALE', 'DEFAULT_CONTRAST', 'INVERTED'];
    case 'EV_WHITE_PLATE':
      return ['INVERTED', 'HIGHLIGHT_REDUCED', 'GRAYSCALE'];
    case 'SLIGHT_ROTATION':
      return ['PERSPECTIVE', 'PERSPECTIVE_LEFT', 'PERSPECTIVE_RIGHT', 'CLAHE'];
    case 'PERSPECTIVE_DISTORTION':
      return ['PERSPECTIVE', 'PERSPECTIVE_LEFT', 'PERSPECTIVE_RIGHT', 'CLAHE'];
    case 'BAD_ANGLE':
      return ['PERSPECTIVE_LEFT', 'PERSPECTIVE_RIGHT', 'PERSPECTIVE', 'CLAHE'];
    case 'MOTION_BLUR':
      return ['SHARPEN', 'CLAHE', 'DEFAULT_CONTRAST'];
    case 'OUT_OF_FOCUS':
      return ['SHARPEN', 'CLAHE', 'DEFAULT_CONTRAST'];
    case 'TOO_SMALL':
      return ['CLAHE', 'DEFAULT_CONTRAST'];
    case 'OCCLUDED':
      return ['CLAHE', 'DEFAULT_CONTRAST', 'DARK_BG'];
    default:
      return [];
  }
}

export function isCorrectableQualityClass(primaryClass: PlateQualityClass): boolean {
  return CORRECTABLE_CLASSES.has(primaryClass) || primaryClass === 'BAD_ANGLE';
}

export function isHardRejectQualityClass(primaryClass: PlateQualityClass): boolean {
  return HARD_REJECT_CLASSES.has(primaryClass);
}

export function createPlateQualityDatasetSchema(): PlateQualityDatasetSchema {
  return {
    task: 'plate-quality-assessment',
    classes: PLATE_QUALITY_CLASSES,
    modelPath: 'public/models/plate-quality-classifier.onnx',
    metadataPath: 'public/models/plate-quality-classifier.metadata.json',
  };
}

export function measurePlateCrop(
  cropCanvas: HTMLCanvasElement,
  options: {
    detectorConfidence?: number;
    perspectiveScore?: number;
    trackStability?: number;
    cropAgeMs?: number;
    maxCropAgeMs?: number;
    heuristicReport?: CropQualityReport;
  } = {}
): { report: CropQualityReport; measurements: PlateQualityMeasurements } {
  const report = options.heuristicReport ?? assessCropQuality(cropCanvas);
  const width = cropCanvas.width || 0;
  const height = cropCanvas.height || 0;
  const pixelStats = computePixelStats(cropCanvas);
  const aspectRatio = width / Math.max(1, height);
  const aspectRatioScore = getAspectRatioScore(aspectRatio);
  const perspectiveScore = clamp01(options.perspectiveScore ?? Math.min(report.aspectRatioScore, aspectRatioScore));
  const maxCropAgeMs = Math.max(250, options.maxCropAgeMs ?? 2500);
  const cropAgeScore = clamp01(1 - Math.max(0, options.cropAgeMs ?? 0) / maxCropAgeMs);
  const detectorConfidence = clamp01(options.detectorConfidence ?? 0.75);
  const trackStability = clamp01(options.trackStability ?? 0.55);
  const occlusionEstimate = clamp01(
    Math.max(0, pixelStats.darkPixelRatio - 0.66) * 1.10 +
    Math.max(0, pixelStats.clippingPercentage - 0.30) * 0.70 +
    Math.max(0, 0.22 - report.contrastScore) * 0.6
  );

  return {
    report,
    measurements: {
      detectorConfidence,
      cropWidth: width,
      cropHeight: height,
      aspectRatio,
      sharpnessScore: clamp01(report.sharpnessScore),
      contrastScore: clamp01(report.contrastScore),
      brightnessScore: clamp01(report.brightnessScore),
      clippingPercentage: pixelStats.clippingPercentage,
      darkPixelRatio: pixelStats.darkPixelRatio,
      brightPixelRatio: pixelStats.brightPixelRatio,
      edgeDensity: pixelStats.edgeDensity,
      whitePlateLikelihood: pixelStats.whitePlateLikelihood,
      perspectiveScore,
      occlusionEstimate,
      trackStability,
      cropAgeScore,
      aspectRatioScore,
      motionBlurScore: clamp01(report.motionBlurScore),
    },
  };
}

export function classifyHeuristicQuality(
  measurements: PlateQualityMeasurements,
  minReadableWidth = 48
): { primaryClass: PlateQualityClass; confidence: number; probabilities: Record<string, number> } {
  let primaryClass: PlateQualityClass = 'GOOD';
  let confidence = 0.76;
  const aspect = measurements.aspectRatio;

  if (measurements.cropWidth < minReadableWidth || measurements.cropHeight < 18) {
    primaryClass = 'TOO_SMALL';
    confidence = 0.92;
  } else if (measurements.occlusionEstimate >= 0.74) {
    primaryClass = 'OCCLUDED';
    confidence = 0.84;
  } else if (measurements.perspectiveScore <= 0.28 || measurements.aspectRatioScore <= 0.18) {
    primaryClass = 'BAD_ANGLE';
    confidence = 0.82;
  } else if (measurements.motionBlurScore >= 0.62) {
    primaryClass = 'MOTION_BLUR';
    confidence = 0.84;
  } else if (measurements.sharpnessScore <= 0.14) {
    primaryClass = 'OUT_OF_FOCUS';
    confidence = 0.88;
  } else if (measurements.perspectiveScore <= 0.52) {
    primaryClass = 'PERSPECTIVE_DISTORTION';
    confidence = 0.78;
  } else if (measurements.aspectRatioScore <= 0.64 && measurements.perspectiveScore > 0.52) {
    primaryClass = 'SLIGHT_ROTATION';
    confidence = 0.74;
  } else if (measurements.clippingPercentage >= 0.22 || measurements.brightnessScore <= 0.24 && measurements.clippingPercentage >= 0.10) {
    primaryClass = 'OVEREXPOSED';
    confidence = 0.82;
  } else if (measurements.darkPixelRatio >= 0.66) {
    primaryClass = 'UNDEREXPOSED';
    confidence = 0.82;
  } else if (measurements.clippingPercentage >= 0.07) {
    primaryClass = 'GLARE_REFLECTION';
    confidence = 0.78;
  } else if (measurements.contrastScore <= 0.18) {
    primaryClass = 'LOW_CONTRAST';
    confidence = 0.80;
  } else if (measurements.whitePlateLikelihood >= 0.58) {
    primaryClass = 'EV_WHITE_PLATE';
    confidence = 0.80;
  } else if (aspect > 0 && aspect <= 1.55) {
    primaryClass = 'SQUARE_PLATE';
    confidence = 0.78;
  } else if (aspect > 0 && aspect < 2.35) {
    primaryClass = 'TWO_LINE_PLATE';
    confidence = 0.78;
  } else if (aspect >= 2.35 && aspect <= 6.2 && measurements.sharpnessScore >= 0.28) {
    primaryClass = 'STANDARD_RECTANGLE';
    confidence = 0.82;
  } else if (measurements.sharpnessScore >= 0.50 && measurements.contrastScore >= 0.28) {
    primaryClass = 'GOOD';
    confidence = 0.88;
  }

  const probabilities = createEmptyQualityProbabilities();
  const remainder = (1 - confidence) / Math.max(1, PLATE_QUALITY_CLASSES.length - 1);
  PLATE_QUALITY_CLASSES.forEach((className) => {
    probabilities[className] = className === primaryClass ? roundMetric(confidence) : roundMetric(remainder);
  });

  return { primaryClass, confidence: roundMetric(confidence), probabilities };
}

export function scorePlateQuality(input: PlateQualityScoreInput): PlateQualityDecision {
  const {
    primaryClass,
    confidence,
    probabilities,
    measurements,
    minQualityScore,
    goodConfidenceThreshold = 0.62,
    minimumClassifierConfidence = 0.45,
  } = input;

  const measurementScore = computeMeasurementScore(measurements);
  const modelScore = computeModelAcceptabilityScore(probabilities);
  const modelIsConfident = confidence >= Math.max(0.70, minimumClassifierConfidence);
  const qualityScore = roundMetric(
    modelIsConfident
      ? modelScore * 0.72 + measurementScore * 0.28
      : modelScore * 0.52 + measurementScore * 0.48
  );
  const rejectionReasons = buildRejectionReasons(primaryClass, confidence, measurements, minQualityScore, qualityScore);
  const correctable = CORRECTABLE_CLASSES.has(primaryClass);
  const unreadableReject = measurements.cropWidth < 18 || measurements.cropHeight < 6;
  const hardReject = HARD_REJECT_CLASSES.has(primaryClass) && confidence >= minimumClassifierConfidence;
  const readableLayout = READABLE_LAYOUT_CLASSES.has(primaryClass);
  const goodAccepted = readableLayout && confidence >= goodConfidenceThreshold;
  // Blur labels influence frame ranking and optional enhancement only. They
  // must not become a proxy for "the OCR model cannot read this".
  const blurClass = primaryClass === 'MOTION_BLUR' || primaryClass === 'OUT_OF_FOCUS';
  const correctableAccepted = correctable &&
    (blurClass || (measurements.sharpnessScore >= 0.08 && measurements.contrastScore >= 0.06));
  const scoreAccepted = (qualityScore >= minQualityScore || correctableAccepted) && !hardReject;
  const acceptableForOCR = (goodAccepted || scoreAccepted) && !unreadableReject;
  const preprocessingPlan = getQualityPreprocessingPlan(primaryClass);

  return {
    acceptableForOCR,
    qualityScore,
    rejectionReasons: acceptableForOCR ? [] : rejectionReasons,
    selectedPreprocessing: acceptableForOCR
      ? (preprocessingPlan.length > 0 ? ['ORIGINAL', ...preprocessingPlan] : ['ORIGINAL'])
      : preprocessingPlan,
    correctable,
  };
}

function computeMeasurementScore(measurements: PlateQualityMeasurements): number {
  const widthScore = clamp01((measurements.cropWidth - 42) / 170);
  const heightScore = clamp01((measurements.cropHeight - 15) / 55);
  const sizeScore = Math.min(widthScore, heightScore);
  const exposurePenalty = Math.max(measurements.clippingPercentage * 1.35, measurements.darkPixelRatio * 0.35);

  return clamp01(
    measurements.detectorConfidence * 0.16 +
    sizeScore * 0.13 +
    measurements.sharpnessScore * 0.20 +
    measurements.contrastScore * 0.13 +
    measurements.brightnessScore * 0.10 +
    measurements.perspectiveScore * 0.07 +
    (1 - measurements.occlusionEstimate) * 0.09 +
    measurements.edgeDensity * 0.03 +
    measurements.trackStability * 0.06 +
    measurements.cropAgeScore * 0.04 -
    exposurePenalty * 0.12
  );
}

function computeModelAcceptabilityScore(probabilities: Record<string, number>): number {
  const good =
    (probabilities.GOOD ?? 0) +
    (probabilities.STANDARD_RECTANGLE ?? 0) +
    (probabilities.SQUARE_PLATE ?? 0) +
    (probabilities.TWO_LINE_PLATE ?? 0) +
    (probabilities.EV_WHITE_PLATE ?? 0) +
    (probabilities.SLIGHT_ROTATION ?? 0);
  const correctable =
    (probabilities.LOW_CONTRAST ?? 0) +
    (probabilities.UNDEREXPOSED ?? 0) +
    (probabilities.OVEREXPOSED ?? 0) +
    (probabilities.GLARE_REFLECTION ?? 0) +
    (probabilities.PERSPECTIVE_DISTORTION ?? 0) +
    (probabilities.BAD_ANGLE ?? 0);
  const hard =
    (probabilities.MOTION_BLUR ?? 0) +
    (probabilities.OUT_OF_FOCUS ?? 0) +
    (probabilities.TOO_SMALL ?? 0) +
    (probabilities.OCCLUDED ?? 0);

  return clamp01(good * 0.86 + correctable * 0.52 + (1 - hard) * 0.16);
}

function buildRejectionReasons(
  primaryClass: PlateQualityClass,
  confidence: number,
  measurements: PlateQualityMeasurements,
  minQualityScore: number,
  qualityScore: number
): string[] {
  const reasons = new Set<string>();
  reasons.add(primaryClass);
  if (CORRECTABLE_CLASSES.has(primaryClass)) reasons.add(`CORRECTABLE_${primaryClass}`);
  if (qualityScore < minQualityScore) reasons.add('QUALITY_SCORE_BELOW_THRESHOLD');
  if (confidence < 0.35) reasons.add('LOW_CLASSIFIER_CONFIDENCE');
  if (measurements.cropWidth < 48 || measurements.cropHeight < 18) reasons.add('CROP_TOO_SMALL');
  if (measurements.sharpnessScore < 0.18) reasons.add('LOW_SHARPNESS');
  if (measurements.contrastScore < 0.18) reasons.add('LOW_CONTRAST');
  if (measurements.clippingPercentage > 0.16) reasons.add('HIGHLIGHT_CLIPPING');
  if (measurements.darkPixelRatio > 0.66) reasons.add('UNDEREXPOSED_CROP');
  if (measurements.perspectiveScore < 0.36) reasons.add('BAD_PERSPECTIVE');
  if (measurements.occlusionEstimate > 0.65) reasons.add('POSSIBLE_OCCLUSION');
  return Array.from(reasons);
}

function computePixelStats(canvas: HTMLCanvasElement): {
  clippingPercentage: number;
  darkPixelRatio: number;
  brightPixelRatio: number;
  edgeDensity: number;
  whitePlateLikelihood: number;
} {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    return {
      clippingPercentage: 1,
      darkPixelRatio: 1,
      brightPixelRatio: 0,
      edgeDensity: 0,
      whitePlateLikelihood: 0,
    };
  }

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  const total = Math.max(1, canvas.width * canvas.height);
  let clipped = 0;
  let dark = 0;
  let bright = 0;
  let edgeSamples = 0;
  let strongEdges = 0;

  const luma = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const offset = i * 4;
    luma[i] = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    if (luma[i] >= 245) clipped++;
    if (luma[i] <= 32) dark++;
    if (luma[i] >= 205) bright++;
  }

  const step = Math.max(1, Math.floor(Math.max(canvas.width, canvas.height) / 120));
  for (let y = step; y < canvas.height - step; y += step) {
    for (let x = step; x < canvas.width - step; x += step) {
      const idx = y * canvas.width + x;
      const gx = Math.abs(luma[idx + step] - luma[idx - step]);
      const gy = Math.abs(luma[idx + canvas.width * step] - luma[idx - canvas.width * step]);
      if (gx + gy > 42) strongEdges++;
      edgeSamples++;
    }
  }

  const clippingPercentage = roundMetric(clipped / total);
  const darkPixelRatio = roundMetric(dark / total);
  const brightPixelRatio = roundMetric(bright / total);
  const edgeDensity = roundMetric(strongEdges / Math.max(1, edgeSamples));
  const whitePlateLikelihood = roundMetric(
    brightPixelRatio * 0.68 +
    Math.min(0.25, darkPixelRatio * 0.9) +
    Math.min(0.20, edgeDensity * 0.6)
  );

  return {
    clippingPercentage,
    darkPixelRatio,
    brightPixelRatio,
    edgeDensity,
    whitePlateLikelihood,
  };
}

function getAspectRatioScore(aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return 0;
  if (aspectRatio >= 0.85 && aspectRatio <= 5.8) return 1;
  if (aspectRatio >= 0.65 && aspectRatio <= 7.2) return 0.72;
  return 0.28;
}

function sanitizeVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const vector = value
    .slice(0, 3)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  return vector.length === 3 ? vector : undefined;
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
  return exps.map((value) => value / sum);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function roundMetric(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}
