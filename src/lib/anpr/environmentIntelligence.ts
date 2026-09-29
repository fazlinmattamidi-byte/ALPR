import {
  ENVIRONMENT_CLASSES,
  EnvironmentClass,
  EnvironmentProfile,
} from './adaptiveConfig';
import {
  canUseWebGpuExecutionProvider,
  configureOrtWasm,
  fetchWithTimeout,
  getOrt,
  runOnnxInference,
  withTimeout,
} from './onnxRuntime';

export type EnvironmentModelStatus = 'UNINITIALIZED' | 'LOADING' | 'READY' | 'FALLBACK' | 'FAILED';

export interface FrameImageStats {
  brightness: number;
  contrast: number;
  glareRatio: number;
  blurScore: number;
  motionScore: number;
  dirtyLensScore: number;
}

const ENVIRONMENT_MODEL_PATH = '/models/environment-classifier.onnx';
const ENVIRONMENT_METADATA_PATH = '/models/environment-classifier.metadata.json';
const MODEL_FETCH_TIMEOUT_MS = 12000;
const MODEL_INIT_TIMEOUT_MS = 12000;
const MODEL_INFERENCE_TIMEOUT_MS = 2500;
const CLASSIFIER_INPUT_SIZE = 224;

let environmentSession: any = null;
let environmentStatus: EnvironmentModelStatus = 'UNINITIALIZED';
let environmentLoadPromise: Promise<boolean> | null = null;
let environmentError: string | null = null;
let reusableCanvas: HTMLCanvasElement | null = null;
let reusableCtx: CanvasRenderingContext2D | null = null;
let reusableTensorData: Float32Array | null = null;
let environmentModelClasses: EnvironmentClass[] = [...ENVIRONMENT_CLASSES];

export function getEnvironmentModelStatus(): EnvironmentModelStatus {
  return environmentStatus;
}

export function getEnvironmentModelError(): string | null {
  return environmentError;
}

export async function initEnvironmentModel(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (environmentSession && environmentStatus === 'READY') return true;
  if (environmentStatus === 'FALLBACK' || environmentStatus === 'FAILED') return false;
  if (environmentLoadPromise) return environmentLoadPromise;

  environmentStatus = 'LOADING';
  environmentError = null;

  environmentLoadPromise = (async () => {
    try {
      const modelResponse = await fetchWithTimeout(
        ENVIRONMENT_MODEL_PATH,
        MODEL_FETCH_TIMEOUT_MS,
        'Environment intelligence model fetch'
      );

      if (!modelResponse.ok) {
        environmentStatus = 'FALLBACK';
        environmentError =
          modelResponse.status === 404
            ? 'Environment classifier ONNX model not found; using frame-stat heuristic fallback.'
            : `HTTP ${modelResponse.status} fetching ${ENVIRONMENT_MODEL_PATH}`;
        return false;
      }

      const ort = await getOrt();
      const webGpuAvailable = canUseWebGpuExecutionProvider();
      configureOrtWasm(ort, webGpuAvailable);
      const modelBytes = new Uint8Array(await modelResponse.arrayBuffer());
      const providersToTry = webGpuAvailable ? [['webgpu', 'wasm'], ['wasm']] : [['wasm']];

      let fastest: { session: any; elapsed: number } | undefined;
      environmentModelClasses = await loadEnvironmentModelClasses();
      for (const providers of providersToTry) {
        try {
          environmentSession = await withTimeout<any>(
            ort.InferenceSession.create(modelBytes, {
              executionProviders: providers,
              graphOptimizationLevel: 'all',
            }),
            MODEL_INIT_TIMEOUT_MS,
            'Environment intelligence model session creation'
          );
          let elapsed = Infinity;
          for (let pass = 0; pass < 2; pass++) {
            const warmupInput = new ort.Tensor('float32', new Float32Array(3 * CLASSIFIER_INPUT_SIZE ** 2), [1, 3, CLASSIFIER_INPUT_SIZE, CLASSIFIER_INPUT_SIZE]);
            let warmupOutputs: Record<string, any> | null = null;
            try {
              warmupOutputs = await withTimeout<Record<string, any>>(
                runOnnxInference(environmentSession, { [environmentSession.inputNames[0]]: warmupInput }, duration => { elapsed = duration; }),
                MODEL_INFERENCE_TIMEOUT_MS, 'Environment classifier warm-up'
              );
            } finally {
              warmupInput.dispose?.();
              if (warmupOutputs) Object.values(warmupOutputs).forEach(output => output?.dispose?.());
            }
          }
          console.debug(`[ANPR Environment] ${providers[0]} warmed inference: ${Math.round(elapsed)}ms`);
          if (!fastest || elapsed < fastest.elapsed) {
            if (fastest) await fastest.session.release?.();
            fastest = { session: environmentSession, elapsed };
          } else await environmentSession.release?.();
          environmentSession = null;
        } catch (err: any) {
          environmentError = err?.message || String(err);
          try { await environmentSession?.release?.(); } catch { /* Best-effort cleanup. */ }
          environmentSession = null;
        }
      }

      if (fastest) {
        environmentSession = fastest.session;
        environmentError = null;
        environmentStatus = 'READY';
        return true;
      }
      environmentStatus = 'FAILED';
      return false;
    } catch (err: any) {
      environmentStatus = 'FALLBACK';
      environmentError = err?.message || String(err);
      return false;
    }
  })().finally(() => {
    environmentLoadPromise = null;
  });

  return environmentLoadPromise;
}

export async function classifyEnvironment(
  canvas: HTMLCanvasElement,
  previousStats?: FrameImageStats
): Promise<EnvironmentProfile> {
  const stats = computeFrameImageStats(canvas, previousStats);
  const modelReady = await initEnvironmentModel();

  if (modelReady && environmentSession) {
    try {
      const modelProfile = await runEnvironmentClassifier(canvas, stats);
      if (modelProfile) return modelProfile;
    } catch (err: any) {
      environmentStatus = 'FALLBACK';
      environmentError = err?.message || String(err);
    }
  }

  return classifyEnvironmentHeuristic(stats);
}

export function computeFrameImageStats(
  canvas: HTMLCanvasElement,
  previousStats?: FrameImageStats
): FrameImageStats {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    return {
      brightness: 0,
      contrast: 0,
      glareRatio: 0,
      blurScore: 0,
      motionScore: previousStats?.motionScore ?? 0,
      dirtyLensScore: 1,
    };
  }

  const sampleWidth = Math.min(180, canvas.width);
  const sampleHeight = Math.max(1, Math.round((sampleWidth / Math.max(1, canvas.width)) * canvas.height));
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sampleWidth;
  sampleCanvas.height = sampleHeight;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  if (!sampleCtx) {
    return {
      brightness: 0,
      contrast: 0,
      glareRatio: 0,
      blurScore: 0,
      motionScore: previousStats?.motionScore ?? 0,
      dirtyLensScore: 1,
    };
  }

  sampleCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
  const image = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight);
  const { data } = image;
  const totalPixels = sampleWidth * sampleHeight;
  const luma = new Float32Array(totalPixels);

  let sum = 0;
  let min = 255;
  let max = 0;
  let glarePixels = 0;

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;
    const value = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    luma[i] = value;
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
    if (value > 242) glarePixels++;
  }

  const mean = sum / Math.max(1, totalPixels);
  let variance = 0;
  for (let i = 0; i < totalPixels; i++) {
    const d = luma[i] - mean;
    variance += d * d;
  }
  variance /= Math.max(1, totalPixels);

  let laplacianSq = 0;
  let laplacianCount = 0;
  for (let y = 1; y < sampleHeight - 1; y += 2) {
    for (let x = 1; x < sampleWidth - 1; x += 2) {
      const idx = y * sampleWidth + x;
      const lap =
        luma[idx - sampleWidth] +
        luma[idx + sampleWidth] +
        luma[idx - 1] +
        luma[idx + 1] -
        4 * luma[idx];
      laplacianSq += lap * lap;
      laplacianCount++;
    }
  }

  const brightness = mean / 255;
  const contrast = Math.min(1, Math.sqrt(variance) / 96);
  const glareRatio = glarePixels / Math.max(1, totalPixels);
  const blurScore = Math.min(1, (laplacianSq / Math.max(1, laplacianCount)) / 900);
  const dirtyLensScore = Math.min(
    1,
    Math.max(0, (0.40 - contrast) / 0.40) * 0.55 +
      Math.max(0, (0.40 - blurScore) / 0.40) * 0.45
  );
  const motionScore =
    previousStats
      ? Math.min(
          1,
          Math.abs(brightness - previousStats.brightness) * 1.4 +
            Math.abs(contrast - previousStats.contrast) * 1.2
        )
      : 0;

  sampleCanvas.width = 0;
  sampleCanvas.height = 0;

  return {
    brightness: roundMetric(brightness),
    contrast: roundMetric(contrast),
    glareRatio: roundMetric(glareRatio),
    blurScore: roundMetric(blurScore),
    motionScore: roundMetric(motionScore),
    dirtyLensScore: roundMetric(dirtyLensScore),
  };
}

function classifyEnvironmentHeuristic(stats: FrameImageStats): EnvironmentProfile {
  let label: EnvironmentClass = 'GOOD_CONDITION';
  let confidence = 0.62;

  if (stats.glareRatio >= 0.10) {
    label = 'GLARE';
    confidence = 0.88;
  } else if (stats.glareRatio >= 0.045 && stats.brightness >= 0.56) {
    label = 'BACKLIGHT';
    confidence = 0.78;
  } else if (stats.brightness <= 0.16) {
    label = 'NIGHT';
    confidence = 0.88;
  } else if (stats.brightness <= 0.30) {
    label = 'LOW_LIGHT';
    confidence = 0.80;
  } else if (stats.contrast <= 0.16 && stats.brightness >= 0.34) {
    label = 'FOG';
    confidence = 0.66;
  } else if (stats.brightness >= 0.58 && stats.contrast >= 0.24 && stats.glareRatio < 0.025) {
    label = 'DAY';
    confidence = 0.74;
  } else if (stats.brightness >= 0.38 && stats.contrast >= 0.22 && stats.blurScore >= 0.32) {
    label = 'GOOD_CONDITION';
    confidence = 0.72;
  } else {
    label = 'DAY';
    confidence = 0.58;
  }

  return {
    label,
    confidence,
    source: 'HEURISTIC',
    sampledAt: Date.now(),
    stats,
  };
}

async function runEnvironmentClassifier(
  canvas: HTMLCanvasElement,
  stats: FrameImageStats
): Promise<EnvironmentProfile | null> {
  if (!environmentSession) return null;

  const ort = await getOrt();
  const input = prepareClassifierInput(canvas);
  const inputName = environmentSession.inputNames?.[0] || 'images';
  const tensor = new ort.Tensor('float32', input, [1, 3, CLASSIFIER_INPUT_SIZE, CLASSIFIER_INPUT_SIZE]);
  let outputs: Record<string, any> | null = null;

  try {
    outputs = await withTimeout<Record<string, any>>(
      runOnnxInference(environmentSession, { [inputName]: tensor }),
      MODEL_INFERENCE_TIMEOUT_MS,
      'Environment intelligence inference'
    );
    const outputName = environmentSession.outputNames?.[0] || Object.keys(outputs)[0];
    const probs = toProbabilities(outputs[outputName]?.data || [], environmentModelClasses.length);
    const top = getTopClass(probs, environmentModelClasses);

    return {
      label: top.label,
      confidence: top.confidence,
      source: 'YOLOV8_CLASSIFIER',
      sampledAt: Date.now(),
      stats,
    };
  } finally {
    tensor.dispose?.();
    if (outputs) {
      Object.values(outputs).forEach((output) => output?.dispose?.());
    }
  }
}

function prepareClassifierInput(canvas: HTMLCanvasElement): Float32Array {
  if (!reusableCanvas) {
    reusableCanvas = document.createElement('canvas');
    reusableCanvas.width = CLASSIFIER_INPUT_SIZE;
    reusableCanvas.height = CLASSIFIER_INPUT_SIZE;
    reusableCtx = reusableCanvas.getContext('2d', { willReadFrequently: true });
  }

  if (!reusableCtx) {
    return new Float32Array(3 * CLASSIFIER_INPUT_SIZE * CLASSIFIER_INPUT_SIZE);
  }

  reusableCtx.drawImage(canvas, 0, 0, CLASSIFIER_INPUT_SIZE, CLASSIFIER_INPUT_SIZE);
  const image = reusableCtx.getImageData(0, 0, CLASSIFIER_INPUT_SIZE, CLASSIFIER_INPUT_SIZE);
  const { data } = image;
  const area = CLASSIFIER_INPUT_SIZE * CLASSIFIER_INPUT_SIZE;

  if (!reusableTensorData || reusableTensorData.length !== area * 3) {
    reusableTensorData = new Float32Array(area * 3);
  }

  for (let i = 0; i < area; i++) {
    reusableTensorData[i] = data[i * 4] / 255;
    reusableTensorData[area + i] = data[i * 4 + 1] / 255;
    reusableTensorData[area * 2 + i] = data[i * 4 + 2] / 255;
  }

  return reusableTensorData;
}

async function loadEnvironmentModelClasses(): Promise<EnvironmentClass[]> {
  try {
    const response = await fetchWithTimeout(
      ENVIRONMENT_METADATA_PATH,
      2500,
      'Environment classifier metadata fetch',
      { cache: 'no-store' }
    );
    if (!response.ok) return [...ENVIRONMENT_CLASSES];
    const metadata = await response.json();
    const classes = Array.isArray(metadata?.classes) ? metadata.classes : [];
    const allowed = new Set<string>(ENVIRONMENT_CLASSES);
    const validClasses = classes.filter((item: unknown): item is EnvironmentClass => (
      typeof item === 'string' && allowed.has(item)
    ));

    return validClasses.length > 0 ? validClasses : [...ENVIRONMENT_CLASSES];
  } catch {
    return [...ENVIRONMENT_CLASSES];
  }
}

function toProbabilities(values: ArrayLike<number>, classCount: number): number[] {
  const raw = Array.from(values).slice(0, classCount);
  if (raw.length === 0) return [];
  const alreadyProbabilities =
    raw.every((value) => value >= 0 && value <= 1) &&
    Math.abs(raw.reduce((sum, value) => sum + value, 0) - 1) < 0.25;

  if (alreadyProbabilities) return raw;

  const max = Math.max(...raw);
  const exps = raw.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
  return exps.map((value) => value / sum);
}

function getTopClass<T extends string>(
  probabilities: number[],
  labels: readonly T[]
): { label: T; confidence: number } {
  let bestIndex = 0;
  let bestValue = probabilities[0] ?? 0;

  for (let i = 1; i < Math.min(probabilities.length, labels.length); i++) {
    if (probabilities[i] > bestValue) {
      bestValue = probabilities[i];
      bestIndex = i;
    }
  }

  return {
    label: labels[bestIndex] ?? labels[0],
    confidence: roundMetric(bestValue),
  };
}

function roundMetric(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}
