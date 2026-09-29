import { describe, expect, it } from 'vitest';
import { addOcrVoteToTrack, evaluateConsensus } from '../lib/anpr/consensus';
import { canPublishPlate } from '../lib/anpr/publicationPolicy';
import { PlateTracker } from '../lib/anpr/tracker';

function makeTrack() {
  return new PlateTracker(15, 8, 1).updateTracks([
    { x: 10, y: 10, width: 120, height: 40, confidence: 0.95 },
  ])[0];
}

describe('scanner publication regressions', () => {
  it.each(['E28', 'MEA1234', 'Z569'])('keeps %s below 90%% out of results', (plate) => {
    expect(canPublishPlate(plate, 0.8999)).toBe(false);
    expect(canPublishPlate(plate, Number.NaN)).toBe(false);
  });

  it.each(['B1', 'BNC15', 'BFQ902', 'BNC115'])('allows valid short registration %s at the threshold', (plate) => {
    expect(canPublishPlate(plate, 0.90)).toBe(true);
    expect(canPublishPlate(plate, 0.90, 0.95)).toBe(false);
    expect(canPublishPlate(plate, 0.80, 0, 1)).toBe(false);
    expect(canPublishPlate(plate, 0.80, 0, 2)).toBe(true);
  });

  it('does not transfer shorter plate votes to an extra-digit reading', () => {
    const track = makeTrack();
    addOcrVoteToTrack(track, 'BNC115', 0.97);
    addOcrVoteToTrack(track, 'BNC1115', 0.94);
    addOcrVoteToTrack(track, 'BNC115', 0.98);
    expect(track.votes.get('BNC115')?.count).toBe(2);
    expect(track.votes.get('BNC1115')?.count).toBe(1);
    expect(evaluateConsensus(track, 2, 0.90).normalizedPlate).toBe('BNC115');
  });

  it('does not count repeated processing of a final frame as independent votes', () => {
    const track = makeTrack();
    addOcrVoteToTrack(track, 'BFQ902', 0.96, 1, 1000);
    addOcrVoteToTrack(track, 'BFQ902', 0.96, 1, 1000);
    expect(evaluateConsensus(track, 2, 0.90).isStabilized).toBe(false);
    addOcrVoteToTrack(track, 'BFQ902', 0.96, 1, 1100);
    expect(evaluateConsensus(track, 2, 0.90).isStabilized).toBe(true);
  });

  it('does not round a subthreshold confidence up to 90%', () => {
    const track = makeTrack();
    addOcrVoteToTrack(track, 'BFQ902', 0.8999);
    const result = evaluateConsensus(track, 1, 0.8);
    expect(canPublishPlate(result.normalizedPlate, result.confidence)).toBe(false);
  });
});

describe('publication after uncertain early frames', () => {
  it('preserves a clear Sample 20 observation instead of averaging it below the gate', () => {
    const track = makeTrack();
    [0.68, 0.76, 0.82, 0.86].forEach((confidence, index) =>
      addOcrVoteToTrack(track, 'JRX9936', confidence, 1, index));
    addOcrVoteToTrack(track, 'JRX9936', 0.978, 1, 10);
    const result = evaluateConsensus(track, 1, 0.90, true);
    expect(result.isStabilized).toBe(true);
    expect(result.confidence).toBeCloseTo(0.978);
    expect(result.voteCount).toBe(1);
    expect(evaluateConsensus(track, 2, 0.90, true).isStabilized).toBe(false);
  });

  it('requires independent qualified frames and retains confident disagreement', () => {
    const track = makeTrack();
    addOcrVoteToTrack(track, 'SWF3587', 0.94, 1, 1);
    addOcrVoteToTrack(track, 'SWF3587', 0.94, 1, 1);
    addOcrVoteToTrack(track, 'SWF3587', 0.60, 1, 2);
    expect(evaluateConsensus(track, 2, 0.90, true).isStabilized).toBe(false);
    addOcrVoteToTrack(track, 'SWF3581', 0.97, 1, 3);
    expect(evaluateConsensus(track, 1, 0.90, true).isStabilized).toBe(false);
    addOcrVoteToTrack(track, 'SWF3587', 0.96, 1, 4);
    expect(evaluateConsensus(track, 2, 0.90, true)).toMatchObject({
      isStabilized: true, normalizedPlate: 'SWF3587', voteCount: 2, totalVotes: 3,
    });
  });
});

it('retains complete observed variants for corroboration by another source frame', async () => {
  const { addOcrCandidateEvidence } = await import('../lib/anpr/consensus');
  const track = makeTrack();
  addOcrVoteToTrack(track, 'VEQ871', 0.93, 1, 1);
  addOcrCandidateEvidence(track, 'VEQ8471', 0.91, 1);
  expect(evaluateConsensus(track, 2, 0.9, true).isStabilized).toBe(false);
  addOcrVoteToTrack(track, 'VEQ8471', 0.94, 1, 2);
  expect(evaluateConsensus(track, 2, 0.9, true)).toMatchObject({
    isStabilized: true, normalizedPlate: 'VEQ8471', voteCount: 2, totalVotes: 2,
  });
});

it('allows a decisive single read but keeps close confident disagreements unresolved', () => {
  const track = makeTrack();
  addOcrVoteToTrack(track, 'CFJ66', 0.92, 1, 1);
  addOcrVoteToTrack(track, 'CFJ6611', 0.975, 1, 2);
  expect(evaluateConsensus(track, 1, 0.9, true)).toMatchObject({ isStabilized: true, normalizedPlate: 'CFJ6611' });
  addOcrVoteToTrack(track, 'CFJ661', 0.97, 1, 3);
  expect(evaluateConsensus(track, 1, 0.9, true).isStabilized).toBe(false);
});

it('bounds per-frame evidence without inflating frozen-frame votes', () => {
  const track = makeTrack();
  for (let frame = 0; frame < 40; frame++) addOcrVoteToTrack(track, 'SWF3587', 0.94, 1, frame);
  expect(track.ocrFrameCandidates?.size).toBe(16);
  expect(track.ocrFrameObservations?.size).toBe(16);
  expect(evaluateConsensus(track, 2, 0.90, true).voteCount).toBe(16);
  addOcrVoteToTrack(track, 'SWF3587', 0.94, 1, 39);
  expect(evaluateConsensus(track, 2, 0.90, true).voteCount).toBe(16);
});

it('does not resolve equally repeated conflicting crop variants by confidence alone', async () => {
  const { addOcrCandidateEvidence } = await import('../lib/anpr/consensus');
  const track = makeTrack();
  for (const frame of [1, 2]) {
    addOcrVoteToTrack(track, 'BNC115', 0.96, 1, frame);
    addOcrCandidateEvidence(track, 'BNC1115', 0.97, frame);
  }
  expect(evaluateConsensus(track, 2, 0.9, true).isStabilized).toBe(false);
  addOcrVoteToTrack(track, 'BNC115', 0.98, 1, 3);
  expect(evaluateConsensus(track, 2, 0.9, true)).toMatchObject({ isStabilized: true, normalizedPlate: 'BNC115' });
});

it('accepts two exact frames over separate one-off fragments without pooling their votes', () => {
  const track = makeTrack();
  addOcrVoteToTrack(track, 'CFJ66', 0.96, 1, 1);
  addOcrVoteToTrack(track, 'CFJ6611', 0.918, 1, 2);
  addOcrVoteToTrack(track, 'CFJ661', 0.912, 1, 3);
  addOcrVoteToTrack(track, 'CFJ6611', 0.934, 1, 4);
  expect(evaluateConsensus(track, 2, 0.9, true)).toMatchObject({
    isStabilized: true, normalizedPlate: 'CFJ6611', voteCount: 2, totalVotes: 4,
  });
  addOcrVoteToTrack(track, 'CFJ661', 0.95, 1, 5);
  expect(evaluateConsensus(track, 2, 0.9, true).isStabilized).toBe(false);
});

it('requires stronger single-read evidence after crop corrections', async () => {
  const { canUseSingleOcrObservation } = await import('../lib/anpr/publicationPolicy');
  expect(canUseSingleOcrObservation(0.958, 'ORIGINAL', 'TIGHT')).toBe(true);
  expect(canUseSingleOcrObservation(0.949, 'ORIGINAL', 'TIGHT')).toBe(false);
  expect(canUseSingleOcrObservation(0.96, 'PERSPECTIVE_LEFT', 'TIGHT')).toBe(false);
  expect(canUseSingleOcrObservation(0.96, 'ORIGINAL', 'ORIGINAL')).toBe(false);
  expect(canUseSingleOcrObservation(0.98, 'PERSPECTIVE_LEFT', 'TIGHT')).toBe(true);
});

it('coalesces a brief overlapping OCR fragment but keeps separate vehicles', async () => {
  const { isSameRecentPlateObservation } = await import('../lib/anpr/publicationPolicy');
  const box = { x: 100, y: 100, width: 100, height: 30 };
  expect(isSameRecentPlateObservation('VNM1212', 'VN1212', box, { ...box, x: 104 }, 220)).toBe(true);
  expect(isSameRecentPlateObservation('VNM1212', 'VN1212', box, { ...box, x: 250 }, 220)).toBe(false);
  expect(isSameRecentPlateObservation('VNM1212', 'VN1212', box, box, 2000)).toBe(false);
  expect(isSameRecentPlateObservation('VNM1212', 'SWF3587', box, box, 220)).toBe(false);
});

describe('ANPR pipeline fixes: publication reliability and visual non-plate rejection', () => {
  it('strong normal plate on one frame at >=95% single-read commits immediately', async () => {
    const { canPublishPlate, canUseSingleOcrObservation } = await import('../lib/anpr/publicationPolicy');
    const plate = 'W1234A';
    const conf = 0.96;
    expect(canUseSingleOcrObservation(conf, 'ORIGINAL', 'TIGHT')).toBe(true);
    expect(canPublishPlate(plate, conf, 0, 1, { aspectRatio: 3.2, detectorConfidence: 0.85 })).toBe(true);
  });

  it('90% normal plate + corroborating frame commits via consensus', async () => {
    const { canPublishPlate } = await import('../lib/anpr/publicationPolicy');
    const plate = 'VBC7890';
    expect(canPublishPlate(plate, 0.90, 0, 1, { aspectRatio: 3.2, detectorConfidence: 0.80 })).toBe(true);
    expect(canPublishPlate(plate, 0.90, 0, 2, { aspectRatio: 3.2, detectorConfidence: 0.80 })).toBe(true);
  });

  it('weak single observation without corroboration is not unsafely committed', async () => {
    const { canPublishPlate, canUseSingleOcrObservation } = await import('../lib/anpr/publicationPolicy');
    const plate = 'W1234A';
    const conf = 0.90;
    expect(canUseSingleOcrObservation(conf, 'ORIGINAL', 'TIGHT')).toBe(false);
    expect(canPublishPlate(plate, conf, 0.95, 1, { aspectRatio: 3.2, detectorConfidence: 0.80 })).toBe(false);
  });

  it('short legitimate Sabah plate with strong visual evidence is published', async () => {
    const { canPublishPlate } = await import('../lib/anpr/publicationPolicy');
    // Sabah prefix SS + short number (legitimate registration format)
    const plate = 'SS12';
    // Valid plate aspect ratio ~ 3.0 and strong detector confidence 0.80
    expect(canPublishPlate(plate, 0.95, 0, 1, { aspectRatio: 3.0, detectorConfidence: 0.80 })).toBe(true);
  });

  it('road sign resembling Sabah plate is rejected by visual evidence gates', async () => {
    const { canPublishPlate, isVisualNonPlate } = await import('../lib/anpr/publicationPolicy');
    const plate = 'SS12';
    // Square street sign (aspect ratio 1.0) or low detector confidence (0.35)
    expect(isVisualNonPlate({ aspectRatio: 1.0, detectorConfidence: 0.35 })).toBe(true);
    expect(canPublishPlate(plate, 0.95, 0, 1, { aspectRatio: 1.0, detectorConfidence: 0.35 })).toBe(false);
    expect(canPublishPlate(plate, 0.95, 0, 1, { aspectRatio: 0.8, detectorConfidence: 0.80 })).toBe(false);
  });

  it('pending OCR survives tracker expiry via getTracksEligibleForOcr', async () => {
    const tracker = new PlateTracker(15, 8, 1);
    const tracks = tracker.updateTracks([{ x: 10, y: 10, width: 120, height: 40, confidence: 0.90 }]);
    const track = tracks[0];
    track.ocrEvidencePending = true;

    // Simulate physical disappearance on next frame (no bounding box)
    tracker.updateTracks([], { capturedAt: Date.now() + 1000 });
    
    // Physical track deleted from activeTracks after lost timeout, but getTracksEligibleForOcr retains it
    const eligibleTracks = tracker.getTracksEligibleForOcr();
    expect(eligibleTracks.some(t => t.trackId === track.trackId)).toBe(true);
    expect(tracker.getTrack(track.trackId)).toBeDefined();
  });

  it('multiple vehicles maintain independent finalisation and evidence isolation', async () => {
    const tracker = new PlateTracker(15, 8, 1);
    const tracks = tracker.updateTracks([
      { x: 10, y: 10, width: 120, height: 40, confidence: 0.90 },
      { x: 200, y: 10, width: 120, height: 40, confidence: 0.88 },
    ]);
    expect(tracks.length).toBe(2);
    const [trackA, trackB] = tracks;
    trackA.ocrEvidencePending = true;
    trackB.ocrEvidencePending = true;

    tracker.updateTracks([], { capturedAt: Date.now() + 1000 });
    const eligible = tracker.getTracksEligibleForOcr();
    expect(eligible.length).toBe(2);
    expect(eligible.map(t => t.trackId)).toContain(trackA.trackId);
    expect(eligible.map(t => t.trackId)).toContain(trackB.trackId);
  });

  it('repeated OCR variants from the exact same source frame capture do not fake multi-frame consensus', async () => {
    const track = makeTrack();
    const sameFrameCaptureTime = 12345678;
    addOcrVoteToTrack(track, 'W1234A', 0.90, 1, sameFrameCaptureTime);
    addOcrVoteToTrack(track, 'W1234A', 0.92, 1, sameFrameCaptureTime); // Same frame variant
    const consensus = evaluateConsensus(track, 2, 0.85, true);
    expect(consensus.isStabilized).toBe(false);

    // Frame #2 capture timestamp
    addOcrVoteToTrack(track, 'W1234A', 0.91, 1, sameFrameCaptureTime + 100);
    const multiFrameConsensus = evaluateConsensus(track, 2, 0.85, true);
    expect(multiFrameConsensus.isStabilized).toBe(true);
  });
});

