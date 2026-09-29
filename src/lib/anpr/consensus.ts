import type { ActiveTrack } from './tracker';
import { normalizePlate, formatDisplayPlate, getJPJTypographicPenalty } from './normaliser';
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

type VoteEntry = {
  plate: string;
  count: number;
  totalConfidence: number;
  effectiveConfidence: number;
  averageConfidence: number;
};

const MAX_TRACK_OCR_OBSERVATIONS = 16;

function isMixedAlphaNumericPlate(value: string): boolean {
  return value.length >= 5 && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

/**
 * Moving plates commonly produce a different single-character reading on each
 * frame. Treat those reads as supporting one candidate family, but always
 * return a string that OCR actually observed (never a database-derived plate).
 */
function getEditDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function isOneCharacterVariant(left: string, right: string): boolean {
  if (left === right) return true;
  if (!isMixedAlphaNumericPlate(left) || !isMixedAlphaNumericPlate(right)) {
    return false;
  }
  if (Math.abs(left.length - right.length) > 1) return false;
  return getEditDistance(left, right) === 1;
}

/**
 * Determines if two OCR readings belong to the same physical vehicle family
 * (e.g. AMA4588 vs AA4588, AMA4588 vs AMA498, VGA1268 vs VGA1266, VOH5370 vs OHH5370, VME7108 vs ME708).
 */
export function arePlatesSameVehicleFamily(left: string, right: string): boolean {
  const cleanA = normalizePlate(left);
  const cleanB = normalizePlate(right);
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;

  if (isOneCharacterVariant(cleanA, cleanB)) return true;

  const digitsA = cleanA.replace(/[^0-9]/g, '');
  const digitsB = cleanB.replace(/[^0-9]/g, '');
  const lettersA = cleanA.replace(/[^A-Z]/g, '');
  const lettersB = cleanB.replace(/[^A-Z]/g, '');

  if (digitsA && digitsB) {
    const digitsDistance = getEditDistance(digitsA, digitsB);
    const lettersDistance = getEditDistance(lettersA, lettersB);

    // Case 1: Exact or close digits (e.g. 5370 == 5370), letters have OCR confusion (e.g. VOH vs OHH, AMA vs AA)
    if (
      digitsA === digitsB ||
      (digitsA.length >= 3 && digitsB.length >= 3 && (digitsA.includes(digitsB) || digitsB.includes(digitsA)))
    ) {
      if (!lettersA || !lettersB) return true;
      if (lettersA === lettersB) return true;
      if (lettersA.startsWith(lettersB) || lettersB.startsWith(lettersA)) return true;
      if (lettersDistance <= 2) return true;
    }

    // Case 2: Exact same letters (e.g. AMA == AMA, VGA == VGA), digits have 1-2 char confusion/omission (e.g. 4588 vs 498, 1268 vs 1266)
    if (lettersA === lettersB && lettersA.length >= 2) {
      if (digitsDistance <= 2 && Math.min(digitsA.length, digitsB.length) >= 2) {
        return true;
      }
    }

    // Case 3: Suffix/prefix letter omission with close digits (e.g. VME7108 vs ME708)
    const digitsSubsequence =
      digitsDistance <= 1 ||
      (digitsA.length >= 3 && digitsB.length >= 3 && (digitsA.includes(digitsB) || digitsB.includes(digitsA)));

    if (digitsSubsequence) {
      if (lettersA.startsWith(lettersB) || lettersB.startsWith(lettersA) || lettersA.endsWith(lettersB) || lettersB.endsWith(lettersA)) return true;
      if (lettersDistance <= 1) return true;
    }
  }

  return false;
}

function getVoteEntries(track: ActiveTrack): { entries: VoteEntry[]; totalVotes: number } {
  let totalVotes = 0;
  const entries: VoteEntry[] = [];

  track.votes.forEach((data, plateStr) => {
    if (data.count <= 0 || !Number.isFinite(data.totalConfidence)) return;
    const normalized = normalizePlate(plateStr);
    if (!normalized) return;
    const penalty = getJPJTypographicPenalty(normalized);
    totalVotes += data.count;
    entries.push({
      plate: normalized,
      count: data.count,
      totalConfidence: data.totalConfidence,
      effectiveConfidence: data.totalConfidence - penalty * data.count,
      averageConfidence: data.totalConfidence / data.count,
    });
  });

  return { entries, totalVotes };
}

function rankObservedRepresentative(entry: VoteEntry): number {
  const pattern = validateMalaysianPattern(entry.plate);
  const completenessBonus = entry.plate.length >= 6 && entry.plate.length <= 8 && pattern.isValid ? 0.08 : 0;
  return (
    entry.averageConfidence * 0.50 +
    pattern.score * 0.26 +
    completenessBonus +
    Math.min(1, entry.count / 3) * 0.12 +
    (pattern.isValid ? 0.08 : 0) -
    getJPJTypographicPenalty(entry.plate)
  );
}

/**
 * Evaluates multi-frame voting consensus for a single track.
 * Each track maintains its own isolated vote map — votes are never shared between tracks.
 */
export function evaluateConsensus(
  track: ActiveTrack,
  minRequiredVotes: number = 3,
  minConfidenceThreshold: number = 0.60,
  requireExactVotes: boolean = false
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

  // Uncertain reads remain available for diagnostics/recovery, but must not
  // dilute later publishable evidence (e.g. 68% glare frames followed by 98%).
  // Count each source frame once and retain disagreement among qualified reads.
  let evidenceTrack = track;
  let qualifiedFrames: number | undefined;
  if (requireExactVotes && track.ocrFrameCandidates?.size) {
    const votes: ActiveTrack['votes'] = new Map();
    qualifiedFrames = 0;
    for (const observations of track.ocrFrameCandidates.values()) {
      let qualified = false;
      for (const [plate, confidence] of observations) {
        if (confidence < minConfidenceThreshold || !validateMalaysianPattern(plate).isValid) continue;
        const vote = votes.get(plate) ?? { count: 0, totalConfidence: 0 };
        vote.count++; vote.totalConfidence += confidence;
        votes.set(plate, vote); qualified = true;
      }
      if (qualified) qualifiedFrames++;
    }
    evidenceTrack = { ...track, votes };
  }
  const { entries, totalVotes: aggregateVotes } = getVoteEntries(evidenceTrack);
  const totalVotes = qualifiedFrames ?? aggregateVotes;
  let topPlate = '';
  let topCount = 0;
  let topTotalConf = -100;
  let topRank = -Infinity;

  entries.forEach((centre) => {
    const family = entries.filter((candidate) => requireExactVotes
      ? centre.plate === candidate.plate
      : isOneCharacterVariant(centre.plate, candidate.plate));
    const familyCount = family.reduce((sum, candidate) => sum + candidate.count, 0);
    const representative = [...family].sort((left, right) => {
      const rankDifference = rankObservedRepresentative(right) - rankObservedRepresentative(left);
      if (Math.abs(rankDifference) > 0.08) return rankDifference;
      if (right.count !== left.count) return right.count - left.count;
      if (Math.abs(rankDifference) > 0.0001) return rankDifference;
      return right.effectiveConfidence - left.effectiveConfidence;
    })[0];
    if (!representative) return;

    const familyRank = familyCount * 10 + rankObservedRepresentative(representative);
    if (familyCount > topCount || (familyCount === topCount && familyRank > topRank)) {
      topPlate = representative.plate;
      topCount = familyCount;
      // Confidence belongs to the selected observed reading. Nearby variants
      // provide repeat evidence, but must not inflate its OCR confidence.
      topTotalConf = representative.averageConfidence * familyCount;
      topRank = familyRank;
    }
  });

  // The single-read path has a stricter floor and must clearly outrank other
  // observed strings. Earlier 90%-range fragments cannot veto a 97%+ read,
  // while similarly confident contradictory strings still require repetition.
  const decisiveRead = requireExactVotes && minRequiredVotes === 1
    ? entries.find(entry => entry.averageConfidence >= Math.max(0.97, minConfidenceThreshold) &&
        entries.every(other => other.plate === entry.plate || entry.averageConfidence > other.averageConfidence + 0.04))
    : undefined;
  if (decisiveRead) {
    topPlate = decisiveRead.plate; topCount = decisiveRead.count;
    topTotalConf = decisiveRead.totalConfidence;
  }

  // Only complete strings actually read from independent crops can stabilize.
  // Neither a longer DB candidate nor a synthetic character vote is evidence.
  const avgConfidence = topCount > 0 ? topTotalConf / topCount : 0;
  const normalized = normalizePlate(topPlate);
  const patternVal = validateMalaysianPattern(normalized);

  const isStabilized =
    topCount >= minRequiredVotes &&
    (!requireExactVotes || Boolean(decisiveRead) || !entries.some(entry => entry.plate !== topPlate && entry.count >= topCount)) &&
    (Boolean(decisiveRead) || topCount > totalVotes / 2 || (requireExactVotes && topCount >= 2 && topCount >= totalVotes / 2)) &&
    avgConfidence >= minConfidenceThreshold &&
    patternVal.isValid &&
    normalized.length >= 2;

  return {
    isStabilized,
    plateNumber: topPlate,
    displayPlate: formatDisplayPlate(normalized, patternVal.category),
    normalizedPlate: normalized,
    confidence: Math.min(1.0, avgConfidence),
    voteCount: topCount,
    totalVotes,
    category: patternVal.category,
  };
}

/** Preserve observed variants so a stronger-looking partial read cannot erase
 * the complete reading that the next independent frame corroborates. */
export function addOcrCandidateEvidence(track: ActiveTrack, text: string, confidence: number, capturedAt: number): void {
  const plate = normalizePlate(text);
  if (!plate || !Number.isFinite(confidence)) return;
  track.ocrFrameCandidates ??= new Map();
  const candidates = track.ocrFrameCandidates.get(capturedAt) ?? new Map<string, number>();
  candidates.set(plate, Math.max(candidates.get(plate) ?? 0, Math.min(1, Math.max(0, confidence))));
  track.ocrFrameCandidates.set(capturedAt, candidates);
  while (track.ocrFrameCandidates.size > MAX_TRACK_OCR_OBSERVATIONS) {
    track.ocrFrameCandidates.delete(Math.min(...track.ocrFrameCandidates.keys()));
  }
}

/**
 * Adds an OCR result as a vote to a specific track's isolated vote map.
 * Incorporates crop quality weight to prioritize crisp frames.
 */
export function addOcrVoteToTrack(
  track: ActiveTrack,
  ocrText: string,
  confidence: number,
  qualityWeight: number = 1.0,
  capturedAt?: number
): void {
  const norm = normalizePlate(ocrText);
  if (!norm || norm.length < 2 || !Number.isFinite(confidence)) return;

  const weightedConfidence = Math.min(1, Math.max(0, confidence));

  if (capturedAt !== undefined) {
    addOcrCandidateEvidence(track, norm, weightedConfidence, capturedAt);
    track.ocrVotedCaptureTimes ??= new Set();
    track.ocrFrameObservations ??= new Map();
    const previous = track.ocrFrameObservations.get(capturedAt);
    if (previous) {
      if (previous.confidence >= weightedConfidence) return;
      // Enhanced pixels may improve one observation, but never add another
      // temporal vote for the same source frame.
      const old = track.votes.get(previous.plate);
      if (old) {
        old.count--;
        old.totalConfidence = Math.max(0, old.totalConfidence - previous.confidence);
        if (old.count <= 0) track.votes.delete(previous.plate);
      }
    } else if (track.ocrVotedCaptureTimes.has(capturedAt)) return;
    track.ocrVotedCaptureTimes.add(capturedAt);
    track.ocrFrameObservations.set(capturedAt, { plate: norm, confidence: weightedConfidence });
  }

  // Preserve each observed string. An insertion is not proof that a shorter
  // Malaysian plate omitted a digit; both are valid hypotheses.
  const current = track.votes.get(norm) || { count: 0, totalConfidence: 0 };
  current.count += 1;
  current.totalConfidence += weightedConfidence;
  track.votes.set(norm, current);

  // Keep per-frame evidence and aggregate counts bounded together.
  while (track.ocrFrameObservations && track.ocrFrameObservations.size > MAX_TRACK_OCR_OBSERVATIONS) {
    const oldest = Math.min(...track.ocrFrameObservations.keys());
    const observation = track.ocrFrameObservations.get(oldest)!;
    track.ocrFrameObservations.delete(oldest);
    const vote = track.votes.get(observation.plate);
    if (vote) {
      vote.count--;
      vote.totalConfidence = Math.max(0, vote.totalConfidence - observation.confidence);
      if (vote.count <= 0) track.votes.delete(observation.plate);
    }
  }

  // Bound stale/noisy evidence on long or looping streams. Without this, a
  // few early moving-frame fragments can permanently prevent later clear
  // reads from becoming a majority.
  let totalObservations = Array.from(track.votes.values()).reduce((sum, vote) => sum + vote.count, 0);
  while (totalObservations > MAX_TRACK_OCR_OBSERVATIONS && track.votes.size > 0) {
    let weakestPlate = '';
    let weakestRank = Number.POSITIVE_INFINITY;
    track.votes.forEach((vote, plate) => {
      const average = vote.count > 0 ? vote.totalConfidence / vote.count : 0;
      const pattern = validateMalaysianPattern(plate);
      const rank = average + pattern.score * 0.18 + (pattern.isValid ? 0.08 : 0);
      if (rank < weakestRank) {
        weakestRank = rank;
        weakestPlate = plate;
      }
    });
    const weakest = track.votes.get(weakestPlate);
    if (!weakest) break;
    const average = weakest.count > 0 ? weakest.totalConfidence / weakest.count : 0;
    weakest.count--;
    weakest.totalConfidence = Math.max(0, weakest.totalConfidence - average);
    totalObservations--;
    if (weakest.count <= 0) track.votes.delete(weakestPlate);
  }
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
