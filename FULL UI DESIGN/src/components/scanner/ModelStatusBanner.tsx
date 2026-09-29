import React from 'react';
import { Cpu, AlertTriangle, Zap, RefreshCw, AlertOctagon, HelpCircle } from 'lucide-react';
import { ANPRRuntimeState, AdmissionBenchmarkResult } from '@/lib/anpr/runtimeManager';

interface ModelStatusBannerProps {
  runtimeState: ANPRRuntimeState;
  detectorProvider?: 'WebGPU' | 'WASM' | 'NONE';
  ocrProvider?: 'WebGPU' | 'WASM' | 'NONE';
  benchmark?: AdmissionBenchmarkResult | null;
  errorMessage?: string | null;
  debugMode?: boolean;
  onRetry?: () => void;
  onManualSearch?: () => void;
}

export const ModelStatusBanner: React.FC<ModelStatusBannerProps> = ({
  runtimeState,
  detectorProvider = 'WASM',
  ocrProvider = 'WASM',
  benchmark,
  errorMessage,
  debugMode = false,
  onRetry,
  onManualSearch,
}) => {
  const isReady = runtimeState === 'READY_WEBGPU' || runtimeState === 'READY_WASM';
  const isDegraded = runtimeState === 'DEGRADED_PERFORMANCE';
  const isUnavailable = runtimeState === 'DETECTOR_UNAVAILABLE' || runtimeState === 'OCR_UNAVAILABLE' || runtimeState === 'RUNTIME_ERROR';
  const isLoading = runtimeState === 'LOADING_MODELS' || runtimeState === 'VALIDATING_MODELS' || runtimeState === 'BENCHMARKING_DEVICE';

  // For normal users when ready and debugMode is false, keep UI 100% clean and transparent
  if (isReady && !debugMode) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2.5 p-3.5 bg-slate-950/95 border border-slate-800 rounded-2xl text-xs backdrop-blur-md shadow-2xl">
      <div className="flex items-center justify-between gap-2">
        {/* DETECTOR STATUS */}
        <div className="flex items-center gap-2">
          {isReady ? (
            <>
              <Cpu className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />
              <span className="font-bold text-emerald-400">AI Detector Ready</span>
              <span className="px-2 py-0.5 bg-emerald-950/80 border border-emerald-800 rounded text-[9px] font-mono text-emerald-300 font-bold">
                {runtimeState === 'READY_WEBGPU' ? 'WebGPU' : 'WASM'}
              </span>
            </>
          ) : isDegraded ? (
            <>
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="font-bold text-amber-400">Slow Scanning Speed</span>
            </>
          ) : isUnavailable ? (
            <>
              <AlertOctagon className="w-4 h-4 text-rose-500 shrink-0" />
              <span className="font-bold text-rose-400">
                {runtimeState === 'OCR_UNAVAILABLE' ? 'OCR Engine Loading Issue' : 'Detector Loading Issue'}
              </span>
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 text-[#00d8f6] animate-spin shrink-0" />
              <span className="font-bold text-[#00d8f6]">
                {runtimeState === 'LOADING_MODELS' ? 'Initializing AI Scanner...' : runtimeState === 'VALIDATING_MODELS' ? 'Checking Models...' : 'Benchmarking Device...'}
              </span>
            </>
          )}
        </div>

        {/* OCR ENGINE STATUS (Debug mode only) */}
        {isReady && debugMode && (
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-[#00d8f6] shrink-0" />
            <span className="font-bold text-[#00d8f6]">PP-OCR ONNX</span>
          </div>
        )}
      </div>

      {/* BENCHMARK DIAGNOSTICS CHIP (Debug mode only) */}
      {benchmark && isReady && debugMode && (
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 border-t border-slate-900 pt-1.5 px-1">
          <span>Det: {benchmark.detectorP95Ms}ms</span>
          <span>OCR: {benchmark.ocrP95Ms}ms</span>
          <span>{benchmark.estimatedFps} FPS</span>
        </div>
      )}

      {/* FRIENDLY ERROR & RETRY ACTION FOR END USERS */}
      {(isUnavailable || isDegraded) && (
        <div className="flex flex-col gap-2 pt-2 border-t border-slate-800/80">
          <p className="text-[11px] text-slate-300 leading-relaxed">
            {isUnavailable 
              ? 'Unable to start automatic AI scanning. You can retry initialization or use manual plate search.' 
              : 'Device scanning speed is reduced. Manual plate search is available.'}
          </p>
          {errorMessage && (
            <p className="text-[10px] text-rose-300/80 font-mono break-all leading-tight bg-rose-950/30 p-2 rounded-xl border border-rose-900/20">
              {errorMessage}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex-1 px-3 py-2 bg-[#00d8f6] hover:bg-[#22e0fb] text-slate-950 font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5 shadow-lg shadow-[#00d8f6]/20"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry Scanner
              </button>
            )}
            {onManualSearch && (
              <button
                onClick={onManualSearch}
                className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5 border border-slate-700"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                Manual Search
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
