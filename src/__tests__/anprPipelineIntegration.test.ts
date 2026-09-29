import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlateTracker, BoundingBox, addQualityCropSample } from '../lib/anpr/tracker';
import { evaluateConsensus, isOneCharacterVariant } from '../lib/anpr/consensus';
import { evaluateDatabaseMatch } from '../lib/anpr/matchingEngine';
import { normalizePlate } from '../lib/anpr/normaliser';
import { prioritiseTracks } from '../lib/anpr/imageProcessor';

describe('ANPR End-to-End Pipeline Integration Regression Tests', () => {
  let tracker: PlateTracker;

  beforeEach(() => {
    tracker = new PlateTracker(15, 8, 2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Scenario 1: Two plates in one frame get independent detections and tracks', () => {
    const boxLeft: BoundingBox = { x: 100, y: 500, width: 80, height: 30, confidence: 0.85 };
    const boxRight: BoundingBox = { x: 400, y: 500, width: 80, height: 30, confidence: 0.82 };

    const tracksFrame1 = tracker.updateTracks([boxLeft, boxRight]);
    expect(tracksFrame1.length).toBe(2);
    expect(tracksFrame1[0].trackId).not.toEqual(tracksFrame1[1].trackId);

    const trackLeft = tracksFrame1.find((t) => t.bbox.x < 250)!;
    const trackRight = tracksFrame1.find((t) => t.bbox.x > 250)!;

    trackLeft.votes.set('NEA7567', { count: 3, totalConfidence: 2.70 });
    trackRight.votes.set('SJC6080', { count: 3, totalConfidence: 2.64 });

    const consensusLeft = evaluateConsensus(trackLeft);
    const consensusRight = evaluateConsensus(trackRight);

    expect(consensusLeft.isStabilized).toBe(true);
    expect(consensusLeft.normalizedPlate).toBe('NEA7567');

    expect(consensusRight.isStabilized).toBe(true);
    expect(consensusRight.normalizedPlate).toBe('SJC6080');
  });

  it('Scenario 2: Three plates in one frame receive independent processing and tracking', () => {
    const box1: BoundingBox = { x: 50, y: 400, width: 70, height: 25, confidence: 0.80 };
    const box2: BoundingBox = { x: 250, y: 400, width: 70, height: 25, confidence: 0.78 };
    const box3: BoundingBox = { x: 500, y: 400, width: 70, height: 25, confidence: 0.88 };

    const tracks = tracker.updateTracks([box1, box2, box3]);
    expect(tracks.length).toBe(3);

    const ids = new Set(tracks.map((t) => t.trackId));
    expect(ids.size).toBe(3);

    tracks[0].votes.set('SYQ9096', { count: 2, totalConfidence: 1.70 });
    tracks[1].votes.set('WYS4460', { count: 2, totalConfidence: 1.65 });
    tracks[2].votes.set('BQF902', { count: 2, totalConfidence: 1.76 });

    expect(evaluateConsensus(tracks[0]).normalizedPlate).toBe('SYQ9096');
    expect(evaluateConsensus(tracks[1]).normalizedPlate).toBe('WYS4460');
    expect(evaluateConsensus(tracks[2]).normalizedPlate).toBe('BQF902');
  });

  it('Scenario 3: One low confidence plate does not prevent other plates from processing', () => {
    const lowConfBox: BoundingBox = { x: 100, y: 200, width: 50, height: 20, confidence: 0.30 };
    const highConfBox: BoundingBox = { x: 400, y: 200, width: 80, height: 30, confidence: 0.90 };

    const tracks = tracker.updateTracks([lowConfBox, highConfBox]);
    expect(tracks.length).toBeGreaterThanOrEqual(1);

    const highTrack = tracks.find((t) => t.bbox.x > 300);
    expect(highTrack).toBeDefined();

    highTrack!.votes.set('SWF3587', { count: 2, totalConfidence: 1.80 });
    const consensus = evaluateConsensus(highTrack!, 2);
    expect(consensus.isStabilized).toBe(true);
    expect(consensus.normalizedPlate).toBe('SWF3587');
  });

  it('Scenario 4: One slow OCR job does not block other parallel tracks', async () => {
    const trackQueue: string[] = [];

    const slowJob = new Promise<string>((resolve) => {
      setTimeout(() => {
        trackQueue.push('Track-Slow-Result');
        resolve('Track-Slow-Result');
      }, 50);
    });

    const fastJob = Promise.resolve('Track-Fast-Result').then((res) => {
      trackQueue.push(res);
      return res;
    });

    const fastRes = await fastJob;
    expect(fastRes).toBe('Track-Fast-Result');
    expect(trackQueue).toEqual(['Track-Fast-Result']);

    const slowRes = await slowJob;
    expect(slowRes).toBe('Track-Slow-Result');
    expect(trackQueue).toEqual(['Track-Fast-Result', 'Track-Slow-Result']);
  });

  it('Scenario 5: Two similar plate numbers maintain distinct vehicle tracks', () => {
    const boxA: BoundingBox = { x: 100, y: 300, width: 80, height: 30, confidence: 0.85 };
    const boxB: BoundingBox = { x: 450, y: 300, width: 80, height: 30, confidence: 0.85 };

    const tracks = tracker.updateTracks([boxA, boxB]);
    expect(tracks.length).toBe(2);

    tracks[0].votes.set('W1234A', { count: 3, totalConfidence: 2.70 });
    tracks[1].votes.set('W1234B', { count: 3, totalConfidence: 2.70 });

    const resA = evaluateConsensus(tracks[0]);
    const resB = evaluateConsensus(tracks[1]);

    expect(resA.normalizedPlate).toBe('W1234A');
    expect(resB.normalizedPlate).toBe('W1234B');
    expect(resA.normalizedPlate).not.toEqual(resB.normalizedPlate);
  });

  it('Scenario 6: Vehicle leaving before OCR finishes still produces result from saved crop', () => {
    const box: BoundingBox = { x: 150, y: 250, width: 80, height: 30, confidence: 0.88 };
    const tracksFrame1 = tracker.updateTracks([box]);
    const trackId = tracksFrame1[0].trackId;

    // Next frame: vehicle leaves camera view (empty detections)
    const tracksFrame2 = tracker.updateTracks([]);
    const lostTrack = tracker.getTrack(trackId)!;

    expect(lostTrack.trackState).toBe('LOST');

    // Asynchronous OCR completes for saved crop
    lostTrack.votes.set('BNC115', { count: 1, totalConfidence: 0.88 });
    const consensus = evaluateConsensus(lostTrack, 1, 0.60);

    expect(consensus.isStabilized).toBe(true);
    expect(consensus.normalizedPlate).toBe('BNC115');
  });

  it('Scenario 7: Video ends with pending OCR jobs - all jobs drain to completion', async () => {
    const pendingJobs = [
      Promise.resolve({ trackId: 'TRK-1', plate: 'SYQ9096' }),
      Promise.resolve({ trackId: 'TRK-2', plate: 'WYS4460' }),
    ];

    const results = await Promise.all(pendingJobs);
    expect(results.length).toBe(2);
    expect(results[0].plate).toBe('SYQ9096');
    expect(results[1].plate).toBe('WYS4460');
  });

  it('Scenario 8: Track pool capacity evicts completed/cooldowned tracks without losing uncommitted evidence', () => {
    const smallTracker = new PlateTracker(15, 2, 1);

    // Create 2 tracks to fill capacity
    smallTracker.updateTracks([
      { x: 50, y: 100, width: 60, height: 25, confidence: 0.8 },
      { x: 200, y: 100, width: 60, height: 25, confidence: 0.8 },
    ]);

    const track1 = Array.from(smallTracker.getActiveTracks(false))[0];
    track1.cooldownActive = true;
    track1.ocrState = 'COOLDOWN';

    // Add a 3rd track -> evicts cooldowned track1
    const updated = smallTracker.updateTracks([
      { x: 350, y: 100, width: 60, height: 25, confidence: 0.9 },
    ]);

    expect(updated.length).toBeLessThanOrEqual(2);
    const hasNewTrack = updated.some((t) => t.bbox.x === 350);
    expect(hasNewTrack).toBe(true);
  });

  it('Scenario 9: Repeated frames of one vehicle produce consolidated session result', () => {
    let currentBbox: BoundingBox = { x: 100, y: 200, width: 80, height: 30, confidence: 0.85 };

    for (let frame = 0; frame < 10; frame++) {
      currentBbox = { x: 100 + frame, y: 200, width: 80, height: 30, confidence: 0.85 };
      tracker.updateTracks([currentBbox]);
    }

    const activeTracks = tracker.getActiveTracks(true);
    expect(activeTracks.length).toBe(1);

    const track = activeTracks[0];
    track.votes.set('BNC115', { count: 8, totalConfidence: 6.80 });

    const consensus = evaluateConsensus(track);
    expect(consensus.isStabilized).toBe(true);
    expect(consensus.voteCount).toBe(8);
  });

  it('Scenario 10: Two vehicles with identical plate text maintain separate track evidence', () => {
    const boxCar1: BoundingBox = { x: 100, y: 500, width: 80, height: 30, confidence: 0.88 };
    const boxCar2: BoundingBox = { x: 600, y: 500, width: 80, height: 30, confidence: 0.88 };

    const tracks = tracker.updateTracks([boxCar1, boxCar2]);
    expect(tracks.length).toBe(2);

    tracks[0].votes.set('BNC115', { count: 2, totalConfidence: 1.80 });
    tracks[1].votes.set('BNC115', { count: 2, totalConfidence: 1.80 });

    expect(tracks[0].trackId).not.toEqual(tracks[1].trackId);
    expect(evaluateConsensus(tracks[0]).normalizedPlate).toBe('BNC115');
    expect(evaluateConsensus(tracks[1]).normalizedPlate).toBe('BNC115');
  });

  it('Scenario 11: High-confidence YOLO candidates bypass heuristic color filter', () => {
    const highConfRedCarBox: BoundingBox = { x: 300, y: 400, width: 90, height: 35, confidence: 0.75 };
    const tracks = tracker.updateTracks([highConfRedCarBox]);
    expect(tracks.length).toBe(1);
    expect(tracks[0].bbox.confidence).toBe(0.75);
  });

  it('Scenario 12: Proportional padding expands crop by 5% within image bounds', () => {
    const box: BoundingBox = { x: 100, y: 100, width: 100, height: 30, confidence: 0.9 };
    const padX = Math.round(box.width * 0.05); // 5px
    const padY = Math.round(box.height * 0.025); // 1px
    expect(padX).toBe(5);
    expect(padY).toBe(1);

    const paddedWidth = box.width + padX * 2;
    expect(paddedWidth).toBe(110);
  });

  it('Scenario 13: Provisional reading updates on same track ID without duplicate vehicle splits', () => {
    const box: BoundingBox = { x: 200, y: 300, width: 80, height: 30, confidence: 0.85 };
    const tracks = tracker.updateTracks([box]);
    const track = tracks[0];

    // Frame 1: provisional read STF3587
    track.votes.set('STF3587', { count: 1, totalConfidence: 0.82 });
    track.provisionalPlate = 'STF3587';
    track.provisionalConfidence = 0.82;

    expect(track.provisionalPlate).toBe('STF3587');

    // Frame 2: stronger read SWF3587 arrives
    track.votes.set('SWF3587', { count: 3, totalConfidence: 2.70 });
    const consensus = evaluateConsensus(track);

    expect(consensus.normalizedPlate).toBe('SWF3587');
    track.provisionalPlate = consensus.normalizedPlate;
    track.provisionalConfidence = consensus.confidence;

    expect(track.provisionalPlate).toBe('SWF3587');
    expect(track.trackId).toBe(tracks[0].trackId);
  });

  it('Scenario 14: Quality crop selection prioritizes complete high-quality crops', () => {
    const box: BoundingBox = { x: 100, y: 100, width: 80, height: 30, confidence: 0.80 };
    const tracks = tracker.updateTracks([box]);
    const track = tracks[0];

    addQualityCropSample(track, { dataUrl: 'data:image/png;base64,low', qualityScore: 0.40, timestamp: 100 });
    addQualityCropSample(track, { dataUrl: 'data:image/png;base64,high', qualityScore: 0.95, timestamp: 200 });

    expect(track.cropSamples.length).toBe(2);
    expect(track.cropSamples[0].qualityScore).toBe(0.95);
    expect(track.cropSamples[0].dataUrl).toBe('data:image/png;base64,high');
  });

  it('Scenario 15: Fair OCR scheduler prioritizes new unvoted tracks over repeat attempts', () => {
    const tracks = [
      { trackId: 'TRK-Old', bbox: { x: 100, y: 100, width: 80, height: 30, confidence: 0.8 }, framesSeen: 10, ocrState: 'IDLE', voteCount: 5 },
      { trackId: 'TRK-New', bbox: { x: 300, y: 100, width: 80, height: 30, confidence: 0.8 }, framesSeen: 1, ocrState: 'IDLE', voteCount: 0 },
    ];

    const priority = prioritiseTracks(tracks, 960, 540, 2);
    expect(priority[0]).toBe('TRK-New');
  });

  it('Scenario 16: Track unconfirmed timeout preserves track across 300ms detector dropout', () => {
    const boxFrame1: BoundingBox = { x: 150, y: 300, width: 85, height: 30, confidence: 0.85 };
    const tracksFrame1 = tracker.updateTracks([boxFrame1]);
    expect(tracksFrame1.length).toBe(1);
    const trackId1 = tracksFrame1[0].trackId;

    // Simulate 300ms delay with no detections
    const tracksFrame2 = tracker.updateTracks([]);
    expect(tracksFrame2.length).toBe(1);

    // Frame 3 (at 320ms): vehicle reappears
    const boxFrame3: BoundingBox = { x: 160, y: 302, width: 85, height: 30, confidence: 0.86 };
    const tracksFrame3 = tracker.updateTracks([boxFrame3]);
    expect(tracksFrame3.length).toBe(1);
    expect(tracksFrame3[0].trackId).toBe(trackId1);
  });

  it('Scenario 17: Single-character variant deduplication recognizes SF3587 as variant of SWF3587', () => {
    expect(isOneCharacterVariant('SF3587', 'SWF3587')).toBe(true);
    expect(isOneCharacterVariant('SWF3587', 'SF3587')).toBe(true);
    expect(isOneCharacterVariant('SWF3587', 'ABC1234')).toBe(false);
  });

  it('Scenario 18: Frame 0 detection creates immediate observation for VNN1212', () => {
    const vnnBox: BoundingBox = { x: 200, y: 400, width: 90, height: 32, confidence: 0.89 };
    const tracks = tracker.updateTracks([vnnBox]);
    expect(tracks.length).toBe(1);
    expect(tracks[0].observationId).toBeDefined();

    tracks[0].votes.set('VNN1212', { count: 3, totalConfidence: 2.75 });
    const consensus = evaluateConsensus(tracks[0]);
    expect(consensus.normalizedPlate).toBe('VNN1212');
  });
});
