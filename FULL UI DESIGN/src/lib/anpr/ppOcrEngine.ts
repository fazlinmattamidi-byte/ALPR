/**
 * PlateQ — PP-OCR ONNX Recognition Engine
 * Model: PP-OCRv4 / PP-OCRv5 Recognition (public/models/ppocr-rec.onnx)
 * 
 * Production Hardware Execution Policy:
 * Fallback Chain: WebGPU -> WASM (WebGL removed from production chain)
 * Dynamic import caching & zero-GC canvas reuse
 * Guaranteed CPU/GPU memory disposal in try/finally blocks
 */

import { CharacterConfidence, PlateCategory, PlateLayout } from '../db/types';
import { normalizePlate, formatDisplayPlate, generateCandidatePlates } from './normaliser';
import { validateMalaysianPattern } from './patterns';
import {
  canUseWebGpuExecutionProvider,
  configureOrtWasm,
  fetchWithTimeout,
  getOrt,
  withTimeout,
} from './onnxRuntime';

export interface PpOcrRecognitionResult {
  text: string;
  normalizedPlate: string;
  displayPlate: string;
  confidence: number;
  characterConfidences: CharacterConfidence[];
  alternativeCandidates: string[];
  layout: PlateLayout;
  category: PlateCategory;
  patternScore: number;
  hasTrailingSuffix: boolean;
  engineUsed: 'PP_OCR' | 'TESSERACT';
}

export type ActiveOcrProvider = 'WebGPU' | 'WASM' | 'NONE';

let ppOcrSession: any = null;
let dictLines: string[] = [];
let isSessionLoading = false;
let sessionLoadPromise: Promise<boolean> | null = null;
let sessionLoadFailures = 0;
const MAX_SESSION_FAILURES = 3;
const MODEL_FETCH_TIMEOUT_MS = 20000;
const PROVIDER_INIT_TIMEOUT_MS = 15000;
const PROVIDER_WARMUP_TIMEOUT_MS = 8000;

let activeOcrProvider: ActiveOcrProvider = 'NONE';
let reusableOcrCanvas: HTMLCanvasElement | null = null;
let reusableOcrCtx: CanvasRenderingContext2D | null = null;
let reusableOcrFloat32Data: Float32Array | null = null;

let lastPpOcrError: string | null = null;

export function getPpOcrError(): string | null {
  return lastPpOcrError;
}

export function getActivePpOcrProvider(): ActiveOcrProvider {
  return activeOcrProvider;
}

/**
 * Initialize PP-OCR ONNX Session with fallback chain: WebGPU -> WASM
 */
export async function initPpOcrSession(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (ppOcrSession) return true;
  if (sessionLoadFailures >= MAX_SESSION_FAILURES) return false;
  if (isSessionLoading && sessionLoadPromise) return sessionLoadPromise;

  isSessionLoading = true;
  lastPpOcrError = null;

  sessionLoadPromise = (async () => {
    try {
      // 1. Fetch character dictionary
      const dictRes = await fetchWithTimeout(
        '/models/ppocr-dict.txt',
        MODEL_FETCH_TIMEOUT_MS,
        'PP-OCR dictionary fetch'
      );
      if (!dictRes.ok) {
        console.warn('[PP-OCR] Dictionary /models/ppocr-dict.txt not found.');
        sessionLoadFailures++;
        return false;
      }
      const dictText = await dictRes.text();
      dictLines = dictText.split(/\r?\n/).map(l => l.trim());
      dictLines.push(' '); // Append space character at index dictLines.length

      // 2. Load ONNX Runtime Web
      const ort = await getOrt();
      const webGpuAvailable = canUseWebGpuExecutionProvider();
      configureOrtWasm(ort, webGpuAvailable);

      const modelRes = await fetchWithTimeout(
        '/models/ppocr-rec.onnx',
        MODEL_FETCH_TIMEOUT_MS,
        'PP-OCR recognition model fetch'
      );
      if (!modelRes.ok) {
        throw new Error(`HTTP ${modelRes.status} ${modelRes.statusText} fetching /models/ppocr-rec.onnx`);
      }
      const modelBuffer = await modelRes.arrayBuffer();
      const modelBytes = new Uint8Array(modelBuffer);

      let lastErrDetail = '';
      const configsToTry = [
        ...(webGpuAvailable ? [{ epList: ['webgpu', 'wasm'], opt: 'all', name: 'WebGPU' as ActiveOcrProvider }] : []),
        { epList: ['wasm'], opt: 'all', name: 'WASM' as ActiveOcrProvider },
        { epList: ['wasm'], opt: 'basic', name: 'WASM' as ActiveOcrProvider },
      ];

      for (const config of configsToTry) {
        try {
          configureOrtWasm(ort, config.name === 'WebGPU');
          const session = await withTimeout<any>(
            ort.InferenceSession.create(modelBytes, {
              executionProviders: config.epList,
              graphOptimizationLevel: config.opt as any,
            }),
            PROVIDER_INIT_TIMEOUT_MS,
            `PP-OCR ${config.name} session creation`
          );

          // Dummy inference validation
          const dummyInput = new ort.Tensor('float32', new Float32Array(1 * 3 * 48 * 320), [1, 3, 48, 320]);
          const inputName = session.inputNames[0] || 'x';
          const dummyResults = await withTimeout<Record<string, any>>(
            session.run({ [inputName]: dummyInput }),
            PROVIDER_WARMUP_TIMEOUT_MS,
            `PP-OCR ${config.name} warm-up`
          );

          dummyInput.dispose?.();
          for (const t of Object.values(dummyResults)) {
            (t as any)?.dispose?.();
          }

          ppOcrSession = session;
          activeOcrProvider = config.name;
          sessionLoadFailures = 0;
          console.log(`[PP-OCR] ONNX Session initialized successfully with provider: ${config.name} (opt: ${config.opt})`);
          return true;
        } catch (err: any) {
          lastErrDetail = err?.message || String(err);
          console.warn(`[PP-OCR] Provider ${config.name} (opt: ${config.opt}) failed:`, lastErrDetail);
        }
      }

      throw new Error(`PP-OCR session creation failed: ${lastErrDetail || 'Unknown error'}`);
    } catch (err: any) {
      sessionLoadFailures++;
      activeOcrProvider = 'NONE';
      lastPpOcrError = err?.message || String(err);
      console.warn(`[PP-OCR] Failed to initialize ONNX session:`, lastPpOcrError);
      return false;
    }
  })().finally(() => {
    isSessionLoading = false;
    sessionLoadPromise = null;
  });

  return sessionLoadPromise;
}

export function isPpOcrReady(): boolean {
  return ppOcrSession !== null && dictLines.length > 0;
}

/**
 * Benchmark helper for WASM admission control
 */
export async function runBenchmarkOcr(): Promise<boolean> {
  if (!ppOcrSession) return false;
  try {
    const ort = await getOrt();
    const dummyInput = new ort.Tensor('float32', new Float32Array(1 * 3 * 48 * 320), [1, 3, 48, 320]);
    const inputName = ppOcrSession.inputNames[0] || 'x';
    const dummyResults = await ppOcrSession.run({ [inputName]: dummyInput });

    dummyInput.dispose?.();
    for (const t of Object.values(dummyResults)) {
      (t as any)?.dispose?.();
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Run PP-OCR ONNX inference on a crop canvas
 */
export async function recognizeWithPpOcr(
  cropCanvas: HTMLCanvasElement,
  isTwoLineHint?: boolean
): Promise<PpOcrRecognitionResult | null> {
  if (!ppOcrSession || dictLines.length === 0) {
    const ready = await initPpOcrSession();
    if (!ready || !ppOcrSession) return null;
  }

  const ar = cropCanvas.width / (cropCanvas.height || 1);
  const isTwoLine = isTwoLineHint || ar < 2.3;

  if (isTwoLine) {
    const halfH = Math.round(cropCanvas.height * 0.54);

    const topCanvas = document.createElement('canvas');
    topCanvas.width = cropCanvas.width;
    topCanvas.height = halfH;
    const topCtx = topCanvas.getContext('2d');
    if (topCtx) topCtx.drawImage(cropCanvas, 0, 0, cropCanvas.width, halfH, 0, 0, topCanvas.width, halfH);

    const botCanvas = document.createElement('canvas');
    botCanvas.width = cropCanvas.width;
    botCanvas.height = cropCanvas.height - halfH;
    const botCtx = botCanvas.getContext('2d');
    if (botCtx) botCtx.drawImage(cropCanvas, 0, halfH, cropCanvas.width, cropCanvas.height - halfH, 0, 0, botCanvas.width, botCanvas.height);

    const [topRes, botRes] = await Promise.all([
      runSingleCropPpOcr(topCanvas),
      runSingleCropPpOcr(botCanvas),
    ]);

    const topText = normalizePlate(topRes.rawText);
    const botText = normalizePlate(botRes.rawText);
    const mergedRaw = normalizePlate(`${topText}${botText}`);

    if (mergedRaw && mergedRaw.length >= 2) {
      const avgConf = Math.min(1.0, (topRes.confidence + botRes.confidence) / 2);
      const patternVal = validateMalaysianPattern(mergedRaw);
      const charConfs: CharacterConfidence[] = mergedRaw.split('').map((char, i) => ({
        char,
        confidence: i < topText.length ? topRes.confidence : botRes.confidence,
        position: i,
      }));

      const alternatives = generateCandidatePlates(mergedRaw, charConfs);

      return {
        text: mergedRaw,
        normalizedPlate: mergedRaw,
        displayPlate: formatDisplayPlate(mergedRaw, patternVal.category),
        confidence: avgConf,
        characterConfidences: charConfs,
        alternativeCandidates: alternatives,
        layout: ar < 1.6 ? 'SQUARE' : 'TWO_LINE',
        category: patternVal.category,
        patternScore: patternVal.score,
        hasTrailingSuffix: patternVal.hasTrailingSuffix,
        engineUsed: 'PP_OCR',
      };
    }
  }

  // Single line plate recognition
  const res = await runSingleCropPpOcr(cropCanvas);
  const normText = normalizePlate(res.rawText);
  if (!normText) return null;

  const patternVal = validateMalaysianPattern(normText);
  const charConfs: CharacterConfidence[] = res.characterConfidences.map((c, i) => ({
    char: c.char,
    confidence: c.confidence,
    position: i,
  }));

  const alternatives = generateCandidatePlates(normText, charConfs);

  return {
    text: normText,
    normalizedPlate: normText,
    displayPlate: formatDisplayPlate(normText, patternVal.category),
    confidence: res.confidence,
    characterConfidences: charConfs,
    alternativeCandidates: alternatives,
    layout: 'SINGLE_LINE',
    category: patternVal.category,
    patternScore: patternVal.score,
    hasTrailingSuffix: patternVal.hasTrailingSuffix,
    engineUsed: 'PP_OCR',
  };
}

/**
 * Execute PP-OCR on a single cropped canvas region with Memory Disposal Guarantee
 */
async function runSingleCropPpOcr(
  canvas: HTMLCanvasElement
): Promise<{ rawText: string; confidence: number; characterConfidences: { char: string; confidence: number }[] }> {
  if (!ppOcrSession) {
    return { rawText: '', confidence: 0, characterConfidences: [] };
  }

  const targetH = 48;
  const targetW = 320;

  if (!reusableOcrCanvas) {
    reusableOcrCanvas = document.createElement('canvas');
    reusableOcrCanvas.width = targetW;
    reusableOcrCanvas.height = targetH;
    reusableOcrCtx = reusableOcrCanvas.getContext('2d', { willReadFrequently: true });
  }

  if (!reusableOcrCtx) {
    return { rawText: '', confidence: 0, characterConfidences: [] };
  }

  // Fill background neutral gray
  reusableOcrCtx.fillStyle = '#7f7f7f';
  reusableOcrCtx.fillRect(0, 0, targetW, targetH);

  // Maintain aspect ratio scaling
  const scale = Math.min(targetW / canvas.width, targetH / canvas.height);
  const drawW = Math.round(canvas.width * scale);
  const drawH = Math.round(canvas.height * scale);
  const offsetX = 0;
  const offsetY = Math.round((targetH - drawH) / 2);

  reusableOcrCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, offsetX, offsetY, drawW, drawH);

  const imgData = reusableOcrCtx.getImageData(0, 0, targetW, targetH);
  const { data } = imgData;

  const channelArea = targetH * targetW;
  if (!reusableOcrFloat32Data || reusableOcrFloat32Data.length !== 3 * channelArea) {
    reusableOcrFloat32Data = new Float32Array(3 * channelArea);
  }

  for (let i = 0; i < channelArea; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];

    // Standard PaddleOCR normalization
    reusableOcrFloat32Data[i] = (r / 255.0 - 0.5) / 0.5;
    reusableOcrFloat32Data[channelArea + i] = (g / 255.0 - 0.5) / 0.5;
    reusableOcrFloat32Data[2 * channelArea + i] = (b / 255.0 - 0.5) / 0.5;
  }

  let inputTensor: any = null;
  let results: any = null;

  try {
    const ort = await getOrt();
    inputTensor = new ort.Tensor('float32', reusableOcrFloat32Data, [1, 3, targetH, targetW]);
    const inputName = ppOcrSession.inputNames[0] || 'x';

    results = await ppOcrSession.run({ [inputName]: inputTensor });

    const outputName = ppOcrSession.outputNames[0];
    const outputTensor = results[outputName];

    if (!outputTensor) {
      return { rawText: '', confidence: 0, characterConfidences: [] };
    }

    const rawOutput = outputTensor.data as Float32Array; // shape: [1, seqLen, numClasses]
    const dims = outputTensor.dims;
    const seqLen = dims[1] || 40;
    const numClasses = dims[2] || dictLines.length + 1;

    // CTC Greedy Decoding
    const charList: string[] = [];
    const charConfs: { char: string; confidence: number }[] = [];
    let prevIdx = 0;

    for (let t = 0; t < seqLen; t++) {
      const offset = t * numClasses;
      let maxIdx = 0;
      let maxProb = -1;

      for (let c = 0; c < numClasses; c++) {
        const prob = rawOutput[offset + c];
        if (prob > maxProb) {
          maxProb = prob;
          maxIdx = c;
        }
      }

      if (maxIdx !== 0 && maxIdx !== prevIdx) {
        if (maxIdx - 1 < dictLines.length) {
          const char = dictLines[maxIdx - 1];
          if (char && char !== ' ') {
            charList.push(char);
            charConfs.push({ char, confidence: Math.min(1.0, Math.max(0.0, maxProb)) });
          }
        }
      }
      prevIdx = maxIdx;
    }

    const rawText = charList.join('');
    const avgConf = charConfs.length > 0
      ? charConfs.reduce((sum, c) => sum + c.confidence, 0) / charConfs.length
      : 0;

    return {
      rawText,
      confidence: avgConf,
      characterConfidences: charConfs,
    };
  } finally {
    inputTensor?.dispose?.();
    if (results) {
      for (const tensor of Object.values(results)) {
        (tensor as any)?.dispose?.();
      }
    }
  }
}
