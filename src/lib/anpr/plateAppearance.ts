/** Small, exposure-normalized image descriptor used only to retain an already
 * read plate across consecutive detections. It never supplies OCR characters. */
export function capturePlateAppearance(
  source: HTMLCanvasElement,
  box: { x: number; y: number; width: number; height: number },
  scratch: HTMLCanvasElement
): number[] | undefined {
  scratch.width = 24; scratch.height = 12;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx || box.width <= 0 || box.height <= 0) return;
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, 24, 12);
  const data = ctx.getImageData(0, 0, 24, 12).data;
  const gray = Array.from({ length: 288 }, (_, i) =>
    (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255);
  const mean = gray.reduce((sum, value) => sum + value, 0) / gray.length;
  const deviation = Math.sqrt(gray.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gray.length);
  if (deviation < 0.06) return; // Flat/blurred patches are not identity evidence.
  return gray.map(value => (value - mean) / deviation);
}

export function isSamePlateAppearance(left?: number[], right?: number[]): boolean {
  if (!left || !right || left.length !== 288 || right.length !== left.length) return false;
  const error = left.reduce((sum, value, i) => sum + (value - right[i]) ** 2, 0) / left.length;
  return Number.isFinite(error) && error < 0.50;
}
