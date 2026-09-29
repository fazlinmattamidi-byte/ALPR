import { isOneCharacterVariant, arePlatesSameVehicleFamily } from './consensus';
import { validateMalaysianPattern } from './patterns';

export const MIN_PUBLISHED_OCR_CONFIDENCE = 0.90;
export const MIN_CORROBORATED_OCR_CONFIDENCE = 0.75;

/**
 * A one-frame result needs very high confidence. Two or more independent,
 * exact OCR observations of the same valid plate may use a lower floor: this
 * is how a real compressed/live stream can be read without treating a single
 * uncertain frame as a detection.
 */
export interface VisualPlateEvidence {
  detectorConfidence?: number;
  cropWidth?: number;
  cropHeight?: number;
  aspectRatio?: number;
  qualityScore?: number;
  isBlurry?: boolean;
}

/**
 * Checks if the visual geometry indicates a non-plate object (such as a square road sign,
 * blue street sign, signboard, or logo with implausible aspect ratio).
 */
export function isVisualNonPlate(evidence?: VisualPlateEvidence): boolean {
  if (!evidence) return false;
  const { aspectRatio, detectorConfidence } = evidence;

  // Implausible aspect ratio for plates (square < 0.95 or extreme > 6.8)
  if (aspectRatio !== undefined) {
    if (aspectRatio < 0.95 || aspectRatio > 6.8) return true;
  }

  // Low detector confidence combined with non-standard ratio
  if (detectorConfidence !== undefined && detectorConfidence < 0.45 && aspectRatio !== undefined) {
    if (aspectRatio < 1.35 || aspectRatio > 5.8) return true;
  }

  return false;
}

/**
 * Detects common currency / price tag / unit sticker collisions (e.g. RM630 from 'RM 6.30', KM50 from '50 KM', etc.)
 */
export function isCurrencyOrUnitText(plate: string): boolean {
  const clean = plate.replace(/[^A-Z0-9]/g, '');
  if (/^RM[0-9]{1,4}$/.test(clean)) return true;
  if (/^[0-9]{1,4}RM$/.test(clean)) return true;
  if (/^KM[0-9]{1,4}$/.test(clean)) return true;
  if (/^KG[0-9]{1,4}$/.test(clean)) return true;
  return false;
}

/**
 * Short strings (length <= 4, e.g. 2-letter + 1-2 digits like SS12, S123, Q12)
 * have much higher collision risk with street signs, section numbers, and logos.
 * They are valid registrations, but require stronger visual/temporal evidence.
 */
export function requiresStrongerEvidence(plate: string): boolean {
  const clean = plate.replace(/[^A-Z0-9]/g, '');
  if (clean.length <= 4) return true;
  if (/^[A-Z]{2}[0-9]{1,2}$/.test(clean)) return true;
  return false;
}

/**
 * A one-frame result needs very high confidence. Two or more independent,
 * exact OCR observations of the same valid plate may use a lower floor: this
 * is how a real compressed/live stream can be read without treating a single
 * uncertain frame as a detection.
 */
export function canPublishPlate(
  plate: string,
  confidence: number,
  configuredThreshold = 0,
  corroboratingObservations = 1,
  evidence?: VisualPlateEvidence
): boolean {
  if (isCurrencyOrUnitText(plate)) return false;
  if (isVisualNonPlate(evidence)) return false;

  const pattern = validateMalaysianPattern(plate);
  if (!pattern.isValid) return false;

  if (requiresStrongerEvidence(plate)) {
    if (evidence) {
      // Short valid-looking strings require stronger supporting evidence
      const shortStringMinConf = corroboratingObservations >= 2 ? 0.88 : 0.94;
      const shortStringMinDet = 0.55;
      if (evidence.detectorConfidence !== undefined && evidence.detectorConfidence < shortStringMinDet) {
        return false;
      }
      if (evidence.aspectRatio !== undefined && (evidence.aspectRatio < 1.45 || evidence.aspectRatio > 5.5)) {
        return false;
      }
      const reqThreshold = Math.max(shortStringMinConf, configuredThreshold);
      return Number.isFinite(confidence) && confidence >= reqThreshold;
    }
  }

  const minimumConfidence = corroboratingObservations >= 2
    ? Math.max(MIN_CORROBORATED_OCR_CONFIDENCE, configuredThreshold)
    : Math.max(MIN_PUBLISHED_OCR_CONFIDENCE, configuredThreshold);

  return Number.isFinite(confidence) && confidence >= minimumConfidence;
}

/** Corrected/padded images can give confident fragments. A raw detector-tight
 * crop retains the 95% instant path; other single observations require 97%.
 * Pattern validation, conflicting evidence and the publication floor still
 * apply at the caller. */
export function canUseSingleOcrObservation(confidence: number, variant: string, cropKind: string): boolean {
  const threshold = variant === 'ORIGINAL' && cropKind === 'TIGHT' ? 0.95 : 0.97;
  return Number.isFinite(confidence) && confidence >= threshold;
}

/** Short-lived geometric identity for a fragmented OCR track. Similar text
 * alone must never collapse cards belonging to separate cars. */
export function isSameRecentPlateObservation(
  left: string, right: string,
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  elapsedMs: number
): boolean {
  const isFamily = isOneCharacterVariant(left, right) || arePlatesSameVehicleFamily(left, right);
  const omittedPrefix = Math.abs(left.length - right.length) <= 2 && Math.min(left.length, right.length) >= 5 &&
    (left.endsWith(right) || right.endsWith(left)) && left.replace(/[^0-9]/g, '') === right.replace(/[^0-9]/g, '');
  if (elapsedMs < 0 || elapsedMs > 750 || (!isFamily && !omittedPrefix)) return false;
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 && intersection / union >= 0.25;
}

