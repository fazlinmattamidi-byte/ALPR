import { CharacterConfidence, PlateCategory } from '../db/types';
import { findSpecialSeriesPrefix, generateSpecialPlateCandidates } from './specialSeries';
import { validateMalaysianPattern } from './patterns';
export interface TypographyCorrectionResult {
  normalized: string;
  corrected: boolean;
  alternatives: string[];
  reason: 'NONE' | 'SABAH_STYLIZED_A';
}

export interface TypographyCorrectionOptions {
  ocrConfidence?: number;
  characterConfidences?: CharacterConfidence[];
}

/**
 * Normalises a raw plate string according to Malaysian ANPR rules:
 * - Upper-cased
 * - Strip all spaces, dashes, dots, symbols
 * - Preserve alphanumeric characters (A-Z, 0-9)
 * - PRESERVE trailing alphabetic suffixes (e.g. KV1234E, W1234A)
 * - Support long registrations up to 15 characters (e.g. PUTRAJAYA1234, POLIS1234)
 */
export function normalizePlate(raw: string): string {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Formats a normalized plate for clear display with standard spacing.
 * Examples:
 * "JSD8888" -> "JSD 8888"
 * "KV1234E" -> "KV 1234 E"
 * "EV1234"  -> "EV 1234"
 * "W1234A"  -> "W 1234 A"
 */
export function formatDisplayPlate(normalized: string, _category?: PlateCategory): string {
  void _category;
  if (!normalized) return '';

  const specialPrefix = findSpecialSeriesPrefix(normalized);
  if (specialPrefix) {
    const suffix = normalized.slice(specialPrefix.length);
    if (/^[0-9]{1,5}[A-Z]?$/.test(suffix)) {
      return `${specialPrefix} ${suffix}`;
    }
  }

  // EV Special: EV 1234, EVA 1234, EVB 1234 A
  const evMatch = /^(EV[A-Z]{0,2})([0-9]{1,5})([A-Z]?)$/.exec(normalized);
  if (evMatch) {
    return [evMatch[1], evMatch[2], evMatch[3]].filter(Boolean).join(' ');
  }

  // Langkawi with Suffix: KV 1234 E
  const langkawiMatch = /^(KV)([0-9]{1,5})([A-Z]?)$/.exec(normalized);
  if (langkawiMatch) {
    return [langkawiMatch[1], langkawiMatch[2], langkawiMatch[3]].filter(Boolean).join(' ');
  }

  // Peninsular with Suffix: W 1234 A
  const matchSuffix = /^([A-Z]{1,3})([0-9]{1,5})([A-Z]{1,2})$/.exec(normalized);
  if (matchSuffix) {
    return `${matchSuffix[1]} ${matchSuffix[2]} ${matchSuffix[3]}`;
  }

  // Standard 1-3 letters + digits: JSD 8888
  const matchStd = /^([A-Z]{1,4})([0-9]{1,5})$/.exec(normalized);
  if (matchStd) {
    return `${matchStd[1]} ${matchStd[2]}`;
  }

  const mixedTail = /^([A-Z]{1,3})([0-9]{1,5})([A-Z][0-9])$/.exec(normalized);
  if (mixedTail) {
    return `${mixedTail[1]} ${mixedTail[2]} ${mixedTail[3]}`;
  }

  const alternatingGroups = normalized.match(/[A-Z]+|[0-9]+/g);
  if (alternatingGroups && alternatingGroups.length > 1) {
    return alternatingGroups.join(' ');
  }

  return normalized;
}

/**
 * Character confusion map for OCR ambiguity in Malaysian license plates
 */

export const CONFUSION_MAP: Record<string, string[]> = {
  A: ['4', 'R', 'W', 'N'],
  B: ['8', 'R', '3'],
  C: ['G', 'O', 'Q'],
  D: ['0', 'O', 'Q'],
  E: ['F', 'B', '3'],
  F: ['T', 'E', 'P'],
  G: ['6', 'C', 'O', '9'],
  H: ['W', 'M', 'N'],
  I: ['1', 'L', 'J', 'W'],
  J: ['U', 'I', '1', 'L', 'T'],
  K: ['X', 'R'],
  L: ['1', 'I', 'J'],
  M: ['N', 'W', 'H'],
  N: ['M', 'H'],
  O: ['0', 'Q', 'D', 'C', 'G'],
  P: ['R', 'F', 'B'],
  Q: ['O', '0', 'D', 'C'],
  R: ['P', 'A', 'B', 'K'],
  S: ['5', '6'],
  T: ['F', '7', 'I'],
  U: ['J', 'V', '0', 'W'],
  V: ['U', 'W', 'Y'],
  W: ['M', 'H', 'V', 'A'],
  X: ['K', 'Y'],
  Y: ['V', 'X'],
  Z: ['2', '7'],

  '0': ['O', 'Q', 'D', 'C', '8', '9'],
  '1': ['I', 'L', 'J', '7'],
  '2': ['Z', '7'],
  '3': ['8', 'B', 'E'],
  '4': ['A', 'H'],
  '5': ['S', '6'],
  '6': ['G', '5', '8'],
  '7': ['T', '1', 'Z', '2'],
  '8': ['B', '3', '6', '9', '0'],
  '9': ['G', '8', 'Q', '0'],
};

// Keep multi-character confusion separate.
export const SEQUENCE_CONFUSIONS: Record<string, string[]> = {
  W: ['VV'],
  M: ['NN'],
  N: ['II'],
  H: ['II'],
  B: ['13'],
  D: ['CL'],
  U: ['LI'],
};

const STYLIZED_PREFIX_CONFUSIONS: Record<string, string[]> = {
  A: ['R'],
  R: ['A'],
};

function generateRepeatedCharacterCandidates(normalized: string): string[] {
  const results: string[] = [];
  if (!normalized || normalized.length < 3) return results;

  // Pattern 1: 2-letter prefix + digits (e.g., AN7569 -> ANN7569, AAN7569)
  const match2Letter = /^([A-Z]{2})([0-9]{1,5})$/.exec(normalized);
  if (match2Letter) {
    const p1 = match2Letter[1][0];
    const p2 = match2Letter[1][1];
    const digits = match2Letter[2];
    results.push(`${p1}${p2}${p2}${digits}`); // e.g. AN7569 -> ANN7569
    results.push(`${p1}${p1}${p2}${digits}`); // e.g. AN7569 -> AAN7569
  }

  // Pattern 2: 1-letter prefix + digits + suffix (e.g. V1212N -> VNN1212)
  const match1LetterDigitsSuffix = /^([A-Z])([0-9]{1,5})([A-Z])$/.exec(normalized);
  if (match1LetterDigitsSuffix) {
    const p1 = match1LetterDigitsSuffix[1];
    const digits = match1LetterDigitsSuffix[2];
    const s1 = match1LetterDigitsSuffix[3];
    results.push(`${p1}${s1}${s1}${digits}`); // e.g. V1212N -> VNN1212
  }

  // Pattern 3: Single digit repeat anywhere in digits (e.g., BNC15 -> BNC115, BNC155; BNC115 -> BNC1155)
  const matchSingleDigitTail = /^([A-Z]{1,3})([0-9]{1,4})$/.exec(normalized);
  if (matchSingleDigitTail) {
    const letters = matchSingleDigitTail[1];
    const digits = matchSingleDigitTail[2];
    for (let i = 0; i < digits.length; i++) {
      const expandedDigits = digits.slice(0, i) + digits[i] + digits.slice(i);
      results.push(`${letters}${expandedDigits}`);
    }
  }

  // Pattern 4: 3-letter repeated prefix deduplication (e.g. ANN7569 -> AN7569, AAN7569 -> AN7569)
  const match3LetterRepeated1 = /^([A-Z])([A-Z])\2([0-9]{1,5})$/.exec(normalized);
  if (match3LetterRepeated1) {
    results.push(`${match3LetterRepeated1[1]}${match3LetterRepeated1[2]}${match3LetterRepeated1[3]}`);
  }
  const match3LetterRepeated2 = /^([A-Z])\1([A-Z])([0-9]{1,5})$/.exec(normalized);
  if (match3LetterRepeated2) {
    results.push(`${match3LetterRepeated2[1]}${match3LetterRepeated2[2]}${match3LetterRepeated2[3]}`);
  }

  return results;
}

/**
 * Position-aware candidate generator for OCR character ambiguity.
 *
 * Rules:
 * - Replaces confused characters only at positions where confidence is low (< 0.85)
 *   or where confusion pairs exist.
 * - Caps total candidate permutations to `maxPermutations` (default 10) to prevent false-positive explosions.
 */
export function generateCandidatePlates(
  normalized: string,
  charConfidences?: CharacterConfidence[],
  maxPermutations: number = 12
): string[] {
  if (!normalized) return [];
  const candidates = new Set<string>();

  generateRepeatedCharacterCandidates(normalized).forEach((candidate) => {
    if (candidate !== normalized && candidates.size < maxPermutations) {
      candidates.add(candidate);
    }
  });
  generateSpecialPlateCandidates(normalized, maxPermutations).forEach((candidate) => {
    if (candidate !== normalized && candidates.size < maxPermutations) {
      candidates.add(candidate);
    }
  });
  generateStylizedPrefixCandidates(normalized).forEach((candidate) => {
    if (candidate !== normalized && candidates.size < maxPermutations) {
      candidates.add(candidate);
    }
  });
  const evMatch = /^EV([A-Z]{1,3}[0-9]{1,4}[A-Z]?)$/.exec(normalized);
  if (evMatch && validateMalaysianPattern(evMatch[1]).isValid && candidates.size < maxPermutations) {
    candidates.add(evMatch[1]);
  }

  // Determine candidate positions for substitution
  const candidateIndices: number[] = [];

  if (charConfidences && charConfidences.length === normalized.length) {
    // Only target characters with low confidence (< 0.85) that have confusion mappings
    charConfidences.forEach((cc, idx) => {
      if (cc.confidence < 0.85 && CONFUSION_MAP[cc.char]) {
        candidateIndices.push(idx);
      }
    });
  }

  // If no low-confidence positions specified, fallback to all matching confusion indices
  if (candidateIndices.length === 0) {
    for (let i = 0; i < normalized.length; i++) {
      if (CONFUSION_MAP[normalized[i]]) {
        candidateIndices.push(i);
      }
    }
  }

  // Generate 1-character substitution permutations.
  // Pass 1: Prioritize substitutions that yield a valid Malaysian plate pattern (e.g. WXY77B8 -> WXY7788)
  const otherSubstitutions: string[] = [];
  for (const idx of candidateIndices) {
    if (candidates.size >= maxPermutations) break;
    const char = normalized[idx];
    const replacements = CONFUSION_MAP[char];
    if (replacements) {
      for (const rep of replacements) {
        const alt = normalized.substring(0, idx) + rep + normalized.substring(idx + 1);
        if (alt !== normalized) {
          if (validateMalaysianPattern(alt).isValid) {
            candidates.add(alt);
            if (candidates.size >= maxPermutations) break;
          } else {
            otherSubstitutions.push(alt);
          }
        }
      }
    }
  }

  // Pass 2: Add remaining candidate substitutions up to limit
  for (const alt of otherSubstitutions) {
    if (candidates.size >= maxPermutations) break;
    candidates.add(alt);
  }

  return Array.from(candidates);
}

export function correctMalaysianTypographyOcr(
  raw: string,
  options: TypographyCorrectionOptions = {}
): TypographyCorrectionResult {
  const normalized = normalizePlate(raw);
  if (!normalized) {
    return { normalized: '', corrected: false, alternatives: [], reason: 'NONE' };
  }

  const alternatives = generateStylizedPrefixCandidates(normalized);

  // 1. Sabah SIF -> SWF OCR confusion (W misread as I/IF)
  const sifMatch = /^SIF([0-9]{1,5}[A-Z]?)$/.exec(normalized);
  if (sifMatch) {
    const corrected = `SWF${sifMatch[1]}`;
    return {
      normalized: corrected,
      corrected: true,
      alternatives: Array.from(new Set([corrected, normalized, ...alternatives])),
      reason: 'SABAH_STYLIZED_A',
    };
  }

  // Do not automatically rewrite VNM to VNN. Both are valid prefixes, so an
  // OCR ambiguity belongs in `alternatives`, not in the displayed reading.

  // 2. Sabah SR -> SA stylized A confusion
  const sabahStylizedA = /^SR([A-Z][0-9]{3,5}[A-Z]?)$/.exec(normalized);
  if (sabahStylizedA) {
    const rConfidence = options.characterConfidences?.find((item) => item.position === 1)?.confidence;
    const confidenceEvidence = Math.max(options.ocrConfidence ?? 0.85, rConfidence ?? 0.85);
    const corrected = `SA${sabahStylizedA[1]}`;

    if (confidenceEvidence >= 0.45) {
      return {
        normalized: corrected,
        corrected: corrected !== normalized,
        alternatives: Array.from(new Set([corrected, ...alternatives])),
        reason: 'SABAH_STYLIZED_A',
      };
    }
  }

  // 3. Malaysian JPJePlate EV side-badge (green RFID strip on the left with "MALAYSIA / EV" logo)
  // When OCR captures the green side badge, standard plates get prepended with 'E' or 'EV' (e.g. EVPK6041 -> VPK6041, EVW1234A -> W1234A).
  const singleCharBadge = /^E([A-Z]{3}[0-9]{1,4}[A-Z]?)$/.exec(normalized);
  if (singleCharBadge && validateMalaysianPattern(singleCharBadge[1]).isValid) {
    const stripped = singleCharBadge[1];
    return {
      normalized: stripped,
      corrected: true,
      alternatives: Array.from(new Set([stripped, normalized, ...alternatives])),
      reason: 'NONE',
    };
  }

  const doubleCharBadge = /^EV([A-Z]{1,3}[0-9]{1,4}[A-Z]?)$/.exec(normalized);
  if (doubleCharBadge && validateMalaysianPattern(doubleCharBadge[1]).isValid) {
    const stripped = doubleCharBadge[1];
    return {
      normalized: stripped,
      corrected: true,
      alternatives: Array.from(new Set([stripped, normalized, ...alternatives])),
      reason: 'NONE',
    };
  }

  return { normalized, corrected: false, alternatives, reason: 'NONE' };
}

function generateStylizedPrefixCandidates(normalized: string): string[] {
  const match = /^([A-Z]{1,3})([0-9]{1,5}[A-Z]{0,2})$/.exec(normalized);
  if (!match) return [];

  const [, prefix, suffix] = match;
  const candidates = new Set<string>();

  for (let index = 0; index < prefix.length; index++) {
    const replacements = STYLIZED_PREFIX_CONFUSIONS[prefix[index]];
    if (!replacements) continue;

    replacements.forEach((replacement) => {
      candidates.add(`${prefix.slice(0, index)}${replacement}${prefix.slice(index + 1)}${suffix}`);
    });
  }

  return Array.from(candidates);
}

/**
 * Calculates Levenshtein Distance between two normalized strings.
 */
export function getLevenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Returns true when OCR likely collapsed a repeated plate character.
 *
 * Example: AN7569 -> ANN7569 is safe because deleting one of the adjacent Ns
 * from the database plate reproduces the OCR text exactly.
 */
export function isRepeatedCharacterOmission(ocrReading: string, candidatePlate: string): boolean {
  const normOcr = normalizePlate(ocrReading);
  const normCandidate = normalizePlate(candidatePlate);

  if (!normOcr || normCandidate.length !== normOcr.length + 1) return false;

  for (let i = 0; i < normCandidate.length; i++) {
    const leftSame = i > 0 && normCandidate[i] === normCandidate[i - 1];
    const rightSame = i < normCandidate.length - 1 && normCandidate[i] === normCandidate[i + 1];
    if (!leftSame && !rightSame) continue;

    const withoutChar = normCandidate.slice(0, i) + normCandidate.slice(i + 1);
    if (withoutChar === normOcr) return true;
  }

  return false;
}

/**
 * Evaluates whether plate A and plate B form a "Possible Match".
 * Returns true if Levenshtein distance === 1 OR if they match via candidate confusion substitution.
 */
export function isPossibleMatch(plateA: string, plateB: string): boolean {
  const normA = normalizePlate(plateA);
  const normB = normalizePlate(plateB);

  if (normA === normB) return false; // Exact match

  // Check 1-char edit distance
  if (Math.abs(normA.length - normB.length) <= 1) {
    const dist = getLevenshteinDistance(normA, normB);
    if (dist === 1) return true;
  }

  // Check confusion candidates
  const candidatesA = generateCandidatePlates(normA);
  if (candidatesA.includes(normB)) return true;

  return false;
}

export interface JPJExclusionResult {
  isValid: boolean;
  penalizedChar?: string;
  reason?: string;
}

/**
 * Validates candidate string against JPJ Malaysian regulation letter exclusion rules.
 * Standard Peninsular vehicle registration numbers exclude letters 'I' and 'O' in letter positions
 * to prevent confusion with numbers '1' and '0'.
 */
export function validateJPJExclusionRules(rawPlate: string): JPJExclusionResult {
  const norm = normalizePlate(rawPlate);
  if (!norm || norm.length < 2) return { isValid: true };

  // Skip special, diplomatic, government, or long institutional series
  if (findSpecialSeriesPrefix(norm)) return { isValid: true };
  if (/^(DP|DC|CC|UN|EV|PUTRAJAYA|POLIS|JKR|TDM|TLDM|TUDM)/.test(norm)) return { isValid: true };

  // Standard Peninsular / Sabah / Sarawak regex structure: [Prefix Letters][Digits 1-5][Suffix Letter?]
  const stdMatch = /^([A-Z]{1,3})([0-9]{1,5})([A-Z]?)$/.exec(norm);
  if (stdMatch) {
    const prefix = stdMatch[1];
    const suffix = stdMatch[3];

    // Check letter I or O in prefix or suffix
    if (prefix.includes('I') || prefix.includes('O')) {
      const badChar = prefix.includes('I') ? 'I' : 'O';
      return {
        isValid: false,
        penalizedChar: badChar,
        reason: `JPJ excludes letter '${badChar}' in standard plate prefix`,
      };
    }
    if (suffix === 'I' || suffix === 'O') {
      return {
        isValid: false,
        penalizedChar: suffix,
        reason: `JPJ excludes letter '${suffix}' in standard plate suffix`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Returns typographic penalty score (0.0 = compliant, 0.30 = violates JPJ exclusion rules).
 */
export function getJPJTypographicPenalty(rawPlate: string): number {
  const validation = validateJPJExclusionRules(rawPlate);
  return validation.isValid ? 0.0 : 0.30;
}
