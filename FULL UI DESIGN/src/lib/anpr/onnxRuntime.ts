let ortModuleCache: Promise<any> | null = null;

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
  const platform = navigator.platform || '';
  const maxTouchPoints = (navigator as any).maxTouchPoints || 0;
  const isIOS =
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (platform === 'MacIntel' && maxTouchPoints > 1);
  const isSafari =
    /Safari/i.test(userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android/i.test(userAgent);

  return !isIOS && !isSafari;
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
 * This keeps local scanning functional on restricted networks and mobile devices.
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

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: useWebGpuLoader ? ORT_JSEP_MODULE : ORT_WASM_MODULE,
    wasm: useWebGpuLoader ? ORT_JSEP_BINARY : ORT_WASM_BINARY,
  };
}
