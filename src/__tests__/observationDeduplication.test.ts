import { describe, it, expect, beforeEach } from 'vitest';
import { PlateTracker, BoundingBox } from '../lib/anpr/tracker';
import { arePlatesSameVehicleFamily } from '../lib/anpr/consensus';

describe('Observation-Based Identity (observationId) & Fragmented Track Reassociation Tests', () => {
  let tracker: PlateTracker;

  beforeEach(() => {
    tracker = new PlateTracker(15, 8, 2);
  });

  it('assigns unique observationId to initial tracks', () => {
    const box1: BoundingBox = { x: 100, y: 200, width: 80, height: 30, confidence: 0.85 };
    const box2: BoundingBox = { x: 400, y: 200, width: 80, height: 30, confidence: 0.82 };

    const tracks = tracker.updateTracks([box1, box2]);
    expect(tracks.length).toBe(2);
    expect(tracks[0].observationId).toBeDefined();
    expect(tracks[1].observationId).toBeDefined();
    expect(tracks[0].observationId).not.toEqual(tracks[1].observationId);
  });

  it('reassociates fragmented track to original observationId after temporary occlusion', () => {
    const boxFrame1: BoundingBox = { x: 200, y: 300, width: 90, height: 35, confidence: 0.88 };

    // Frame 1: Vehicle appears, track 1 created
    const tracksF1 = tracker.updateTracks([boxFrame1], { capturedAt: 1000 });
    expect(tracksF1.length).toBe(1);
    const initialTrackId = tracksF1[0].trackId;
    const initialObsId = tracksF1[0].observationId;
    expect(initialObsId).toBeDefined();

    // Frame 2-6: Vehicle occluded/lost for 5 frames
    for (let f = 2; f <= 6; f++) {
      tracker.updateTracks([], { capturedAt: 1000 + f * 400 });
    }

    // Active tracks should now be empty (track 1 expired into recentlyExpiredTracks)
    expect(tracker.getActiveTracks().length).toBe(0);

    // Frame 7: Vehicle re-emerges at close spatial position
    const boxFrame7: BoundingBox = { x: 215, y: 305, width: 92, height: 36, confidence: 0.86 };
    const tracksF7 = tracker.updateTracks([boxFrame7], { capturedAt: 3600 });

    expect(tracksF7.length).toBe(1);
    const newTrack = tracksF7[0];

    // New track gets new trackId, but inherits original observationId!
    expect(newTrack.trackId).not.toEqual(initialTrackId);
    expect(newTrack.observationId).toEqual(initialObsId);
  });

  it('keeps two different vehicles with similar plate numbers as separate observations', () => {
    const boxCarA: BoundingBox = { x: 100, y: 200, width: 80, height: 30, confidence: 0.85 };
    const boxCarB: BoundingBox = { x: 500, y: 400, width: 80, height: 30, confidence: 0.85 };

    const tracks = tracker.updateTracks([boxCarA, boxCarB]);
    expect(tracks.length).toBe(2);

    tracks[0].votes.set('AMA4588', { count: 3, totalConfidence: 2.70 });
    tracks[1].votes.set('AMA4589', { count: 3, totalConfidence: 2.68 });

    // Distinct physical tracks remain separate observations
    expect(tracks[0].observationId).not.toEqual(tracks[1].observationId);
    expect(tracks[0].votes.get('AMA4588')?.count).toBe(3);
    expect(tracks[1].votes.get('AMA4589')?.count).toBe(3);
  });

  it('correctly identifies same-vehicle family variants for deduplication', () => {
    // Motion/OCR variations of the exact same vehicle
    expect(arePlatesSameVehicleFamily('AMA4588', 'AA4588')).toBe(true);
    expect(arePlatesSameVehicleFamily('AMA4588', 'AMA458B')).toBe(true);
    expect(arePlatesSameVehicleFamily('AA4588', 'AMA458B')).toBe(true);
    expect(arePlatesSameVehicleFamily('VNM1212', 'VNN1212')).toBe(true);
    expect(arePlatesSameVehicleFamily('SWF3587', 'S3587')).toBe(true);
    expect(arePlatesSameVehicleFamily('ANN7569', 'AN7569')).toBe(true);
    expect(arePlatesSameVehicleFamily('AMA4588', 'AMA498')).toBe(true);
    expect(arePlatesSameVehicleFamily('VGA1268', 'VGA1266')).toBe(true);
    expect(arePlatesSameVehicleFamily('VOH5370', 'OHH5370')).toBe(true);
    expect(arePlatesSameVehicleFamily('VME7108', 'ME708')).toBe(true);

    // Completely distinct vehicles
    expect(arePlatesSameVehicleFamily('VNM1212', 'SWF3587')).toBe(false);
    expect(arePlatesSameVehicleFamily('WTH931', 'VPX8709')).toBe(false);
    expect(arePlatesSameVehicleFamily('SYQ9096', 'WYS4460')).toBe(false);
  });

  it('detects collapsed repeated digits such as BNC15 vs BNC115', async () => {
    const { isRepeatedCharacterOmission } = await import('../lib/anpr/normaliser');
    // BNC15 is a collapsed omission of BNC115
    expect(isRepeatedCharacterOmission('BNC15', 'BNC115')).toBe(true);
    // Conversely BNC115 contains the repeated digit
    expect(isRepeatedCharacterOmission('BNC115', 'BNC15')).toBe(false);
  });

  it('allows targeted adaptive preprocessing for standard plates when confidence < 0.90', async () => {
    const { getSpecialAdaptiveOcrVariants } = await import('../lib/anpr/ocrEngine');
    const mockCanvas = { width: 300, height: 100 } as HTMLCanvasElement;
    const variants = getSpecialAdaptiveOcrVariants(mockCanvas, {
      text: 'BNC15',
      confidence: 0.78,
    });
    expect(variants).toEqual(['CONTRAST_BOOST', 'SHARPEN', 'CLAHE']);
  });

  it('preserves track when ocrEvidencePending is true even if frames are lost', () => {
    const box: BoundingBox = { x: 100, y: 150, width: 80, height: 30, confidence: 0.85 };
    const tracks = tracker.updateTracks([box], { capturedAt: 1000 });
    expect(tracks.length).toBe(1);

    const track = tracks[0];
    track.ocrEvidencePending = true;
    track.firstOcrStartedAt = 1000;

    // Simulate 3 missing frames (track not visible)
    for (let f = 1; f <= 3; f++) {
      tracker.updateTracks([], { capturedAt: 1000 + f * 50 });
    }

    // With ocrEvidencePending = true, track should NOT be deleted within 5000ms
    const active = tracker.getActiveTracks();
    expect(active.length).toBe(1);
    expect(active[0].trackId).toBe(track.trackId);
    expect(active[0].firstOcrStartedAt).toBe(1000);
    expect(active[0].ocrEvidencePending).toBe(true);
  });
});

