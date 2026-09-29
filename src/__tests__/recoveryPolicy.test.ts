import type { PreprocessVariant } from '../lib/anpr/imageProcessor';
import { describe, expect, it } from 'vitest';
import { planOcrRecovery, planDetectorRecovery, environmentRecoveryVariants, selectOcrRecoveryCandidates } from '../lib/anpr/recoveryPolicy';
import { preprocessCropVariant } from '../lib/anpr/imageProcessor';
import { applyClahe } from '../lib/anpr/localContrast';
import { addOcrVoteToTrack, evaluateConsensus } from '../lib/anpr/consensus';
import { PlateTracker } from '../lib/anpr/tracker';

describe('model-directed recovery', () => {
  it.each([
    ['GLARE_REFLECTION', 'HIGHLIGHT_REDUCED'], ['MOTION_BLUR', 'SHARPEN'],
    ['OUT_OF_FOCUS', 'SHARPEN'], ['BAD_ANGLE', 'PERSPECTIVE_LEFT'],
    ['UNDEREXPOSED', 'GAMMA_BRIGHTEN'],
  ] as const)('routes %s to its correction on the first pass', (quality, variant) => {
    expect(planOcrRecovery(quality, 'DAY', 0)).toEqual(['ORIGINAL', variant]);
  });
  it('alternates exposure and tile recovery without relying on a night label', () => {
    expect(planDetectorRecovery('DAY', 0)).toBe('CLAHE');
    expect(planDetectorRecovery('NIGHT', 0)).toBe('GAMMA_BRIGHTEN');
    expect(planDetectorRecovery('NIGHT', 1)).toBeUndefined();
    expect(planDetectorRecovery('NIGHT', 2)).toBe('CLAHE');
  });
  it('keeps exposure recovery active for a dark PARKING scene', () => {
    const stats = { brightness: 0.12, contrast: 0.3, glareRatio: 0.01, blurScore: 0.5, motionScore: 0, dirtyLensScore: 0 };
    expect(planOcrRecovery('GOOD', 'PARKING', 0, [], stats)).toEqual(['ORIGINAL', 'GAMMA_BRIGHTEN']);
    expect(planDetectorRecovery('PARKING', 0, stats)).toBe('GAMMA_BRIGHTEN');
  });
  it('uses different angle corrections across retries', () => {
    expect([0, 1, 2].map(attempt => planOcrRecovery('BAD_ANGLE', 'DAY', attempt)[1]))
      .toEqual(['PERSPECTIVE_LEFT', 'PERSPECTIVE_RIGHT', 'PERSPECTIVE']);
  });
  it('lets the night model guide a GOOD crop and preserves the clean-day fast path', () => {
    expect(planOcrRecovery('GOOD', 'NIGHT', 0)).toEqual(['ORIGINAL', 'GAMMA_BRIGHTEN']);
    expect(planOcrRecovery('GOOD', 'DAY', 0)).toEqual(['ORIGINAL']);
    expect(environmentRecoveryVariants('GLARE')).toContain('HIGHLIGHT_REDUCED');
  });
  it('does not let inner crops crowd a targeted correction out of the OCR budget', () => {
    const original: { variant: PreprocessVariant } = { variant: 'ORIGINAL' };
    const corrected = { variant: 'CLAHE' as const };
    const inner = { variant: 'ORIGINAL' as const };
    expect(selectOcrRecoveryCandidates(original, [corrected], [inner], true, 0, 2)).toEqual([original, corrected]);
    expect(selectOcrRecoveryCandidates(original, [corrected], [inner], true, 1, 1)).toEqual([corrected]);
    expect(selectOcrRecoveryCandidates(original, [corrected], [inner], true, 1, 2)).toEqual([corrected, inner]);
  });
  it('upgrades an enhanced source observation without inflating temporal evidence', () => {
    const track = new PlateTracker(15, 8, 1).updateTracks([{ x: 0, y: 0, width: 100, height: 40, confidence: 0.95 }])[0];
    addOcrVoteToTrack(track, 'MEA123', 0.7, 1, 1000);
    addOcrVoteToTrack(track, 'NEA123', 0.96, 1, 1000);
    expect(track.votes.has('MEA123')).toBe(false);
    const result = evaluateConsensus(track, 2, 0.90);
    expect(result.normalizedPlate).toBe('NEA123');
    expect(result.totalVotes).toBe(1);
    expect(result.isStabilized).toBe(false);
  });
});

describe('local contrast recovery', () => {
  it('retains grey detail instead of reducing the image to two levels', () => {
    const data = new Uint8ClampedArray(64 * 32 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = 60 + (i / 4) % 64;
      data[i + 3] = 255;
    }
    const ctx = {
      getImageData: () => ({ data }),
      putImageData: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    preprocessCropVariant(ctx, 64, 32, 'CLAHE');
    expect(new Set(Array.from(data).filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(20);
    expect(Array.from(data).filter((_, i) => i % 4 === 3).every(value => value === 255)).toBe(true);
  });
  it('does not manufacture detail in saturated or flat pixels', () => {
    const data = new Uint8ClampedArray(32 * 32 * 4).fill(255);
    applyClahe(data, 32, 32);
    expect(data.every(value => value === 255)).toBe(true);
  });
});
