import { expect, it } from 'vitest';
import { haveDifferentNumericOutputs } from '../lib/anpr/runtimeOutputValidation';

it('rejects the constant blank output seen on the GPU recognizer', () => {
  expect(haveDifferentNumericOutputs([0.94, 0.0001, 0], [0.94, 0.0001, 0])).toBe(false);
  expect(haveDifferentNumericOutputs([0.94, 0.0001, 0], [0.80, 0.14, 0.001])).toBe(true);
});
it('does not admit invalid numeric tensors as input-responsive', () => {
  expect(haveDifferentNumericOutputs([], [])).toBe(false);
  expect(haveDifferentNumericOutputs([0.1], [0.2, 0.3])).toBe(false);
  expect(haveDifferentNumericOutputs([0.1], [NaN])).toBe(false);
  expect(haveDifferentNumericOutputs([Infinity], [0.2])).toBe(false);
});

it('keeps the known failing macOS model/provider combination on direct WASM', async () => {
  const { vi } = await import('vitest');
  const { canUseWebGpuExecutionProvider } = await import('../lib/anpr/onnxRuntime');
  try {
    vi.stubGlobal('navigator', { gpu: {}, userAgent: 'Chrome/140.0.0', platform: 'MacIntel' });
    expect(canUseWebGpuExecutionProvider()).toBe(false);
    vi.stubGlobal('navigator', { gpu: {}, userAgent: 'Chrome/140.0.0', platform: 'Win32' });
    expect(canUseWebGpuExecutionProvider()).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
