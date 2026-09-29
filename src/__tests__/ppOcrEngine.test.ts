import { describe, it, expect } from 'vitest';
import {
  normalizePlate,
  formatDisplayPlate,
  generateCandidatePlates,
  correctMalaysianTypographyOcr,
} from '../lib/anpr/normaliser';
import { validateMalaysianPattern } from '../lib/anpr/patterns';
import { chooseBestOcrCandidate, buildPpOcrResult } from '../lib/anpr/ppOcrEngine';

interface LabeledOcrTestCase {
  id: string;
  category: 'REPEATED_CHARS' | 'SUFFIX_LETTER' | 'TWO_LINE' | 'WHITE_BG' | 'BLURRED' | 'NO_TEXT';
  rawTextInput: string;
  expectedPlate: string;
  expectedCategory: string;
  shouldPass: boolean;
}

describe('PP-OCR Labeled Recognition & Pattern Test Suite', () => {

  const testCases: LabeledOcrTestCase[] = [
    // Repeated Character Cases
    {
      id: 'rep-1',
      category: 'REPEATED_CHARS',
      rawTextInput: 'JSD8888',
      expectedPlate: 'JSD8888',
      expectedCategory: 'STANDARD',
      shouldPass: true,
    },
    {
      id: 'rep-2',
      category: 'REPEATED_CHARS',
      rawTextInput: 'AAA1111',
      expectedPlate: 'AAA1111',
      expectedCategory: 'STANDARD',
      shouldPass: true,
    },
    {
      id: 'rep-3',
      category: 'REPEATED_CHARS',
      rawTextInput: 'WXY7788',
      expectedPlate: 'WXY7788',
      expectedCategory: 'STANDARD',
      shouldPass: true,
    },

    // Suffix Letter Plates
    {
      id: 'suf-1',
      category: 'SUFFIX_LETTER',
      rawTextInput: 'KV1234E',
      expectedPlate: 'KV1234E',
      expectedCategory: 'LANGKAWI',
      shouldPass: true,
    },
    {
      id: 'suf-2',
      category: 'SUFFIX_LETTER',
      rawTextInput: 'W1234A',
      expectedPlate: 'W1234A',
      expectedCategory: 'STANDARD',
      shouldPass: true,
    },

    // Two-Line Plates (Combined Raw Inputs)
    {
      id: 'twoline-1',
      category: 'TWO_LINE',
      rawTextInput: 'WAA\n8888',
      expectedPlate: 'WAA8888',
      expectedCategory: 'STANDARD',
      shouldPass: true,
    },

    // White Background JPJePlate / Diplomatic / EV Plates
    {
      id: 'whitebg-1',
      category: 'WHITE_BG',
      rawTextInput: '12-34-DC',
      expectedPlate: '1234DC',
      expectedCategory: 'DIPLOMATIC',
      shouldPass: true,
    },

    // Blurred / Low Confidence Input
    {
      id: 'blur-1',
      category: 'BLURRED',
      rawTextInput: 'V B 1 2 3',
      expectedPlate: 'VB123',
      expectedCategory: 'STANDARD',
      shouldPass: true,
    },

    // No Text Crop
    {
      id: 'notext-1',
      category: 'NO_TEXT',
      rawTextInput: '',
      expectedPlate: '',
      expectedCategory: 'UNKNOWN',
      shouldPass: false,
    },
  ];

  testCases.forEach((tc) => {
    it(`[${tc.category}] ${tc.id}: ${tc.rawTextInput || 'BLANK'} -> ${tc.expectedPlate}`, () => {
      const norm = normalizePlate(tc.rawTextInput);
      expect(norm).toBe(tc.expectedPlate);

      if (tc.shouldPass) {
        const pattern = validateMalaysianPattern(norm);
        expect(pattern.score).toBeGreaterThan(0.0);
        
        const display = formatDisplayPlate(norm, pattern.category);
        expect(display).toBeTruthy();

        // Verify alternative candidates generation works without infinite loops
        const mockCharConfs = norm.split('').map((char, i) => ({ char, confidence: 0.9, position: i }));
        const alts = generateCandidatePlates(norm, mockCharConfs);
        expect(Array.isArray(alts)).toBe(true);
      }
    });
  });

  it('generates recovery candidates for repeated, substituted, and missing plate characters', () => {
    expect(generateCandidatePlates('BNC15')).toContain('BNC115');
    expect(generateCandidatePlates('AN7569')).toContain('ANN7569');
    expect(generateCandidatePlates('WYS460')).toContain('WYS4460');
    expect(generateCandidatePlates('BOF902')).toContain('BQF902');
    expect(generateCandidatePlates('VDG534')).toContain('VDG5534');
    expect(generateCandidatePlates('IAM1284')).toContain('WAM1284');
    expect(generateCandidatePlates('AEA7567')).toContain('NEA7567');
  });

  it('selects valid full-crop single-line candidate over broken split-line fragments', () => {
    const singleLineFull = buildPpOcrResult('BAD3000', 0.88, [
      { char: 'B', confidence: 0.88, position: 0 },
      { char: 'A', confidence: 0.88, position: 1 },
      { char: 'D', confidence: 0.88, position: 2 },
      { char: '3', confidence: 0.88, position: 3 },
      { char: '0', confidence: 0.88, position: 4 },
      { char: '0', confidence: 0.88, position: 5 },
      { char: '0', confidence: 0.88, position: 6 },
    ], 'SINGLE_LINE');

    const splitGarbage = buildPpOcrResult('0A', 0.19, [
      { char: '0', confidence: 0.19, position: 0 },
      { char: 'A', confidence: 0.19, position: 1 },
    ], 'TWO_LINE');

    const best = chooseBestOcrCandidate([splitGarbage, singleLineFull]);
    expect(best).not.toBeNull();
    expect(best?.normalizedPlate).toBe('BAD3000');
    expect(best?.confidence).toBe(0.88);
  });

  it('normalizes Malaysian JPJePlate EV green badge prefixes (e.g. EVPK6041 -> VPK6041)', () => {
    const evTesla = correctMalaysianTypographyOcr('EVPK6041');
    expect(evTesla.corrected).toBe(true);
    expect(evTesla.normalized).toBe('VPK6041');

    const evKlang = correctMalaysianTypographyOcr('EVW1234A');
    expect(evKlang.corrected).toBe(true);
    expect(evKlang.normalized).toBe('W1234A');
  });
});
