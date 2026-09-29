import { afterEach, expect, it, vi } from 'vitest';
import { extractTwoLineTextCrops, selectCorroboratedTextLine } from '../lib/anpr/textRowCrops';

afterEach(() => { vi.unstubAllGlobals(); });

it('keeps the narrow digit in a text row while excluding the frame and dealer text', () => {
  const width = 200, height = 180;
  const data = new Uint8ClampedArray(width * height * 4);
  const rect = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      const p = (j * width + i) * 4; data[p] = data[p + 1] = data[p + 2] = 230; data[p + 3] = 255;
    }
  };
  rect(0, 0, 5, height); rect(195, 0, 5, height);
  rect(45, 25, 18, 45); rect(78, 25, 18, 45); rect(112, 25, 18, 45);
  rect(45, 92, 20, 45); rect(73, 92, 3, 45); rect(84, 92, 20, 45); rect(115, 92, 20, 45);
  rect(45, 156, 90, 5);
  const draws: number[][] = [];
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (_: unknown, ...args: number[]) => draws.push(args) }) }) });
  const source = { width, height, getContext: () => ({ getImageData: () => ({ data }) }) } as unknown as HTMLCanvasElement;
  expect(extractTwoLineTextCrops(source)).not.toBeNull();
  expect(draws).toHaveLength(2);
  expect(draws[1][0]).toBeLessThan(45);
  expect(draws[1][0] + draws[1][2]).toBeGreaterThan(134);
  expect(draws[1][1]).toBeLessThan(92);
  expect(draws[1][1] + draws[1][3]).toBeLessThan(156);
});

it('leaves blank crops to the original OCR path', () => {
  const source = { width: 100, height: 100, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(40000) }) }) } as unknown as HTMLCanvasElement;
  expect(extractTwoLineTextCrops(source)).toBeNull();
});

it('prefers corroborated row text over a more confident missing digit, without inventing one', () => {
  expect(selectCorroboratedTextLine([
    { rawText: '708', confidence: 0.97 },
    { rawText: '7108', confidence: 0.86 },
    { rawText: '7108', confidence: 0.94 },
    { rawText: '7108', confidence: 0.95 },
  ])).toMatchObject({ rawText: '7108', confidence: (0.86 + 0.94 + 0.95) / 3 });
  expect(selectCorroboratedTextLine([
    { rawText: '708', confidence: 0.97 }, { rawText: '7108', confidence: 0.94 },
  ])).toBeNull();
  expect(selectCorroboratedTextLine([
    { rawText: '708', confidence: 0.97 }, { rawText: '708', confidence: 0.94 },
  ])?.rawText).toBe('708');
});
