import { describe, it, expect, afterEach, vi } from 'vitest';
import { selectOcrRecoveryCandidates } from '../lib/anpr/recoveryPolicy';
import { createInnerPlateTextCrop, cropCanvasRegionFast, cropDeskewedCanvasRegionFast } from '../lib/anpr/imageProcessor';
import { evaluateConsensus, addOcrVoteToTrack } from '../lib/anpr/consensus';
import { PlateTracker } from '../lib/anpr/tracker';
import type { PreprocessVariant } from '../lib/anpr/imageProcessor';

describe('Edge Character Preservation & Crop Candidate Prioritization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('1. Candidate Prioritization Order', () => {
    it('always prioritizes original full crop before enhanced and inner crops', () => {
      const original = { variant: 'ORIGINAL' as PreprocessVariant, id: 'orig' };
      const enhanced = [
        { variant: 'CLAHE' as PreprocessVariant, id: 'clahe' },
        { variant: 'GAMMA_BRIGHTEN' as PreprocessVariant, id: 'gamma' },
      ];
      const inner = [{ variant: 'ORIGINAL' as PreprocessVariant, id: 'inner' }];

      const candidates = selectOcrRecoveryCandidates(original, enhanced, inner, false, 0, 4);
      expect(candidates[0]).toEqual(original);
      expect(candidates).toEqual([original, ...enhanced, ...inner]);
    });

    it('ensures full crop is evaluated before destructive inner variants in difficult mode', () => {
      const original = { variant: 'ORIGINAL' as PreprocessVariant, id: 'orig' };
      const enhanced = [{ variant: 'CLAHE' as PreprocessVariant, id: 'clahe' }];
      const inner = [{ variant: 'ORIGINAL' as PreprocessVariant, id: 'inner' }];

      // Pass 0 evaluates original first
      const firstPass = selectOcrRecoveryCandidates(original, enhanced, inner, true, 0, 2);
      expect(firstPass[0]).toEqual(original);

      // Subsequent retries evaluate correction before inner
      const retryPass = selectOcrRecoveryCandidates(original, enhanced, inner, true, 1, 2);
      expect(retryPass[0]).toEqual(enhanced[0]);
    });
  });

  describe('2. Consensus Complete Plate Protection against Truncated Subsets', () => {
    it('selects full 7-character plate (WMH1548) over higher-confidence cropped fragment (MH548)', () => {
      const track = new PlateTracker(15, 8, 1).updateTracks([{ x: 0, y: 0, width: 100, height: 40, confidence: 0.95 }])[0];

      // Simulate OCR evidence: 2 observations of complete plate (conf 0.84), 1 observation of inner cropped fragment (conf 0.94)
      addOcrVoteToTrack(track, 'WMH1548', 0.82, 1, 1000);
      addOcrVoteToTrack(track, 'WMH1548', 0.87, 1, 1100);
      addOcrVoteToTrack(track, 'MH548', 0.94, 1, 1200);

      const result = evaluateConsensus(track, 2, 0.75, true);
      expect(result.normalizedPlate).toBe('WMH1548');
      expect(result.voteCount).toBe(2);
    });

    it('prefers complete standard Malaysian plate over truncated prefix or suffix subsets', () => {
      const track = new PlateTracker(15, 8, 1).updateTracks([{ x: 0, y: 0, width: 100, height: 40, confidence: 0.95 }])[0];

      // Complete 7-char reading vs 5-char prefix-clipped reading
      addOcrVoteToTrack(track, 'VNE7108', 0.80, 1, 1000);
      addOcrVoteToTrack(track, 'VNE7108', 0.85, 1, 1100);
      addOcrVoteToTrack(track, 'NE7108', 0.92, 1, 1200);

      const result = evaluateConsensus(track, 2, 0.75, true);
      expect(result.normalizedPlate).toBe('VNE7108');
    });
  });

  describe('3. Crop Boundary & Geometry Robustness', () => {
    function setupMockDocument() {
      vi.stubGlobal('document', {
        createElement: (tag: string) => {
          if (tag === 'canvas') {
            return {
              width: 0,
              height: 0,
              getContext: () => ({
                imageSmoothingEnabled: true,
                imageSmoothingQuality: 'high',
                fillStyle: '',
                fillRect: vi.fn(),
                save: vi.fn(),
                restore: vi.fn(),
                translate: vi.fn(),
                rotate: vi.fn(),
                scale: vi.fn(),
                drawImage: vi.fn(),
                getImageData: () => ({ data: new Uint8ClampedArray(400) }),
                putImageData: vi.fn(),
              }),
            };
          }
          return {};
        },
      });
    }

    it('creates crop with safe outer margins without clipping first and last characters', () => {
      setupMockDocument();
      const dummyCanvas = { width: 1920, height: 1080 } as unknown as HTMLCanvasElement;

      // Tight detection box representing wide-angle camera boundary
      const tightBbox = { x: 500, y: 400, width: 120, height: 35, confidence: 0.90 };
      const crop = cropCanvasRegionFast(dummyCanvas, tightBbox);

      expect(crop.width).toBeGreaterThanOrEqual(320);
      expect(crop.height).toBeGreaterThanOrEqual(48);
    });

    it('preserves plate geometry on slanted tight bounding boxes without cutting edges', () => {
      setupMockDocument();
      const dummyCanvas = { width: 1920, height: 1080 } as unknown as HTMLCanvasElement;

      const slantedBbox = { x: 300, y: 200, width: 150, height: 45, confidence: 0.88 };
      const deskewed = cropDeskewedCanvasRegionFast(dummyCanvas, slantedBbox, 0.15);

      expect(deskewed.width).toBeGreaterThanOrEqual(320);
      expect(deskewed.height).toBeGreaterThanOrEqual(48);
    });

    it('preserves inner crop as a valid standalone canvas without breaking dimensions', () => {
      setupMockDocument();
      const sourceCrop = { width: 360, height: 108 } as unknown as HTMLCanvasElement;

      const inner = createInnerPlateTextCrop(sourceCrop);
      expect(inner.width).toBe(360);
      expect(inner.height).toBe(108);
    });
  });
});
