import { VehicleCase, MatchType, CharacterConfidence, PlateCategory } from '../db/types';
import { normalizePlate, generateCandidatePlates, isPossibleMatch } from './normaliser';
import { validateMalaysianPattern } from './patterns';

export interface MatchEvaluationResult {
  matchType: MatchType;
  matchedVehicle: VehicleCase | null;
  possibleMatches: VehicleCase[];
  confidence: number;
  normalizedPlate: string;
  category: PlateCategory;
  reason: string;
}

/**
 * Database-Aware Candidate Ranking Engine.
 * Evaluates raw OCR reading and candidate permutations against active vehicle repository records.
 *
 * Ranking Hierarchy:
 * 1. Stable full-plate reading with exact normalized DB match -> EXACT MATCH
 * 2. Candidate differing at 1 low-confidence character matching active DB case -> POSSIBLE MATCH
 * 3. Valid pattern candidate not registered in DB -> NO CASE (NONE)
 * 4. Insufficient confidence / blurred / unreadable -> INSUFFICIENT_CONFIDENCE
 */
export function evaluateDatabaseMatch(
  ocrReading: string,
  ocrConfidence: number,
  allVehicles: VehicleCase[],
  charConfidences?: CharacterConfidence[],
  minConfidenceThreshold: number = 0.65
): MatchEvaluationResult {
  const norm = normalizePlate(ocrReading);
  const patternVal = validateMalaysianPattern(norm);

  // Safety check 1: Extremely short or missing reading
  if (!norm || norm.length < 2) {
    return {
      matchType: 'INSUFFICIENT_CONFIDENCE',
      matchedVehicle: null,
      possibleMatches: [],
      confidence: ocrConfidence,
      normalizedPlate: norm,
      category: patternVal.category,
      reason: 'Reading too short or empty',
    };
  }

  // Safety check 2: Low confidence threshold check
  if (ocrConfidence < minConfidenceThreshold) {
    return {
      matchType: 'INSUFFICIENT_CONFIDENCE',
      matchedVehicle: null,
      possibleMatches: [],
      confidence: ocrConfidence,
      normalizedPlate: norm,
      category: patternVal.category,
      reason: `Confidence (${Math.round(ocrConfidence * 100)}%) below threshold (${Math.round(minConfidenceThreshold * 100)}%)`,
    };
  }

  // ── Rank 1: Exact Normalized Match ──
  const exactVeh = allVehicles.find(
    v => v.normalizedPlate === norm && v.status !== 'CLOSED'
  );

  if (exactVeh) {
    return {
      matchType: 'EXACT',
      matchedVehicle: exactVeh,
      possibleMatches: [],
      confidence: ocrConfidence,
      normalizedPlate: norm,
      category: exactVeh.plateCategory || patternVal.category,
      reason: 'Exact normalized plate equality',
    };
  }

  // Also check closed case (warn user, returns no case or custom status)
  const closedVeh = allVehicles.find(
    v => v.normalizedPlate === norm && v.status === 'CLOSED'
  );
  if (closedVeh) {
    return {
      matchType: 'NONE',
      matchedVehicle: null,
      possibleMatches: [],
      confidence: ocrConfidence,
      normalizedPlate: norm,
      category: patternVal.category,
      reason: 'Case is closed',
    };
  }

  // ── Rank 2: Possible Match via Positional Confusion Substitution ──
  const candidates = generateCandidatePlates(norm, charConfidences, 10);
  const possibleVehicles: VehicleCase[] = [];

  for (const cand of candidates) {
    const matchVeh = allVehicles.find(v => v.normalizedPlate === cand && v.status !== 'CLOSED');
    if (matchVeh && !possibleVehicles.some(pv => pv.id === matchVeh.id)) {
      possibleVehicles.push(matchVeh);
    }
  }

  // Fallback 1-char edit distance search for active/on-hold vehicles
  if (possibleVehicles.length === 0) {
    for (const v of allVehicles) {
      if (v.status === 'CLOSED') continue;
      if (isPossibleMatch(norm, v.normalizedPlate)) {
        possibleVehicles.push(v);
      }
    }
  }

  if (possibleVehicles.length > 0) {
    return {
      matchType: 'POSSIBLE',
      matchedVehicle: null,
      possibleMatches: possibleVehicles,
      confidence: ocrConfidence * 0.90, // Slightly reduced confidence for possible match
      normalizedPlate: norm,
      category: patternVal.category,
      reason: `Possible match with ${possibleVehicles.length} registered active case(s)`,
    };
  }

  // ── Rank 3: Valid Pattern Candidate, Not in Repository Database ──
  return {
    matchType: 'NONE',
    matchedVehicle: null,
    possibleMatches: [],
    confidence: ocrConfidence,
    normalizedPlate: norm,
    category: patternVal.category,
    reason: 'Valid Malaysian plate pattern, no active case in repository',
  };
}
