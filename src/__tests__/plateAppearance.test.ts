import { describe, expect, it } from 'vitest';
import { PlateTracker } from '../lib/anpr/tracker';
import { isSamePlateAppearance } from '../lib/anpr/plateAppearance';

const appearance = Array.from({ length: 288 }, (_, i) => i % 2 ? 1 : -1);
const box = { x: 120, y: 180, width: 92, height: 30, confidence: 0.9, appearance };

describe('completed plate continuity', () => {
  it('retains a completed car still visible without scheduling a new track', () => {
    const tracker = new PlateTracker();
    const track = tracker.updateTracks([box])[0];
    track.cooldownActive = true;
    const visible = tracker.updateTracks([{ ...box, x: 122 }]).filter(t => t.visibleThisFrame);
    expect(visible).toHaveLength(1);
    expect(visible[0].trackId).toBe(track.trackId);
    expect(visible[0].cooldownActive).toBe(true);
  });

  it('does not hide a different plate occupying the same position', () => {
    const tracker = new PlateTracker();
    const track = tracker.updateTracks([box])[0];
    track.cooldownActive = true;
    const visible = tracker.updateTracks([{ ...box, appearance: appearance.map(v => -v) }]).filter(t => t.visibleThisFrame);
    expect(visible).toHaveLength(1);
    expect(visible[0].trackId).not.toBe(track.trackId);
  });

  it('does not reuse a completed identity after a detection gap', () => {
    const tracker = new PlateTracker();
    const track = tracker.updateTracks([box])[0];
    track.cooldownActive = true;
    tracker.updateTracks([]);
    const visible = tracker.updateTracks([box]).filter(t => t.visibleThisFrame);
    expect(visible[0].trackId).not.toBe(track.trackId);
  });

  it('requires usable finite image evidence', () => {
    expect(isSamePlateAppearance(undefined, appearance)).toBe(false);
    expect(isSamePlateAppearance([], [])).toBe(false);
    expect(isSamePlateAppearance(appearance, appearance.map(() => NaN))).toBe(false);
    expect(isSamePlateAppearance(appearance, appearance.map(v => v * 0.99))).toBe(true);
  });
});

it('preserves an unresolved plate after a gap when a different car crosses its coordinates', () => {
  const tracker = new PlateTracker();
  const track = tracker.updateTracks([box])[0];
  track.votes.set('CFJ6611', { count: 1, totalConfidence: 0.93 });
  track.ocrEvidencePending = true;
  tracker.updateTracks([]);
  const visible = tracker.updateTracks([{ ...box, appearance: appearance.map(v => -v) }]).filter(t => t.visibleThisFrame);
  expect(visible).toHaveLength(1);
  expect(visible[0].trackId).not.toBe(track.trackId);
  expect(visible[0].votes.size).toBe(0);
  expect(tracker.getTrack(track.trackId)?.votes.has('CFJ6611')).toBe(true);
});
