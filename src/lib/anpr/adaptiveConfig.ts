import type { PreprocessVariant } from './imageProcessor';

export const ENVIRONMENT_CLASSES = [
  'BACKLIGHT',
  'DAY',
  'FOG',
  'GLARE',
  'GOOD_CONDITION',
  'HEAVY_RAIN',
  'HIGHWAY',
  'LOW_LIGHT',
  'NIGHT',
  'PARKING',
  'RAIN',
  'TRAFFIC',
  'TUNNEL',
] as const;

export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

export const PLATE_QUALITY_CLASSES = [
  'GOOD',
  'STANDARD_RECTANGLE',
  'SQUARE_PLATE',
  'TWO_LINE_PLATE',
  'EV_WHITE_PLATE',
  'SLIGHT_ROTATION',
  'PERSPECTIVE_DISTORTION',
  'MOTION_BLUR',
  'OUT_OF_FOCUS',
  'TOO_SMALL',
  'LOW_CONTRAST',
  'OVEREXPOSED',
  'UNDEREXPOSED',
  'GLARE_REFLECTION',
  'OCCLUDED',
  'BAD_ANGLE',
] as const;

export type PlateQualityClass = (typeof PLATE_QUALITY_CLASSES)[number];

export type Distribution<T extends string> = Record<T, number>;

export const ENVIRONMENT_CLASSIFIER_ACTION_CONFIDENCE = 0.70;
export const ENVIRONMENT_HEURISTIC_ACTION_CONFIDENCE = 0.58;

export interface EnvironmentProfile {
  label: EnvironmentClass;
  confidence: number;
  source: 'YOLOV8_CLASSIFIER' | 'HEURISTIC';
  sampledAt: number;
  stats?: {
    brightness: number;
    contrast: number;
    glareRatio: number;
    blurScore: number;
    motionScore: number;
    dirtyLensScore: number;
  };
}

export interface AdaptiveScannerConfig {
  environment: EnvironmentProfile;
  detector: {
    targetIntervalMs: number;
    busyIntervalMs: number;
    minDelayMs: number;
    minConfidence: number;
  };
  camera: {
    idealWidth: number;
    idealHeight: number;
    idealFps: number;
    fallbackWidth: number;
    fallbackHeight: number;
  };
  processing: {
    maxLongEdge: number;
    preprocessingVariants: PreprocessVariant[];
    perspectiveRectification: boolean;
  };
  buffer: {
    maxSize: number;
    maxEntryAgeMs: number;
    cropSampleIntervalMultiplier: number;
  };
  ocr: {
    minQuality: number;
    firstReadMinQuality: number;
    repeatReadMinQuality: number;
    minTrackConfidence: number;
    firstReadMinTrackConfidence: number;
    recognitionThreshold: number;
    consensusVotes: number;
    maxConcurrency: number;
    firstReadRetryMs: number;
    repeatReadRetryMs: number;
    requiredBufferedCrops: number;
    maxBestCropAgeMs: number;
    maxCandidateCrops: number;
    useInnerTextCrop: boolean;
  };
  qualityGate: {
    acceptedClasses: PlateQualityClass[];
    marginalClasses: PlateQualityClass[];
    minimumClassifierConfidence: number;
  };
  track: {
    lifetimeMultiplier: number;
    prioritizeHighestConfidence: boolean;
    maxPredictionFrames: number;
    lostTrackTimeoutMs: number;
    unconfirmedTrackTimeoutMs: number;
  };
  datasetFolder: string;
}

export function createEmptyDistribution<T extends string>(classes: readonly T[]): Distribution<T> {
  return classes.reduce((acc, item) => {
    acc[item] = 0;
    return acc;
  }, {} as Distribution<T>);
}

export function incrementDistribution<T extends string>(
  distribution: Distribution<T>,
  label: T,
  amount = 1
): Distribution<T> {
  return {
    ...distribution,
    [label]: (distribution[label] ?? 0) + amount,
  };
}

export function getDistributionPercentages<T extends string>(
  distribution: Distribution<T>
): Record<T, number> {
  const total = (Object.values(distribution) as number[]).reduce((sum, value) => sum + Number(value), 0);
  const result = {} as Record<T, number>;

  (Object.keys(distribution) as T[]).forEach((key) => {
    result[key] = total > 0 ? Math.round(((distribution[key] || 0) / total) * 1000) / 10 : 0;
  });

  return result;
}

export function createDefaultEnvironmentProfile(): EnvironmentProfile {
  return {
    label: 'GOOD_CONDITION',
    confidence: 0,
    source: 'HEURISTIC',
    sampledAt: Date.now(),
  };
}

export function isEnvironmentProfileActionable(environment: EnvironmentProfile): boolean {
  const minimumConfidence =
    environment.source === 'YOLOV8_CLASSIFIER'
      ? ENVIRONMENT_CLASSIFIER_ACTION_CONFIDENCE
      : ENVIRONMENT_HEURISTIC_ACTION_CONFIDENCE;

  return environment.confidence >= minimumConfidence;
}

export function createAdaptiveScannerConfig(
  environment: EnvironmentProfile = createDefaultEnvironmentProfile()
): AdaptiveScannerConfig {
  const base: AdaptiveScannerConfig = {
    environment,
    detector: {
      targetIntervalMs: 75,
      busyIntervalMs: 120,
      minDelayMs: 16,
      minConfidence: 0.35,
    },
    camera: {
      idealWidth: 1920,
      idealHeight: 1080,
      idealFps: 30,
      fallbackWidth: 1280,
      fallbackHeight: 720,
    },
    processing: {
      maxLongEdge: 1280,
      preprocessingVariants: ['ORIGINAL', 'PERSPECTIVE', 'DARK_BG', 'INVERTED', 'CLAHE', 'HIGHLIGHT_REDUCED'],
      perspectiveRectification: true,
    },
    buffer: {
      maxSize: 6,
      maxEntryAgeMs: 2500,
      cropSampleIntervalMultiplier: 1,
    },
    ocr: {
      minQuality: 0.24,
      firstReadMinQuality: 0.26,
      repeatReadMinQuality: 0.22,
      minTrackConfidence: 0.70,
      firstReadMinTrackConfidence: 0.62,
      recognitionThreshold: 0.60,
      consensusVotes: 3,
      maxConcurrency: 3,
      firstReadRetryMs: 90,
      repeatReadRetryMs: 180,
      requiredBufferedCrops: 1,
      maxBestCropAgeMs: 1100,
      maxCandidateCrops: 5,
      useInnerTextCrop: true,
    },
    qualityGate: {
      acceptedClasses: ['GOOD', 'STANDARD_RECTANGLE', 'SQUARE_PLATE', 'TWO_LINE_PLATE', 'EV_WHITE_PLATE', 'SLIGHT_ROTATION'],
      marginalClasses: ['LOW_CONTRAST', 'UNDEREXPOSED', 'OVEREXPOSED', 'GLARE_REFLECTION', 'PERSPECTIVE_DISTORTION', 'BAD_ANGLE'],
      minimumClassifierConfidence: 0.45,
    },
    track: {
      lifetimeMultiplier: 1,
      prioritizeHighestConfidence: false,
      maxPredictionFrames: 2,
      lostTrackTimeoutMs: 900,
      unconfirmedTrackTimeoutMs: 260,
    },
    datasetFolder: `dataset/${environment.label.toLowerCase()}`,
  };

  switch (environment.label) {
    case 'DAY':
    case 'GOOD_CONDITION':
      return base;

    case 'NIGHT':
    case 'LOW_LIGHT':
    case 'TUNNEL':
      return mergeAdaptiveConfig(base, {
        detector: {
          targetIntervalMs: 115,
          busyIntervalMs: 180,
          minConfidence: 0.32,
        },
        processing: {
          preprocessingVariants: ['ORIGINAL', 'PERSPECTIVE', 'CLAHE', 'SHARPEN', 'DARK_BG', 'INVERTED', 'GAMMA_BRIGHTEN'],
        },
        buffer: {
          maxSize: 7,
          maxEntryAgeMs: 3200,
          cropSampleIntervalMultiplier: 0.85,
        },
        ocr: {
          firstReadMinQuality: 0.22,
          repeatReadMinQuality: 0.20,
          minTrackConfidence: 0.68,
          firstReadMinTrackConfidence: 0.58,
          recognitionThreshold: 0.66,
          consensusVotes: 4,
          requiredBufferedCrops: 1,
          maxBestCropAgeMs: 1600,
          maxCandidateCrops: 6,
        },
      });

    case 'RAIN':
    case 'HEAVY_RAIN':
      return mergeAdaptiveConfig(base, {
        detector: {
          targetIntervalMs: environment.label === 'HEAVY_RAIN' ? 135 : 115,
          busyIntervalMs: environment.label === 'HEAVY_RAIN' ? 230 : 185,
          minConfidence: 0.40,
        },
        processing: {
          preprocessingVariants: ['ORIGINAL', 'PERSPECTIVE', 'SHARPEN', 'NOISE_REDUCED', 'CLAHE', 'DARK_BG'],
        },
        buffer: {
          maxSize: 7,
          maxEntryAgeMs: 3400,
          cropSampleIntervalMultiplier: 0.9,
        },
        ocr: {
          minQuality: 0.34,
          firstReadMinQuality: 0.36,
          repeatReadMinQuality: 0.32,
          minTrackConfidence: 0.74,
          firstReadMinTrackConfidence: 0.66,
          recognitionThreshold: 0.68,
          consensusVotes: 4,
          requiredBufferedCrops: 1,
          maxBestCropAgeMs: 1700,
        },
        qualityGate: {
          marginalClasses: ['LOW_CONTRAST', 'UNDEREXPOSED', 'GLARE_REFLECTION', 'PERSPECTIVE_DISTORTION', 'BAD_ANGLE'],
          minimumClassifierConfidence: 0.50,
        },
        track: {
          lifetimeMultiplier: environment.label === 'HEAVY_RAIN' ? 1.8 : 1.45,
          maxPredictionFrames: 2,
          lostTrackTimeoutMs: environment.label === 'HEAVY_RAIN' ? 1200 : 950,
          unconfirmedTrackTimeoutMs: 320,
        },
      });

    case 'FOG':
      return mergeAdaptiveConfig(base, {
        detector: {
          targetIntervalMs: 130,
          busyIntervalMs: 220,
          minConfidence: 0.38,
        },
        processing: {
          preprocessingVariants: ['ORIGINAL', 'PERSPECTIVE', 'CLAHE', 'SHARPEN', 'NOISE_REDUCED'],
        },
        buffer: {
          maxSize: 7,
          maxEntryAgeMs: 3400,
        },
        ocr: {
          minQuality: 0.36,
          firstReadMinQuality: 0.38,
          repeatReadMinQuality: 0.34,
          recognitionThreshold: 0.70,
          consensusVotes: 4,
          requiredBufferedCrops: 1,
          maxCandidateCrops: 6,
        },
        qualityGate: {
          acceptedClasses: ['GOOD', 'STANDARD_RECTANGLE', 'SQUARE_PLATE', 'TWO_LINE_PLATE', 'EV_WHITE_PLATE', 'SLIGHT_ROTATION'],
          marginalClasses: ['PERSPECTIVE_DISTORTION', 'BAD_ANGLE'],
          minimumClassifierConfidence: 0.52,
        },
      });

    case 'GLARE':
    case 'BACKLIGHT':
      return mergeAdaptiveConfig(base, {
        detector: {
          targetIntervalMs: 120,
          busyIntervalMs: 190,
          minConfidence: 0.38,
        },
        processing: {
          preprocessingVariants: ['ORIGINAL', 'PERSPECTIVE', 'HIGHLIGHT_REDUCED', 'CLAHE', 'DARK_BG', 'INVERTED', 'SHARPEN'],
        },
        buffer: {
          maxSize: 8,
          maxEntryAgeMs: 3000,
        },
        ocr: {
          minQuality: 0.32,
          firstReadMinQuality: 0.34,
          repeatReadMinQuality: 0.30,
          recognitionThreshold: 0.68,
          consensusVotes: 4,
          maxCandidateCrops: 6,
        },
        qualityGate: {
          marginalClasses: ['GLARE_REFLECTION', 'LOW_CONTRAST', 'OVEREXPOSED'],
        },
      });

    case 'HIGHWAY':
      return mergeAdaptiveConfig(base, {
        detector: {
          targetIntervalMs: 70,
          busyIntervalMs: 110,
          minConfidence: 0.34,
        },
        processing: {
          maxLongEdge: 960,
          preprocessingVariants: ['ORIGINAL', 'PERSPECTIVE', 'SHARPEN', 'DARK_BG', 'INVERTED'],
        },
        buffer: {
          maxSize: 4,
          maxEntryAgeMs: 2500,
          cropSampleIntervalMultiplier: 0.65,
        },
        ocr: {
          consensusVotes: 2,
          maxConcurrency: 2,
          firstReadRetryMs: 70,
          repeatReadRetryMs: 140,
          requiredBufferedCrops: 1,
          maxBestCropAgeMs: 1200,
          maxCandidateCrops: 3,
          useInnerTextCrop: false,
        },
        track: {
          lifetimeMultiplier: 0.8,
          prioritizeHighestConfidence: true,
          maxPredictionFrames: 1,
          lostTrackTimeoutMs: 420,
          unconfirmedTrackTimeoutMs: 180,
        },
      });

    case 'TRAFFIC':
      return mergeAdaptiveConfig(base, {
        detector: {
          targetIntervalMs: 65,
          busyIntervalMs: 105,
          minConfidence: 0.32,
        },
        buffer: {
          maxSize: 5,
          maxEntryAgeMs: 2600,
          cropSampleIntervalMultiplier: 0.55,
        },
        ocr: {
          firstReadMinQuality: 0.22,
          repeatReadMinQuality: 0.20,
          firstReadMinTrackConfidence: 0.54,
          firstReadRetryMs: 55,
          repeatReadRetryMs: 110,
          requiredBufferedCrops: 1,
          maxBestCropAgeMs: 900,
          maxCandidateCrops: 3,
          useInnerTextCrop: false,
        },
        track: {
          lifetimeMultiplier: 0.7,
          prioritizeHighestConfidence: true,
          maxPredictionFrames: 1,
          lostTrackTimeoutMs: 360,
          unconfirmedTrackTimeoutMs: 160,
        },
      });

    case 'PARKING':
      return mergeAdaptiveConfig(base, {
        detector: {
          targetIntervalMs: environment.label === 'PARKING' ? 140 : 90,
          busyIntervalMs: environment.label === 'PARKING' ? 220 : 145,
        },
        buffer: {
          maxSize: environment.label === 'PARKING' ? 9 : 8,
          maxEntryAgeMs: environment.label === 'PARKING' ? 4500 : 3000,
          cropSampleIntervalMultiplier: environment.label === 'PARKING' ? 1.1 : 0.85,
        },
        ocr: {
          maxConcurrency: 4,
          requiredBufferedCrops: 1,
          maxCandidateCrops: 5,
        },
        track: {
          lifetimeMultiplier: environment.label === 'PARKING' ? 1.15 : 1.35,
          prioritizeHighestConfidence: true,
          maxPredictionFrames: environment.label === 'PARKING' ? 2 : 1,
          lostTrackTimeoutMs: environment.label === 'PARKING' ? 900 : 520,
          unconfirmedTrackTimeoutMs: environment.label === 'PARKING' ? 280 : 180,
        },
      });

    default:
      return base;
  }
}

type DeepPartialAdaptiveConfig = {
  detector?: Partial<AdaptiveScannerConfig['detector']>;
  camera?: Partial<AdaptiveScannerConfig['camera']>;
  processing?: Partial<AdaptiveScannerConfig['processing']>;
  buffer?: Partial<AdaptiveScannerConfig['buffer']>;
  ocr?: Partial<AdaptiveScannerConfig['ocr']>;
  qualityGate?: Partial<AdaptiveScannerConfig['qualityGate']>;
  track?: Partial<AdaptiveScannerConfig['track']>;
};

function mergeAdaptiveConfig(
  base: AdaptiveScannerConfig,
  patch: DeepPartialAdaptiveConfig
): AdaptiveScannerConfig {
  return {
    ...base,
    detector: { ...base.detector, ...patch.detector },
    camera: { ...base.camera, ...patch.camera },
    processing: { ...base.processing, ...patch.processing },
    buffer: { ...base.buffer, ...patch.buffer },
    ocr: { ...base.ocr, ...patch.ocr },
    qualityGate: { ...base.qualityGate, ...patch.qualityGate },
    track: { ...base.track, ...patch.track },
  };
}
