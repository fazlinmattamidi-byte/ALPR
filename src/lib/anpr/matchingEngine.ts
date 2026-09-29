import { VehicleCase, MatchType, CharacterConfidence, PlateCategory } from '../db/types';
import {
  normalizePlate,
  generateCandidatePlates,
  isPossibleMatch,
} from './normaliser';
import { validateMalaysianPattern } from './patterns';
import { correctMalaysianPlateOcr } from './specialSeries';

export interface MatchEvaluationResult {
  matchType: MatchType;
  matchedVehicle: VehicleCase | null;
  possibleMatches: VehicleCase[];
  confidence: number;
  normalizedPlate: string;
  category: PlateCategory;
  reason: string;
}

export interface VehicleMatchIndex {
  byPlate: Map<string, VehicleCase[]>;
  activeByLength: Map<number, VehicleCase[]>;
}

/** Rebuild when repository records change, rather than on every OCR result. */
export function buildVehicleMatchIndex(vehicles: VehicleCase[]): VehicleMatchIndex {
  const index: VehicleMatchIndex = { byPlate: new Map(), activeByLength: new Map() };
  for (const vehicle of vehicles) {
    const plate = normalizePlate(vehicle.normalizedPlate || vehicle.plateNumber);
    const record = { ...vehicle, normalizedPlate: plate };
    index.byPlate.set(plate, [...(index.byPlate.get(plate) ?? []), record]);
    if (record.status !== 'CLOSED' && record.status !== 'RECOVERED') {
      const bucket = index.activeByLength.get(plate.length) ?? [];
      bucket.push(record);
      index.activeByLength.set(plate.length, bucket);
    }
  }
  return index;
}

function isActive(vehicle: VehicleCase): boolean {
  return vehicle.status !== 'CLOSED' && vehicle.status !== 'RECOVERED';
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
  allVehicles: VehicleCase[] | VehicleMatchIndex,
  charConfidences?: CharacterConfidence[],
  minConfidenceThreshold: number = 0.65
): MatchEvaluationResult {
  const correction = correctMalaysianPlateOcr(ocrReading, {
    ocrConfidence,
    characterConfidences: charConfidences,
  });
  const norm = correction.normalized || normalizePlate(ocrReading);
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
  if (!Number.isFinite(ocrConfidence) || ocrConfidence < minConfidenceThreshold) {
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
  const index = Array.isArray(allVehicles) ? buildVehicleMatchIndex(allVehicles) : allVehicles;
  const exactRecords = index.byPlate.get(norm) ?? [];
  const exactVeh = exactRecords.find(isActive);

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
  const closedVeh = exactRecords.find(v => !isActive(v));
  if (closedVeh) {
    return {
      matchType: 'NONE',
      matchedVehicle: null,
      possibleMatches: [],
      confidence: ocrConfidence,
      normalizedPlate: norm,
      category: patternVal.category,
      reason: closedVeh.status === 'RECOVERED' ? 'Case is recovered' : 'Case is closed',
    };
  }

  // ── Rank 2: Possible Match via Positional Confusion Substitution ──
  const candidates = generateCandidatePlates(norm, charConfidences, 10);
  const possibleVehicles: VehicleCase[] = [];

  for (const cand of candidates) {
    for (const matchVeh of index.byPlate.get(cand) ?? []) {
      if (isActive(matchVeh) && !possibleVehicles.some(pv => pv.id === matchVeh.id)) {
        possibleVehicles.push(matchVeh);
      }
    }
  }

  // Fallback 1-char edit distance search for active/on-hold vehicles
  if (possibleVehicles.length === 0) {
    const nearbyRecords = [-1, 0, 1].flatMap(offset => index.activeByLength.get(norm.length + offset) ?? []);
    for (const v of nearbyRecords) {
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
