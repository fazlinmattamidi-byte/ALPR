/**
 * PlateQ — Production ANPR Runtime Manager & Admission Controller
 * 
 * Strict Runtime State Machine:
 * UNINITIALIZED -> LOADING_MODELS -> VALIDATING_MODELS -> BENCHMARKING_DEVICE -> READY_WEBGPU / READY_WASM / DEGRADED_PERFORMANCE / DETECTOR_UNAVAILABLE / OCR_UNAVAILABLE / RUNTIME_ERROR
 * 
 * Hardware Execution Policy:
 * Preferred Chain: WebGPU -> WASM (WebGL removed from production chain)
 * 
 * WASM Admission Benchmark Thresholds (Configurable):
 * - Detector P95 latency < 500 ms
 * - OCR P95 latency < 1200 ms
 * - Sustainable live scanning FPS >= 2.0 FPS
 */

import { initLocalOnnxSession, getDetectorStatus, getActiveDetectorProvider, runBenchmarkDetection } from './yoloDetector';
import { initPpOcrSession, isPpOcrReady, runBenchmarkOcr } from './ppOcrEngine';
import { withTimeout } from './onnxRuntime';

export type ANPRRuntimeState =
  | 'UNINITIALIZED'
  | 'LOADING_MODELS'
  | 'VALIDATING_MODELS'
  | 'BENCHMARKING_DEVICE'
  | 'READY_WEBGPU'
  | 'READY_WASM'
  | 'DEGRADED_PERFORMANCE'
  | 'DETECTOR_UNAVAILABLE'
  | 'OCR_UNAVAILABLE'
  | 'RUNTIME_ERROR';

export interface AdmissionBenchmarkConfig {
  maxDetectorP95Ms: number;  // Default: 500 ms
  maxOcrP95Ms: number;       // Default: 1200 ms
  minSustainableFps: number; // Default: 2.0 FPS
}

export interface AdmissionBenchmarkResult {
  passed: boolean;
  activeProvider: 'WebGPU' | 'WASM' | 'NONE';
  detectorWarmupMs: number;
  detectorMedianMs: number;
  detectorP95Ms: number;
  ocrMedianMs: number;
  ocrP95Ms: number;
  estimatedFps: number;
  reason?: string;
}

export const DEFAULT_BENCHMARK_CONFIG: AdmissionBenchmarkConfig = {
  maxDetectorP95Ms: 500,
  maxOcrP95Ms: 1200,
  minSustainableFps: 2.0,
};

let currentRuntimeState: ANPRRuntimeState = 'UNINITIALIZED';
let latestBenchmarkResult: AdmissionBenchmarkResult | null = null;
let runtimeErrorMessage: string | null = null;
let benchmarkRunId = 0;
let ocrInitRunId = 0;

const ADMISSION_BENCHMARK_TIMEOUT_MS = 12000;
const BACKGROUND_BENCHMARK_DELAY_MS = 3000;

export function getANPRRuntimeState(): ANPRRuntimeState {
  return currentRuntimeState;
}

export function getLatestBenchmarkResult(): AdmissionBenchmarkResult | null {
  return latestBenchmarkResult;
}

export function getRuntimeErrorMessage(): string | null {
  return runtimeErrorMessage;
}

/**
 * Initialize production ANPR runtime state machine with hardware admission benchmarking.
 */
export async function initializeANPRRuntime(
  benchmarkConfig: AdmissionBenchmarkConfig = DEFAULT_BENCHMARK_CONFIG
): Promise<{ state: ANPRRuntimeState; benchmark?: AdmissionBenchmarkResult }> {
  if (typeof window === 'undefined') {
    currentRuntimeState = 'UNINITIALIZED';
    return { state: currentRuntimeState };
  }

  currentRuntimeState = 'LOADING_MODELS';
  runtimeErrorMessage = null;

  try {
    // 1. Initialize Local YOLO Detector ONNX Session
    const detectorLoaded = await initLocalOnnxSession();
    if (!detectorLoaded || getDetectorStatus() === 'FAILED') {
      const { getDetectorError } = await import('./yoloDetector');
      currentRuntimeState = 'DETECTOR_UNAVAILABLE';
      runtimeErrorMessage = getDetectorError() || 'Local YOLO ONNX detector model failed to load.';
      return { state: currentRuntimeState };
    }

    currentRuntimeState = 'VALIDATING_MODELS';
    const detectorProvider = getActiveDetectorProvider();

    currentRuntimeState = detectorProvider === 'WebGPU' ? 'READY_WEBGPU' : 'READY_WASM';
    startBackgroundOcrInitAndBenchmark(benchmarkConfig, currentRuntimeState);
    return { state: currentRuntimeState };

  } catch (err: any) {
    currentRuntimeState = 'RUNTIME_ERROR';
    runtimeErrorMessage = err?.message || 'Unexpected ANPR runtime initialization error.';
    return { state: currentRuntimeState };
  }
}

function startBackgroundOcrInitAndBenchmark(
  benchmarkConfig: AdmissionBenchmarkConfig,
  readyState: ANPRRuntimeState
): void {
  const runId = ++ocrInitRunId;

  initPpOcrSession()
    .then(async (ocrLoaded) => {
      if (runId !== ocrInitRunId) return;

      if (!ocrLoaded || !isPpOcrReady()) {
        const { getPpOcrError } = await import('./ppOcrEngine');
        currentRuntimeState = 'OCR_UNAVAILABLE';
        runtimeErrorMessage = getPpOcrError() || 'Local PP-OCR ONNX model failed to load.';
        return;
      }

      startBackgroundAdmissionBenchmark(benchmarkConfig, readyState);
    })
    .catch(async () => {
      if (runId !== ocrInitRunId) return;
      const { getPpOcrError } = await import('./ppOcrEngine');
      currentRuntimeState = 'OCR_UNAVAILABLE';
      runtimeErrorMessage = getPpOcrError() || 'Local PP-OCR ONNX model failed to load.';
    });
}

function startBackgroundAdmissionBenchmark(
  benchmarkConfig: AdmissionBenchmarkConfig,
  readyState: ANPRRuntimeState
): void {
  const runId = ++benchmarkRunId;

  setTimeout(() => {
    if (runId !== benchmarkRunId) return;

    withTimeout(
      runAdmissionBenchmark(benchmarkConfig),
      ADMISSION_BENCHMARK_TIMEOUT_MS,
      'ANPR admission benchmark'
    )
      .then((benchmark) => {
        if (runId !== benchmarkRunId) return;
        latestBenchmarkResult = benchmark;

        if (readyState === 'READY_WEBGPU' || benchmark.passed) {
          if (currentRuntimeState === 'DEGRADED_PERFORMANCE') {
            runtimeErrorMessage = null;
          }
          currentRuntimeState = readyState;
          return;
        }

        currentRuntimeState = 'DEGRADED_PERFORMANCE';
        runtimeErrorMessage = benchmark.reason || 'Device performance below minimum admission threshold for live continuous scanning.';
      })
      .catch((err: any) => {
        if (runId !== benchmarkRunId) return;
        if (currentRuntimeState === 'READY_WEBGPU' || currentRuntimeState === 'READY_WASM') {
          currentRuntimeState = 'DEGRADED_PERFORMANCE';
          runtimeErrorMessage = err?.message || 'Device benchmark timed out. Live scanning remains enabled with reduced performance diagnostics.';
        }
      });
  }, BACKGROUND_BENCHMARK_DELAY_MS);
}

/**
 * Execute startup latency and throughput admission benchmark.
 */
async function runAdmissionBenchmark(
  config: AdmissionBenchmarkConfig
): Promise<AdmissionBenchmarkResult> {
  const provider = getActiveDetectorProvider();
  const detectorLatencies: number[] = [];
  const ocrLatencies: number[] = [];

  // Warm-up run
  const warmupStart = performance.now();
  await runBenchmarkDetection();
  await runBenchmarkOcr();
  const warmupMs = Math.round(performance.now() - warmupStart);

  // 5 Detector benchmark iterations
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await runBenchmarkDetection();
    detectorLatencies.push(performance.now() - start);
  }

  // 3 OCR benchmark iterations
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await runBenchmarkOcr();
    ocrLatencies.push(performance.now() - start);
  }

  detectorLatencies.sort((a, b) => a - b);
  ocrLatencies.sort((a, b) => a - b);

  const detectorMedianMs = Math.round(detectorLatencies[Math.floor(detectorLatencies.length / 2)]);
  const detectorP95Ms = Math.round(detectorLatencies[Math.floor(detectorLatencies.length * 0.95)] || detectorLatencies[detectorLatencies.length - 1]);

  const ocrMedianMs = Math.round(ocrLatencies[Math.floor(ocrLatencies.length / 2)]);
  const ocrP95Ms = Math.round(ocrLatencies[Math.floor(ocrLatencies.length * 0.95)] || ocrLatencies[ocrLatencies.length - 1]);

  const estimatedFps = Math.round((1000 / Math.max(1, detectorMedianMs)) * 10) / 10;

  const passedDetectorP95 = detectorP95Ms <= config.maxDetectorP95Ms;
  const passedOcrP95 = ocrP95Ms <= config.maxOcrP95Ms;
  const passedFps = estimatedFps >= config.minSustainableFps;

  const passed = (provider === 'WebGPU') || (passedDetectorP95 && passedOcrP95 && passedFps);

  let reason = '';
  if (!passed) {
    if (!passedDetectorP95) reason = `Detector P95 latency (${detectorP95Ms} ms) exceeds limit (${config.maxDetectorP95Ms} ms). `;
    if (!passedOcrP95) reason += `OCR P95 latency (${ocrP95Ms} ms) exceeds limit (${config.maxOcrP95Ms} ms). `;
    if (!passedFps) reason += `Estimated FPS (${estimatedFps}) below minimum (${config.minSustainableFps} FPS).`;
  }

  return {
    passed,
    activeProvider: provider === 'WebGPU' ? 'WebGPU' : provider === 'WASM' ? 'WASM' : 'NONE',
    detectorWarmupMs: warmupMs,
    detectorMedianMs,
    detectorP95Ms,
    ocrMedianMs,
    ocrP95Ms,
    estimatedFps,
    reason: reason || undefined,
  };
}
