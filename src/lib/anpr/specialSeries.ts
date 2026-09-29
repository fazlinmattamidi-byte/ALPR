export const SPECIAL_SERIES_STORAGE_KEY = 'plateq_special_series_prefixes';

export const DEFAULT_SPECIAL_SERIES_PREFIXES = [
  'MALAYSIA',
  'MADANI',
  'GOLD',
  'PUTRAJAYA',
  'PERODUA',
  'PROTON',
  'LOTUS',
  'WWW',
  'VIP',
  'FF',
  'QV',
  'PATRIOT',
  'PETRA',
  'BAMBEE',
  'G1M',
  'PERFECT',
  'RIMAU',
  'NAVY',
  'AIRFORCE',
  'SUKMA',
  'JAGUH',
  'NAAM',
  'A1M',
  'M1M',
  'T1M',
  'K1M',
  'NBOS',
  'RAPID',
  'GTR',
  'GT',
  'YY',
  'UU',
  'UG',
  'XX',
  'X',
  'Y',
  'G',
  'GG',
  'GP',
  'SAS',
  'SAM',
  'SMS',
  'PERHUTANAN',
  '1MALAYSIA',
  'LIMO',
  'TEG',
  'UPM',
  'UTM',
  'UKM',
  'USM',
  'UUM',
  'UIM',
  'UITM',
  'UMT',
  'UMP',
  'UIA',
  'IIUM',
  'UTEM',
  'UTHM',
  'UNIMAP',
  'UNIMAS',
  'UMS',
  'UNIZAS',
  'UPNM',
  'USIM',
  'XXVIASEAN',
  'ASEAN',
] as const;

type RuntimeSpecialSeriesWindow = Window &
  typeof globalThis & {
    __PLATEQ_SPECIAL_SERIES_PREFIXES__?: string[] | string;
  };

export interface SpecialPlateCorrectionResult {
  normalized: string;
  corrected: boolean;
  reason: 'NONE' | 'PREFIX_PROBABILITY' | 'FUTURE_SPECIAL_PREFIX';
  alternatives: string[];
}

export interface SpecialPlateCorrectionOptions {
  ocrConfidence?: number;
  characterConfidences?: Array<{
    char: string;
    confidence: number;
    position?: number;
  }>;
  minPrefixProbability?: number;
}

export interface PrefixProbabilityCandidate {
  plate: string;
  prefix: string;
  observedPrefix: string;
  observedSuffix: string;
  numericSuffix: string;
  editDistance: number;
  prefixProbability: number;
  suffixProbability: number;
  confidenceEvidence: number;
  score: number;
}

const OCR_TO_ALPHA: Record<string, string> = {
  '0': 'O',
  '1': 'I',
  '2': 'Z',
  '4': 'A',
  '5': 'S',
  '6': 'G',
  '7': 'T',
  '8': 'B',
};

const OCR_TO_DIGIT: Record<string, string> = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  Z: '2',
  A: '4',
  S: '5',
  G: '6',
  T: '7',
  B: '8',
};

let runtimeSpecialSeriesPrefixes: string[] = [];

function sanitizePrefix(prefix: string): string {
  return prefix.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parsePrefixList(value?: string[] | string | null): string[] {
  if (!value) return [];
  const rawItems = Array.isArray(value) ? value : value.split(/[,;\s]+/);
  return rawItems
    .map(sanitizePrefix)
    .filter((prefix) => /^[A-Z0-9]{2,15}$/.test(prefix));
}

function getExternalConfiguredPrefixes(): string[] {
  const envPrefixes =
    typeof process !== 'undefined'
      ? parsePrefixList(process.env?.NEXT_PUBLIC_PLATEQ_SPECIAL_SERIES_PREFIXES)
      : [];

  if (typeof window === 'undefined') return envPrefixes;

  const runtimeWindow = window as RuntimeSpecialSeriesWindow;
  const globalPrefixes = parsePrefixList(runtimeWindow.__PLATEQ_SPECIAL_SERIES_PREFIXES__);

  let storedPrefixes: string[] = [];
  try {
    storedPrefixes = parsePrefixList(window.localStorage?.getItem(SPECIAL_SERIES_STORAGE_KEY));
  } catch {
    storedPrefixes = [];
  }

  return [...envPrefixes, ...globalPrefixes, ...storedPrefixes];
}

export function setRuntimeSpecialSeriesPrefixes(prefixes: string[]): void {
  runtimeSpecialSeriesPrefixes = parsePrefixList(prefixes);
}

export function resetRuntimeSpecialSeriesPrefixes(): void {
  runtimeSpecialSeriesPrefixes = [];
}

export function getSpecialSeriesPrefixes(): string[] {
  return Array.from(
    new Set([
      ...DEFAULT_SPECIAL_SERIES_PREFIXES,
      ...runtimeSpecialSeriesPrefixes,
      ...getExternalConfiguredPrefixes(),
    ].map(sanitizePrefix).filter(Boolean))
  ).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function getSpecialSeriesPrefixPatternSource(): string {
  return getSpecialSeriesPrefixes()
    .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

export function findSpecialSeriesPrefix(normalizedPlate: string): string | null {
  const normalized = normalizeAlnum(normalizedPlate);
  return getSpecialSeriesPrefixes().find((prefix) => normalized.startsWith(prefix)) ?? null;
}

export function isConfiguredSpecialSeriesCandidate(normalizedPlate: string): boolean {
  const normalized = normalizeAlnum(normalizedPlate);
  const prefix = findSpecialSeriesPrefix(normalized);
  if (!prefix) return false;
  const suffix = normalized.slice(prefix.length);
  return /^[0-9]{1,5}[A-Z]?$/.test(suffix);
}

export function isFutureSpecialSeriesCandidate(normalizedPlate: string): boolean {
  const normalized = normalizeAlnum(normalizedPlate);
  if (isConfiguredSpecialSeriesCandidate(normalized)) return false;

  const match = /^([A-Z]{4,12})([0-9]{1,5}[A-Z]?)$/.exec(normalized);
  if (!match) return false;

  const prefix = match[1];
  if (/^(POLIS|KASTAM|PRISON|JKR|PUTRAJAYA)$/.test(prefix)) return false;

  return true;
}

export function isPotentialSpecialSeriesCandidate(normalizedPlate: string): boolean {
  const normalized = normalizeAlnum(normalizedPlate);
  if (!normalized) return false;
  if (isConfiguredSpecialSeriesCandidate(normalized) || isFutureSpecialSeriesCandidate(normalized)) return true;
  return /^[A-Z0-9]{4,15}$/.test(normalized) &&
    rankSpecialSeriesPrefixCandidates(normalized, { minPrefixProbability: 0.64 }).length > 0;
}

export function correctMalaysianPlateOcr(
  raw: string,
  options: SpecialPlateCorrectionOptions = {}
): SpecialPlateCorrectionResult {
  const normalized = normalizeAlnum(raw);
  if (!normalized) {
    return { normalized: '', corrected: false, reason: 'NONE', alternatives: [] };
  }

  if (isProtectedStandardPlateShape(normalized)) {
    return { normalized, corrected: false, reason: 'NONE', alternatives: [] };
  }

  const prefixCandidates = rankSpecialSeriesPrefixCandidates(normalized, options);
  const futureCorrection = buildFutureSpecialCorrection(normalized, options);
  const alternatives = Array.from(
    new Set([
      ...prefixCandidates.map((item) => item.plate),
      futureCorrection?.plate,
    ].filter(Boolean) as string[])
  );
  const best = [
    ...prefixCandidates.map((candidate) => ({
      plate: candidate.plate,
      score: candidate.score,
      reason: 'PREFIX_PROBABILITY' as const,
    })),
    ...(futureCorrection ? [futureCorrection] : []),
  ].sort((a, b) => b.score - a.score)[0];

  if (!best) {
    return { normalized, corrected: false, reason: 'NONE', alternatives };
  }

  return {
    normalized: best.plate,
    corrected: best.plate !== normalized,
    reason: best.reason,
    alternatives,
  };
}

export function generateSpecialPlateCandidates(
  raw: string,
  maxCandidates = 12,
  options: SpecialPlateCorrectionOptions = {}
): string[] {
  const correction = correctMalaysianPlateOcr(raw, options);
  return Array.from(new Set([correction.normalized, ...correction.alternatives].filter(Boolean))).slice(0, maxCandidates);
}

export function rankSpecialSeriesPrefixCandidates(
  raw: string,
  options: SpecialPlateCorrectionOptions = {}
): PrefixProbabilityCandidate[] {
  const normalized = normalizeAlnum(raw);
  if (!normalized) return [];

  const minScore = options.minPrefixProbability ?? 0.70;
  const byPlate = new Map<string, PrefixProbabilityCandidate>();

  for (const prefix of getSpecialSeriesPrefixes()) {
    const takeLengths = buildPrefixTakeLengths(prefix.length, normalized.length);

    for (const takeLength of takeLengths) {
      const observedRawPrefix = normalized.slice(0, takeLength);
      const observedPrefix = toAlphaEquivalent(observedRawPrefix);
      if (!observedPrefix) continue;

      const observedSuffix = normalized.slice(takeLength);
      const numericSuffix = toDigitString(observedSuffix);
      if (!/^[0-9]{1,5}$/.test(numericSuffix)) continue;
      if (numericSuffix.length !== observedSuffix.length) continue;

      const editDistance = levenshteinDistance(observedPrefix, prefix);
      if (editDistance > getMaxPrefixDistance(prefix, options.ocrConfidence)) continue;

      const prefixProbability = scorePrefixProbability(prefix, observedRawPrefix, observedPrefix, editDistance);
      const suffixProbability = scoreSuffixProbability(observedSuffix, numericSuffix);
      const confidenceEvidence = getConfidenceEvidence(options, takeLength, observedSuffix.length);
      const numberLengthPrior = Math.min(1, numericSuffix.length / 4);
      const score =
        prefixProbability * 0.58 +
        suffixProbability * 0.22 +
        confidenceEvidence * 0.15 +
        numberLengthPrior * 0.05;

      if (score < minScore) continue;

      const plate = `${prefix}${numericSuffix}`;
      const candidate: PrefixProbabilityCandidate = {
        plate,
        prefix,
        observedPrefix,
        observedSuffix,
        numericSuffix,
        editDistance,
        prefixProbability,
        suffixProbability,
        confidenceEvidence,
        score,
      };

      const existing = byPlate.get(plate);
      if (!existing || candidate.score > existing.score) {
        byPlate.set(plate, candidate);
      }
    }
  }

  return Array.from(byPlate.values()).sort((a, b) => b.score - a.score);
}

function isProtectedStandardPlateShape(normalized: string): boolean {
  if (isConfiguredSpecialSeriesCandidate(normalized)) return false;
  if (/^[A-Z]{1,3}[0-9]{1,5}[A-Z]{0,2}$/.test(normalized)) return true;
  if (/^EV[A-Z]{0,2}[0-9]{1,5}[A-Z]?$/.test(normalized)) return true;
  if (/^KV[0-9]{1,5}[A-Z]?$/.test(normalized)) return true;
  if (/^(SA|SB|SD|SK|SS|ST|SU|SW|S)[A-Z]{0,2}[0-9]{1,5}[A-Z]?$/.test(normalized)) return true;
  if (/^(QA|QB|QC|QD|QK|QL|QP|QR|QS|QT|Q)[A-Z]{0,2}[0-9]{1,5}[A-Z]?$/.test(normalized)) return true;
  return false;
}

function buildFutureSpecialCorrection(
  normalized: string,
  options: SpecialPlateCorrectionOptions
): { plate: string; score: number; reason: SpecialPlateCorrectionResult['reason'] } | null {
  for (let prefixLength = Math.min(12, normalized.length - 1); prefixLength >= 4; prefixLength--) {
    const rawPrefix = normalized.slice(0, prefixLength);
    const rawDigitCount = (rawPrefix.match(/[0-9]/g) || []).length;
    if (rawDigitCount > 1) continue;

    const prefix = toAlphaEquivalent(normalized.slice(0, prefixLength));
    const observedSuffix = normalized.slice(prefixLength);
    const numericSuffix = toDigitString(observedSuffix);
    if (numericSuffix.length !== observedSuffix.length) continue;

    if (/^[A-Z]{4,12}$/.test(prefix) && /^[0-9]{1,5}$/.test(numericSuffix)) {
      const confidenceEvidence = getConfidenceEvidence(options, prefixLength, numericSuffix.length);
      return {
        plate: `${prefix}${numericSuffix}`,
        score: 0.62 + confidenceEvidence * 0.08 + Math.min(0.08, numericSuffix.length * 0.01),
        reason: 'FUTURE_SPECIAL_PREFIX',
      };
    }
  }

  return null;
}

function buildPrefixTakeLengths(prefixLength: number, normalizedLength: number): number[] {
  const minLength = Math.max(1, prefixLength - 2);
  const maxLength = Math.min(normalizedLength - 1, prefixLength + 2);
  const preferred = [prefixLength, prefixLength - 1, prefixLength + 1, prefixLength - 2, prefixLength + 2];

  return Array.from(new Set(preferred))
    .filter((length) => length >= minLength && length <= maxLength)
    .sort((a, b) => Math.abs(a - prefixLength) - Math.abs(b - prefixLength));
}

function getMaxPrefixDistance(prefix: string, ocrConfidence = 0.86): number {
  if (prefix.length >= 7) return ocrConfidence >= 0.78 ? 2 : 1;
  if (prefix.length >= 4) return 1;
  if (prefix.length >= 3) return ocrConfidence >= 0.88 ? 1 : 0;
  return 0;
}

function scorePrefixProbability(
  prefix: string,
  observedRawPrefix: string,
  observedPrefix: string,
  editDistance: number
): number {
  const maxLen = Math.max(prefix.length, observedPrefix.length, 1);
  const editSimilarity = 1 - editDistance / maxLen;
  const positionalSimilarity = scorePositionalPrefixSimilarity(prefix, observedRawPrefix);
  const lengthSkew = Math.abs(prefix.length - observedPrefix.length);
  const prefixLengthPrior = Math.min(1, prefix.length / 8);
  const digitConfusionDensity = (observedRawPrefix.match(/[0-9]/g) || []).length /
    Math.max(1, observedRawPrefix.length);

  return clampNumber(
    editSimilarity * 0.58 +
      positionalSimilarity * 0.32 +
      prefixLengthPrior * 0.10 +
      Math.min(0.04, digitConfusionDensity * 0.08) -
      lengthSkew * 0.03,
    0,
    1
  );
}

function scorePositionalPrefixSimilarity(prefix: string, observedRawPrefix: string): number {
  const comparedLength = Math.max(prefix.length, observedRawPrefix.length, 1);
  let score = 0;

  for (let index = 0; index < comparedLength; index++) {
    const target = prefix[index];
    const observedRaw = observedRawPrefix[index];

    if (!target || !observedRaw) {
      score += 0.18;
    } else {
      score += scoreObservedPrefixChar(observedRaw, target);
    }
  }

  return clampNumber(score / comparedLength, 0, 1);
}

function scoreObservedPrefixChar(observedRaw: string, target: string): number {
  const alpha = OCR_TO_ALPHA[observedRaw] || observedRaw;
  if (alpha === target) return /[0-9]/.test(observedRaw) ? 0.9 : 1;
  if (isLikelyAlphaConfusion(alpha, target)) return 0.72;
  return 0.18;
}

function isLikelyAlphaConfusion(observed: string, target: string): boolean {
  const confusions: Record<string, string[]> = {
    A: ['R'],
    B: ['R'],
    D: ['O', 'Q'],
    I: ['L'],
    L: ['I'],
    O: ['D', 'Q'],
    Q: ['O', 'D'],
    R: ['A', 'B'],
    S: ['Z'],
    U: ['V'],
    V: ['U', 'Y'],
    Y: ['V'],
    Z: ['S'],
  };

  return confusions[target]?.includes(observed) ?? false;
}

function scoreSuffixProbability(observedSuffix: string, numericSuffix: string): number {
  if (!observedSuffix || observedSuffix.length !== numericSuffix.length) return 0;
  let converted = 0;

  for (let index = 0; index < observedSuffix.length; index++) {
    const observed = observedSuffix[index];
    if (observed === numericSuffix[index]) continue;
    if (OCR_TO_DIGIT[observed] === numericSuffix[index]) {
      converted++;
      continue;
    }
    return 0;
  }

  const conversionRatio = converted / Math.max(1, observedSuffix.length);
  const lengthPrior = Math.min(0.04, numericSuffix.length * 0.01);
  return clampNumber(0.97 - conversionRatio * 0.12 + lengthPrior, 0, 1);
}

function getConfidenceEvidence(
  options: SpecialPlateCorrectionOptions,
  prefixLength: number,
  suffixLength: number
): number {
  const confidences = options.characterConfidences
    ?.slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((item) => clampNumber(item.confidence, 0, 1))
    .filter((confidence) => Number.isFinite(confidence));

  if (confidences && confidences.length > 0) {
    const relevant = confidences.slice(0, Math.max(1, prefixLength + suffixLength));
    return relevant.reduce((sum, value) => sum + value, 0) / relevant.length;
  }

  if (typeof options.ocrConfidence === 'number') {
    return clampNumber(options.ocrConfidence, 0, 1);
  }

  return 0.86;
}

function normalizeAlnum(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toAlphaEquivalent(value: string): string {
  return value
    .split('')
    .map((char) => OCR_TO_ALPHA[char] || char)
    .join('')
    .replace(/[^A-Z]/g, '');
}

function toDigitString(value: string): string {
  return value
    .split('')
    .map((char) => {
      if (/[0-9]/.test(char)) return char;
      return OCR_TO_DIGIT[char] || '';
    })
    .join('');
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? previous
        : Math.min(previous + 1, row[j] + 1, row[j - 1] + 1);
      previous = temp;
    }
  }

  return row[b.length];
}
