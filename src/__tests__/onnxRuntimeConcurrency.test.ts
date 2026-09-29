import { expect, it } from 'vitest';
import { runOnnxInference, configureOrtWasm } from '../lib/anpr/onnxRuntime';

it('serializes different model sessions on the shared backend, including warm-up and recovery', async () => {
  configureOrtWasm({ env: { wasm: {} } }, true);
  let activeSession = false;
  const order: string[] = [];
  const session = (name: string, fail = false) => ({
    async run() {
      if (activeSession) throw new Error('Session already started');
      activeSession = true;
      order.push(name);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (fail) throw new Error('model failure');
        return {};
      } finally { activeSession = false; }
    },
  });
  const results = await Promise.allSettled([
    runOnnxInference(session('detector'), {}),
    runOnnxInference(session('environment'), {}),
    runOnnxInference(session('quality', true), {}),
    runOnnxInference(session('ocr'), {}),
    runOnnxInference(session('benchmark'), {}),
  ]);
  expect(order).toEqual(['detector', 'environment', 'quality', 'ocr', 'benchmark']);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
});
