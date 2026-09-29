import { ActiveTrack } from './tracker';
import { validateMalaysianPattern } from './patterns';

export type MalaysianPlateColourProfile =
  | 'DARK_BACKGROUND_LIGHT_TEXT'
  | 'LIGHT_BACKGROUND_DARK_TEXT'
  | 'LIGHT_BACKGROUND_DARK_TEXT_GREEN_EV_CUE'
  | 'SPECIAL_SUPPORTED_PROFILE'
  | 'BLUE_BACKGROUND_LIGHT_TEXT'
  | 'GREEN_BACKGROUND_LIGHT_TEXT'
  | 'HIGH_SATURATION_SIGN'
  | 'UNKNOWN_COLOUR_PROFILE';

export type CandidateDecisionState =
  | 'STRONG_CANDIDATE'
  | 'UNCERTAIN_CANDIDATE'
  | 'OBVIOUS_NON_PLATE';

export type PlateConfirmationState =
  | 'PLATE_CANDIDATE'
  | 'CONFIRMED_PLATE'
  | 'REJECTED_NON_PLATE'
  | 'UNRESOLVED_EXPIRED';

export interface MalaysianVisualCandidateReport {
  colourProfile: MalaysianPlateColourProfile;
  colourEvidenceScore: number;
  geometryEvidenceScore: number;
  strokeEvidenceScore: number;
  cropQualityScore: number;
  signEvidencePenalty: number;
  malaysiaVisualCandidateScore: number;
  decision: CandidateDecisionState;
  rejectionReason?: string;
  details: {
    aspectRatio: number;
    relativeArea: number;
    medianLuminance: number;
    foregroundContrast: number;
    meanSaturation: number;
    estimatedStrokeCount: number;
    isDegraded: boolean;
  };
}

export interface MalaysianConfirmationContextOptions {
  sourceDimensions?: { width: number; height: number };
  isMobileCamera?: boolean;
  cameraMovementMode?: 'STATIONARY' | 'MOVING' | 'UNKNOWN';
  cameraId?: string;
}

export interface MalaysianConfirmationContextDetails {
  normalizedX: number;
  normalizedY: number;
  scaleEvolutionRatio: number;
  totalDisplacement: number;
  motionScore: number;
  staticSignEvidenceScore: number;
  scaleApproachEvidenceScore: number;
  overheadSignEvidenceScore: number;
  staticEvidenceLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  signEvidenceLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  motionLabel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  scaleLabel: 'NONE' | 'INCREASING' | 'DECREASING' | 'STEADY';
  positionLabel: 'LOWER' | 'CENTER' | 'UPPER' | 'OVERHEAD';
}

export interface MalaysianFinalConfirmationReport {
  confirmationState: PlateConfirmationState;
  finalMalaysiaPlateScore: number;
  isPatternValid: boolean;
  patternCategory?: string;
  ocrConfidence: number;
  temporalVoteCount: number;
  decision: 'CONFIRMED_PLATE' | 'PLATE_CANDIDATE' | 'REJECTED_NON_PLATE';
  rejectionReason?: string;
  contextDetails: MalaysianConfirmationContextDetails;
}

/**
 * Converts RGB to HSV colour space.
 */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, v };
}

/**
 * Classifies the crop into a tolerant Malaysian plate colour profile.
 * Tolerates illumination variations, night, glare, and reflections.
 */
export function classifyMalaysianColourProfile(
  canvas: HTMLCanvasElement,
  options: { isNight?: boolean; isGlare?: boolean } = {}
): {
  profile: MalaysianPlateColourProfile;
  evidenceScore: number;
  signPenalty: number;
  medianLuminance: number;
  contrast: number;
  meanSaturation: number;
  dominantHue: number;
  hasGreenEvBadge: boolean;
} {
  const width = canvas.width;
  const height = canvas.height;
  if (width < 8 || height < 4) {
    return {
      profile: 'UNKNOWN_COLOUR_PROFILE',
      evidenceScore: 0.10,
      signPenalty: 0,
      medianLuminance: 128,
      contrast: 0,
      meanSaturation: 0,
      dominantHue: 0,
      hasGreenEvBadge: false,
    };
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return {
      profile: 'UNKNOWN_COLOUR_PROFILE',
      evidenceScore: 0.10,
      signPenalty: 0,
      medianLuminance: 128,
      contrast: 0,
      meanSaturation: 0,
      dominantHue: 0,
      hasGreenEvBadge: false,
    };
  }

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    return {
      profile: 'UNKNOWN_COLOUR_PROFILE',
      evidenceScore: 0.10,
      signPenalty: 0,
      medianLuminance: 128,
      contrast: 0,
      meanSaturation: 0,
      dominantHue: 0,
      hasGreenEvBadge: false,
    };
  }

  const data = imageData.data;
  const luminances: number[] = [];
  let satSum = 0;
  let satCount = 0;
  let bluePixels = 0;
  let greenPixels = 0;
  let highSatPixels = 0;
  let leftGreenPixels = 0;
  let leftTotalPixels = 0;

  // Sample inner 80% to avoid car body/bumper paint edge bleed
  const startX = Math.floor(width * 0.10);
  const endX = Math.ceil(width * 0.90);
  const startY = Math.floor(height * 0.10);
  const endY = Math.ceil(height * 0.90);
  const leftBadgeEndX = Math.floor(width * 0.28); // Left ~28% region for EV green badge

  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 400)));

  for (let y = startY; y < endY; y += step) {
    for (let x = startX; x < endX; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      luminances.push(lum);

      const { h, s } = rgbToHsv(r, g, b);
      satSum += s;
      satCount++;

      // Only count vivid sign pixels if channel intensity is sufficient (avoid dark reflection miscounts)
      const maxChannel = Math.max(r, g, b);
      if (s > 0.30 && maxChannel >= 85) {
        highSatPixels++;
        if (h >= 180 && h <= 255 && b >= 95 && b > r + 20) {
          bluePixels++;
        } else if (h >= 75 && h <= 165 && g >= 85 && g > r + 15) {
          greenPixels++;
        }
      }

      if (x <= leftBadgeEndX) {
        leftTotalPixels++;
        if (s > 0.25 && h >= 75 && h <= 165 && lum > 30) {
          leftGreenPixels++;
        }
      }
    }
  }

  if (luminances.length === 0) {
    return {
      profile: 'UNKNOWN_COLOUR_PROFILE',
      evidenceScore: 0.10,
      signPenalty: 0,
      medianLuminance: 128,
      contrast: 0,
      meanSaturation: 0,
      dominantHue: 0,
      hasGreenEvBadge: false,
    };
  }

  luminances.sort((a, b) => a - b);
  const medianLum = luminances[Math.floor(luminances.length * 0.5)];
  const p10Lum = luminances[Math.floor(luminances.length * 0.1)];
  const p90Lum = luminances[Math.floor(luminances.length * 0.9)];
  const contrast = p90Lum - p10Lum;
  const meanSat = satCount > 0 ? satSum / satCount : 0;
  const blueFraction = satCount > 0 ? bluePixels / satCount : 0;
  const greenFraction = satCount > 0 ? greenPixels / satCount : 0;
  const highSatFraction = satCount > 0 ? highSatPixels / satCount : 0;
  const leftGreenRatio = leftTotalPixels > 0 ? leftGreenPixels / leftTotalPixels : 0;
  // An EV plate has a green badge on the left (~20%), but the rest of the plate is white.
  // A highway sign is green across the entire board (greenFraction >= 0.30).
  const isEvPlateGreenBadge = leftGreenRatio >= 0.20 && greenFraction < 0.25 && medianLum >= 105;

  // Degraded / Low-light condition protection
  if (options.isNight || (options.isGlare && p90Lum > 245 && contrast < 20)) {
    return {
      profile: 'UNKNOWN_COLOUR_PROFILE',
      evidenceScore: 0.12,
      signPenalty: 0,
      medianLuminance: medianLum,
      contrast,
      meanSaturation: meanSat,
      dominantHue: 0,
      hasGreenEvBadge: isEvPlateGreenBadge,
    };
  }

  // Malaysian EV / JPJePlate (White background with green EV identifier cue on left only)
  if (isEvPlateGreenBadge) {
    return {
      profile: 'LIGHT_BACKGROUND_DARK_TEXT_GREEN_EV_CUE',
      evidenceScore: 0.35,
      signPenalty: 0,
      medianLuminance: medianLum,
      contrast,
      meanSaturation: meanSat,
      dominantHue: 120,
      hasGreenEvBadge: true,
    };
  }

  // Obvious blue highway sign (distinct blue background with blueFraction >= 25%)
  if (blueFraction >= 0.25) {
    return {
      profile: 'BLUE_BACKGROUND_LIGHT_TEXT',
      evidenceScore: -0.40,
      signPenalty: 0.50,
      medianLuminance: medianLum,
      contrast,
      meanSaturation: meanSat,
      dominantHue: 215,
      hasGreenEvBadge: false,
    };
  }

  // Obvious green destination / road sign (broad green background with greenFraction >= 25%)
  if (greenFraction >= 0.25) {
    return {
      profile: 'GREEN_BACKGROUND_LIGHT_TEXT',
      evidenceScore: -0.35,
      signPenalty: 0.45,
      medianLuminance: medianLum,
      contrast,
      meanSaturation: meanSat,
      dominantHue: 120,
      hasGreenEvBadge: false,
    };
  }

  // Colorful billboard / advertisement (high saturation across the crop)
  if (highSatFraction >= 0.45 && meanSat >= 0.40) {
    return {
      profile: 'HIGH_SATURATION_SIGN',
      evidenceScore: -0.30,
      signPenalty: 0.40,
      medianLuminance: medianLum,
      contrast,
      meanSaturation: meanSat,
      dominantHue: 0,
      hasGreenEvBadge: false,
    };
  }

  // Standard Malaysian Plate: Dark background, light characters (tolerates ambient hue shifts)
  if (medianLum <= 120 && contrast >= 15) {
    return {
      profile: 'DARK_BACKGROUND_LIGHT_TEXT',
      evidenceScore: 0.30,
      signPenalty: 0,
      medianLuminance: medianLum,
      contrast,
      meanSaturation: meanSat,
      dominantHue: 0,
      hasGreenEvBadge: false,
    };
  }

  // Legitimate Light-Background Plate: White/light background, dark characters
  if (medianLum >= 125 && contrast >= 15 && meanSat <= 0.35) {
    return {
      profile: 'LIGHT_BACKGROUND_DARK_TEXT',
      evidenceScore: 0.25,
      signPenalty: 0,
      medianLuminance: medianLum,
      contrast,
      meanSaturation: meanSat,
      dominantHue: 0,
      hasGreenEvBadge: false,
    };
  }

  // Unknown / neutral profile (does not penalize)
  return {
    profile: 'UNKNOWN_COLOUR_PROFILE',
    evidenceScore: 0.10,
    signPenalty: 0,
    medianLuminance: medianLum,
    contrast,
    meanSaturation: meanSat,
    dominantHue: 0,
    hasGreenEvBadge: isEvPlateGreenBadge,
  };
}

/**
 * Validates aspect ratio and frame-relative dimensions against Malaysian plate formats.
 */
export function evaluatePlateGeometry(
  bbox: { width: number; height: number },
  sourceDimensions?: { width: number; height: number }
): {
  geometryScore: number;
  isTwoLineAspect: boolean;
  aspectRatio: number;
  relativeArea: number;
  isExtremeAspect: boolean;
  isMassiveBoard: boolean;
} {
  const width = Math.max(1, bbox.width);
  const height = Math.max(1, bbox.height);
  const aspectRatio = width / height;

  const srcW = sourceDimensions?.width || 1280;
  const srcH = sourceDimensions?.height || 720;
  const relativeArea = (width * height) / (srcW * srcH);

  const isStandardSingleLine = aspectRatio >= 2.4 && aspectRatio <= 5.8;
  const isTwoLineAspect = aspectRatio >= 1.05 && aspectRatio < 2.4;
  const isExtremeAspect = aspectRatio > 6.5 || aspectRatio < 0.80;
  const isMassiveBoard = relativeArea > 0.40;

  let geometryScore = 0.10;
  if (isStandardSingleLine) {
    geometryScore = 0.25;
  } else if (isTwoLineAspect) {
    geometryScore = 0.25;
  } else if (isExtremeAspect) {
    geometryScore = -0.35;
  } else if (aspectRatio >= 5.8 && aspectRatio <= 6.5) {
    geometryScore = 0.05;
  }

  if (isMassiveBoard) {
    geometryScore -= 0.30;
  }

  return {
    geometryScore,
    isTwoLineAspect,
    aspectRatio,
    relativeArea,
    isExtremeAspect,
    isMassiveBoard,
  };
}

/**
 * Evaluates stroke transition frequency and vertical character height span cheaply.
 */
export function evaluateCharacterStrokeStructure(
  canvas: HTMLCanvasElement,
  medianLum: number
): {
  strokeScore: number;
  estimatedStrokeCount: number;
  verticalSpanRatio: number;
  isMultiRowSign: boolean;
} {
  const width = canvas.width;
  const height = canvas.height;
  if (width < 16 || height < 8) {
    return { strokeScore: 0.10, estimatedStrokeCount: 0, verticalSpanRatio: 0.6, isMultiRowSign: false };
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { strokeScore: 0.10, estimatedStrokeCount: 0, verticalSpanRatio: 0.6, isMultiRowSign: false };
  }

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    return { strokeScore: 0.10, estimatedStrokeCount: 0, verticalSpanRatio: 0.6, isMultiRowSign: false };
  }

  const data = imageData.data;
  const yLines = [
    Math.floor(height * 0.35),
    Math.floor(height * 0.50),
    Math.floor(height * 0.65),
  ];

  let totalTransitions = 0;
  for (const y of yLines) {
    let transitions = 0;
    let lastState = false;
    const startX = Math.floor(width * 0.08);
    const endX = Math.ceil(width * 0.92);

    for (let x = startX; x < endX; x++) {
      const idx = (y * width + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const isAbove = lum > medianLum;
      if (x > startX && isAbove !== lastState) {
        transitions++;
      }
      lastState = isAbove;
    }
    totalTransitions += transitions;
  }

  const avgTransitions = totalTransitions / yLines.length;

  // Measure vertical span of strokes
  let topY = height;
  let bottomY = 0;
  const sampleXRange = [
    Math.floor(width * 0.3),
    Math.floor(width * 0.5),
    Math.floor(width * 0.7),
  ];

  for (const x of sampleXRange) {
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (Math.abs(lum - medianLum) > 25) {
        if (y < topY) topY = y;
        if (y > bottomY) bottomY = y;
      }
    }
  }

  const verticalSpan = Math.max(0, bottomY - topY);
  const verticalSpanRatio = height > 0 ? verticalSpan / height : 0.6;
  const isMultiRowSign = avgTransitions > 26;

  let strokeScore = 0.10;
  if (avgTransitions >= 5 && avgTransitions <= 20 && verticalSpanRatio >= 0.35) {
    strokeScore = 0.25;
  } else if (avgTransitions > 24) {
    strokeScore = -0.30;
  } else if (avgTransitions < 3) {
    strokeScore = -0.15;
  }

  return {
    strokeScore,
    estimatedStrokeCount: Math.round(avgTransitions / 2),
    verticalSpanRatio,
    isMultiRowSign,
  };
}

/**
 * Evaluates candidate pre-OCR visual validity for Malaysian plates.
 */
export function evaluateMalaysianPlateVisualCandidate(
  cropCanvas: HTMLCanvasElement,
  bbox: { width: number; height: number; confidence: number },
  sourceDimensions?: { width: number; height: number },
  options: { isNight?: boolean; isGlare?: boolean; isBlur?: boolean; isSlanted?: boolean } = {}
): MalaysianVisualCandidateReport {
  const colourReport = classifyMalaysianColourProfile(cropCanvas, options);
  const geomReport = evaluatePlateGeometry(bbox, sourceDimensions);
  const strokeReport = evaluateCharacterStrokeStructure(cropCanvas, colourReport.medianLuminance);

  const yoloConfidence = bbox.confidence ?? 0.5;
  const yoloScore = yoloConfidence * 0.25;

  const isDegraded = Boolean(options.isNight || options.isGlare || options.isBlur || options.isSlanted);
  const cropQualityScore = isDegraded ? 0.05 : 0.10;

  const totalScore =
    yoloScore +
    colourReport.evidenceScore +
    geomReport.geometryScore +
    strokeReport.strokeScore +
    cropQualityScore -
    colourReport.signPenalty;

  const isSignColour =
    colourReport.profile === 'BLUE_BACKGROUND_LIGHT_TEXT' ||
    colourReport.profile === 'GREEN_BACKGROUND_LIGHT_TEXT' ||
    colourReport.profile === 'HIGH_SATURATION_SIGN';

  const hasStrongPlateGeometry =
    geomReport.aspectRatio >= 1.05 && geomReport.aspectRatio <= 5.8 && !geomReport.isMassiveBoard;
  const hasRegistrationStrokeCount =
    strokeReport.estimatedStrokeCount >= 2 && strokeReport.estimatedStrokeCount <= 12 && !strokeReport.isMultiRowSign;
  const hasValidPlateColour = !isSignColour;

  const hasStrongPlateEvidence =
    hasValidPlateColour &&
    ((hasStrongPlateGeometry && hasRegistrationStrokeCount) ||
      (yoloConfidence >= 0.70 && hasStrongPlateGeometry && !strokeReport.isMultiRowSign));

  const isObviousNonPlateVisual =
    isSignColour ||
    geomReport.isExtremeAspect ||
    geomReport.isMassiveBoard ||
    strokeReport.isMultiRowSign ||
    totalScore < 0.12;

  let decision: CandidateDecisionState = 'UNCERTAIN_CANDIDATE';
  let rejectionReason: string | undefined;

  if (isDegraded) {
    // When degraded (night, glare, blur, slanted), never early reject unless there is
    // overwhelming multi-signal proof of a massive highway sign.
    const isDefinitiveHighwayGantry =
      isSignColour && geomReport.isMassiveBoard && strokeReport.isMultiRowSign;

    if (isDefinitiveHighwayGantry) {
      decision = 'OBVIOUS_NON_PLATE';
      rejectionReason = `Definitive highway sign under degraded condition (${colourReport.profile})`;
    } else {
      decision = totalScore >= 0.45 ? 'STRONG_CANDIDATE' : 'UNCERTAIN_CANDIDATE';
    }
  } else {
    // Normal lighting: reject obvious non-plates when not protected by strong genuine plate evidence
    if (isObviousNonPlateVisual && !hasStrongPlateEvidence) {
      decision = 'OBVIOUS_NON_PLATE';
      rejectionReason = isSignColour
        ? `Strong non-plate visual evidence (${colourReport.profile})`
        : 'Non-plate geometry and visual structure';
    } else if (
      totalScore >= 0.45 ||
      (yoloConfidence >= 0.65 && colourReport.evidenceScore >= 0.20 && geomReport.geometryScore >= 0.15) ||
      (hasStrongPlateEvidence && totalScore >= 0.35)
    ) {
      decision = 'STRONG_CANDIDATE';
    } else {
      decision = 'UNCERTAIN_CANDIDATE';
    }
  }

  return {
    colourProfile: colourReport.profile,
    colourEvidenceScore: colourReport.evidenceScore,
    geometryEvidenceScore: geomReport.geometryScore,
    strokeEvidenceScore: strokeReport.strokeScore,
    cropQualityScore,
    signEvidencePenalty: colourReport.signPenalty,
    malaysiaVisualCandidateScore: Number(totalScore.toFixed(3)),
    decision,
    rejectionReason,
    details: {
      aspectRatio: Number(geomReport.aspectRatio.toFixed(2)),
      relativeArea: Number(geomReport.relativeArea.toFixed(3)),
      medianLuminance: Math.round(colourReport.medianLuminance),
      foregroundContrast: Math.round(colourReport.contrast),
      meanSaturation: Number(colourReport.meanSaturation.toFixed(2)),
      estimatedStrokeCount: strokeReport.estimatedStrokeCount,
      isDegraded,
    },
  };
}

/**
 * Multi-signal final confirmation combining detector, visual candidate, OCR,
 * Malaysian pattern validation, scale evolution, kinematics, and spatial context.
 */
export function evaluateMalaysianPlateFinalConfirmation(
  track: ActiveTrack,
  ocrText: string,
  ocrConfidence: number,
  visualReport?: MalaysianVisualCandidateReport,
  options: MalaysianConfirmationContextOptions = {}
): MalaysianFinalConfirmationReport {
  const patternResult = validateMalaysianPattern(ocrText);
  const isPatternValid = patternResult.isValid;
  const patternScore = patternResult.score;

  const yoloConfidence = track.bbox.confidence ?? 0.5;
  const visualScore = visualReport?.malaysiaVisualCandidateScore ?? (track.visualCandidateScore ?? 0.50);
  const voteCount = track.votes.get(ocrText)?.count ?? 1;
  const temporalScore = Math.min(0.20, (voteCount - 1) * 0.10);

  // 1. Spatial frame position analysis
  const srcW = options.sourceDimensions?.width || 1280;
  const srcH = options.sourceDimensions?.height || 720;
  const normalizedX = Number(((track.bbox.x + track.bbox.width / 2) / srcW).toFixed(3));
  const normalizedY = Number(((track.bbox.y + track.bbox.height / 2) / srcH).toFixed(3));

  let positionLabel: 'LOWER' | 'CENTER' | 'UPPER' | 'OVERHEAD' = 'CENTER';
  if (normalizedY < 0.18) positionLabel = 'OVERHEAD';
  else if (normalizedY < 0.35) positionLabel = 'UPPER';
  else if (normalizedY > 0.70) positionLabel = 'LOWER';

  let overheadSignEvidenceScore = 0.0;
  if (normalizedY < 0.18) {
    overheadSignEvidenceScore = 0.15;
    if (track.framesSeen >= 6 || (visualReport?.signEvidencePenalty ?? 0) > 0.20) {
      overheadSignEvidenceScore = 0.25;
    }
  }

  // 2. Motion & Kinematics analysis
  const totalDisplacement = Number((track.totalDisplacement ?? 0).toFixed(1));
  const motionScore = Number((track.motionScore ?? 0).toFixed(2));
  let motionLabel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' = 'NONE';
  if (motionScore > 0.45 || totalDisplacement > 40) motionLabel = 'HIGH';
  else if (motionScore > 0.15 || totalDisplacement > 15) motionLabel = 'MEDIUM';
  else if (motionScore > 0.03 || totalDisplacement > 5) motionLabel = 'LOW';

  // 3. Scale evolution & approach analysis
  const scaleEvolutionRatio = Number((track.scaleEvolutionRatio ?? 1.0).toFixed(2));
  let scaleLabel: 'NONE' | 'INCREASING' | 'DECREASING' | 'STEADY' = 'NONE';
  if (scaleEvolutionRatio >= 1.25) scaleLabel = 'INCREASING';
  else if (scaleEvolutionRatio <= 0.80) scaleLabel = 'DECREASING';
  else if (track.framesSeen >= 4) scaleLabel = 'STEADY';

  const scaleApproachEvidenceScore = scaleEvolutionRatio >= 1.25
    ? Math.min(0.15, Number(((scaleEvolutionRatio - 1.0) * 0.20).toFixed(3)))
    : 0.0;

  // 4. Static sign evidence (on stationary cameras only)
  const isMovingOrUnknownCamera =
    options.isMobileCamera === true ||
    options.cameraMovementMode === 'MOVING' ||
    options.cameraMovementMode === 'UNKNOWN';

  let staticSignEvidenceScore = 0.0;
  if (!isMovingOrUnknownCamera) {
    if (track.framesSeen >= 8 && totalDisplacement < 12 && scaleEvolutionRatio < 1.08) {
      staticSignEvidenceScore = Math.min(0.35, Number((0.15 + (track.framesSeen - 8) * 0.025).toFixed(3)));
    } else if (track.framesSeen >= 4 && totalDisplacement < 6 && scaleEvolutionRatio < 1.05) {
      staticSignEvidenceScore = 0.10;
    }
  } else {
    // When camera itself is moving or unknown, disable static sign zero-motion penalty
    staticSignEvidenceScore = 0.0;
  }

  let staticEvidenceLabel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  if (staticSignEvidenceScore >= 0.20) staticEvidenceLabel = 'HIGH';
  else if (staticSignEvidenceScore >= 0.08) staticEvidenceLabel = 'MEDIUM';

  const combinedSignEvidence = Math.max(
    visualReport?.signEvidencePenalty ?? 0,
    overheadSignEvidenceScore,
    staticSignEvidenceScore
  );
  let signEvidenceLabel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  if (combinedSignEvidence >= 0.25) signEvidenceLabel = 'HIGH';
  else if (combinedSignEvidence >= 0.10) signEvidenceLabel = 'MEDIUM';

  // 5. Decoupled Physical vs Text Evidence Scoring
  const physicalScore =
    0.15 * yoloConfidence +
    0.20 * Math.max(0, visualScore) +
    0.10 * scaleApproachEvidenceScore;

  const physicalSignPenalty =
    0.15 * staticSignEvidenceScore +
    0.10 * overheadSignEvidenceScore +
    (visualReport?.signEvidencePenalty ?? 0) * 0.20;

  const netPhysicalEvidence = physicalScore - physicalSignPenalty;

  const textScore =
    0.35 * (ocrConfidence * patternScore) +
    0.20 * (isPatternValid ? 1.0 : 0.0) +
    0.10 * temporalScore;

  const finalMalaysiaPlateScore = Number(
    Math.max(
      0,
      Math.min(
        1.0,
        physicalScore + textScore - physicalSignPenalty
      )
    ).toFixed(3)
  );

  let decision: PlateConfirmationState = 'PLATE_CANDIDATE';
  let rejectionReason: string | undefined;

  // Fast confirmation for genuine plates
  const isInstantStrong =
    isPatternValid &&
    ocrConfidence >= 0.75 &&
    patternScore >= 0.60 &&
    (visualReport?.decision === 'STRONG_CANDIDATE' || visualScore >= 0.35) &&
    staticSignEvidenceScore < 0.18 &&
    overheadSignEvidenceScore < 0.20 &&
    netPhysicalEvidence >= 0.20;

  // Consensus confirmation over multiple frames (requires sufficient physical evidence)
  const isStabilizedConsensus =
    isPatternValid &&
    voteCount >= 2 &&
    ocrConfidence >= 0.55 &&
    finalMalaysiaPlateScore >= 0.48 &&
    staticSignEvidenceScore < 0.25 &&
    netPhysicalEvidence >= 0.18;

  // Bounded Lifecycle: Prune stuck persistent false positives (BAY44, NO12, overhead signs)
  const isPersistentNonPlateSign =
    track.framesSeen >= 10 &&
    (staticSignEvidenceScore >= 0.20 || overheadSignEvidenceScore >= 0.20) &&
    scaleEvolutionRatio < 1.10 &&
    totalDisplacement < 15 &&
    netPhysicalEvidence < 0.22;

  const isObviousNonPlate =
    (!isPatternValid && patternScore < 0.20 && (visualReport?.decision === 'OBVIOUS_NON_PLATE' || voteCount >= 5)) ||
    (visualReport?.colourProfile === 'BLUE_BACKGROUND_LIGHT_TEXT' && !isPatternValid) ||
    isPersistentNonPlateSign;

  if (isInstantStrong || isStabilizedConsensus) {
    decision = 'CONFIRMED_PLATE';
  } else if (isObviousNonPlate) {
    decision = 'REJECTED_NON_PLATE';
    rejectionReason = isPersistentNonPlateSign
      ? 'Persistent non-plate context evidence (stationary/overhead sign)'
      : 'Text does not match Malaysian vehicle registration structure';
  } else {
    decision = 'PLATE_CANDIDATE';
  }

  return {
    confirmationState: decision,
    finalMalaysiaPlateScore,
    isPatternValid,
    patternCategory: patternResult.category,
    ocrConfidence,
    temporalVoteCount: voteCount,
    decision,
    rejectionReason,
    contextDetails: {
      normalizedX,
      normalizedY,
      scaleEvolutionRatio,
      totalDisplacement,
      motionScore,
      staticSignEvidenceScore,
      scaleApproachEvidenceScore,
      overheadSignEvidenceScore,
      staticEvidenceLabel,
      signEvidenceLabel,
      motionLabel,
      scaleLabel,
      positionLabel,
    },
  };
}
