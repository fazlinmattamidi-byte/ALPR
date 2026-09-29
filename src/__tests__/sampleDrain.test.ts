import { afterEach, describe, expect, it, vi } from 'vitest';
import { canDrainOcrCrop, OcrWorkPool, shouldContinueSampleDrain, VideoFrameAdmission } from '../lib/anpr/liveScheduling';
import { addOcrVoteToTrack, evaluateConsensus } from '../lib/anpr/consensus';
import { PlateTracker } from '../lib/anpr/tracker';
import { chooseBestOcrCandidate, type PpOcrRecognitionResult } from '../lib/anpr/ppOcrEngine';
import { chooseBestRecognitionResult } from '../lib/anpr/ocrEngine';
import { BestFrameSelector } from '../lib/anpr/bestFrameSelector';

vi.mock('../lib/anpr/qualityAssessor', () => ({
  assessCropQuality: () => ({ overallScore: 0.9, sharpnessScore: 0.9, aspectRatioScore: 0.9, contrastScore: 0.9, motionBlurScore: 0.1, isPartialCrop: false }),
}));
afterEach(() => { vi.useRealTimers(); });

function track() {
  return new PlateTracker(15, 8, 1).updateTracks([{ x: 0, y: 0, width: 120, height: 40, confidence: 0.95 }])[0];
}

describe('sample completion drains captured evidence', () => {
  it('waits for the final detector frame before declaring completion', () => {
    expect(shouldContinueSampleDrain(0, true, false, 1000, 15000)).toBe(true);
  });
  it('keeps two queued readings alive after playback and the admission deadline', async () => {
    vi.useFakeTimers();
    const pool = new OcrWorkPool();
    const results: string[] = [];
    const jobs = ['SWF3587', 'VNM1212'].map((plate, i) => {
      const release = pool.acquire(plate, 2)!;
      return new Promise<void>(resolve => setTimeout(() => {
        results.push(plate); release(); resolve();
      }, 6000 + i * 1000));
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(shouldContinueSampleDrain(pool.activeCount, false, false, 5000, 5000)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(jobs);
    expect(results).toEqual(['SWF3587', 'VNM1212']);
    expect(shouldContinueSampleDrain(pool.activeCount, false, false, 7000, 5000)).toBe(false);
  });
  it('uses older unread source frames and bounds retries on a frozen frame', () => {
    const used = new Set([2000]);
    expect(canDrainOcrCrop(3, 1500, used)).toBe(true);
    expect(canDrainOcrCrop(3, 2000, used)).toBe(false);
    const admission = new VideoFrameAdmission();
    expect(admission.accept(1)).toBe(true);
    expect(admission.accept(1)).toBe(false);
  });
  it('expires unschedulable evidence without cancelling running work', () => {
    expect(shouldContinueSampleDrain(0, false, true, 16000, 15000)).toBe(false);
    expect(shouldContinueSampleDrain(1, false, true, 16000, 15000)).toBe(true);
  });
  it('retains crop pixels past normal expiry and frees them after draining', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const selector = new BestFrameSelector();
    const canvas = { width: 120, height: 40 } as HTMLCanvasElement;
    selector.addCropCandidate(1, canvas, { x: 0, y: 0, width: 120, height: 40 });
    selector.retainForDrain(16000);
    vi.setSystemTime(7000);
    selector.pruneStale(1000);
    expect(selector.getTopCrops(1)).toHaveLength(1);
    expect(canvas.width).toBe(120);
    selector.retainForDrain(0);
    selector.pruneStale();
    expect(selector.getTopCrops(1)).toHaveLength(0);
    expect(canvas.width).toBe(0);
  });
});

describe('published consensus uses repeated exact text', () => {
  it('does not let BNC115 confirm an extra-digit BNC1115 reading', () => {
    const t = track();
    addOcrVoteToTrack(t, 'BNC1115', 0.91, 1, 1);
    addOcrVoteToTrack(t, 'BNC115', 0.90, 1, 2);
    expect(evaluateConsensus(t, 2, 0.90, true).isStabilized).toBe(false);
    addOcrVoteToTrack(t, 'BNC115', 0.96, 1, 3);
    const result = evaluateConsensus(t, 2, 0.90, true);
    expect(result.isStabilized).toBe(true);
    expect(result.normalizedPlate).toBe('BNC115');
  });
  it('still permits a very confident single-frame read for a brief clip', () => {
    const t = track();
    addOcrVoteToTrack(t, 'JRX9936', 0.97, 1, 1);
    expect(evaluateConsensus(t, 1, 0.95, true).isStabilized).toBe(true);
    addOcrVoteToTrack(t, 'JRX9936', 0.97, 1, 1);
    expect(evaluateConsensus(t, 2, 0.90, true).isStabilized).toBe(false);
  });
});


describe('OCR ranking does not reward extra digits', () => {
  function candidate(plate: string, confidence: number): PpOcrRecognitionResult {
    return { text: plate, normalizedPlate: plate, displayPlate: plate, confidence,
      characterConfidences: [], alternativeCandidates: [], layout: 'SINGLE_LINE',
      category: 'STANDARD', patternScore: 1, hasTrailingSuffix: false, engineUsed: 'PP_OCR' };
  }
  it.each(['BNC115', 'BNC15'])('prefers the more confident %s to an inserted-digit hypothesis', plate => {
    const candidates = [candidate('BNC1115', 0.91), candidate(plate, 0.92)];
    expect(chooseBestOcrCandidate(candidates)?.normalizedPlate).toBe(plate);
    expect(chooseBestRecognitionResult(candidates).normalizedPlate).toBe(plate);
  });
});

it('drains alternate final-frame crops without granting extra temporal votes', () => {
  const attempted = new Set(['final-tight']);
  expect(canDrainOcrCrop(4, 'final-padded', attempted)).toBe(true);
  expect(canDrainOcrCrop(4, 'final-tight', attempted)).toBe(false);
  const t = track();
  addOcrVoteToTrack(t, 'SWF3587', 0.94, 1, 1000);
  addOcrVoteToTrack(t, 'SWF3587', 0.983, 1, 1000);
  expect(evaluateConsensus(t, 1, 0.95, true)).toMatchObject({ isStabilized: true, voteCount: 1 });
  expect(evaluateConsensus(t, 2, 0.90, true).isStabilized).toBe(false);
});

it('retains the last crop even if old padded crops have a better heuristic score', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const selector = new BestFrameSelector();
  selector.configure({ maxBufferSize: 2 });
  for (const capturedAt of [100, 200]) {
    selector.addCropCandidate(1, { width: 120, height: 40 } as HTMLCanvasElement,
      { x: 0, y: 0, width: 200, height: 60, confidence: 1 }, { capturedAt, trackStability: 1, perspectiveScore: 1 });
  }
  const final = { width: 120, height: 40 } as HTMLCanvasElement;
  selector.addCropCandidate(1, final, { x: 0, y: 0, width: 40, height: 15, confidence: 0.3 },
    { capturedAt: 300, trackStability: 0.1, perspectiveScore: 0.1, cropKind: 'TIGHT' });
  expect(selector.getTopCrops(1, 3).map(crop => crop.capturedAt)).toContain(300);
  expect(selector.getCropCount(1)).toBe(2);
  expect(final.width).toBe(120);
});

it('makes every retained crop available to the final drain, including lower ranked alternatives', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const selector = new BestFrameSelector();
  selector.configure({ maxBufferSize: 12 });
  for (let i = 0; i < 12; i++) {
    selector.addCropCandidate(1, { width: 120, height: 40 } as HTMLCanvasElement,
      { x: 0, y: 0, width: 120, height: 40, confidence: 0.9 }, { capturedAt: i });
  }
  expect(selector.getTopCrops(1, 16)).toHaveLength(12);
});

it('does not mistake a ticking playback clock for a new decoded video frame', () => {
  const admission = new VideoFrameAdmission();
  expect(admission.accept(0, 1)).toBe(true);
  expect(admission.accept(0.015, 1)).toBe(false);
  expect(admission.accept(0.033, 2)).toBe(true);
  expect(admission.accept(0.060, 2)).toBe(false);
  expect(admission.accept(0, 1)).toBe(true); // seek/loop
});
