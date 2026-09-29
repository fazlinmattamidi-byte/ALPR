/** Contrast-limited adaptive histogram equalization, with bilinear tile blending.
 * Input/output are RGBA; alpha is preserved. No binarization or invented edges.
 */
export function applyClahe(data: Uint8ClampedArray, width: number, height: number, clipLimit = 2): void {
  if (width < 1 || height < 1) return;
  const cols = Math.min(8, Math.max(1, Math.floor(width / 16)));
  const rows = Math.min(8, Math.max(1, Math.floor(height / 16)));
  const maps: Float32Array[] = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = Math.floor(tx * width / cols), x1 = Math.floor((tx + 1) * width / cols);
      const y0 = Math.floor(ty * height / rows), y1 = Math.floor((ty + 1) * height / rows);
      const count = (x1 - x0) * (y1 - y0);
      const histogram = new Float32Array(256);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) histogram[data[(y * width + x) * 4]]++;
      const map = new Float32Array(256);
      // Leave flat tiles flat, including completely clipped glare.
      if (histogram.some(value => value === count)) {
        for (let i = 0; i < 256; i++) map[i] = i;
      } else {
        const cap = Math.max(1, clipLimit * count / 256);
        let excess = 0;
        for (let i = 0; i < 256; i++) { excess += Math.max(0, histogram[i] - cap); histogram[i] = Math.min(cap, histogram[i]); }
        let cumulative = 0;
        for (let i = 0; i < 256; i++) {
          cumulative += histogram[i] + excess / 256;
          map[i] = Math.min(255, cumulative * 255 / count);
        }
      }
      maps.push(map);
    }
  }
  for (let y = 0; y < height; y++) {
    const gy = Math.max(0, Math.min(rows - 1, (y + 0.5) * rows / height - 0.5));
    const y0 = Math.floor(gy), y1 = Math.min(rows - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.max(0, Math.min(cols - 1, (x + 0.5) * cols / width - 0.5));
      const x0 = Math.floor(gx), x1 = Math.min(cols - 1, x0 + 1), fx = gx - x0;
      const offset = (y * width + x) * 4, value = data[offset];
      const top = maps[y0 * cols + x0][value] * (1 - fx) + maps[y0 * cols + x1][value] * fx;
      const bottom = maps[y1 * cols + x0][value] * (1 - fx) + maps[y1 * cols + x1][value] * fx;
      data[offset] = data[offset + 1] = data[offset + 2] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
}
