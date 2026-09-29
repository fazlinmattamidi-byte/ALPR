import type { InferenceSession } from 'onnxruntime-web';

let ortModuleCache: Promise<any> | null = null;
let sharedGpuContext = false;

const ORT_PUBLIC_PATH = '/ort-wasm/';
const ORT_WASM_MODULE = `${ORT_PUBLIC_PATH}ort-wasm-simd-threaded.mjs`;
const ORT_WASM_BINARY = `${ORT_PUBLIC_PATH}ort-wasm-simd-threaded.wasm`;
const ORT_JSEP_MODULE = `${ORT_PUBLIC_PATH}ort-wasm-simd-threaded.jsep.mjs`;
const ORT_JSEP_BINARY = `${ORT_PUBLIC_PATH}ort-wasm-simd-threaded.jsep.wasm`;

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  timeoutMs: number,
  label: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function canUseWebGpuExecutionProvider(): boolean {
  if (typeof navigator === 'undefined' || !(navigator as any).gpu) return false;

  const userAgent = navigator.userAgent || '';
  const isChromeOrEdge = /Chrome|Chromium|Edg/i.test(userAgent) && !/OPR|Firefox/i.test(userAgent);
  const platform = navigator.platform || '';
  const isDesktop = /Mac|Win|Linux x86_64|Linux armv8l/i.test(platform);

  // The shipped OCR model currently produces input-insensitive blank output
  // on the tested Apple Metal runtime. Loading JSEP before falling back also
  // makes CPU inference slower than direct WASM. Use the validated direct
  // runtime on macOS until this model/provider combination is revalidated.
  const isMac = /Mac/i.test(platform);
  return isChromeOrEdge && isDesktop && !isMac;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existingScript) {
      if ((window as any).ort) {
        resolve();
        return;
      }

      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Load ONNX Runtime from the installed npm package instead of a CDN script.
 * This keeps local scanning functional on restricted networks and desktop laptop deployments.
 */
export async function getOrt(): Promise<any> {
  if (typeof window === 'undefined') return null;

  const existingOrt = (window as any).ort;
  if (existingOrt) return existingOrt;

  if (!ortModuleCache) {
    ortModuleCache = loadScript('/ort-wasm/ort.min.js').then(() => {
      const ort = (window as any).ort;
      if (!ort) throw new Error('ONNX Runtime loaded but did not expose window.ort');
      return ort;
    });
  }

  return ortModuleCache;
}

export function configureOrtWasm(ort: any, useWebGpuLoader = false): void {
  if (!ort?.env?.wasm) return;
  sharedGpuContext ||= useWebGpuLoader;

  ort.env.logLevel = 'error';
  // Threaded WASM requires cross-origin isolation. Use the available CPU
  // safely when it is enabled; otherwise retain the reliable single-thread
  // fallback instead of requesting a configuration the browser cannot run.
  const cpuCount = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1;
  const supportsThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  ort.env.wasm.numThreads = supportsThreads ? Math.min(4, Math.max(1, cpuCount - 1)) : 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: useWebGpuLoader ? ORT_JSEP_MODULE : ORT_WASM_MODULE,
    wasm: useWebGpuLoader ? ORT_JSEP_BINARY : ORT_WASM_BINARY,
  };
}

// ORT's WebGPU backend shares an active-session context across model sessions.
// Per-model locks are insufficient: environment/quality/OCR can collide with
// detection even though each individual session is internally serialized.
let runtimeInferenceQueue: Promise<void> = Promise.resolve();

export function runOnnxInference(
  session: Pick<InferenceSession, 'run'>,
  feeds: InferenceSession.FeedsType,
  onDuration?: (milliseconds: number) => void
): Promise<InferenceSession.ReturnType> {
  const run = async () => {
    const started = performance.now();
    try { return await session.run(feeds); }
    finally { onDuration?.(performance.now() - started); }
  };
  // Plain WASM sessions do not share the WebGPU active-session context. Keep
  // their existing per-model locks without delaying unrelated model work.
  if (!sharedGpuContext) return run();
  const inference = runtimeInferenceQueue.then(run);
  runtimeInferenceQueue = inference.then(() => undefined, () => undefined);
  return inference;
}
