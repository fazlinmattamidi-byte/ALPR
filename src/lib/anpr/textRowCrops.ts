/** Locate two rows of contrasting glyphs, excluding the plate frame and dealer
 * text. Optional recovery only: callers retain their original plate crop. */
export function extractTwoLineTextCrops(source: HTMLCanvasElement): { top: HTMLCanvasElement; bottom: HTMLCanvasElement } | null {
  const { width, height } = source;
  if (width < 24 || height < 32) return null;
  const ctx = source.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114);
    sum += gray[i];
  }
  // Bounded exposure-relative threshold; polarity covers light/dark plates.
  const threshold = Math.min(190, Math.max(65, sum / gray.length + 30));
  type Component = { left: number; right: number; top: number; bottom: number; area: number };
  for (const bright of [true, false]) {
    const visited = new Uint8Array(gray.length);
    const queue = new Int32Array(gray.length);
    const components: Component[] = [];
    const foreground = (i: number) => bright ? gray[i] > threshold : gray[i] < threshold;
    for (let start = 0; start < gray.length; start++) {
      if (visited[start] || !foreground(start)) continue;
      let head = 0, tail = 1;
      queue[0] = start; visited[start] = 1;
      const item: Component = { left: width, right: 0, top: height, bottom: 0, area: 0 };
      while (head < tail) {
        const i = queue[head++], x = i % width, y = Math.floor(i / width);
        item.left = Math.min(item.left, x); item.right = Math.max(item.right, x);
        item.top = Math.min(item.top, y); item.bottom = Math.max(item.bottom, y); item.area++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (!visited[next] && foreground(next)) { visited[next] = 1; queue[tail++] = next; }
        }
      }
      const h = item.bottom - item.top + 1, w = item.right - item.left + 1;
      if (item.left > 1 && item.top > 1 && item.right < width - 2 && item.bottom < height - 2 &&
          h >= height * 0.12 && h <= height * 0.60 && w < width * 0.70 && item.area >= width * height * 0.001) {
        components.push(item);
      }
    }
    components.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
    let split = -1, gap = height * 0.15;
    for (let i = 1; i < components.length; i++) {
      const distance = (components[i].top + components[i].bottom - components[i - 1].top - components[i - 1].bottom) / 2;
      if (distance > gap) { gap = distance; split = i; }
    }
    if (split < 0) continue;
    const rows = [components.slice(0, split), components.slice(split)].map(group => ({
      left: Math.min(...group.map(c => c.left)), right: Math.max(...group.map(c => c.right)),
      top: Math.min(...group.map(c => c.top)), bottom: Math.max(...group.map(c => c.bottom)),
    }));
    if (rows.some(row => row.right - row.left < width * 0.20 || row.bottom - row.top > height * 0.60)) continue;
    const crop = (row: typeof rows[number]) => {
      const margin = Math.max(2, Math.round((row.bottom - row.top) * 0.06));
      const x = Math.max(0, row.left - margin), y = Math.max(0, row.top - margin);
      const w = Math.min(width - x, row.right - row.left + 1 + margin * 2);
      const h = Math.min(height - y, row.bottom - row.top + 1 + margin * 2);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d')?.drawImage(source, x, y, w, h, 0, 0, w, h);
      return canvas;
    };
    return { top: crop(rows[0]), bottom: crop(rows[1]) };
  }
  return null;
}

/** Compare pixel variants of one row; these are not independent frame votes. */
export function selectCorroboratedTextLine<T extends { rawText: string; confidence: number }>(reads: T[]): T | null {
  const groups = new Map<string, T[]>();
  for (const read of reads) {
    if (!read.rawText || read.confidence < 0.70) continue;
    const group = groups.get(read.rawText) ?? [];
    group.push(read); groups.set(read.rawText, group);
  }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
  const winner = ranked[0];
  if (!winner || winner.length < 2 || winner.length <= (ranked[1]?.length ?? 0)) return null;
  return { ...winner[0], confidence: winner.reduce((sum, read) => sum + read.confidence, 0) / winner.length };
}

export function trimTextLineTop(source: HTMLCanvasElement, ratio: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const trim = Math.round(source.height * Math.max(0, Math.min(0.15, ratio)));
  canvas.width = source.width; canvas.height = source.height - trim;
  canvas.getContext('2d')?.drawImage(source, 0, trim, source.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
