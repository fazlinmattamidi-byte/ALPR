import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/anpr/environmentIntelligence', () => ({ initEnvironmentModel: vi.fn(async () => true) }));
vi.mock('../lib/anpr/plateQualityService', () => ({ initPlateQualityModel: vi.fn(async () => true) }));
vi.mock('../lib/anpr/yoloDetector', () => ({
  initLocalOnnxSession: vi.fn(async () => true),
  getDetectorStatus: () => 'READY',
  getActiveDetectorProvider: () => 'WASM',
  runBenchmarkDetection: vi.fn(),
}));
vi.mock('../lib/anpr/ppOcrEngine', () => ({
  initPpOcrSession: vi.fn(),
  isPpOcrReady: vi.fn(),
  runBenchmarkOcr: vi.fn(),
}));
import { runBenchmarkDetection } from '../lib/anpr/yoloDetector';
import { initEnvironmentModel } from '../lib/anpr/environmentIntelligence';
import { initPpOcrSession, isPpOcrReady } from '../lib/anpr/ppOcrEngine';
let runtime: typeof import('../lib/anpr/runtimeManager');
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime = await import('../lib/anpr/runtimeManager');
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('scanner engine preparation', () => {
  it('does not announce ready before OCR warm-up completes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    let finish!: (ready: boolean) => void;
    vi.mocked(initPpOcrSession).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(isPpOcrReady).mockReturnValue(true);
    const pending = runtime.initializeANPRRuntime();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(runtime.getANPRRuntimeState()).toBe('VALIDATING_MODELS');
    finish(true);
    expect((await pending).state).toBe('READY_WASM');
  });

  it('waits for the condition classifiers before declaring ready', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    vi.mocked(initPpOcrSession).mockResolvedValueOnce(true);
    vi.mocked(isPpOcrReady).mockReturnValue(true);
    let finish!: (ready: boolean) => void;
    vi.mocked(initEnvironmentModel).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = runtime.initializeANPRRuntime();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(runtime.getANPRRuntimeState()).toBe('VALIDATING_MODELS');
    finish(true);
    expect((await pending).state).toBe('READY_WASM');
  });

  it('shares preparation across repeated starts and reuses warmed engines', async () => {
    vi.stubGlobal('window', {});
    vi.mocked(initPpOcrSession).mockResolvedValueOnce(true);
    vi.mocked(isPpOcrReady).mockReturnValue(true);
    let finish!: (value: boolean) => void;
    vi.mocked(runBenchmarkDetection).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = runtime.initializeANPRRuntime();
    const second = runtime.initializeANPRRuntime();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(runtime.getANPRRuntimeState()).toBe('BENCHMARKING_DEVICE');
    finish(true);
    await first;
    const benchmarkCalls = vi.mocked(runBenchmarkDetection).mock.calls.length;
    await runtime.initializeANPRRuntime();
    expect(runBenchmarkDetection).toHaveBeenCalledTimes(benchmarkCalls);
    expect(initPpOcrSession).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning unavailable when OCR preparation fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    vi.mocked(initPpOcrSession).mockResolvedValueOnce(false);
    vi.mocked(isPpOcrReady).mockReturnValue(false);
    expect((await runtime.initializeANPRRuntime()).state).toBe('OCR_UNAVAILABLE');
  });
});
