import { CharacterConfidence, PlateCategory, PlateLayout } from '../db/types';

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
export function formatDisplayPlate(normalized: string, category?: PlateCategory): string {
  if (!normalized) return '';

  // EV Special
  if (normalized.startsWith('EV') && normalized.length > 2) {
    return `EV ${normalized.substring(2)}`;
  }

  // Langkawi with Suffix: KV 1234 E
  if (normalized.startsWith('KV') && /[0-9]+[A-Z]$/.test(normalized)) {
    const digits = normalized.substring(2, normalized.length - 1);
    const suffix = normalized.charAt(normalized.length - 1);
    return `KV ${digits} ${suffix}`;
  }

  // Peninsular with Suffix: W 1234 A
  const matchSuffix = /^([A-Z]{1,3})([0-9]{1,4})([A-Z])$/.exec(normalized);
  if (matchSuffix) {
    return `${matchSuffix[1]} ${matchSuffix[2]} ${matchSuffix[3]}`;
  }

  // Standard 1-3 letters + digits: JSD 8888
  const matchStd = /^([A-Z]{1,4})([0-9]{1,4})$/.exec(normalized);
  if (matchStd) {
    return `${matchStd[1]} ${matchStd[2]}`;
  }

  return normalized;
}

/**
 * Character confusion map for OCR ambiguity in Malaysian license plates
 */

export const CONFUSION_MAP: Record<string, string[]> = {
  'O': ['0'],
  '0': ['O', 'Q', 'D'],
  'I': ['1', 'L'],
  '1': ['I', 'L'],
  'L': ['1', 'I'],
  'B': ['8'],
  '8': ['B'],
  'S': ['5'],
  '5': ['S'],
  'Z': ['2'],
  '2': ['Z'],
  'G': ['6'],
  '6': ['G'],
  'A': ['4'],
  '4': ['A'],
  'T': ['7'],
  '7': ['T'],
  'D': ['0', 'O'],
  'Q': ['0', 'O'],
};

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
  maxPermutations: number = 10
): string[] {
  if (!normalized) return [];
  const candidates = new Set<string>();

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

  // Generate 1-character substitution permutations first
  for (const idx of candidateIndices) {
    if (candidates.size >= maxPermutations) break;
    const char = normalized[idx];
    const replacements = CONFUSION_MAP[char];
    if (replacements) {
      for (const rep of replacements) {
        if (candidates.size >= maxPermutations) break;
        const alt = normalized.substring(0, idx) + rep + normalized.substring(idx + 1);
        if (alt !== normalized) {
          candidates.add(alt);
        }
      }
    }
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
