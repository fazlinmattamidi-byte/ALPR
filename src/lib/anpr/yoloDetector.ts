/**
 * PlateQ — Primary Malaysian License Plate Detection Engine
 * Model: YOLOv8 Object Detection (Universe Roboflow: fyp-hq4ka/license-plate-malaysia-kqy48)
 * 
 * Production Hardware Execution Policy:
 * Stable Chain: WASM -> WebGPU (WebGL removed from production chain)
 * Zero silent fallbacks to CV heuristic or remote APIs in production.
 */

import { detectPlateCandidatesCV, verifyPlateStrokeDensity, preprocessCropVariant, releaseCanvasMemory, type PreprocessVariant } from './imageProcessor';
import {
  canUseWebGpuExecutionProvider,
  configureOrtWasm,
  fetchWithTimeout,
  getOrt,
  runOnnxInference,
  withTimeout,
} from './onnxRuntime';

export interface BoundingBox {
  x: number;      // top-left x in canvas pixels
  y: number;      // top-left y in canvas pixels
  width: number;  // width in canvas pixels
  height: number; // height in canvas pixels
}

export interface DetectedPlateBox {
  bbox: BoundingBox;
  confidence: number;
  label: string;
  sourceEngine: 'LOCAL_ONNX' | 'CV_HEURISTIC';
}

export interface DetectionOptions {
  minConfidence?: number;
  iouThreshold?: number;
  enginePreference?: 'AUTO' | 'LOCAL_ONNX' | 'CV_HEURISTIC';
  developerMode?: boolean;
  enhanceSmallPlates?: boolean;
  recoveryVariant?: PreprocessVariant;
}

export type DetectorStatus = 'UNINITIALIZED' | 'LOADING' | 'READY' | 'FAILED';
export type ActiveExecutionProvider = 'WebGPU' | 'WASM' | 'NONE';

let localOnnxSession: any = null;
let detectorStatus: DetectorStatus = 'UNINITIALIZED';
let activeProvider: ActiveExecutionProvider = 'NONE';
let isOnnxLoading = false;
let onnxLoadPromise: Promise<boolean> | null = null;
let onnxLoadFailures = 0;
const MAX_ONNX_FAILURES = 3;
const MODEL_FETCH_TIMEOUT_MS = 20000;
const PROVIDER_INIT_TIMEOUT_MS = 15000;
const PROVIDER_WARMUP_TIMEOUT_MS = 8000;
const DEFAULT_DETECTOR_MODEL_PATH = '/models/plate-detector.onnx';
let detectorModelPath = DEFAULT_DETECTOR_MODEL_PATH;

// Inference singletons for zero GC overhead. ONNX Runtime Web sessions and the
// reusable tensor buffers are shared, so detector inference must run serially.
let detectorQueue: Promise<void> = Promise.resolve();
let reusableCanvas: HTMLCanvasElement | null = null;
let reusableCtx: CanvasRenderingContext2D | null = null;
let reusableFloat32Data: Float32Array | null = null;

let lastDetectorError: string | null = null;

export function getDetectorError(): string | null {
  return lastDetectorError;
}

export function getDetectorStatus(): DetectorStatus {
  return detectorStatus;
}

export function getActiveDetectorProvider(): ActiveExecutionProvider {
  return activeProvider;
}

export function getDetectorModelPath(): string {
  return detectorModelPath;
}

/** Development-lab model switching. Production callers keep the default path. */
export function configureDetectorModel(modelPath: string = DEFAULT_DETECTOR_MODEL_PATH): void {
  if (!modelPath.startsWith('/models/') || !modelPath.endsWith('.onnx')) {
    throw new Error('Detector model must be a local /models/*.onnx asset.');
  }
  if (modelPath === detectorModelPath && detectorStatus !== 'FAILED') return;
  releaseOnnxSession(localOnnxSession);
  localOnnxSession = null;
  detectorModelPath = modelPath;
  detectorStatus = 'UNINITIALIZED';
  activeProvider = 'NONE';
  isOnnxLoading = false;
  onnxLoadPromise = null;
  onnxLoadFailures = 0;
  lastDetectorError = null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function releaseOnnxSession(session: any): void {
  try {
    session?.release?.();
  } catch {
    // Best-effort cleanup for ONNX Runtime Web sessions.
  }
  try {
    session?.dispose?.();
  } catch {
    // Older runtime builds expose release(), newer/other builds may expose dispose().
  }
}

function markDetectorRuntimeFailure(err: unknown, context: string): void {
  lastDetectorError = `${context}: ${getErrorMessage(err)}`;
  detectorStatus = 'FAILED';
  activeProvider = 'NONE';
  onnxLoadFailures = MAX_ONNX_FAILURES;
  const failedSession = localOnnxSession;
  localOnnxSession = null;
  releaseOnnxSession(failedSession);
  console.debug(`[ANPR YoloDetector] ${lastDetectorError}`);
}

/**
 * Initialize Local ONNX Session with stable chain: WASM -> WebGPU
 */
export async function initLocalOnnxSession(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (localOnnxSession && detectorStatus === 'READY') return true;
  if (onnxLoadFailures >= MAX_ONNX_FAILURES) {
    detectorStatus = 'FAILED';
    return false;
  }
  if (isOnnxLoading && onnxLoadPromise) return onnxLoadPromise;

  isOnnxLoading = true;
  detectorStatus = 'LOADING';
  lastDetectorError = null;

  onnxLoadPromise = (async () => {
    try {
      const ort = await getOrt();
      const webGpuAvailable = canUseWebGpuExecutionProvider();

      // Configure WASM paths to match the locally served runtime assets.
      configureOrtWasm(ort, webGpuAvailable);

      // Fetch model into Uint8Array to bypass browser URL fetch restrictions on iOS Safari
      const modelRes = await fetchWithTimeout(
        detectorModelPath,
        MODEL_FETCH_TIMEOUT_MS,
        'YOLOv8 detector model fetch'
      );
      if (!modelRes.ok) {
        throw new Error(`HTTP ${modelRes.status} ${modelRes.statusText} fetching ${detectorModelPath}`);
      }
      const modelBuffer = await modelRes.arrayBuffer();
      const modelBytes = new Uint8Array(modelBuffer);

      // WebGPU is admitted only after session creation and a real warm-up
      // inference succeed. WASM remains the reliable fallback.
      const providersToTry: { name: ActiveExecutionProvider; epList: string[] }[] = [
        ...(webGpuAvailable ? [{ name: 'WebGPU' as const, epList: ['webgpu', 'wasm'] }] : []),
        { name: 'WASM', epList: ['wasm'] },
      ];
      let lastErrDetail = '';
      let fastest: { session: any; provider: ActiveExecutionProvider; elapsed: number } | undefined;
      for (const item of providersToTry) {
        let session: any = null;
        try {
          configureOrtWasm(ort, item.name === 'WebGPU');
          session = await withTimeout<any>(
            ort.InferenceSession.create(modelBytes, {
              executionProviders: item.epList,
              graphOptimizationLevel: 'all',
            }), PROVIDER_INIT_TIMEOUT_MS, `YOLOv8 detector ${item.name} session creation`
          );
          const targetSize = 640;
          const inputName = session.inputNames[0] || 'images';
          let elapsed = Infinity;
          // Exclude shader compilation and time waiting behind other models.
          // Provider availability alone is not evidence that it is faster.
          for (let pass = 0; pass < 2; pass++) {
            const input = new ort.Tensor('float32', new Float32Array(3 * targetSize * targetSize), [1, 3, targetSize, targetSize]);
            let outputs: Record<string, any> | undefined;
            try {
              outputs = await withTimeout<Record<string, any>>(
                runOnnxInference(session, { [inputName]: input }, duration => { elapsed = duration; }),
                PROVIDER_WARMUP_TIMEOUT_MS, `YOLOv8 detector ${item.name} warm-up`
              );
            } finally {
              input.dispose?.();
              if (outputs) Object.values(outputs).forEach(t => t?.dispose?.());
            }
          }
          console.debug(`[ANPR YoloDetector] ${item.name} warmed inference: ${Math.round(elapsed)}ms`);
          if (!fastest || elapsed < fastest.elapsed) {
            if (fastest) releaseOnnxSession(fastest.session);
            fastest = { session, provider: item.name, elapsed };
          } else releaseOnnxSession(session);
        } catch (err: any) {
          releaseOnnxSession(session);
          lastErrDetail = err?.message || String(err);
          console.debug(`[ANPR YoloDetector] Provider ${item.name} failed initialization:`, lastErrDetail);
        }
      }
      if (fastest) {
        localOnnxSession = fastest.session;
        activeProvider = fastest.provider;
        detectorStatus = 'READY';
        onnxLoadFailures = 0;
        console.log(`[ANPR YoloDetector] Model initialized successfully with provider: ${activeProvider}`);
        return true;
      }

      throw new Error(`All execution providers failed to run model.${lastErrDetail ? ` Last error: ${lastErrDetail}` : ''}`);
    } catch (err: any) {
      onnxLoadFailures++;
      detectorStatus = 'FAILED';
      activeProvider = 'NONE';
      lastDetectorError = err?.message || String(err);
      console.debug(`[ANPR YoloDetector] Local ONNX load failed (attempt ${onnxLoadFailures}/${MAX_ONNX_FAILURES}):`, lastDetectorError);
      return false;
    }
  })().finally(() => {
    isOnnxLoading = false;
    onnxLoadPromise = null;
  });

  return onnxLoadPromise;
}

export async function validateDetector(): Promise<{ valid: boolean; provider?: ActiveExecutionProvider }> {
  if (!localOnnxSession || detectorStatus !== 'READY') return { valid: false };
  try {
    if (!localOnnxSession.inputNames || !localOnnxSession.outputNames) return { valid: false };
    return { valid: true, provider: activeProvider };
  } catch {
    return { valid: false };
  }
}

/**
 * Detect all visible Malaysian vehicle number plates across the camera frame.
 */
export async function detectMalaysianPlates(
  canvas: HTMLCanvasElement,
  options: DetectionOptions = {}
): Promise<DetectedPlateBox[]> {
  const minConf = options.minConfidence ?? 0.24;
  const pref = options.enginePreference || 'AUTO';
  const iouThreshold = options.iouThreshold ?? 0.35;

  // 1. Primary Production Engine: Single-Pass Real-Time ONNX Detection
  if (pref === 'LOCAL_ONNX' || pref === 'AUTO') {
    if (!localOnnxSession && detectorStatus !== 'FAILED') {
      await initLocalOnnxSession();
    }
    if (localOnnxSession && detectorStatus === 'READY') {
      try {
        // Always inspect the complete frame first.
        let candidates = await runLocalOnnxDetection(canvas, minConf, iouThreshold, options.developerMode === true);

        // Photometric recovery preserves source coordinates when initial pass is empty or sparse.
        if (candidates.length === 0 && options.recoveryVariant && typeof document !== 'undefined') {
          const corrected = document.createElement('canvas');
          corrected.width = canvas.width;
          corrected.height = canvas.height;
          try {
            const ctx = corrected.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(canvas, 0, 0);
              preprocessCropVariant(ctx, corrected.width, corrected.height, options.recoveryVariant);
              const recovered = await runLocalOnnxDetection(corrected, minConf, iouThreshold, options.developerMode === true);
              if (recovered.length > 0) {
                candidates = recovered;
              }
            }
          } finally {
            releaseCanvasMemory(corrected);
          }
        }

        // Tiled quadrant detection zooms into quadrants to detect small/distant plates.
        // Merge tiled detections with full-frame detections via NMS so distant plates are not dropped.
        if (options.enhanceSmallPlates && canvas.width >= 320 && canvas.height >= 240) {
          const tiledBoxes = await runTiledQuadrantDetection(
            canvas, minConf, iouThreshold, options.developerMode === true
          );
          if (tiledBoxes.length > 0) {
            candidates = applyFiltersAndNMS(
              [...candidates, ...tiledBoxes],
              iouThreshold,
              canvas.width,
              canvas.height,
              undefined,
              options.developerMode === true
            );
          }
        }

        return candidates;
      } catch (err) {
        markDetectorRuntimeFailure(err, 'Local ONNX inference failed');
      }
    }
    return [];
  }

  // 2. Developer Mode Engine: CV Heuristic (Gated strictly by developerMode)
  if (pref === 'CV_HEURISTIC') {
    if (options.developerMode !== true) {
      console.warn('[ANPR YoloDetector] CV Heuristic detector requested without developerMode.');
      return [];
    }
    const cvCandidates = detectPlateCandidatesCV(canvas, minConf);
    const mapped = cvCandidates.map((c) => ({
      bbox: {
        x: c.crop.x,
        y: c.crop.y,
        width: c.crop.width,
        height: c.crop.height,
      },
      confidence: c.confidence,
      label: 'License-Plate',
      sourceEngine: 'CV_HEURISTIC' as const,
    }));
    return applyFiltersAndNMS(mapped, iouThreshold, canvas.width, canvas.height, canvas, true);
  }

  return [];
}

/**
 * Benchmark detection helper for WASM admission control
 */
export function runBenchmarkDetection(): Promise<boolean> {
  // Health/admission probes share the detector session with live frames.
  const job = detectorQueue.then(runBenchmarkDetectionExclusive);
  detectorQueue = job.then(() => undefined, () => undefined);
  return job;
}

async function runBenchmarkDetectionExclusive(): Promise<boolean> {
  if (!localOnnxSession) return false;
  try {
    const ort = await getOrt();
    const targetSize = 640;
    const dummyInput = new ort.Tensor('float32', new Float32Array(3 * targetSize * targetSize), [1, 3, targetSize, targetSize]);
    const inputName = localOnnxSession.inputNames[0] || 'images';
    const dummyResults = await runOnnxInference(localOnnxSession, { [inputName]: dummyInput });

    dummyInput.dispose?.();
    for (const t of Object.values(dummyResults)) {
      (t as any)?.dispose?.();
    }
    return true;
  } catch (err) {
    markDetectorRuntimeFailure(err, 'YOLOv8 detector benchmark failed');
    return false;
  }
}

/**
 * Run Local ONNX Inference with Letterboxing Preprocessing & Inverse Transform
 */
async function runLocalOnnxDetection(
  canvas: HTMLCanvasElement,
  minConfidence: number,
  iouThreshold: number,
  debug = false
): Promise<DetectedPlateBox[]> {
  if (!localOnnxSession || typeof window === 'undefined') return [];

  const queuedInference = detectorQueue.then(() =>
    runLocalOnnxDetectionExclusive(canvas, minConfidence, iouThreshold, debug)
  );
  detectorQueue = queuedInference.then(
    () => undefined,
    () => undefined
  );
  return queuedInference;
}

async function runLocalOnnxDetectionExclusive(
  canvas: HTMLCanvasElement,
  minConfidence: number,
  iouThreshold: number,
  debug = false
): Promise<DetectedPlateBox[]> {
  const targetSize = 640;

  // Reuse canvas & 2D context to avoid GC overhead
  if (!reusableCanvas) {
    reusableCanvas = document.createElement('canvas');
    reusableCanvas.width = targetSize;
    reusableCanvas.height = targetSize;
    reusableCtx = reusableCanvas.getContext('2d', { willReadFrequently: true });
  }

  if (!reusableCtx) {
    return [];
  }

  // 1. Aspect-Ratio Preserving Letterboxing Preprocessing
  const scale = Math.min(targetSize / canvas.width, targetSize / canvas.height);
  const drawW = Math.round(canvas.width * scale);
  const drawH = Math.round(canvas.height * scale);
  const padX = Math.round((targetSize - drawW) / 2);
  const padY = Math.round((targetSize - drawH) / 2);

  // Fill canvas neutral gray background
  reusableCtx.fillStyle = '#7f7f7f';
  reusableCtx.fillRect(0, 0, targetSize, targetSize);
  // Draw scaled image centered inside 640x640 letterbox
  reusableCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, padX, padY, drawW, drawH);

  const imgData = reusableCtx.getImageData(0, 0, targetSize, targetSize);
  const { data } = imgData;

  const channelArea = targetSize * targetSize;
  if (!reusableFloat32Data || reusableFloat32Data.length !== 3 * channelArea) {
    reusableFloat32Data = new Float32Array(3 * channelArea);
  }

  const floatData = reusableFloat32Data;
  const channelArea2 = 2 * channelArea;
  const inv255 = 1 / 255.0;

  for (let i = 0, src = 0; i < channelArea; i++, src += 4) {
    floatData[i] = data[src] * inv255;
    floatData[channelArea + i] = data[src + 1] * inv255;
    floatData[channelArea2 + i] = data[src + 2] * inv255;
  }

  let inputTensor: any = null;
  let results: any = null;

  try {
    const ort = await getOrt();
    inputTensor = new ort.Tensor('float32', reusableFloat32Data, [1, 3, targetSize, targetSize]);
    const inputName = localOnnxSession.inputNames[0] || 'images';

    results = await runOnnxInference(localOnnxSession, { [inputName]: inputTensor });

    const outputName = localOnnxSession.outputNames[0] || 'output0';
    const outputTensor = results[outputName];
    if (!outputTensor) return [];

    const dims = outputTensor.dims;
    const rawData = outputTensor.data as Float32Array;

    let numAnchors = 8400;
    let numChannels = 5;
    let isTransposed = false;

    if (dims.length >= 2) {
      const d1 = dims[dims.length - 2];
      const d2 = dims[dims.length - 1];
      if (d1 > d2) {
        numAnchors = d1;
        numChannels = d2;
        isTransposed = true; // e.g. [1, 8400, 5]
      } else {
        numChannels = d1;
        numAnchors = d2;
        isTransposed = false; // e.g. [1, 5, 8400]
      }
    }

    const hasObjectness = (numChannels === 6 || numChannels === 85);
    const detections: DetectedPlateBox[] = [];

    // Relative Minimum Detection Sizes
    const minBoxW = Math.max(18, canvas.width * 0.012);
    const minBoxH = Math.max(6, canvas.height * 0.005);

    for (let i = 0; i < numAnchors; i++) {
      let cx: number, cy: number, w: number, h: number, objConf: number, classConf: number;

      if (isTransposed) {
        cx = rawData[i * numChannels + 0];
        cy = rawData[i * numChannels + 1];
        w = rawData[i * numChannels + 2];
        h = rawData[i * numChannels + 3];
        if (hasObjectness) {
          objConf = rawData[i * numChannels + 4];
          classConf = rawData[i * numChannels + 5];
        } else {
          objConf = 1.0;
          classConf = rawData[i * numChannels + 4];
        }
      } else {
        cx = rawData[0 * numAnchors + i];
        cy = rawData[1 * numAnchors + i];
        w = rawData[2 * numAnchors + i];
        h = rawData[3 * numAnchors + i];
        if (hasObjectness) {
          objConf = rawData[4 * numAnchors + i];
          classConf = rawData[5 * numAnchors + i];
        } else {
          objConf = 1.0;
          classConf = rawData[4 * numAnchors + i];
        }
      }

      const conf = objConf * classConf;

      // Validate finite numbers
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(conf)) {
        continue;
      }

      if (conf >= minConfidence) {
        // Reverse Letterbox Coordinate Mapping:
        // (cx, cy, w, h) are in 0..640 letterbox space.
        // Subtract letterbox padding, then divide by scale factor to map back to original canvas pixels.
        const realCx = (cx - padX) / scale;
        const realCy = (cy - padY) / scale;
        const realW = w / scale;
        const realH = h / scale;

        // Strict boundary clipping
        const left = Math.max(0, Math.min(canvas.width, realCx - realW / 2));
        const top = Math.max(0, Math.min(canvas.height, realCy - realH / 2));
        const right = Math.max(0, Math.min(canvas.width, realCx + realW / 2));
        const bottom = Math.max(0, Math.min(canvas.height, realCy + realH / 2));

        const finalW = Math.round(right - left);
        const finalH = Math.round(bottom - top);

        if (finalW >= minBoxW && finalH >= minBoxH) {
          detections.push({
            bbox: {
              x: Math.round(left),
              y: Math.round(top),
              width: finalW,
              height: finalH,
            },
            confidence: Math.round(conf * 1000) / 1000,
            label: 'License-Plate',
            sourceEngine: 'LOCAL_ONNX',
          });
        }
      }
    }

    return applyFiltersAndNMS(detections, iouThreshold, canvas.width, canvas.height, canvas, debug);
  } finally {
    // Memory Disposal Guarantee for CPU/GPU memory
    inputTensor?.dispose?.();
    if (results) {
      for (const tensor of Object.values(results)) {
        (tensor as any)?.dispose?.();
      }
    }
  }
}

async function runTiledQuadrantDetection(
  canvas: HTMLCanvasElement,
  minConfidence: number,
  iouThreshold: number,
  debug = false
): Promise<DetectedPlateBox[]> {
  const W = canvas.width;
  const H = canvas.height;
  if (W < 320 || H < 240) return [];

  const tiles = W >= H
    ? [
        { x: 0, y: 0, width: Math.round(W * 0.62), height: H },
        { x: Math.round(W * 0.38), y: 0, width: Math.round(W * 0.62), height: H },
      ]
    : [
        { x: 0, y: 0, width: W, height: Math.round(H * 0.62) },
        { x: 0, y: Math.round(H * 0.38), width: W, height: Math.round(H * 0.62) },
      ];

  const allDetections: DetectedPlateBox[] = [];

  for (const tile of tiles) {
    if (typeof document === 'undefined') break;
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = tile.width;
    tileCanvas.height = tile.height;
    const tCtx = tileCanvas.getContext('2d', { willReadFrequently: true });
    if (!tCtx) continue;

    tCtx.drawImage(canvas, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
    const subBoxes = await runLocalOnnxDetection(tileCanvas, minConfidence, iouThreshold, debug);

    for (const sub of subBoxes) {
      allDetections.push({
        bbox: {
          x: sub.bbox.x + tile.x,
          y: sub.bbox.y + tile.y,
          width: sub.bbox.width,
          height: sub.bbox.height,
        },
        confidence: sub.confidence,
        label: sub.label,
        sourceEngine: sub.sourceEngine,
      });
    }
  }

  return applyFiltersAndNMS(allDetections, iouThreshold, W, H, canvas, debug);
}

function applyFiltersAndNMS(
  boxes: DetectedPlateBox[],
  iouThreshold: number,
  canvasWidth: number,
  canvasHeight: number,
  sourceCanvas?: HTMLCanvasElement,
  debug = false
): DetectedPlateBox[] {
  const minW = Math.max(16, canvasWidth * 0.010);
  const minH = Math.max(5, canvasHeight * 0.004);

  const rejected: Array<{ box: DetectedPlateBox; reason: string }> = [];

  const filtered = boxes.filter(box => {
    const { width, height } = box.bbox;
    if (width < minW || height < minH) {
      rejected.push({ box, reason: 'MIN_SIZE' });
      return false;
    }
    
    const ar = width / height;
    if (ar < 0.95 || ar > 6.5) {
      rejected.push({ box, reason: 'ASPECT_RATIO' });
      return false;
    }
    
    if (sourceCanvas && !verifyPlateStrokeDensity(sourceCanvas, box.bbox)) {
      rejected.push({ box, reason: 'STROKE_DENSITY' });
      return false;
    }

    return true;
  });

  // NMS removes duplicate views of the *same* plate. Do not truncate the
  // remaining set by confidence: every spatially distinct valid plate is an
  // independent scanner candidate and must reach the tracker.
  const selected = applyNMS(filtered, iouThreshold, canvasWidth, canvasHeight);

  if (debug) {
    const selectedKeys = new Set(selected.map(({ bbox }) => `${bbox.x}:${bbox.y}:${bbox.width}:${bbox.height}`));
    const nmsSuppressed = filtered.filter(({ bbox }) =>
      !selectedKeys.has(`${bbox.x}:${bbox.y}:${bbox.width}:${bbox.height}`)
    );
    console.debug('[ANPR Detector] candidate diagnostics', {
      frame: { width: canvasWidth, height: canvasHeight },
      rawCandidates: boxes,
      filterRejected: rejected,
      nmsSuppressed,
      finalCandidates: selected,
    });
  }

  return selected;
}

function getBoxArea(box: DetectedPlateBox): number {
  return box.bbox.width * box.bbox.height;
}

function getBoxRank(box: DetectedPlateBox, _frameArea: number): number {
  return box.confidence;
}

function isMostlyContained(inner: BoundingBox, outer: BoundingBox): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  const centreInside =
    cx >= outer.x &&
    cx <= outer.x + outer.width &&
    cy >= outer.y &&
    cy <= outer.y + outer.height;

  return centreInside && inner.width * inner.height < outer.width * outer.height * 0.65;
}

function getIntersectionOverMinimumArea(left: BoundingBox, right: BoundingBox): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  );
  const intersection = intersectionWidth * intersectionHeight;
  const minimumArea = Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  return intersection / minimumArea;
}

function isNearDuplicateBox(left: BoundingBox, right: BoundingBox): boolean {
  const leftCx = left.x + left.width / 2;
  const leftCy = left.y + left.height / 2;
  const rightCx = right.x + right.width / 2;
  const rightCy = right.y + right.height / 2;
  const closeCentres =
    Math.abs(leftCx - rightCx) <= Math.min(left.width, right.width) * 0.45 &&
    Math.abs(leftCy - rightCy) <= Math.min(left.height, right.height) * 0.70;
  const widthRatio = Math.max(left.width, right.width) / Math.max(1, Math.min(left.width, right.width));
  const heightRatio = Math.max(left.height, right.height) / Math.max(1, Math.min(left.height, right.height));

  return getIntersectionOverMinimumArea(left, right) >= 0.48 ||
    (closeCentres && widthRatio <= 1.9 && heightRatio <= 1.9);
}

function applyNMS(
  boxes: DetectedPlateBox[],
  iouThreshold: number,
  canvasWidth: number,
  canvasHeight: number
): DetectedPlateBox[] {
  const frameArea = canvasWidth * canvasHeight;
  const sorted = [...boxes].sort((a, b) => getBoxRank(b, frameArea) - getBoxRank(a, frameArea));
  const selected: DetectedPlateBox[] = [];

  for (const box of sorted) {
    let keep = true;
    for (const sel of selected) {
      if (
        calculateIoU(box.bbox, sel.bbox) > iouThreshold ||
        isMostlyContained(box.bbox, sel.bbox) ||
        isMostlyContained(sel.bbox, box.bbox) ||
        isNearDuplicateBox(box.bbox, sel.bbox)
      ) {
        keep = false;
        break;
      }
    }
    if (keep) {
      selected.push(box);
    }
  }

  return selected;
}

export function calculateIoU(boxA: BoundingBox, boxB: BoundingBox): number {
  const xA = Math.max(boxA.x, boxB.x);
  const yA = Math.max(boxA.y, boxB.y);
  const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const interWidth = Math.max(0, xB - xA);
  const interHeight = Math.max(0, yB - yA);
  const interArea = interWidth * interHeight;

  if (interArea === 0) return 0;

  const areaA = boxA.width * boxA.height;
  const areaB = boxB.width * boxB.height;
  return interArea / (areaA + areaB - interArea);
}
