import { ActiveTrack } from './tracker';
import { normalizePlate, formatDisplayPlate } from './normaliser';
import { validateMalaysianPattern } from './patterns';
import { CharacterConfidence, PlateCategory } from '../db/types';

export interface ConsensusResult {
  isStabilized: boolean;
  plateNumber: string;
  displayPlate: string;
  normalizedPlate: string;
  confidence: number;
  voteCount: number;
  totalVotes: number;
  category: PlateCategory;
  characterConfidences?: CharacterConfidence[];
}

/**
 * Evaluates multi-frame voting consensus for a single track.
 * Each track maintains its own isolated vote map — votes are never shared between tracks.
 */
export function evaluateConsensus(
  track: ActiveTrack,
  minRequiredVotes: number = 3,
  minConfidenceThreshold: number = 0.60
): ConsensusResult {
  if (!track.votes || track.votes.size === 0) {
    return {
      isStabilized: false,
      plateNumber: '',
      displayPlate: '',
      normalizedPlate: '',
      confidence: 0,
      voteCount: 0,
      totalVotes: 0,
      category: 'UNKNOWN_VALID_CANDIDATE',
    };
  }

  let totalVotes = 0;
  let topPlate = '';
  let topCount = 0;
  let topTotalConf = 0;

  track.votes.forEach((data, plateStr) => {
    totalVotes += data.count;
    if (data.count > topCount || (data.count === topCount && data.totalConfidence > topTotalConf)) {
      topPlate = plateStr;
      topCount = data.count;
      topTotalConf = data.totalConfidence;
    }
  });

  // Character-Position Level Consensus Fallback
  // If top full-string count is 2 and total votes >= 3, reconstruct plate string position-by-position
  if (topCount < minRequiredVotes && totalVotes >= minRequiredVotes) {
    const charPosVotes = new Map<number, Map<string, number>>();
    track.votes.forEach((data, plateStr) => {
      for (let i = 0; i < plateStr.length; i++) {
        const char = plateStr[i];
        if (!charPosVotes.has(i)) charPosVotes.set(i, new Map());
        const posMap = charPosVotes.get(i)!;
        posMap.set(char, (posMap.get(char) || 0) + data.count * data.totalConfidence);
      }
    });

    const charList: string[] = [];
    charPosVotes.forEach((posMap) => {
      let bestChar = '';
      let maxScore = -1;
      posMap.forEach((score, char) => {
        if (score > maxScore) {
          maxScore = score;
          bestChar = char;
        }
      });
      if (bestChar) charList.push(bestChar);
    });

    const reconstructed = normalizePlate(charList.join(''));
    if (reconstructed.length >= 2) {
      topPlate = reconstructed;
      topCount = minRequiredVotes; // Allow character-level position consensus to satisfy minRequiredVotes
    }
  }

  const avgConfidence = topCount > 0 ? topTotalConf / topCount : 0.70;
  const normalized = normalizePlate(topPlate);
  const patternVal = validateMalaysianPattern(normalized);

  const isStabilized =
    topCount >= minRequiredVotes &&
    avgConfidence >= minConfidenceThreshold &&
    normalized.length >= 2;

  return {
    isStabilized,
    plateNumber: topPlate,
    displayPlate: formatDisplayPlate(normalized, patternVal.category),
    normalizedPlate: normalized,
    confidence: Math.min(1.0, Math.round(avgConfidence * 100) / 100),
    voteCount: topCount,
    totalVotes,
    category: patternVal.category,
  };
}

/**
 * Adds an OCR result as a vote to a specific track's isolated vote map.
 * Incorporates crop quality weight to prioritize crisp frames.
 */
export function addOcrVoteToTrack(
  track: ActiveTrack,
  ocrText: string,
  confidence: number,
  qualityWeight: number = 1.0
): void {
  const norm = normalizePlate(ocrText);
  if (!norm || norm.length < 2) return;

  const boundedQuality = Math.min(1.0, Math.max(0.0, qualityWeight));
  const qualityMultiplier = 0.75 + boundedQuality * 0.25;
  const weightedConfidence = confidence * qualityMultiplier;

  const current = track.votes.get(norm) || { count: 0, totalConfidence: 0 };
  current.count += 1;
  current.totalConfidence += weightedConfidence;
  track.votes.set(norm, current);
}

/**
 * Returns display string for track's current reading.
 */
export function getTrackReadingDisplay(track: ActiveTrack): string {
  if (track.stabilizedPlate) return formatDisplayPlate(track.stabilizedPlate);
  if (!track.votes || track.votes.size === 0) return '';

  let topPlate = '';
  let topCount = 0;
  track.votes.forEach((data, plateStr) => {
    if (data.count > topCount) { topPlate = plateStr; topCount = data.count; }
  });

  return topPlate ? formatDisplayPlate(topPlate) : '';
}
