import fs from 'fs';
import path from 'path';

function copyOnnxWasm() {
  const projectRoot = process.cwd();
  const src = path.join(projectRoot, 'node_modules', 'onnxruntime-web', 'dist');
  const dest = path.join(projectRoot, 'public', 'ort-wasm');

  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  for (const file of fs.readdirSync(src)) {
    const isWasmLoader =
      file.startsWith('ort-wasm-simd-threaded') && (file.endsWith('.wasm') || file.endsWith('.mjs'));
    const isBrowserRuntime = file === 'ort.min.js';

    if (!isWasmLoader && !isBrowserRuntime) continue;

    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);
    const srcStat = fs.statSync(srcFile);
    const destStat = fs.existsSync(destFile) ? fs.statSync(destFile) : null;

    if (!destStat || srcStat.mtimeMs > destStat.mtimeMs) {
      fs.copyFileSync(srcFile, destFile);
    }
  }
}

copyOnnxWasm();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          },
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
