/**
 * PlateQ — PP-OCR ONNX Recognition Engine
 * Model: PP-OCRv4 / PP-OCRv5 Recognition (public/models/ppocr-rec.onnx)
 * 
 * Production Hardware Execution Policy:
 * Stable Chain: WASM -> WebGPU (WebGL removed from production chain)
 * Dynamic import caching & zero-GC canvas reuse
 * Guaranteed CPU/GPU memory disposal in try/finally blocks
 */

import { CharacterConfidence, PlateCategory, PlateLayout } from '../db/types';
import {
  normalizePlate,
  formatDisplayPlate,
  generateCandidatePlates,
  correctMalaysianTypographyOcr,
} from './normaliser';
import { validateMalaysianPattern } from './patterns';
import { haveDifferentNumericOutputs } from './runtimeOutputValidation';
import { extractTwoLineTextCrops, selectCorroboratedTextLine, trimTextLineTop } from './textRowCrops';
import { releaseCanvasMemory, splitCompactTwoLineCrop, splitTwoLineCrop } from './imageProcessor';
import {
  correctMalaysianPlateOcr,
  isPotentialSpecialSeriesCandidate,
} from './specialSeries';
import {
  canUseWebGpuExecutionProvider,
  configureOrtWasm,
  fetchWithTimeout,
  getOrt,
  runOnnxInference,
  withTimeout,
} from './onnxRuntime';

export interface PpOcrRecognitionResult {
  corroboratedRows?: boolean;
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

let ocrInferenceQueue: Promise<any> = Promise.resolve();

async function runSessionInferenceExclusive(session: any, feeds: Record<string, any>): Promise<Record<string, any>> {
  const queued = ocrInferenceQueue.then(() => runOnnxInference(session, feeds));
  ocrInferenceQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

let ppOcrSession: any = null;
let dictLines: string[] = [];
let isSessionLoading = false;
let sessionLoadPromise: Promise<boolean> | null = null;
let sessionLoadFailures = 0;
const MAX_SESSION_FAILURES = 3;
const MODEL_FETCH_TIMEOUT_MS = 20000;
const PROVIDER_INIT_TIMEOUT_MS = 15000;
const PROVIDER_WARMUP_TIMEOUT_MS = 8000;
const DEFAULT_OCR_MODEL_PATH = '/models/ppocr-rec.onnx';
const DEFAULT_OCR_DICTIONARY_PATH = '/models/ppocr-dict.txt';
let ocrModelPath = DEFAULT_OCR_MODEL_PATH;
let ocrDictionaryPath = DEFAULT_OCR_DICTIONARY_PATH;

let activeOcrProvider: ActiveOcrProvider = 'NONE';

interface OcrBufferContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  float32Data: Float32Array;
}

const ocrBufferPool: OcrBufferContext[] = [];

function acquireOcrBuffer(targetW: number, targetH: number): OcrBufferContext | null {
  const existing = ocrBufferPool.pop();
  if (existing) return existing;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const float32Data = new Float32Array(3 * targetH * targetW);
  return { canvas, ctx, float32Data };
}

function releaseOcrBuffer(buf: OcrBufferContext): void {
  if (ocrBufferPool.length < 12) {
    ocrBufferPool.push(buf);
  }
}

let lastPpOcrError: string | null = null;

export function getPpOcrError(): string | null {
  return lastPpOcrError;
}

export function getActivePpOcrProvider(): ActiveOcrProvider {
  return activeOcrProvider;
}

export function getPpOcrModelPath(): string {
  return ocrModelPath;
}

export function configurePpOcrModel(
  modelPath: string = DEFAULT_OCR_MODEL_PATH,
  dictionaryPath: string = DEFAULT_OCR_DICTIONARY_PATH
): void {
  if (!modelPath.startsWith('/models/') || !modelPath.endsWith('.onnx')) {
    throw new Error('OCR model must be a local /models/*.onnx asset.');
  }
  if (!dictionaryPath.startsWith('/models/') || !dictionaryPath.endsWith('.txt')) {
    throw new Error('OCR dictionary must be a local /models/*.txt asset.');
  }
  if (modelPath === ocrModelPath && dictionaryPath === ocrDictionaryPath && ppOcrSession) return;
  try {
    ppOcrSession?.release?.();
    ppOcrSession?.dispose?.();
  } catch {
    // Best-effort cleanup across ONNX Runtime Web versions.
  }
  ppOcrSession = null;
  dictLines = [];
  ocrBufferPool.length = 0;
  ocrModelPath = modelPath;
  ocrDictionaryPath = dictionaryPath;
  isSessionLoading = false;
  sessionLoadPromise = null;
  sessionLoadFailures = 0;
  activeOcrProvider = 'NONE';
  lastPpOcrError = null;
}

/**
 * Initialize PP-OCR ONNX Session with stable chain: WASM -> WebGPU
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
        ocrDictionaryPath,
        MODEL_FETCH_TIMEOUT_MS,
        'PP-OCR dictionary fetch'
      );
      if (!dictRes.ok) {
        console.warn(`[PP-OCR] Dictionary ${ocrDictionaryPath} not found.`);
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
        ocrModelPath,
        MODEL_FETCH_TIMEOUT_MS,
        'PP-OCR recognition model fetch'
      );
      if (!modelRes.ok) {
        throw new Error(`HTTP ${modelRes.status} ${modelRes.statusText} fetching ${ocrModelPath}`);
      }
      const modelBuffer = await modelRes.arrayBuffer();
      const modelBytes = new Uint8Array(modelBuffer);

      let lastErrDetail = '';
      // Select WebGPU only after it creates a session and completes warm-up;
      // a failed GPU path falls through once to the WASM alternatives.
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

          // A resolved run is insufficient admission evidence. Some GPU
          // providers return the same blank OCR output for every input. Probe
          // input responsiveness before playback, then fall back automatically.
          const inputName = session.inputNames[0] || 'x';
          let firstOutput: Float32Array | undefined;
          try {
            for (const patterned of [false, true]) {
              const data = new Float32Array(3 * 48 * 320);
              if (patterned) for (let i = 0; i < data.length; i++) {
                data[i] = (Math.floor((i % 320) / 8) + Math.floor((Math.floor(i / 320) % 48) / 6)) % 2 ? 1 : -1;
              }
              const input = new ort.Tensor('float32', data, [1, 3, 48, 320]);
              let output: Record<string, any> | undefined;
              try {
                output = await withTimeout<Record<string, any>>(
                  runOnnxInference(session, { [inputName]: input }), PROVIDER_WARMUP_TIMEOUT_MS,
                  `PP-OCR ${config.name} input validation`
                );
                const tensor = output[session.outputNames[0]];
                const values = tensor?.data as Float32Array | undefined;
                if (!values?.length || !values.every(Number.isFinite)) throw new Error('OCR returned invalid numeric output');
                if (!firstOutput) firstOutput = Float32Array.from(values);
                else if (!haveDifferentNumericOutputs(firstOutput, values)) throw new Error('OCR output did not respond to changed input');
              } finally {
                input.dispose?.();
                if (output) Object.values(output).forEach(t => t?.dispose?.());
              }
            }
          } catch (error) {
            await session.release?.();
            throw error;
          }

          ppOcrSession = session;
          activeOcrProvider = config.name;
          sessionLoadFailures = 0;
          console.log(`[PP-OCR] ONNX Session initialized successfully with provider: ${config.name} (opt: ${config.opt})`);
          return true;
        } catch (err: any) {
          lastErrDetail = err?.message || String(err);
          console.debug(`[PP-OCR] Provider ${config.name} (opt: ${config.opt}) failed:`, lastErrDetail);
        }
      }

      throw new Error(`PP-OCR session creation failed: ${lastErrDetail || 'Unknown error'}`);
    } catch (err: any) {
      sessionLoadFailures++;
      activeOcrProvider = 'NONE';
      lastPpOcrError = err?.message || String(err);
      console.debug(`[PP-OCR] Failed to initialize ONNX session:`, lastPpOcrError);
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
    const dummyResults = await runSessionInferenceExclusive(ppOcrSession, { [inputName]: dummyInput });

    dummyInput.dispose?.();
    for (const t of Object.values(dummyResults)) {
      (t as any)?.dispose?.();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Run PP-OCR ONNX inference on a crop canvas.
 * @param quickMode When true, skips the secondary 4-inference trimming pass for two-line plates.
 *                  Use on first OCR attempt to stay under ~800ms, leaving budget for retries.
 */
export async function recognizeWithPpOcr(
  cropCanvas: HTMLCanvasElement,
  isTwoLineHint?: boolean,
  quickMode = false
): Promise<PpOcrRecognitionResult | null> {
  if (!ppOcrSession || dictLines.length === 0) {
    const ready = await initPpOcrSession();
    if (!ready || !ppOcrSession) return null;
  }

  const ar = cropCanvas.width / (cropCanvas.height || 1);
  const isTwoLine = Boolean(isTwoLineHint && ar < 1.85) || ar < 1.65;

  if (isTwoLine) {
    const lineCrops = splitTwoLineCrop(cropCanvas);

    try {
      // Read the unmodified top/bottom lines first and full crop
      const [topRes, botRes, fullRes] = await Promise.all([
        recognizePpOcrTextLine(lineCrops.top),
        recognizePpOcrTextLine(lineCrops.bottom),
        recognizePpOcrTextLine(cropCanvas),
      ]);

      // On genuine two-line/square plates (ar < 1.65), fullRes is squashed vertically and produces
      // partial/jumbled single-line artifacts (e.g. ME108 instead of VME 7108).
      // Only allow a single-line shortcut on elongated plates (ar >= 1.65) with high confidence and complete length.
      const fullText = normalizePlate(fullRes.rawText);
      const fullPattern = validateMalaysianPattern(fullText);
      if (
        ar >= 1.65 &&
        fullText.length >= 6 &&
        fullText.length <= 8 &&
        fullPattern.isValid &&
        fullPattern.category !== 'UNKNOWN_VALID_CANDIDATE' &&
        fullRes.confidence >= 0.90
      ) {
        return buildPpOcrResult(fullText, fullRes.confidence, normalizeCharacterConfidences(fullRes), 'SINGLE_LINE');
      }

      const candidates: PpOcrRecognitionResult[] = [];
      const addMergedLineCandidate = (
        top: Awaited<ReturnType<typeof recognizePpOcrTextLine>>,
        bottom: Awaited<ReturnType<typeof recognizePpOcrTextLine>>
      ) => {
        const topText = normalizePlate(top.rawText);
        const bottomText = normalizePlate(bottom.rawText);
        const mergedRaw = normalizePlate(`${topText}${bottomText}`);
        if (mergedRaw.length < 2 || mergedRaw.length > 8) return;

        // In a genuine two-line plate, one line is predominantly letters and the other is digits
        const topLetters = (topText.match(/[A-Z]/g) || []).length;
        const topDigits = (topText.match(/[0-9]/g) || []).length;
        const botLetters = (bottomText.match(/[A-Z]/g) || []).length;
        const botDigits = (bottomText.match(/[0-9]/g) || []).length;
        if (topLetters >= 2 && topDigits >= 2 && botLetters >= 2 && botDigits >= 2) {
          // Reject duplicate whole-plate slices!
          return;
        }

        const avgConf = Math.min(1.0, (top.confidence + bottom.confidence) / 2);
        const charConfs: CharacterConfidence[] = mergedRaw.split('').map((char, i) => ({
          char,
          confidence: i < topText.length ? top.confidence : bottom.confidence,
          position: i,
        }));
        candidates.push(buildPpOcrResult(mergedRaw, avgConf, charConfs, ar < 1.6 ? 'SQUARE' : 'TWO_LINE'));
      };

      addMergedLineCandidate(topRes, botRes);

      if (fullText.length >= 2 && fullText.length <= 9) {
        candidates.push(buildPpOcrResult(fullText, fullRes.confidence, normalizeCharacterConfidences(fullRes), 'SINGLE_LINE'));
      }

      const originalBest = chooseBestOcrCandidate(candidates);
      // Fast path: if initial read produced a strong valid pattern, return immediately
      if (originalBest && originalBest.patternScore >= 0.65 && originalBest.confidence >= 0.88) {
        return originalBest;
      }

      // quickMode: caller wants a fast first read (~3 inferences total)
      if (quickMode) {
        return chooseBestOcrCandidate(candidates);
      }

      // Targeted recovery 1: tight outer margins (2 inferences)
      const tightLineCrops = splitTwoLineCrop(cropCanvas, { trimOuterMargins: true });
      try {
        const [tightTopRes, tightBotRes] = await Promise.all([
          recognizePpOcrTextLine(tightLineCrops.top),
          recognizePpOcrTextLine(tightLineCrops.bottom),
        ]);
        addMergedLineCandidate(tightTopRes, tightBotRes);
        addMergedLineCandidate(topRes, tightBotRes);
        addMergedLineCandidate(tightTopRes, botRes);
      } finally {
        releaseCanvasMemory(tightLineCrops.top);
        releaseCanvasMemory(tightLineCrops.bottom);
      }

      const tightBest = chooseBestOcrCandidate(candidates);
      if (tightBest && tightBest.patternScore >= 0.65 && tightBest.confidence >= 0.90) {
        return tightBest;
      }

      // Targeted recovery 2: text row crop bounding (2 inferences)
      const textRows = extractTwoLineTextCrops(cropCanvas);
      if (textRows) {
        try {
          const [textTop, textBottom] = await Promise.all([
            recognizePpOcrTextLine(textRows.top),
            recognizePpOcrTextLine(textRows.bottom),
          ]);
          addMergedLineCandidate(textTop, textBottom);
          const merged = normalizePlate(textTop.rawText + textBottom.rawText);
          if (validateMalaysianPattern(merged).isValid && Math.min(textTop.confidence, textBottom.confidence) >= 0.85) {
            return {
              ...buildPpOcrResult(merged, (textTop.confidence + textBottom.confidence) / 2, [
                ...normalizeCharacterConfidences(textTop),
                ...normalizeCharacterConfidences(textBottom).map(c => ({ ...c, position: c.position + normalizePlate(textTop.rawText).length })),
              ], 'SQUARE'),
              corroboratedRows: true,
            };
          }
        } finally {
          releaseCanvasMemory(textRows.top);
          releaseCanvasMemory(textRows.bottom);
        }
      }

      const best = chooseBestOcrCandidate(candidates);
      if (best) return best;
    } finally {
      releaseCanvasMemory(lineCrops.top);
      releaseCanvasMemory(lineCrops.bottom);
    }
  }

  // Single line plate recognition (1 fast inference)
  let res = await recognizePpOcrTextLine(cropCanvas);
  let normText = normalizePlate(res.rawText);
  if (!normText) return null;

  // Narrow adjacent digits can collapse at the recognizer's default width.
  // Compare actual pixel resamplings for short numeric bodies; agreement,
  // rather than registration length or inserted characters, selects the read.
  // Genuine one/two-digit plates remain valid and can win unchanged.
  if (/^[A-Z]{1,3}[0-9]{1,2}$/.test(normText) && /[17]/.test(normText)) {
    const variants = await Promise.all([1.25, 1.5, 2].map(scale => recognizePpOcrTextLine(cropCanvas, scale)));
    const corroborated = selectCorroboratedTextLine([res, ...variants]);
    if (corroborated && corroborated.confidence >= 0.90) {
      res = corroborated;
      normText = normalizePlate(res.rawText);
    }
  }

  const charConfs: CharacterConfidence[] = res.characterConfidences.map((c, i) => ({
    char: c.char,
    confidence: c.confidence,
    position: i,
  }));

  const singleCandidate = buildPpOcrResult(normText, res.confidence, charConfs, 'SINGLE_LINE');

  // Alternatives are suggestions, not observations. Promoting an inserted
  // digit or a 6->G suffix with the original probability fabricated evidence.
  return singleCandidate;
}

export function buildPpOcrResult(
  normalizedPlate: string,
  confidence: number,
  characterConfidences: CharacterConfidence[],
  layout: PlateLayout
): PpOcrRecognitionResult {
  const correction = correctMalaysianPlateOcr(normalizedPlate, {
    ocrConfidence: confidence,
    characterConfidences,
  });
  const typographyCorrection = correctMalaysianTypographyOcr(correction.normalized || normalizedPlate, {
    ocrConfidence: confidence,
    characterConfidences,
  });
  const correctedPlate = typographyCorrection.normalized;
  const patternVal = validateMalaysianPattern(correctedPlate);
  const alternatives = Array.from(new Set([
    ...correction.alternatives,
    ...typographyCorrection.alternatives,
    ...generateCandidatePlates(correctedPlate, characterConfidences),
  ])).filter((candidate) => candidate !== correctedPlate);
  const correctedConfidence = confidence;

  return {
    text: correctedPlate,
    normalizedPlate: correctedPlate,
    displayPlate: formatDisplayPlate(correctedPlate, patternVal.category),
    confidence: correctedConfidence,
    characterConfidences,
    alternativeCandidates: alternatives,
    layout,
    category: patternVal.category,
    patternScore: patternVal.score,
    hasTrailingSuffix: patternVal.hasTrailingSuffix,
    engineUsed: 'PP_OCR',
  };
}

function normalizeCharacterConfidences(result: {
  rawText: string;
  confidence: number;
  characterConfidences: { char: string; confidence: number }[];
}): CharacterConfidence[] {
  const normalized = normalizePlate(result.rawText);
  const fromEngine = result.characterConfidences
    .map((candidate) => ({
      char: normalizePlate(candidate.char),
      confidence: candidate.confidence,
    }))
    .filter((candidate) => candidate.char.length === 1);

  if (fromEngine.length === normalized.length) {
    return fromEngine.map((candidate, position) => ({
      char: candidate.char,
      confidence: candidate.confidence,
      position,
    }));
  }

  return normalized.split('').map((char, position) => ({
    char,
    confidence: result.confidence,
    position,
  }));
}

export function chooseBestOcrCandidate(candidates: PpOcrRecognitionResult[]): PpOcrRecognitionResult | null {
  if (candidates.length === 0) return null;

  const ranked = candidates
    .filter((candidate) => candidate.normalizedPlate.length >= 2 && candidate.normalizedPlate.length <= 9)
    .map((candidate) => {
      const pattern = validateMalaysianPattern(candidate.normalizedPlate);
      const hasLetters = /[A-Z]/.test(candidate.normalizedPlate);
      const hasDigits = /[0-9]/.test(candidate.normalizedPlate);
      const isTwoLineCandidate = candidate.layout === 'TWO_LINE' || candidate.layout === 'SQUARE';
      const layoutScore = isTwoLineCandidate && candidate.normalizedPlate.length <= 8 ? 0.04 : 0;
      const specialScore = isPotentialSpecialSeriesCandidate(candidate.normalizedPlate) && candidate.normalizedPlate.length <= 10 ? 0.10 : 0;
      const implausiblePenalty = hasLetters && hasDigits ? 0 : 0.4;
      const score =
        candidate.confidence * 0.46 +
        pattern.score * 0.34 +
        (pattern.isValid ? 0.08 : 0) +
        layoutScore -
        implausiblePenalty +
        specialScore;

      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.candidate ?? null;
}

/**
 * Execute PP-OCR on a single cropped canvas region with Memory Disposal Guarantee
 */
export async function recognizePpOcrTextLine(
  canvas: HTMLCanvasElement,
  widthScale = 1
): Promise<{ rawText: string; confidence: number; characterConfidences: { char: string; confidence: number }[] }> {
  if (!ppOcrSession) {
    return { rawText: '', confidence: 0, characterConfidences: [] };
  }

  const targetH = 48;
  const targetW = 320;
  const buffer = acquireOcrBuffer(targetW, targetH);
  if (!buffer) {
    return { rawText: '', confidence: 0, characterConfidences: [] };
  }

  const { ctx: targetCtx, float32Data } = buffer;

  // Fill background neutral gray
  targetCtx.fillStyle = '#7f7f7f';
  targetCtx.fillRect(0, 0, targetW, targetH);

  // Maintain aspect ratio scaling
  const scale = Math.min(targetW / (canvas.width * widthScale), targetH / canvas.height);
  const drawW = Math.round(canvas.width * scale * widthScale);
  const drawH = Math.round(canvas.height * scale);
  const offsetX = 0;
  const offsetY = Math.round((targetH - drawH) / 2);

  targetCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, offsetX, offsetY, drawW, drawH);

  const imgData = targetCtx.getImageData(0, 0, targetW, targetH);
  const { data } = imgData;

  const channelArea = targetH * targetW;
  for (let i = 0; i < channelArea; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];

    // Standard PaddleOCR normalization
    float32Data[i] = (r / 255.0 - 0.5) / 0.5;
    float32Data[channelArea + i] = (g / 255.0 - 0.5) / 0.5;
    float32Data[2 * channelArea + i] = (b / 255.0 - 0.5) / 0.5;
  }

  let inputTensor: any = null;
  let results: any = null;

  try {
    const ort = await getOrt();
    inputTensor = new ort.Tensor('float32', float32Data, [1, 3, targetH, targetW]);
    const inputName = ppOcrSession.inputNames[0] || 'x';

    results = await runSessionInferenceExclusive(ppOcrSession, { [inputName]: inputTensor });

    const outputName = ppOcrSession.outputNames[0];
    const outputTensor = results[outputName];

    if (!outputTensor) {
      return { rawText: '', confidence: 0, characterConfidences: [] };
    }

    const rawOutput = outputTensor.data as Float32Array; // shape: [1, seqLen, numClasses]
    const dims = outputTensor.dims;
    const seqLen = dims[1] || 40;
    const numClasses = dims[2] || dictLines.length + 1;

    // CTC Top-2 Decoding with Alternative Generation
    const charList: string[] = [];
    const altCharList: string[] = [];
    const charConfs: { char: string; confidence: number }[] = [];
    let prevIdx = 0;
    let prevAltIdx = 0;
    let streakChar = 0;
    let streakPeakProb = 0;
    let streakSawTrough = false;
    let streakTroughProb = 0;

    for (let t = 0; t < seqLen; t++) {
      const offset = t * numClasses;
      const blankProb = rawOutput[offset + 0]; // Blank is class 0 in PaddleOCR CTC
      let maxIdx = 0;
      let maxProb = -1;
      let secondIdx = 0;
      let secondProb = -1;

      for (let c = 0; c < numClasses; c++) {
        const prob = rawOutput[offset + c];
        if (prob > maxProb) {
          secondProb = maxProb;
          secondIdx = maxIdx;
          maxProb = prob;
          maxIdx = c;
        } else if (prob > secondProb) {
          secondProb = prob;
          secondIdx = c;
        }
      }

      if (maxIdx !== 0) {
        if (maxIdx !== prevIdx) {
          if (maxIdx - 1 < dictLines.length) {
            const char = dictLines[maxIdx - 1];
            if (char && char !== ' ') {
              charList.push(char);
              charConfs.push({ char, confidence: Math.min(1.0, Math.max(0.0, maxProb)) });
            }
          }
          streakChar = maxIdx;
          streakPeakProb = maxProb;
          streakSawTrough = false;
          streakTroughProb = maxProb;
        } else if (streakChar === maxIdx) {
          // Detect inter-character dip between two identical adjacent characters (e.g. 11 in BNC115, NN in ANN7569)
          if (maxProb < streakPeakProb * 0.70 || blankProb > 0.18) {
            streakSawTrough = true;
            streakTroughProb = Math.min(streakTroughProb, maxProb);
          } else if (streakSawTrough && maxProb > streakTroughProb + 0.16 && maxProb >= 0.40) {
            if (maxIdx - 1 < dictLines.length) {
              const char = dictLines[maxIdx - 1];
              if (char && char !== ' ') {
                charList.push(char);
                charConfs.push({ char, confidence: Math.min(1.0, Math.max(0.0, maxProb)) });
              }
            }
            streakPeakProb = maxProb;
            streakSawTrough = false;
            streakTroughProb = maxProb;
          } else if (!streakSawTrough && maxProb > streakPeakProb) {
            streakPeakProb = maxProb;
          }
        }
      } else {
        streakChar = 0;
        streakPeakProb = 0;
        streakSawTrough = false;
        streakTroughProb = 0;
      }
      prevIdx = maxIdx;

      // Alternative prediction if second choice probability is close to top prediction (e.g. M vs N)
      const altChoiceIdx = (secondProb > 0.35 && maxProb - secondProb < 0.28) ? secondIdx : maxIdx;
      if (altChoiceIdx !== 0 && altChoiceIdx !== prevAltIdx) {
        if (altChoiceIdx - 1 < dictLines.length) {
          const altChar = dictLines[altChoiceIdx - 1];
          if (altChar && altChar !== ' ') {
            altCharList.push(altChar);
          }
        }
      }
      prevAltIdx = altChoiceIdx;
    }

    const rawText = charList.join('');
    const altText = altCharList.join('');

    const avgConf = charConfs.length > 0
      ? charConfs.reduce((sum, c) => sum + c.confidence, 0) / charConfs.length
      : 0;

    // Expand candidate list with Top-2 CTC decoding alternative
    if (altText && altText !== rawText) {
      generateCandidatePlates(altText).forEach((cand) => {
        if (!charConfs.some((c) => c.char === cand)) {
          // Alternative candidate recorded
        }
      });
    }

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
    releaseOcrBuffer(buffer);
  }
}
