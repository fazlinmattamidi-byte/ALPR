import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../lib/anpr/onnxRuntime'); });

it('serializes shared-session crop and benchmark work, including recovery after an inference error', async () => {
  let running = false, failNext = false, collisions = 0;
  const session = {
    inputNames: ['x'], outputNames: ['out'],
    async run(feeds: Record<string, { data: Float32Array }>) {
      if (running) { collisions++; throw new Error('Session already started'); }
      running = true;
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (failNext) { failNext = false; throw new Error('inference failure'); }
        const probability = feeds.x.data[0] === 0 ? .99 : .98;
        return { out: { data: new Float32Array([0, probability, 0, 0, .99, 0, 0, 0, 0, 0, .99, 0]), dims: [1, 3, 4], dispose() {} } };
      } finally { running = false; }
    },
  };
  const ctx = { fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(320 * 48 * 4) }) };
  const canvas = () => ({ width: 320, height: 80, getContext: () => ctx });
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { createElement: canvas });
  const failedGpu = { inputNames: ['x'], outputNames: ['out'], release: vi.fn(),
    run: async () => ({ out: { data: new Float32Array([.94, .01, 0]), dispose() {} } }),
  };
  vi.doMock('../lib/anpr/onnxRuntime', async () => ({
    ...await vi.importActual('../lib/anpr/onnxRuntime'),
    getOrt: async () => ({ Tensor: class { constructor(_type: string, public data: Float32Array) {} dispose() {} }, InferenceSession: { create: async (_model: unknown, options: { executionProviders: string[] }) => options.executionProviders[0] === 'webgpu' ? failedGpu : session } }),
    canUseWebGpuExecutionProvider: () => true, configureOrtWasm() {},
    withTimeout: (promise: Promise<unknown>) => promise,
    fetchWithTimeout: async () => ({ ok: true, text: async () => 'A\n1', arrayBuffer: async () => new ArrayBuffer(1) }),
  }));
  const engine = await import('../lib/anpr/ppOcrEngine');
  expect(await engine.initPpOcrSession()).toBe(true);
  expect(engine.getActivePpOcrProvider()).toBe('WASM');
  expect(failedGpu.release).toHaveBeenCalledOnce();
  const results = await Promise.all([
    engine.recognizeWithPpOcr(canvas() as unknown as HTMLCanvasElement),
    engine.recognizeWithPpOcr(canvas() as unknown as HTMLCanvasElement),
    engine.runBenchmarkOcr(),
  ]);
  expect(results[0]?.normalizedPlate).toBe('A1');
  expect(results[1]?.normalizedPlate).toBe('A1');
  expect(results[2]).toBe(true);
  failNext = true;
  const recovered = await Promise.allSettled([
    engine.recognizeWithPpOcr(canvas() as unknown as HTMLCanvasElement),
    engine.recognizeWithPpOcr(canvas() as unknown as HTMLCanvasElement),
  ]);
  expect(recovered.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
  expect(collisions).toBe(0);
});
