import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForDecodedFrame } from '../lib/anpr/scannerStartup';
import { canScheduleOcrEvidence } from '../lib/anpr/liveScheduling';

class VideoStub extends EventTarget {
  readyState = 0;
  videoWidth = 0;
  frame() { this.readyState = 2; this.videoWidth = 640; this.dispatchEvent(new Event('loadeddata')); }
}

afterEach(() => { vi.useRealTimers(); });

describe('one-click source preparation', () => {
  it('waits for decoded pixels before allowing tracking/playback', async () => {
    const source = new VideoStub();
    const started = vi.fn();
    const pending = waitForDecodedFrame(source as unknown as HTMLVideoElement).then(started);
    source.dispatchEvent(new Event('canplay'));
    await Promise.resolve();
    expect(started).not.toHaveBeenCalled();
    source.frame();
    await pending;
    expect(started).toHaveBeenCalledTimes(1);
  });
  it('accepts a source whose frame is already decoded', async () => {
    const source = new VideoStub(); source.frame();
    await expect(waitForDecodedFrame(source as unknown as HTMLVideoElement)).resolves.toBeUndefined();
  });
  it('reports decode failure instead of leaving preparation spinning', async () => {
    const source = new VideoStub();
    const pending = waitForDecodedFrame(source as unknown as HTMLVideoElement);
    source.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow('Unable to decode');
  });
  it('reports a source timeout', async () => {
    vi.useFakeTimers();
    const pending = waitForDecodedFrame(new VideoStub() as unknown as HTMLVideoElement, 100);
    const check = expect(pending).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(100);
    await check;
  });
});

describe('OCR keeps trying new evidence without another Mula click', () => {
  it('admits a first observation immediately', () => {
    expect(canScheduleOcrEvidence(0, 0, 100, undefined, false)).toBe(true);
  });
  it('admits a fresh crop after three unsuccessful attempts and 2.5 seconds', () => {
    expect(canScheduleOcrEvidence(3, 3000, 2000, 1000, false)).toBe(true);
  });
  it('does not keep retrying exhausted frozen evidence', () => {
    expect(canScheduleOcrEvidence(3, 3000, 1000, 1000, false)).toBe(false);
    expect(canScheduleOcrEvidence(3, 3000, -Infinity, 1000, false)).toBe(false);
  });
  it('stops committed tracks even if more crops arrive', () => {
    expect(canScheduleOcrEvidence(3, 3000, 2000, 1000, true)).toBe(false);
  });
});
