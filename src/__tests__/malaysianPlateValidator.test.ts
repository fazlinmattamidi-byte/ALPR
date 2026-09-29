import { describe, it, expect } from 'vitest';
import {
  classifyMalaysianColourProfile,
  evaluatePlateGeometry,
  evaluateCharacterStrokeStructure,
  evaluateMalaysianPlateVisualCandidate,
  evaluateMalaysianPlateFinalConfirmation,
} from '../lib/anpr/malaysianPlateValidator';
import { ActiveTrack } from '../lib/anpr/tracker';

function createMockPlateCanvas(
  width: number,
  height: number,
  bgRgb: [number, number, number],
  textRgb: [number, number, number],
  options: {
    strokeCount?: number;
    leftStripeRgb?: [number, number, number];
    leftStripeWidthRatio?: number;
  } = {}
): HTMLCanvasElement {
  const data = new Uint8ClampedArray(width * height * 4);
  const strokeCount = options.strokeCount ?? 6;
  const leftStripeWidth = Math.floor(width * (options.leftStripeWidthRatio ?? 0));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      let rgb = bgRgb;

      // Left stripe (e.g. green EV badge)
      if (options.leftStripeRgb && x < leftStripeWidth) {
        rgb = options.leftStripeRgb;
      } else if (y >= height * 0.25 && y <= height * 0.75 && x >= width * 0.1 && x <= width * 0.9) {
        // Draw mock characters with stroke frequency
        const period = (width * 0.8) / strokeCount;
        const phase = (x - width * 0.1) % period;
        if (phase < period * 0.45) {
          rgb = textRgb;
        }
      }

      data[idx] = rgb[0];
      data[idx + 1] = rgb[1];
      data[idx + 2] = rgb[2];
      data[idx + 3] = 255;
    }
  }

  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data, width, height }),
    }),
  } as unknown as HTMLCanvasElement;
}

function createMockTrack(overrides: Partial<ActiveTrack> = {}): ActiveTrack {
  return {
    trackId: 'TRK-1',
    trackNumber: 1,
    bbox: { x: 100, y: 100, width: 220, height: 65, confidence: 0.88 },
    smoothBbox: { x: 100, y: 100, width: 220, height: 65, confidence: 0.88 },
    vx: 0,
    vy: 0,
    cropSamples: [],
    lastSeenFrame: 1,
    firstSeenFrame: 1,
    lastSeenTimestamp: 1000,
    firstSeenTimestamp: 1000,
    framesSeen: 1,
    trackState: 'VISIBLE',
    ocrState: 'DETECTED',
    ocrRunning: false,
    ocrJobQueued: false,
    votes: new Map(),
    cooldownActive: false,
    candidateState: 'PLATE_CANDIDATE',
    ...overrides,
  };
}

describe('Malaysian Plate Visual Candidate & Colour Gate', () => {
  describe('Genuine Malaysian Plates (Recall Tests 1 - 12)', () => {
    it('1. accepts standard black plate with white/silver characters', () => {
      const canvas = createMockPlateCanvas(220, 65, [25, 25, 25], [230, 230, 230], { strokeCount: 6 });
      const report = evaluateMalaysianPlateVisualCandidate(
        canvas,
        { width: 220, height: 65, confidence: 0.88 }
      );

      expect(report.colourProfile).toBe('DARK_BACKGROUND_LIGHT_TEXT');
      expect(report.decision).toBe('STRONG_CANDIDATE');
      expect(report.malaysiaVisualCandidateScore).toBeGreaterThanOrEqual(0.55);
    });

    it('2. accepts motorcycle / two-line plate geometry', () => {
      const canvas = createMockPlateCanvas(160, 110, [25, 25, 25], [230, 230, 230], { strokeCount: 4 });
      const geom = evaluatePlateGeometry({ width: 160, height: 110 });
      expect(geom.isTwoLineAspect).toBe(true);
      expect(geom.geometryScore).toBeGreaterThan(0.20);

      const report = evaluateMalaysianPlateVisualCandidate(
        canvas,
        { width: 160, height: 110, confidence: 0.85 }
      );
      expect(report.decision).toBe('STRONG_CANDIDATE');
    });

    it('3. accepts legitimate white-background plate classes (taxi / commercial)', () => {
      const canvas = createMockPlateCanvas(220, 65, [235, 235, 235], [20, 20, 20], { strokeCount: 6 });
      const report = evaluateMalaysianPlateVisualCandidate(
        canvas,
        { width: 220, height: 65, confidence: 0.85 }
      );

      expect(report.colourProfile).toBe('LIGHT_BACKGROUND_DARK_TEXT');
      expect(report.decision).toBe('STRONG_CANDIDATE');
    });

    it('4. accepts Malaysian EV / JPJePlate with green identifier cue', () => {
      // White plate with green left stripe
      const canvas = createMockPlateCanvas(
        220,
        65,
        [240, 240, 240],
        [20, 20, 20],
        { strokeCount: 6, leftStripeRgb: [30, 160, 60], leftStripeWidthRatio: 0.22 }
      );
      const report = evaluateMalaysianPlateVisualCandidate(
        canvas,
        { width: 220, height: 65, confidence: 0.90 }
      );

      expect(report.colourProfile).toBe('LIGHT_BACKGROUND_DARK_TEXT_GREEN_EV_CUE');
      expect(report.decision).toBe('STRONG_CANDIDATE');
      expect(report.malaysiaVisualCandidateScore).toBeGreaterThanOrEqual(0.60);
    });

    it('5. preserves recall on night plates without rejecting for low illumination', () => {
      const nightCanvas = createMockPlateCanvas(200, 60, [15, 15, 18], [120, 120, 125], { strokeCount: 5 });
      const report = evaluateMalaysianPlateVisualCandidate(
        nightCanvas,
        { width: 200, height: 60, confidence: 0.82 },
        undefined,
        { isNight: true }
      );

      expect(report.colourProfile).toBe('UNKNOWN_COLOUR_PROFILE');
      expect(report.decision).not.toBe('OBVIOUS_NON_PLATE');
      expect(report.decision).toBe('STRONG_CANDIDATE');
    });

    it('6. preserves recall under headlight glare', () => {
      const glareCanvas = createMockPlateCanvas(200, 60, [240, 240, 240], [250, 250, 250]);
      const report = evaluateMalaysianPlateVisualCandidate(
        glareCanvas,
        { width: 200, height: 60, confidence: 0.80 },
        undefined,
        { isGlare: true }
      );

      expect(report.colourProfile).toBe('UNKNOWN_COLOUR_PROFILE');
      expect(report.decision).not.toBe('OBVIOUS_NON_PLATE');
    });

    it('7. preserves recall on slanted / perspective plates', () => {
      const slantedCanvas = createMockPlateCanvas(210, 70, [25, 25, 25], [230, 230, 230], { strokeCount: 5 });
      const report = evaluateMalaysianPlateVisualCandidate(
        slantedCanvas,
        { width: 210, height: 70, confidence: 0.85 },
        undefined,
        { isSlanted: true }
      );

      expect(report.decision).toBe('STRONG_CANDIDATE');
    });

    it('8. preserves recall on motion blurred plates without destroying crop', () => {
      const blurCanvas = createMockPlateCanvas(190, 60, [30, 30, 30], [180, 180, 180], { strokeCount: 4 });
      const report = evaluateMalaysianPlateVisualCandidate(
        blurCanvas,
        { width: 190, height: 60, confidence: 0.78 },
        undefined,
        { isBlur: true }
      );

      expect(report.decision).not.toBe('OBVIOUS_NON_PLATE');
    });

    it('9. preserves recall on small / distant plates', () => {
      const smallCanvas = createMockPlateCanvas(60, 20, [30, 30, 30], [200, 200, 200], { strokeCount: 4 });
      const report = evaluateMalaysianPlateVisualCandidate(
        smallCanvas,
        { width: 60, height: 20, confidence: 0.75 }
      );

      expect(report.decision).not.toBe('OBVIOUS_NON_PLATE');
    });

    it('10. preserves recall on dirty / faded plates', () => {
      const fadedCanvas = createMockPlateCanvas(200, 60, [60, 58, 55], [170, 168, 165], { strokeCount: 6 });
      const report = evaluateMalaysianPlateVisualCandidate(
        fadedCanvas,
        { width: 200, height: 60, confidence: 0.82 }
      );

      expect(report.decision).toBe('STRONG_CANDIDATE');
    });
  });

  describe('Non-Plate Road Objects & Sign Rejection (Tests 13 - 22)', () => {
    it('13. rejects blue highway destination signs', () => {
      const blueSignCanvas = createMockPlateCanvas(320, 60, [20, 70, 190], [250, 250, 250], { strokeCount: 16 });
      const report = evaluateMalaysianPlateVisualCandidate(
        blueSignCanvas,
        { width: 320, height: 60, confidence: 0.65 },
        { width: 1280, height: 720 }
      );

      expect(report.colourProfile).toBe('BLUE_BACKGROUND_LIGHT_TEXT');
      expect(report.decision).toBe('OBVIOUS_NON_PLATE');
      expect(report.rejectionReason).toContain('Strong non-plate visual evidence');
    });

    it('14. rejects green highway exit / gantry signs', () => {
      const greenSignCanvas = createMockPlateCanvas(400, 70, [20, 140, 50], [250, 250, 250], { strokeCount: 18 });
      const report = evaluateMalaysianPlateVisualCandidate(
        greenSignCanvas,
        { width: 400, height: 70, confidence: 0.60 },
        { width: 1280, height: 720 }
      );

      expect(report.colourProfile).toBe('GREEN_BACKGROUND_LIGHT_TEXT');
      expect(report.decision).toBe('OBVIOUS_NON_PLATE');
    });

    it('15. rejects colorful advertising boards', () => {
      const adCanvas = createMockPlateCanvas(300, 120, [220, 40, 40], [255, 255, 20], { strokeCount: 15 });
      const report = evaluateMalaysianPlateVisualCandidate(
        adCanvas,
        { width: 300, height: 120, confidence: 0.55 },
        { width: 1280, height: 720 }
      );

      expect(report.colourProfile).toBe('HIGH_SATURATION_SIGN');
      expect(report.decision).toBe('OBVIOUS_NON_PLATE');
    });

    it('16. rejects extreme aspect ratio banners (e.g. AR > 7.0)', () => {
      const geom = evaluatePlateGeometry({ width: 700, height: 80 });
      expect(geom.isExtremeAspect).toBe(true);
      expect(geom.geometryScore).toBeLessThan(0);
    });

    it('17. rejects massive overhead toll gantry boards (>45% of frame)', () => {
      const geom = evaluatePlateGeometry({ width: 1000, height: 500 }, { width: 1280, height: 720 });
      expect(geom.isMassiveBoard).toBe(true);
      expect(geom.geometryScore).toBeLessThan(0);
    });

    it('18. rejects paragraph / multi-row text signage', () => {
      const multiRowCanvas = createMockPlateCanvas(300, 100, [30, 30, 30], [230, 230, 230], { strokeCount: 32 });
      const stroke = evaluateCharacterStrokeStructure(multiRowCanvas, 80);
      expect(stroke.isMultiRowSign).toBe(true);
      expect(stroke.strokeScore).toBeLessThan(0);
    });
  });
});

describe('Post-OCR Malaysian Multi-Signal Final Confirmation', () => {
  it('confirms valid Malaysian plate with strong OCR and pattern match', () => {
    const track = createMockTrack();
    const result = evaluateMalaysianPlateFinalConfirmation(track, 'VME7108', 0.92);

    expect(result.decision).toBe('CONFIRMED_PLATE');
    expect(result.isPatternValid).toBe(true);
    expect(result.finalMalaysiaPlateScore).toBeGreaterThanOrEqual(0.65);
  });

  it('confirms standard Peninsular letter-number plate (WXY1234)', () => {
    const track = createMockTrack();
    const result = evaluateMalaysianPlateFinalConfirmation(track, 'WXY1234', 0.89);

    expect(result.decision).toBe('CONFIRMED_PLATE');
    expect(result.isPatternValid).toBe(true);
  });

  it('confirms EV special series (EV1234, EVA88)', () => {
    const track = createMockTrack();
    const result = evaluateMalaysianPlateFinalConfirmation(track, 'EV1234', 0.90);

    expect(result.decision).toBe('CONFIRMED_PLATE');
    expect(result.patternCategory).toBe('EV_SPECIAL');
  });

  it('confirms Sabah / Sarawak plate series (SAB1234, QAA1234)', () => {
    const track = createMockTrack();
    const result1 = evaluateMalaysianPlateFinalConfirmation(track, 'SAB1234', 0.88);
    expect(result1.decision).toBe('CONFIRMED_PLATE');
    expect(result1.patternCategory).toBe('SABAH');

    const result2 = evaluateMalaysianPlateFinalConfirmation(track, 'QAA1234', 0.88);
    expect(result2.decision).toBe('CONFIRMED_PLATE');
    expect(result2.patternCategory).toBe('SARAWAK');
  });

  it('rejects highway text and non-registration words (PLAZA TOL, KUALA LUMPUR, EXIT)', () => {
    const track = createMockTrack();
    const result1 = evaluateMalaysianPlateFinalConfirmation(track, 'KUALA LUMPUR', 0.85);
    expect(result1.isPatternValid).toBe(false);

    const result2 = evaluateMalaysianPlateFinalConfirmation(track, 'PLAZA TOL', 0.80);
    expect(result2.isPatternValid).toBe(false);

    const result3 = evaluateMalaysianPlateFinalConfirmation(track, 'EXIT 204', 0.80);
    expect(result3.isPatternValid).toBe(false);
  });

  it('does not confirm persistent road signs with invalid registration syntax even after 100 frames', () => {
    const track = createMockTrack({
      framesSeen: 100,
      votes: new Map([['LEBUHRAYA', { count: 100, totalConfidence: 90 }]]),
    });

    const result = evaluateMalaysianPlateFinalConfirmation(track, 'LEBUHRAYA', 0.90);
    expect(result.isPatternValid).toBe(false);
    expect(result.decision).not.toBe('CONFIRMED_PLATE');
  });
});

describe('False Rejection Audit & Confusion Matrix', () => {
  it('never early-rejects on single imperfect visual signal (One Weak Signal != Rejection)', () => {
    // 1. Black plate with blueish reflection but standard plate aspect ratio & strokes
    const blueReflectCanvas = createMockPlateCanvas(220, 65, [25, 35, 60], [220, 220, 220], { strokeCount: 6 });
    const r1 = evaluateMalaysianPlateVisualCandidate(blueReflectCanvas, { width: 220, height: 65, confidence: 0.85 });
    expect(r1.decision).not.toBe('OBVIOUS_NON_PLATE');

    // 2. Yellowish illumination under warm streetlights
    const yellowLightCanvas = createMockPlateCanvas(220, 65, [45, 40, 20], [240, 230, 180], { strokeCount: 6 });
    const r2 = evaluateMalaysianPlateVisualCandidate(yellowLightCanvas, { width: 220, height: 65, confidence: 0.82 });
    expect(r2.decision).not.toBe('OBVIOUS_NON_PLATE');

    // 3. Plate entering from edge (clipped aspect ratio AR = 2.0)
    const clippedCanvas = createMockPlateCanvas(130, 65, [25, 25, 25], [230, 230, 230], { strokeCount: 3 });
    const r3 = evaluateMalaysianPlateVisualCandidate(clippedCanvas, { width: 130, height: 65, confidence: 0.75 });
    expect(r3.decision).not.toBe('OBVIOUS_NON_PLATE');

    // 4. Low stroke count on a clean 3-character plate (e.g. W1A)
    const shortPlateCanvas = createMockPlateCanvas(180, 60, [25, 25, 25], [230, 230, 230], { strokeCount: 3 });
    const r4 = evaluateMalaysianPlateVisualCandidate(shortPlateCanvas, { width: 180, height: 60, confidence: 0.85 });
    expect(r4.decision).not.toBe('OBVIOUS_NON_PLATE');
  });

  it('evaluates comprehensive 40-sample dataset and produces Confusion Matrix with ZERO False Negatives', () => {
    interface TestSample {
      name: string;
      isRealPlate: boolean;
      canvas: HTMLCanvasElement;
      bbox: { width: number; height: number; confidence: number };
      sourceDim?: { width: number; height: number };
      options?: { isNight?: boolean; isGlare?: boolean; isBlur?: boolean; isSlanted?: boolean };
    }

    const testSet: TestSample[] = [
      // 20 Genuine Malaysian Plates
      { name: 'Standard Black Peninsular', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [20, 20, 20], [240, 240, 240]), bbox: { width: 220, height: 65, confidence: 0.90 } },
      { name: 'Standard Black Sabah', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [25, 25, 25], [235, 235, 235]), bbox: { width: 220, height: 65, confidence: 0.88 } },
      { name: 'Standard Black Sarawak', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [22, 22, 22], [230, 230, 230]), bbox: { width: 220, height: 65, confidence: 0.87 } },
      { name: 'Motorcycle Square Plate', isRealPlate: true, canvas: createMockPlateCanvas(160, 110, [25, 25, 25], [230, 230, 230]), bbox: { width: 160, height: 110, confidence: 0.85 } },
      { name: 'Two-Line Taxi Plate', isRealPlate: true, canvas: createMockPlateCanvas(160, 100, [240, 240, 240], [20, 20, 20]), bbox: { width: 160, height: 100, confidence: 0.86 } },
      { name: 'White Background Commercial', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [235, 235, 235], [20, 20, 20]), bbox: { width: 220, height: 65, confidence: 0.85 } },
      { name: 'Malaysian EV JPJePlate', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [240, 240, 240], [20, 20, 20], { leftStripeRgb: [30, 160, 60], leftStripeWidthRatio: 0.22 }), bbox: { width: 220, height: 65, confidence: 0.92 } },
      { name: 'EV Plate Without Visible Stripe (Distant)', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [235, 235, 235], [20, 20, 20]), bbox: { width: 220, height: 65, confidence: 0.82 } },
      { name: 'Night Low Light Plate', isRealPlate: true, canvas: createMockPlateCanvas(200, 60, [15, 15, 18], [120, 120, 125]), bbox: { width: 200, height: 60, confidence: 0.80 }, options: { isNight: true } },
      { name: 'Headlight Glare Plate', isRealPlate: true, canvas: createMockPlateCanvas(200, 60, [240, 240, 240], [250, 250, 250]), bbox: { width: 200, height: 60, confidence: 0.78 }, options: { isGlare: true } },
      { name: 'Motion Blurred Plate', isRealPlate: true, canvas: createMockPlateCanvas(190, 60, [30, 30, 30], [180, 180, 180]), bbox: { width: 190, height: 60, confidence: 0.76 }, options: { isBlur: true } },
      { name: 'Slanted Perspective Plate', isRealPlate: true, canvas: createMockPlateCanvas(210, 70, [25, 25, 25], [230, 230, 230]), bbox: { width: 210, height: 70, confidence: 0.84 }, options: { isSlanted: true } },
      { name: 'Distant Small Plate (60px)', isRealPlate: true, canvas: createMockPlateCanvas(60, 20, [30, 30, 30], [200, 200, 200]), bbox: { width: 60, height: 20, confidence: 0.74 } },
      { name: 'Close-Up Plate (400px)', isRealPlate: true, canvas: createMockPlateCanvas(400, 110, [25, 25, 25], [230, 230, 230]), bbox: { width: 400, height: 110, confidence: 0.94 } },
      { name: 'Dirty Faded Plate', isRealPlate: true, canvas: createMockPlateCanvas(200, 60, [60, 58, 55], [170, 168, 165]), bbox: { width: 200, height: 60, confidence: 0.80 } },
      { name: 'Streetlight Yellow Tint Plate', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [45, 40, 20], [240, 230, 180]), bbox: { width: 220, height: 65, confidence: 0.84 } },
      { name: 'Blue Reflection Black Plate', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [25, 35, 60], [220, 220, 220]), bbox: { width: 220, height: 65, confidence: 0.86 } },
      { name: 'Partially Clipped Frame Entry Plate', isRealPlate: true, canvas: createMockPlateCanvas(130, 65, [25, 25, 25], [230, 230, 230]), bbox: { width: 130, height: 65, confidence: 0.76 } },
      { name: 'Short Prefix Plate (W1A)', isRealPlate: true, canvas: createMockPlateCanvas(180, 60, [25, 25, 25], [230, 230, 230], { strokeCount: 3 }), bbox: { width: 180, height: 60, confidence: 0.88 } },
      { name: 'Trader Dealer Suffix Plate', isRealPlate: true, canvas: createMockPlateCanvas(220, 65, [240, 240, 240], [180, 20, 20]), bbox: { width: 220, height: 65, confidence: 0.85 } },

      // 20 Non-Plate Road Objects & Sign False Positives
      { name: 'Blue Highway Direction Sign', isRealPlate: false, canvas: createMockPlateCanvas(320, 60, [20, 70, 190], [250, 250, 250], { strokeCount: 16 }), bbox: { width: 320, height: 60, confidence: 0.65 } },
      { name: 'Blue Toll Highway Information Sign', isRealPlate: false, canvas: createMockPlateCanvas(300, 80, [15, 65, 180], [250, 250, 250], { strokeCount: 18 }), bbox: { width: 300, height: 80, confidence: 0.62 } },
      { name: 'Green Highway Exit Signboard', isRealPlate: false, canvas: createMockPlateCanvas(400, 70, [20, 140, 50], [250, 250, 250], { strokeCount: 18 }), bbox: { width: 400, height: 70, confidence: 0.60 } },
      { name: 'Green Distance Table Board', isRealPlate: false, canvas: createMockPlateCanvas(350, 90, [20, 135, 45], [250, 250, 250], { strokeCount: 22 }), bbox: { width: 350, height: 90, confidence: 0.58 } },
      { name: 'Overhead Gantry Road Board', isRealPlate: false, canvas: createMockPlateCanvas(600, 120, [20, 140, 50], [250, 250, 250], { strokeCount: 26 }), bbox: { width: 600, height: 120, confidence: 0.65 } },
      { name: 'Massive Toll Canopy Sign', isRealPlate: false, canvas: createMockPlateCanvas(700, 250, [20, 70, 190], [250, 250, 250], { strokeCount: 30 }), bbox: { width: 900, height: 450, confidence: 0.70 }, sourceDim: { width: 1280, height: 720 } },
      { name: 'Red Sale Commercial Billboard', isRealPlate: false, canvas: createMockPlateCanvas(300, 120, [220, 40, 40], [255, 255, 20], { strokeCount: 15 }), bbox: { width: 300, height: 120, confidence: 0.55 } },
      { name: 'Bright Yellow Warning Board', isRealPlate: false, canvas: createMockPlateCanvas(280, 100, [230, 210, 20], [10, 10, 10], { strokeCount: 16 }), bbox: { width: 280, height: 100, confidence: 0.58 } },
      { name: 'Orange Road Construction Sign', isRealPlate: false, canvas: createMockPlateCanvas(260, 90, [230, 120, 20], [10, 10, 10], { strokeCount: 14 }), bbox: { width: 260, height: 90, confidence: 0.56 } },
      { name: 'Shop Front Business Nameboard', isRealPlate: false, canvas: createMockPlateCanvas(450, 80, [190, 30, 80], [255, 255, 255], { strokeCount: 24 }), bbox: { width: 450, height: 80, confidence: 0.60 } },
      { name: 'Extreme Aspect Ratio Banner (AR=8.0)', isRealPlate: false, canvas: createMockPlateCanvas(800, 100, [30, 30, 30], [230, 230, 230]), bbox: { width: 800, height: 100, confidence: 0.60 } },
      { name: 'Extreme Vertical Pillar Sign (AR=0.4)', isRealPlate: false, canvas: createMockPlateCanvas(60, 150, [30, 30, 30], [230, 230, 230]), bbox: { width: 60, height: 150, confidence: 0.55 } },
      { name: 'Bus Side Advertisement Text', isRealPlate: false, canvas: createMockPlateCanvas(500, 100, [210, 80, 30], [255, 255, 255], { strokeCount: 28 }), bbox: { width: 500, height: 100, confidence: 0.62 } },
      { name: 'Truck Cargo Door Safety Notice', isRealPlate: false, canvas: createMockPlateCanvas(320, 110, [20, 80, 180], [255, 255, 255], { strokeCount: 30 }), bbox: { width: 320, height: 110, confidence: 0.58 } },
      { name: 'Highway Rest Stop Restoran Sign', isRealPlate: false, canvas: createMockPlateCanvas(380, 90, [20, 130, 60], [255, 255, 255], { strokeCount: 20 }), bbox: { width: 380, height: 90, confidence: 0.60 } },
      { name: 'Building Address Number Banner', isRealPlate: false, canvas: createMockPlateCanvas(350, 70, [20, 80, 190], [255, 255, 255], { strokeCount: 16 }), bbox: { width: 350, height: 70, confidence: 0.54 } },
      { name: 'Parking Zone Rate Board', isRealPlate: false, canvas: createMockPlateCanvas(280, 120, [20, 75, 185], [255, 255, 255], { strokeCount: 22 }), bbox: { width: 280, height: 120, confidence: 0.59 } },
      { name: 'Highway Speed Limit & Radar Sign', isRealPlate: false, canvas: createMockPlateCanvas(300, 90, [20, 80, 180], [255, 255, 255], { strokeCount: 16 }), bbox: { width: 300, height: 90, confidence: 0.61 } },
      { name: 'Pedestrian Crossing Signboard', isRealPlate: false, canvas: createMockPlateCanvas(250, 100, [20, 80, 190], [255, 255, 255], { strokeCount: 14 }), bbox: { width: 250, height: 100, confidence: 0.56 } },
      { name: 'Toll Lane Touch N Go Rate Board', isRealPlate: false, canvas: createMockPlateCanvas(360, 85, [15, 70, 180], [255, 255, 255], { strokeCount: 20 }), bbox: { width: 360, height: 85, confidence: 0.63 } },
    ];

    let TP = 0; // Real plate preserved for OCR
    let FN = 0; // Real plate incorrectly rejected (Target = 0!)
    let TN = 0; // Non-plate correctly eliminated before OCR
    let FP = 0; // Non-plate admitted to OCR

    const falseNegativeList: string[] = [];

    for (const sample of testSet) {
      const report = evaluateMalaysianPlateVisualCandidate(
        sample.canvas,
        sample.bbox,
        sample.sourceDim,
        sample.options
      );

      const predictedPlate = report.decision !== 'OBVIOUS_NON_PLATE';

      if (sample.isRealPlate) {
        if (predictedPlate) {
          TP++;
        } else {
          FN++;
          falseNegativeList.push(`${sample.name}: Reason = ${report.rejectionReason}`);
        }
      } else {
        if (!predictedPlate) {
          TN++;
        } else {
          FP++;
        }
      }
    }

    const preOcrPlateRecall = TP / (TP + FN);
    const nonPlateRejectionRate = TN / (TN + FP);

    console.info(`\n======================================================`);
    console.info(`MALAYSIA CANDIDATE GATE AUDIT CONFUSION MATRIX`);
    console.info(`======================================================`);
    console.info(`                       Predicted Plate   Predicted Non-Plate`);
    console.info(`Real Plate (20)             TP = ${TP}            FN = ${FN}`);
    console.info(`Non-Plate  (20)             FP = ${FP}            TN = ${TN}`);
    console.info(`------------------------------------------------------`);
    console.info(`Pre-OCR Plate Recall:        ${(preOcrPlateRecall * 100).toFixed(1)}% (Target: 100%)`);
    console.info(`Non-Plate Rejection Rate:    ${(nonPlateRejectionRate * 100).toFixed(1)}%`);
    console.info(`OCR Workload Reduction:      ${((TN / testSet.length) * 100).toFixed(1)}% of total YOLO proposals filtered pre-OCR`);
    console.info(`======================================================\n`);

    // Zero False Negatives requirement:
    expect(falseNegativeList).toEqual([]);
    expect(FN).toBe(0);
    expect(preOcrPlateRecall).toBe(1.0);
    expect(TN).toBeGreaterThanOrEqual(18); // >= 90% of highway/ad/toll boards filtered pre-OCR
  });
});

