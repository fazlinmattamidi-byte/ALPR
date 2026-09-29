import { describe, it, expect, vi, afterEach } from 'vitest';
import { CameraDetectionScheduler, SchedulerTurnContext } from '../lib/anpr/liveScheduling';
import { classifyCropCondition } from '../lib/anpr/imageProcessor';
import { PlateTracker, isTrackDrawable } from '../lib/anpr/tracker';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CameraDetectionScheduler', () => {
  it('fairly sequences multiple cameras in round-robin order without starvation', async () => {
    const executedSlots: string[] = [];
    const scheduler = new CameraDetectionScheduler({
      getSlotIds: () => ['cam-1', 'cam-2', 'cam-3', 'cam-4'],
      runTurn: async (ctx: SchedulerTurnContext) => {
        executedSlots.push(ctx.slotId);
        expect(ctx.isMultiCamera).toBe(true);
        expect(ctx.totalSlots).toBe(4);
      },
    });

    scheduler.start(0);
    // Let scheduler tick 8 turns
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    scheduler.stop();

    expect(executedSlots.length).toBeGreaterThanOrEqual(4);
    // Verify strict round-robin ordering
    expect(executedSlots.slice(0, 4)).toEqual(['cam-1', 'cam-2', 'cam-3', 'cam-4']);
  });

  it('dynamically adapts when cameras are started and stopped independently', async () => {
    let activeSlots = ['cam-1', 'cam-2', 'cam-3', 'cam-4'];
    const executedSlots: string[] = [];

    const scheduler = new CameraDetectionScheduler({
      getSlotIds: () => activeSlots,
      runTurn: async (ctx: SchedulerTurnContext) => {
        executedSlots.push(ctx.slotId);
      },
    });

    scheduler.start(0);

    // Turn 1: All 4 running
    await new Promise((r) => setTimeout(r, 40));
    const countAfterAll4 = executedSlots.length;
    expect(countAfterAll4).toBeGreaterThanOrEqual(2);

    // Stop Cam 2: Now [cam-1, cam-3, cam-4]
    activeSlots = ['cam-1', 'cam-3', 'cam-4'];
    executedSlots.length = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(executedSlots.includes('cam-2')).toBe(false);
    expect(executedSlots.filter((s) => s === 'cam-1' || s === 'cam-3' || s === 'cam-4').length).toBeGreaterThanOrEqual(2);

    // Stop Cam 4: Now [cam-1, cam-3]
    activeSlots = ['cam-1', 'cam-3'];
    executedSlots.length = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(executedSlots.includes('cam-2')).toBe(false);
    expect(executedSlots.includes('cam-4')).toBe(false);

    // Restart Cam 2: Now [cam-1, cam-3, cam-2]
    activeSlots = ['cam-1', 'cam-3', 'cam-2'];
    executedSlots.length = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(executedSlots.includes('cam-2')).toBe(true);

    scheduler.stop();
  });

  it('runs single-camera fast path with zero unnecessary delay', async () => {
    const executedSlots: string[] = [];
    const scheduler = new CameraDetectionScheduler({
      getSlotIds: () => ['cam-1'],
      runTurn: async (ctx: SchedulerTurnContext) => {
        executedSlots.push(ctx.slotId);
        expect(ctx.isMultiCamera).toBe(false);
      },
    });

    scheduler.start(0);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    scheduler.stop();

    expect(executedSlots.length).toBeGreaterThanOrEqual(3);
    expect(executedSlots.every((s) => s === 'cam-1')).toBe(true);
  });

  it('maintains strict isolation between independent camera trackers', () => {
    const tracker1 = new PlateTracker();
    const tracker2 = new PlateTracker();

    // Camera 1 sees a plate
    tracker1.updateTracks(
      [{ x: 100, y: 100, width: 200, height: 60, confidence: 0.9 }],
      { capturedAt: 1000, mediaTimeSeconds: 1.0 }
    );

    // Camera 2 sees a different plate
    tracker2.updateTracks(
      [{ x: 300, y: 200, width: 180, height: 55, confidence: 0.85 }],
      { capturedAt: 1000, mediaTimeSeconds: 1.0 }
    );

    expect(tracker1.getActiveTracks(false).length).toBe(1);
    expect(tracker2.getActiveTracks(false).length).toBe(1);
    expect(tracker1.getActiveTracks(false)[0].bbox.x).toBe(100);
    expect(tracker2.getActiveTracks(false)[0].bbox.x).toBe(300);

    // Stop Camera 2 -> reset tracker2
    tracker2.clear();

    // Camera 1 must remain completely unaffected
    expect(tracker1.getActiveTracks(false).length).toBe(1);
    expect(tracker1.getActiveTracks(false)[0].bbox.x).toBe(100);
    expect(tracker2.getActiveTracks(false).length).toBe(0);
  });
});

describe('classifyCropCondition', () => {
  function createMockCanvas(width: number, height: number, fillRgb: [number, number, number]): HTMLCanvasElement {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      data[idx] = fillRgb[0];
      data[idx + 1] = fillRgb[1];
      data[idx + 2] = fillRgb[2];
      data[idx + 3] = 255;
    }
    return {
      width,
      height,
      getContext: () => ({
        getImageData: () => ({ data, width, height }),
      }),
    } as unknown as HTMLCanvasElement;
  }

  it('classifies DARK plates and selects CLAHE / DARK_BG targeted variants', () => {
    const darkCanvas = createMockCanvas(200, 60, [25, 25, 25]);
    const analysis = classifyCropCondition(darkCanvas);
    expect(analysis.tags).toContain('DARK');
    expect(analysis.targetedVariants).toContain('CLAHE');
    expect(analysis.targetedVariants).toContain('DARK_BG');
  });

  it('classifies GLARE plates and selects TOPHAT / ADAPTIVE_THRESHOLD variants', () => {
    const glareCanvas = createMockCanvas(200, 60, [250, 250, 250]);
    const analysis = classifyCropCondition(glareCanvas);
    expect(analysis.tags).toContain('GLARE');
    expect(analysis.targetedVariants).toContain('TOPHAT');
  });

  it('classifies TWO_LINE plates from aspect ratio and selects two-line-aware variants', () => {
    const twoLineCanvas = createMockCanvas(120, 100, [100, 100, 100]); // aspect < 1.6
    const analysis = classifyCropCondition(twoLineCanvas);
    expect(analysis.tags).toContain('TWO_LINE');
    expect(analysis.isTwoLine).toBe(true);
    expect(analysis.targetedVariants).toContain('PERSPECTIVE');
  });

  it('classifies SLANTED plates and applies perspective rectification without clipping', () => {
    const slantedCanvas = createMockCanvas(200, 60, [100, 100, 100]);
    const analysis = classifyCropCondition(slantedCanvas, undefined, 0.12); // ~7 degrees
    expect(analysis.tags).toContain('SLANTED');
    expect(analysis.targetedVariants).toContain('PERSPECTIVE');
  });

  it('classifies combination conditions e.g. DARK + SLANTED', () => {
    const darkSlantedCanvas = createMockCanvas(200, 60, [25, 25, 25]);
    const analysis = classifyCropCondition(darkSlantedCanvas, undefined, 0.15);
    expect(analysis.tags).toContain('DARK');
    expect(analysis.tags).toContain('SLANTED');
    expect(analysis.targetedVariants).toContain('CLAHE');
    expect(analysis.targetedVariants).toContain('PERSPECTIVE');
  });
});

describe('overlayAgeMs and Bounding Box Freshness', () => {
  it('disappears quickly when real detection is older than 200ms without hovering', () => {
    const tracker = new PlateTracker();
    const now = Date.now();

    // Frame 1: Detection present
    tracker.updateTracks(
      [{ x: 100, y: 100, width: 200, height: 60, confidence: 0.9 }],
      { capturedAt: now, mediaTimeSeconds: 1.0 }
    );

    const activeTracks1 = tracker.getActiveTracks(false);
    expect(activeTracks1.length).toBe(1);
    expect(isTrackDrawable(activeTracks1[0])).toBe(true);

    // Frame 2: 250ms later with no visual detection (plate left frame, but OCR still queued)
    tracker.updateTracks([], { capturedAt: now + 250, mediaTimeSeconds: 1.25 });
    const activeTracks2 = tracker.getActiveTracks(false);
    expect(activeTracks2.length).toBe(1);
    expect(activeTracks2[0].overlayAgeMs).toBeGreaterThanOrEqual(250);

    // Box must NOT be drawable when stale (>200ms)
    expect(isTrackDrawable(activeTracks2[0])).toBe(false);
  });
});
