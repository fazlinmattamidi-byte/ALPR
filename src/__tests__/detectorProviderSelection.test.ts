import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../lib/anpr/onnxRuntime'); });

it('prepares once and chooses the faster warmed provider rather than assuming GPU is faster', async () => {
  const makeSession = (delay: number) => ({
    inputNames: ['images'], outputNames: ['output0'], release: vi.fn(),
    run: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, delay));
      return { output0: { dispose() {} } };
    }),
  });
  const gpu = makeSession(15), wasm = makeSession(1);
  vi.stubGlobal('window', {});
  vi.doMock('../lib/anpr/onnxRuntime', async () => ({
    ...await vi.importActual('../lib/anpr/onnxRuntime'),
    canUseWebGpuExecutionProvider: () => true,
    configureOrtWasm() {},
    fetchWithTimeout: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    getOrt: async () => ({
      Tensor: class { dispose() {} },
      InferenceSession: { create: async (_bytes: unknown, options: { executionProviders: string[] }) =>
        options.executionProviders[0] === 'webgpu' ? gpu : wasm },
    }),
  }));
  const detector = await import('../lib/anpr/yoloDetector');
  expect(await detector.initLocalOnnxSession()).toBe(true);
  expect(detector.getActiveDetectorProvider()).toBe('WASM');
  expect(gpu.run).toHaveBeenCalledTimes(2);
  expect(wasm.run).toHaveBeenCalledTimes(2);
  expect(gpu.release).toHaveBeenCalledOnce();
  expect(wasm.release).not.toHaveBeenCalled();
  expect(await detector.initLocalOnnxSession()).toBe(true);
  expect(wasm.run).toHaveBeenCalledTimes(2);
});
