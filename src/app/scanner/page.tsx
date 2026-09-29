'use client';

import { capturePlateAppearance } from '@/lib/anpr/plateAppearance';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/context/LanguageContext';
import { useStorage } from '@/context/StorageContext';
import { useAuth } from '@/context/AuthContext';
import { cleanPlateNumber, formatMYR } from '@/lib/utils';
import { DetectionLog, Vehicle } from '@/types';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookmarkCheck,
  Brain,
  Camera,
  CheckCircle2,
  Clapperboard,
  Download,
  Eye,
  Film,
  FlipHorizontal,
  Loader2,
  MapPin,
  Maximize2,
  Minimize2,
  Minus,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
  SwitchCamera,
  Upload,
  Video,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from 'lucide-react';
import {
  TRAINING_VIDEOS,
  getTrainingVideoById,
} from '@/lib/anpr/trainingVideos';
import { PlateTracker, ActiveTrack, type BoundingBox, calculateIoU, calculateCentroidDistance } from '@/lib/anpr/tracker';
import { CameraHealthMonitor, HealthSnapshot } from '@/lib/anpr/healthMonitor';
import {
  detectMalaysianPlates,
  validateDetector,
  getActiveDetectorProvider,
  ActiveExecutionProvider,
} from '@/lib/anpr/yoloDetector';
import {
  generateAdaptiveCrops,
  createInnerPlateTextCrop,
  cropDeskewedCanvasRegionFast,
  cropCanvasRegionFast,
  classifyCropCondition,
  prioritiseTracks,
  type PreprocessVariant,
  releaseCanvasMemory,
  scaleBoundingBox,
} from '@/lib/anpr/imageProcessor';
import { BestFrameSelector } from '@/lib/anpr/bestFrameSelector';
import { recognizePlateFromCanvas } from '@/lib/anpr/ocrEngine';
import { planOcrRecovery, selectOcrRecoveryCandidates, planDetectorRecovery } from '@/lib/anpr/recoveryPolicy';
import {
  canPublishPlate,
  canUseSingleOcrObservation,
  isSameRecentPlateObservation,
  MIN_CORROBORATED_OCR_CONFIDENCE,
} from '@/lib/anpr/publicationPolicy';
import { addOcrVoteToTrack, addOcrCandidateEvidence, evaluateConsensus, isOneCharacterVariant, arePlatesSameVehicleFamily } from '@/lib/anpr/consensus';
import { isRepeatedCharacterOmission } from '@/lib/anpr/normaliser';
import { waitForDecodedFrame } from '@/lib/anpr/scannerStartup';
import { OcrWorkPool, VideoFrameAdmission, canScheduleOcrEvidence, shouldContinueSampleDrain, canDrainOcrCrop, CameraDetectionScheduler } from '@/lib/anpr/liveScheduling';
import {
  initializeANPRRuntime,
  getANPRRuntimeState,
  getLatestBenchmarkResult,
  getRuntimeErrorMessage,
  ANPRRuntimeState,
  AdmissionBenchmarkResult,
} from '@/lib/anpr/runtimeManager';
import { getActivePpOcrProvider, isPpOcrReady, ActiveOcrProvider } from '@/lib/anpr/ppOcrEngine';
import { validateMalaysianPattern } from '@/lib/anpr/patterns';
import {
  evaluateMalaysianPlateVisualCandidate,
  evaluateMalaysianPlateFinalConfirmation,
} from '@/lib/anpr/malaysianPlateValidator';
import { buildVehicleMatchIndex, evaluateDatabaseMatch } from '@/lib/anpr/matchingEngine';
import { INITIAL_SETTINGS } from '@/lib/db/settingsDefaults';
import { ScannerSettings, VehicleCase } from '@/lib/db/types';
import { ModelStatusBanner } from '@/components/scanner/ModelStatusBanner';
import {
  AdaptiveScannerConfig,
  createAdaptiveScannerConfig,
  createDefaultEnvironmentProfile,
  createEmptyDistribution,
  ENVIRONMENT_CLASSES,
  EnvironmentClass,
  EnvironmentProfile,
  getDistributionPercentages,
  incrementDistribution,
  isEnvironmentProfileActionable,
  PLATE_QUALITY_CLASSES,
  PlateQualityClass,
} from '@/lib/anpr/adaptiveConfig';
import {
  classifyEnvironment,
  FrameImageStats,
  getEnvironmentModelStatus,
} from '@/lib/anpr/environmentIntelligence';
import {
  classifyPlateQuality,
  createPlateQualityDatasetSchema,
  getPlateQualityBackend,
  getPlateQualityEngineLabel,
  getPlateQualityModelStatus,
  PlateQualityAssessment,
} from '@/lib/anpr/plateQualityModel';
import {
  CameraHealthSnapshot,
  CameraRuntimeMetadata,
  DesktopCameraDevice,
  createCameraHealthSnapshot,
  enumerateDesktopCameras,
  getCameraRuntimeMetadata,
  getRememberedCameraId,
  openDesktopCameraStream,
  rememberSelectedCamera,
  selectPreferredCamera,
  streamNeedsReconnect,
} from '@/lib/anpr/cameraManager';

type AlertMatch = {
  vehicle: Vehicle;
  cameraName: string;
  cameraId: string;
  detectionId?: string;
  snapshotDataUrl?: string;
  confidence?: number;
  timestamp?: string;
  actionStatus?: 'PENDING' | 'REVIEWED';
};

export type CameraMovementConfig = 'AUTO' | 'STATIONARY' | 'MOBILE';

export type CameraSlot = {
  id: string;
  deviceId: string;
  movementMode?: CameraMovementConfig;
};

type ScanLocation = {
  name: string;
  gps: string;
};

type SessionDetection = DetectionLog &
  ScanLocation & {
    matchType?: 'EXACT' | 'POSSIBLE' | 'NONE';
    possibleVehicleIds?: string[];
    recordedAtMs?: number;
    evidenceCount?: number;
    detectedAtVideoSeconds?: number;
    readAtVideoSeconds?: number;
    recognitionDurationMs?: number;
    detectionLatencyMs?: number;
    readLatencyMs?: number;
    processingDurationMs?: number;
    frameAgeMs?: number;
  };

type RecentPlateFamily = {
  bbox: BoundingBox;
  capturedAt: number;
  plate: string;
  detectionId: string;
  confidence: number;
  evidenceCount: number;
  matchType: 'EXACT' | 'POSSIBLE' | 'NONE';
  timestamp: number;
};

type SeenPlateItem = {
  id: string;
  plate: string;
  tone: SeenPlateTone;
  confidence: number;
  cameraName: string;
  timestamp: string;
  detail: string;
  searchHref: string;
  active: boolean;
  detection: SessionDetection | undefined;
  actionStatus: 'PENDING' | 'REVIEWED' | undefined;
  snapshotDataUrl: string | undefined;
  canMarkAction: boolean;
  timing?: string;
};

type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

type SlotScannerRuntime = {
  tracker: PlateTracker;
  bestFrameSelector: BestFrameSelector;
  processingCanvas: HTMLCanvasElement | null;
  sourceFrameCanvas: HTMLCanvasElement | null;
  lastMaintenanceTs: number;
  ocrGeneration: number;
  lastProcessedMediaTime?: number;
  detectorRunning?: boolean;
  drainDeadline?: number;
};

type SlotMetrics = {
  camFrames: number;
  detFrames: number;
  platesVisible: number;
  activeTracks: number;
  tracks: ActiveTrack[];
};

type DeviceTier = 'A' | 'B' | 'C' | 'D';

export type CameraSlotStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';

type MotionBucket = 'NORMAL' | 'UNSTABLE' | 'COLLECT_ONLY' | 'PAUSED';

type PerformanceMode = 'DESKTOP_STANDARD' | 'ADAPTIVE' | 'RECOVERY' | 'SURVIVAL';

type SeenPlateTone = 'EXACT' | 'POSSIBLE' | 'NONE' | 'CHECKING' | 'READING';

type ScannerReloadTriggerCode =
  | 'SCHEDULED_REFRESH'
  | 'STREAM_RECONNECT'
  | 'CAMERA_FPS_DROP'
  | 'DETECTOR_SLOWDOWN'
  | 'OCR_QUEUE_BACKLOG'
  | 'MEMORY_GROWTH';

type ScannerReloadTrigger = {
  code: ScannerReloadTriggerCode;
  message: string;
  confirmationMs: number;
};

type ScannerNoticeMode = 'STARTING' | 'RELOADING';

type ScannerReloadNotice = {
  isReloading: boolean;
  reason: string;
  startedAt: number;
  completedAt?: number;
  count: number;
  mode: ScannerNoticeMode;
  title?: string;
  body?: string;
};

type CameraStopOptions = {
  preserveScanningState?: boolean;
  invalidatePendingStarts?: boolean;
};

type MobileFacingMode = 'user' | 'environment';

type ScannerRuntimeMetrics = {
  sessionStartedAt: number;
  detectorLatencyTotalMs: number;
  detectorLatencySamples: number;
  detectorLatencyHistoryMs: number[];
  ocrLatencyTotalMs: number;
  ocrLatencySamples: number;
  ocrLatencyHistoryMs: number[];
  trackLifetimeTotalMs: number;
  completedTrackCount: number;
  lostTrackObservations: number;
  reacquiredTrackCount: number;
  duplicateOcrSkippedCount: number;
  ocrAttemptCount: number;
  ocrAcceptedCount: number;
  ocrSkippedQueuePressureCount: number;
  consensusAttemptCount: number;
  falseAlertCount: number;
  droppedFrameCount: number;
  cropQualityTotal: number;
  cropQualitySamples: number;
  lastOcrQueueDepth: number;
  maxOcrQueueDepth: number;
  motionBuckets: Record<MotionBucket, number>;
  baseDeviceTier: DeviceTier;
  deviceTier: DeviceTier;
  adaptationLevel: number;
  performanceMode: PerformanceMode;
  performanceModeReason: string;
  executionMode: string;
  cameraProfile: string;
  processingProfile: string;
  ocrProfile: string;
  currentEnvironment: EnvironmentClass;
  currentEnvironmentConfidence: number;
  currentEnvironmentSource: EnvironmentProfile['source'];
  currentQuality: PlateQualityClass;
  currentQualityConfidence: number;
  currentQualityBackend: PlateQualityAssessment['backend'];
  environmentDistribution: Record<EnvironmentClass, number>;
  qualityDistribution: Record<PlateQualityClass, number>;
  qualityLatencyTotalMs: number;
  qualityLatencySamples: number;
  qualityLatencyHistoryMs: number[];
  qualityAcceptedCropCount: number;
  qualityRejectedCropCount: number;
  qualityOcrAvoidedCount: number;
  qualityCorrectableRecoveredCount: number;
  bestFrameReplacementCount: number;
  tracksWaitingForBetterCrop: number;
  heuristicQualityUsageCount: number;
  onnxQualityUsageCount: number;
  qualityRejectionReasons: Record<string, number>;
  environmentStats: Record<
    EnvironmentClass,
    {
      frames: number;
      detectorLatencyTotalMs: number;
      detectorLatencySamples: number;
      ocrLatencyTotalMs: number;
      ocrLatencySamples: number;
      cropQualityTotal: number;
      cropQualitySamples: number;
    }
  >;
  cameraHealth: CameraHealthSnapshot;
  memoryBaselineMb?: number;
  memoryCurrentMb?: number;
};

type ScannerMetricsSnapshot = ScannerRuntimeMetrics & {
  detectorLatencyAvgMs: number;
  detectorLatencyMedianMs: number;
  detectorLatencyP95Ms: number;
  ocrLatencyAvgMs: number;
  ocrLatencyMedianMs: number;
  ocrLatencyP95Ms: number;
  trackLifetimeAvgMs: number;
  cropQualityAvg: number;
  qualityLatencyAvgMs: number;
  qualityLatencyP95Ms: number;
  trackLossRate: number;
  duplicateOcrRate: number;
  averageTrackConfidence: number;
  memoryGrowthPercent?: number;
};

type CompletedTrackEvent = {
  id: string;
  trackId: string;
  cameraId: string;
  cameraName: string;
  plate: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  detectorConfidence: number;
  detectorLatencyMs: number;
  trackConfidence: number;
  confidenceComponents?: ActiveTrack['confidenceComponents'];
  ocrConfidence: number;
  ocrLatencyMs: number;
  consensusCount: number;
  matchType: 'EXACT' | 'POSSIBLE' | 'NONE';
  motionLevel: MotionBucket;
  cropQuality: number;
  processingTimeMs: number;
  reasonForCompletion: string;
  deviceTier: DeviceTier;
  environment: EnvironmentClass;
  environmentConfidence: number;
  qualityClass: PlateQualityClass;
  qualityConfidence: number;
};

type DatasetSample = {
  id: string;
  timestamp: string;
  folderPath: string;
  originalImageDataUrl: string;
  plateCropDataUrl: string;
  environmentClass: EnvironmentClass;
  environmentConfidence: number;
  qualityClass: PlateQualityClass;
  qualityConfidence: number;
  qualityScore: number;
  qualityBackend: PlateQualityAssessment['backend'];
  qualityRejectionReasons: string[];
  selectedPreprocessing: string[];
  ocrResult: string;
  ocrConfidence: number;
  detectorConfidence: number;
  trackConfidence: number;
  camera: CameraRuntimeMetadata | null;
};

type HealthStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';

type HealthComponent = {
  label: string;
  status: HealthStatus;
  score: number;
  detail: string;
};

type SystemHealthSnapshot = {
  overallScore: number;
  components: HealthComponent[];
};

type ScannerPerformanceTargets = {
  detectorMedianLatencyMs: number;
  detectorP95LatencyMs: number;
  ocrMedianLatencyMs: number;
  ocrP95LatencyMs: number;
  trackLossRate: number;
  duplicateOcrRate: number;
  falseExactMatches: number;
  sustainedDetectorFps: number;
  maxOcrQueueDepth: number;
  minAverageTrackConfidence: number;
  memoryGrowthPercent: number;
};

const SCANNER_PERFORMANCE_TARGETS: ScannerPerformanceTargets = {
  detectorMedianLatencyMs: 80,
  detectorP95LatencyMs: 250,
  ocrMedianLatencyMs: 150,
  ocrP95LatencyMs: 500,
  trackLossRate: 0.05,
  duplicateOcrRate: 0.01,
  falseExactMatches: 0,
  sustainedDetectorFps: 5,
  maxOcrQueueDepth: 6,
  minAverageTrackConfidence: 0.75,
  memoryGrowthPercent: 10,
};

const LATENCY_HISTORY_LIMIT = 300;

function pushBoundedMetricSample(samples: number[], value: number, limit = LATENCY_HISTORY_LIMIT): void {
  samples.push(Math.round(value));
  if (samples.length > limit) {
    samples.splice(0, samples.length - limit);
  }
}

function getPercentile(samples: number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[idx];
}

function getUsedHeapMb(): number | undefined {
  if (typeof performance === 'undefined') return undefined;
  const maybePerformance = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const bytes = maybePerformance.memory?.usedJSHeapSize;
  return typeof bytes === 'number' ? Math.round((bytes / 1024 / 1024) * 10) / 10 : undefined;
}

function downgradeDeviceTier(tier: DeviceTier, levels: number): DeviceTier {
  const tiers: DeviceTier[] = ['A', 'B', 'C', 'D'];
  const currentIndex = Math.max(0, tiers.indexOf(tier));
  return tiers[Math.min(tiers.length - 1, currentIndex + Math.max(0, levels))];
}

function getPerformanceMode(baseTier: DeviceTier, effectiveTier: DeviceTier, adaptationLevel: number): PerformanceMode {
  if (adaptationLevel >= 3 || effectiveTier === 'D') return 'SURVIVAL';
  if (adaptationLevel > 0 || effectiveTier !== baseTier) return 'ADAPTIVE';
  return 'DESKTOP_STANDARD';
}

function getExecutionModeLabel(): string {
  return 'WebGPU -> WASM';
}

function getCameraProfileValues(
  adaptationLevel = 0,
  mobileOptimized = false
): { width: number; height: number; fps: number } {
  if (mobileOptimized) {
    return { width: 1280, height: 720, fps: 24 };
  }

  if (adaptationLevel >= 3) return { width: 1280, height: 720, fps: 24 };
  if (adaptationLevel >= 2) return { width: 1280, height: 720, fps: 30 };
  if (adaptationLevel >= 1) return { width: 1600, height: 900, fps: 30 };
  return { width: 1920, height: 1080, fps: 30 };
}

function getCameraProfileLabel(tier: DeviceTier, adaptationLevel = 0, mobileOptimized = false): string {
  const { width, height, fps } = getCameraProfileValues(adaptationLevel, mobileOptimized);
  return `${width}x${height} @ ${fps} FPS (${mobileOptimized ? 'Phone Tier' : 'Tier'} ${tier})`;
}

function getProcessingProfileLabel(tier: DeviceTier, adaptationLevel = 0): string {
  const maxLongEdge = getProcessingMaxLongEdge(tier, adaptationLevel);
  return `max ${maxLongEdge}px long edge`;
}

function getOcrProfileLabel(tier: DeviceTier, adaptationLevel = 0): string {
  const variants =
    adaptationLevel >= 2 || tier === 'D'
      ? 1
      : tier === 'A'
      ? 6
      : tier === 'B'
      ? 3
      : 2;
  return `${getTierOcrConcurrencyLimit(tier)} job(s), ${variants} variant(s)`;
}

function applyRuntimePerformanceProfile(
  metrics: ScannerRuntimeMetrics,
  baseTier: DeviceTier,
  adaptationLevel = metrics.adaptationLevel,
  reason = metrics.performanceModeReason
): void {
  const boundedLevel = clampNumber(adaptationLevel, 0, 3);
  const effectiveTier = downgradeDeviceTier(baseTier, boundedLevel);
  const mobileOptimized = isMobileScannerDevice();
  metrics.baseDeviceTier = baseTier;
  metrics.deviceTier = effectiveTier;
  metrics.adaptationLevel = boundedLevel;
  metrics.performanceMode = getPerformanceMode(baseTier, effectiveTier, boundedLevel);
  metrics.performanceModeReason = reason;
  metrics.executionMode = getExecutionModeLabel();
  metrics.cameraProfile = getCameraProfileLabel(effectiveTier, boundedLevel, mobileOptimized);
  metrics.processingProfile = getProcessingProfileLabel(effectiveTier, boundedLevel);
  metrics.ocrProfile = getOcrProfileLabel(effectiveTier, boundedLevel);
}

function createEnvironmentStats(): ScannerRuntimeMetrics['environmentStats'] {
  return ENVIRONMENT_CLASSES.reduce((acc, label) => {
    acc[label] = {
      frames: 0,
      detectorLatencyTotalMs: 0,
      detectorLatencySamples: 0,
      ocrLatencyTotalMs: 0,
      ocrLatencySamples: 0,
      cropQualityTotal: 0,
      cropQualitySamples: 0,
    };
    return acc;
  }, {} as ScannerRuntimeMetrics['environmentStats']);
}

function createInitialCameraHealth(): CameraHealthSnapshot {
  return {
    status: 'UNKNOWN',
    score: 0,
    brightness: 0,
    contrast: 0,
    blurScore: 0,
    droppedFrames: 0,
    fps: 0,
    detail: 'waiting for frame sample',
  };
}

function createInitialRuntimeMetrics(deviceTier: DeviceTier = 'B'): ScannerRuntimeMetrics {
  const memoryBaselineMb = getUsedHeapMb();
  const initialEnvironment = createDefaultEnvironmentProfile();
  const mobileOptimized = isMobileScannerDevice();
  const metrics: ScannerRuntimeMetrics = {
    sessionStartedAt: Date.now(),
    detectorLatencyTotalMs: 0,
    detectorLatencySamples: 0,
    detectorLatencyHistoryMs: [],
    ocrLatencyTotalMs: 0,
    ocrLatencySamples: 0,
    ocrLatencyHistoryMs: [],
    trackLifetimeTotalMs: 0,
    completedTrackCount: 0,
    lostTrackObservations: 0,
    reacquiredTrackCount: 0,
    duplicateOcrSkippedCount: 0,
    ocrAttemptCount: 0,
    ocrAcceptedCount: 0,
    ocrSkippedQueuePressureCount: 0,
    consensusAttemptCount: 0,
    falseAlertCount: 0,
    droppedFrameCount: 0,
    cropQualityTotal: 0,
    cropQualitySamples: 0,
    lastOcrQueueDepth: 0,
    maxOcrQueueDepth: 0,
    motionBuckets: {
      NORMAL: 0,
      UNSTABLE: 0,
      COLLECT_ONLY: 0,
      PAUSED: 0,
    },
    baseDeviceTier: deviceTier,
    deviceTier,
    adaptationLevel: 0,
    performanceMode: getPerformanceMode(deviceTier, deviceTier, 0),
    performanceModeReason: 'Desktop baseline profile',
    executionMode: getExecutionModeLabel(),
    cameraProfile: getCameraProfileLabel(deviceTier, 0, mobileOptimized),
    processingProfile: getProcessingProfileLabel(deviceTier, 0),
    ocrProfile: getOcrProfileLabel(deviceTier, 0),
    currentEnvironment: initialEnvironment.label,
    currentEnvironmentConfidence: initialEnvironment.confidence,
    currentEnvironmentSource: initialEnvironment.source,
    currentQuality: 'GOOD',
    currentQualityConfidence: 0,
    currentQualityBackend: 'heuristic',
    environmentDistribution: createEmptyDistribution(ENVIRONMENT_CLASSES),
    qualityDistribution: createEmptyDistribution(PLATE_QUALITY_CLASSES),
    qualityLatencyTotalMs: 0,
    qualityLatencySamples: 0,
    qualityLatencyHistoryMs: [],
    qualityAcceptedCropCount: 0,
    qualityRejectedCropCount: 0,
    qualityOcrAvoidedCount: 0,
    qualityCorrectableRecoveredCount: 0,
    bestFrameReplacementCount: 0,
    tracksWaitingForBetterCrop: 0,
    heuristicQualityUsageCount: 0,
    onnxQualityUsageCount: 0,
    qualityRejectionReasons: {},
    environmentStats: createEnvironmentStats(),
    cameraHealth: createInitialCameraHealth(),
    memoryBaselineMb,
    memoryCurrentMb: memoryBaselineMb,
  };

  applyRuntimePerformanceProfile(metrics, deviceTier, 0, metrics.performanceModeReason);
  return metrics;
}

function createMetricsSnapshot(
  metrics: ScannerRuntimeMetrics,
  tracks: ActiveTrack[]
): ScannerMetricsSnapshot {
  const lostAndVisible = metrics.lostTrackObservations + tracks.length;
  const averageTrackConfidence =
    tracks.length > 0
      ? tracks.reduce((sum, track) => sum + (track.trackConfidence ?? 0), 0) / tracks.length
      : 0;
  const duplicateOcrRate =
    metrics.ocrAttemptCount > 0 ? metrics.duplicateOcrSkippedCount / metrics.ocrAttemptCount : 0;
  const memoryCurrentMb = metrics.memoryCurrentMb ?? getUsedHeapMb();
  const memoryGrowthPercent =
    metrics.memoryBaselineMb && memoryCurrentMb
      ? ((memoryCurrentMb - metrics.memoryBaselineMb) / metrics.memoryBaselineMb) * 100
      : undefined;

  return {
    ...metrics,
    detectorLatencyAvgMs:
      metrics.detectorLatencySamples > 0 ? metrics.detectorLatencyTotalMs / metrics.detectorLatencySamples : 0,
    detectorLatencyMedianMs: getPercentile(metrics.detectorLatencyHistoryMs, 50),
    detectorLatencyP95Ms: getPercentile(metrics.detectorLatencyHistoryMs, 95),
    ocrLatencyAvgMs: metrics.ocrLatencySamples > 0 ? metrics.ocrLatencyTotalMs / metrics.ocrLatencySamples : 0,
    ocrLatencyMedianMs: getPercentile(metrics.ocrLatencyHistoryMs, 50),
    ocrLatencyP95Ms: getPercentile(metrics.ocrLatencyHistoryMs, 95),
    trackLifetimeAvgMs:
      metrics.completedTrackCount > 0 ? metrics.trackLifetimeTotalMs / metrics.completedTrackCount : 0,
    cropQualityAvg:
      metrics.cropQualitySamples > 0 ? metrics.cropQualityTotal / metrics.cropQualitySamples : 0,
    qualityLatencyAvgMs:
      metrics.qualityLatencySamples > 0 ? metrics.qualityLatencyTotalMs / metrics.qualityLatencySamples : 0,
    qualityLatencyP95Ms: getPercentile(metrics.qualityLatencyHistoryMs, 95),
    trackLossRate:
      lostAndVisible > 0 ? metrics.lostTrackObservations / lostAndVisible : 0,
    duplicateOcrRate,
    averageTrackConfidence,
    memoryCurrentMb,
    memoryGrowthPercent,
  };
}

function scoreTarget(value: number, target: number, higherIsBetter = false): number {
  if (target <= 0) return value <= target ? 100 : 0;
  if (higherIsBetter) {
    return Math.round(Math.min(1, value / target) * 100);
  }
  return Math.round(Math.min(1, target / Math.max(value, 1)) * 100);
}

function scoreCeilingTarget(value: number, target: number): number {
  if (value <= target) return 100;
  if (target <= 0) return 0;
  return Math.round(Math.max(0, 100 - ((value - target) / target) * 100));
}

function statusFromScore(score: number): HealthStatus {
  if (score >= 90) return 'OK';
  if (score >= 65) return 'WARN';
  return 'FAIL';
}

function createHealthComponent(
  label: string,
  score: number,
  detail: string,
  status?: HealthStatus
): HealthComponent {
  return {
    label,
    score,
    detail,
    status: status ?? statusFromScore(score),
  };
}

function createSystemHealthSnapshot(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number
): SystemHealthSnapshot {
  const targets = SCANNER_PERFORMANCE_TARGETS;
  const detectorLatencyScore = scoreTarget(snapshot.detectorLatencyP95Ms || snapshot.detectorLatencyAvgMs, targets.detectorP95LatencyMs);
  const detectorFpsScore = scoreTarget(detectorFps, targets.sustainedDetectorFps, true);
  const detectorScore = Math.round((detectorLatencyScore * 0.65) + (detectorFpsScore * 0.35));

  const ocrLatencyScore = snapshot.ocrLatencySamples > 0
    ? scoreTarget(snapshot.ocrLatencyP95Ms || snapshot.ocrLatencyAvgMs, targets.ocrP95LatencyMs)
    : 100;
  const duplicateScore = scoreCeilingTarget(snapshot.duplicateOcrRate, targets.duplicateOcrRate);
  const ocrScore = Math.round(ocrLatencyScore * 0.75 + duplicateScore * 0.25);

  const trackingLossScore = scoreCeilingTarget(snapshot.trackLossRate, targets.trackLossRate);
  const confidenceScore = scoreTarget(snapshot.averageTrackConfidence, targets.minAverageTrackConfidence, true);
  const trackingScore = Math.round(trackingLossScore * 0.55 + confidenceScore * 0.45);

  const queueScore = scoreCeilingTarget(snapshot.lastOcrQueueDepth, targets.maxOcrQueueDepth);
  const cameraScore = snapshot.cameraHealth.status === 'UNKNOWN'
    ? cameraFps > 0 ? Math.min(100, Math.round((cameraFps / 24) * 100)) : 0
    : snapshot.cameraHealth.score;
  const falseAlertScore = snapshot.falseAlertCount <= targets.falseExactMatches ? 100 : 0;
  const memoryScore =
    typeof snapshot.memoryGrowthPercent === 'number'
      ? scoreCeilingTarget(snapshot.memoryGrowthPercent, targets.memoryGrowthPercent)
      : 100;

  const components = [
    createHealthComponent('Detector', detectorScore, `${detectorFps.toFixed(0)} FPS · P95 ${snapshot.detectorLatencyP95Ms.toFixed(0)} ms`),
    createHealthComponent('OCR', ocrScore, `P95 ${snapshot.ocrLatencyP95Ms.toFixed(0)} ms · dup ${(snapshot.duplicateOcrRate * 100).toFixed(1)}%`),
    createHealthComponent('Tracking', trackingScore, `loss ${(snapshot.trackLossRate * 100).toFixed(1)}% · conf ${Math.round(snapshot.averageTrackConfidence * 100)}%`),
    createHealthComponent('Queue', queueScore, `depth ${snapshot.lastOcrQueueDepth} · max ${snapshot.maxOcrQueueDepth}`),
    createHealthComponent(
      'Memory',
      memoryScore,
      typeof snapshot.memoryGrowthPercent === 'number'
        ? `${snapshot.memoryCurrentMb?.toFixed(1) ?? '0.0'} MB · ${snapshot.memoryGrowthPercent.toFixed(1)}%`
        : 'heap unavailable',
      typeof snapshot.memoryGrowthPercent === 'number' ? undefined : 'UNKNOWN'
    ),
    createHealthComponent(
      'Camera',
      cameraScore,
      snapshot.cameraHealth.status === 'UNKNOWN' ? `${cameraFps.toFixed(0)} FPS` : snapshot.cameraHealth.detail,
      snapshot.cameraHealth.status === 'UNKNOWN' ? undefined : snapshot.cameraHealth.status
    ),
    createHealthComponent('Alerts', falseAlertScore, `${snapshot.falseAlertCount} false exact`, falseAlertScore === 100 ? 'OK' : 'FAIL'),
  ];

  const knownComponents = components.filter((component) => component.status !== 'UNKNOWN');
  const overallScore = Math.round(
    knownComponents.reduce((sum, component) => sum + component.score, 0) / Math.max(1, knownComponents.length)
  );

  return { overallScore, components };
}

function getSampleAverage(samples: number[], count: number, offsetFromEnd = 0): number {
  const end = Math.max(0, samples.length - offsetFromEnd);
  const start = Math.max(0, end - count);
  const slice = samples.slice(start, end);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function getRuntimeAdaptationReason(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number
): string | null {
  const detectorTargetMs = getTierDetectorTargetMs(snapshot.deviceTier);
  const recentDetectorAvg = getSampleAverage(snapshot.detectorLatencyHistoryMs, 12);
  const previousDetectorAvg = getSampleAverage(snapshot.detectorLatencyHistoryMs, 12, 12);
  const recentOcrAvg = getSampleAverage(snapshot.ocrLatencyHistoryMs, 8);
  const detectorHasSamples = snapshot.detectorLatencySamples >= 8;
  const ocrHasSamples = snapshot.ocrLatencySamples >= 4;

  if (
    detectorHasSamples &&
    snapshot.detectorLatencyP95Ms > Math.max(SCANNER_PERFORMANCE_TARGETS.detectorP95LatencyMs, detectorTargetMs * 2.2)
  ) {
    return `Detector P95 ${snapshot.detectorLatencyP95Ms.toFixed(0)} ms exceeded Tier ${snapshot.deviceTier} target`;
  }

  if (detectorHasSamples && recentDetectorAvg > detectorTargetMs * 1.8) {
    return `Detector average ${recentDetectorAvg.toFixed(0)} ms is too slow`;
  }

  if (
    snapshot.detectorLatencySamples >= 30 &&
    previousDetectorAvg > 0 &&
    recentDetectorAvg > previousDetectorAvg * 1.35 &&
    recentDetectorAvg > detectorTargetMs * 1.25
  ) {
    return 'Thermal slowdown trend detected';
  }

  if (ocrHasSamples && snapshot.ocrLatencyP95Ms > Math.max(SCANNER_PERFORMANCE_TARGETS.ocrP95LatencyMs, 900)) {
    return `OCR P95 ${snapshot.ocrLatencyP95Ms.toFixed(0)} ms is too slow`;
  }

  if (ocrHasSamples && recentOcrAvg > 700 && snapshot.lastOcrQueueDepth >= 3) {
    return 'OCR queue is backing up';
  }

  if (cameraFps > 0 && cameraFps < 8 && detectorFps < Math.max(2, SCANNER_PERFORMANCE_TARGETS.sustainedDetectorFps * 0.5)) {
    return 'Camera frame rate dropped under load';
  }

  return null;
}

function canRecoverRuntimeProfile(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number
): boolean {
  const detectorTargetMs = getTierDetectorTargetMs(snapshot.deviceTier);
  const recentDetectorAvg = getSampleAverage(snapshot.detectorLatencyHistoryMs, 10);
  const detectorHealthy =
    snapshot.detectorLatencySamples < 8 ||
    (recentDetectorAvg > 0 && recentDetectorAvg < detectorTargetMs * 1.5);
  const cameraHealthy = cameraFps === 0 || cameraFps >= 8;

  return detectorHealthy && cameraHealthy;
}

function classifyDeviceTier(
  benchmark: AdmissionBenchmarkResult | null,
  runtimeState: ANPRRuntimeState
): DeviceTier {
  if (benchmark) {
    if (benchmark.estimatedFps >= 9) return 'A';
    if (benchmark.estimatedFps >= 6.5) return 'B';
    if (benchmark.estimatedFps >= 4) return 'C';
    return 'D';
  }

  if (runtimeState === 'READY_WEBGPU') return 'A';
  if (runtimeState === 'READY_WASM') return 'B';
  if (runtimeState === 'DEGRADED_PERFORMANCE') return 'C';
  return 'D';
}

function getTierDetectorTargetMs(tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return 70;
    case 'B':
      return 115;
    case 'C':
      return 190;
    case 'D':
      return 300;
    default:
      return DETECTION_TARGET_INTERVAL_MS;
  }
}

function getTierDetectorBusyIntervalMs(tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return DETECTION_BUSY_INTERVAL_MS;
    case 'B':
      return 180;
    case 'C':
      return 300;
    case 'D':
      return 480;
    default:
      return DETECTION_BUSY_INTERVAL_MS;
  }
}

function getTierOcrConcurrencyLimit(tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return 6;
    case 'B':
      return 5;
    case 'C':
      return 4;
    default:
      return 3;
  }
}

function isSupportedDesktopScannerBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const isChromeOrEdge = /Chrome|Chromium|Edg/i.test(userAgent) && !/OPR|Firefox|Safari\/.*Version/i.test(userAgent);
  const platform = navigator.platform || '';
  const isDesktopPlatform = /Mac|Win|Linux x86_64|Linux armv8l/i.test(platform);

  return isChromeOrEdge && isDesktopPlatform;
}

function getCameraPerformanceConstraints(
  adaptationLevel = 0,
  mobileOptimized = isMobileScannerDevice()
): MediaTrackConstraints {
  const { width, height, fps } = getCameraProfileValues(adaptationLevel, mobileOptimized);

  return {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: fps, max: 30 },
  };
}

function getActiveCameraCaptureConfig(
  cameraConfig: AdaptiveScannerConfig['camera'],
  adaptationLevel = 0
): AdaptiveScannerConfig['camera'] {
  if (!isMobileScannerDevice()) return cameraConfig;

  const profile = getCameraProfileValues(adaptationLevel, true);
  const fallbackWidth = adaptationLevel >= 2 ? 854 : 960;
  const fallbackHeight = adaptationLevel >= 2 ? 480 : 540;

  return {
    idealWidth: Math.min(cameraConfig.idealWidth, profile.width),
    idealHeight: Math.min(cameraConfig.idealHeight, profile.height),
    idealFps: Math.min(cameraConfig.idealFps, profile.fps),
    fallbackWidth: Math.min(cameraConfig.fallbackWidth, fallbackWidth),
    fallbackHeight: Math.min(cameraConfig.fallbackHeight, fallbackHeight),
  };
}

function getProcessingMaxLongEdge(tier: DeviceTier, adaptationLevel = 0, adaptiveMaxLongEdge?: number): number {
  if (adaptiveMaxLongEdge) {
    // Environment presets must not silently throw away plate pixels on a
    // capable device. Resolution is reduced only after the runtime performance
    // controller records actual overload (adaptationLevel > 0).
    const capableDeviceFloor = adaptationLevel === 0 && (tier === 'A' || tier === 'B') ? 1280 : 720;
    return Math.max(capableDeviceFloor, adaptiveMaxLongEdge);
  }
  if (adaptationLevel >= 3) return 720;
  if (adaptationLevel >= 2) return 800;
  if (adaptationLevel >= 1) return 960;

  if (tier === 'A') return 1600;
  if (tier === 'B') return 1280;
  if (tier === 'C') return 960;
  return 720;
}

function getProcessingDimensions(
  videoWidth: number,
  videoHeight: number,
  tier: DeviceTier,
  adaptationLevel = 0,
  adaptiveMaxLongEdge?: number
): { width: number; height: number } {
  if (videoWidth <= 0 || videoHeight <= 0) return { width: 0, height: 0 };

  const maxLongEdge = getProcessingMaxLongEdge(tier, adaptationLevel, adaptiveMaxLongEdge);
  const longEdge = Math.max(videoWidth, videoHeight);
  const scale = Math.min(1, maxLongEdge / longEdge);

  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

function getTierCropSampleIntervalMs(baseIntervalMs: number, tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return baseIntervalMs;
    case 'B':
      return Math.round(baseIntervalMs * 1.35);
    case 'C':
      return Math.round(baseIntervalMs * 1.9);
    case 'D':
      return Math.round(baseIntervalMs * 2.8);
    default:
      return baseIntervalMs;
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function getScannerCameraSettleMs(mode: ScannerNoticeMode): number {
  if (isMobileScannerDevice()) {
    return mode === 'RELOADING'
      ? MOBILE_SCANNER_CAMERA_RELOAD_SETTLE_MS
      : MOBILE_SCANNER_CAMERA_STARTUP_SETTLE_MS;
  }

  return mode === 'RELOADING' ? SCANNER_CAMERA_RELOAD_SETTLE_MS : SCANNER_CAMERA_STARTUP_SETTLE_MS;
}

function downloadJson(filename: string, payload: unknown): void {
  if (typeof document === 'undefined') return;

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function addEnvironmentDetectorSample(
  metrics: ScannerRuntimeMetrics,
  environment: EnvironmentClass,
  latencyMs: number
): void {
  const stats = metrics.environmentStats[environment];
  if (!stats) return;
  stats.frames++;
  stats.detectorLatencyTotalMs += latencyMs;
  stats.detectorLatencySamples++;
}

function addEnvironmentOcrSample(
  metrics: ScannerRuntimeMetrics,
  environment: EnvironmentClass,
  latencyMs: number,
  cropQuality: number
): void {
  const stats = metrics.environmentStats[environment];
  if (!stats) return;
  stats.ocrLatencyTotalMs += latencyMs;
  stats.ocrLatencySamples++;
  stats.cropQualityTotal += cropQuality;
  stats.cropQualitySamples++;
}

function addQualityAssessmentSample(metrics: ScannerRuntimeMetrics, assessment: PlateQualityAssessment): void {
  metrics.currentQuality = assessment.primaryClass;
  metrics.currentQualityConfidence = assessment.confidence;
  metrics.currentQualityBackend = assessment.backend;
  metrics.qualityDistribution = incrementDistribution(metrics.qualityDistribution, assessment.primaryClass);
  metrics.qualityLatencyTotalMs += assessment.latencyMs;
  metrics.qualityLatencySamples++;
  pushBoundedMetricSample(metrics.qualityLatencyHistoryMs, assessment.latencyMs);

  if (assessment.backend === 'heuristic') {
    metrics.heuristicQualityUsageCount++;
  } else {
    metrics.onnxQualityUsageCount++;
  }

  if (assessment.acceptableForOCR) {
    metrics.qualityAcceptedCropCount++;
  } else {
    metrics.qualityRejectedCropCount++;
    assessment.rejectionReasons.forEach((reason) => {
      metrics.qualityRejectionReasons[reason] = (metrics.qualityRejectionReasons[reason] ?? 0) + 1;
    });
  }
}

function attachQualityAssessmentToTrack(
  track: ActiveTrack,
  assessment: PlateQualityAssessment,
  submittedToOcr: boolean
): void {
  track.qualityClass = assessment.primaryClass;
  track.qualityConfidence = assessment.confidence;
  track.qualityScore = assessment.qualityScore;
  track.qualityBackend = assessment.backend;
  track.qualityAcceptedForOcr = assessment.acceptableForOCR;
  track.qualityRejectionReasons = assessment.rejectionReasons;
  track.qualityCropSize = {
    width: assessment.measurements.cropWidth,
    height: assessment.measurements.cropHeight,
  };
  track.qualitySharpness = assessment.measurements.sharpnessScore;
  track.qualitySelectedPreprocessing = assessment.selectedPreprocessing;
  track.qualitySubmittedToOcr = submittedToOcr;

  if (track.stats) {
    track.stats.bestCropQuality = Math.max(track.stats.bestCropQuality ?? 0, assessment.qualityScore);
    track.stats.lastQualityLatencyMs = Math.round(assessment.latencyMs);
  }
}

function serializeDistributionPercentages<T extends string>(distribution: Record<T, number>): Record<T, number> {
  return getDistributionPercentages(distribution);
}

function canvasToJpegDataUrl(canvas: HTMLCanvasElement, quality = 0.82): string {
  try {
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return '';
  }
}

function cloneCanvasSnapshot(source?: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!source || source.width <= 0 || source.height <= 0) return null;

  const snapshot = document.createElement('canvas');
  snapshot.width = source.width;
  snapshot.height = source.height;
  const ctx = snapshot.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    releaseCanvasMemory(snapshot);
    return null;
  }

  try {
    ctx.drawImage(source, 0, 0);
    return snapshot;
  } catch {
    releaseCanvasMemory(snapshot);
    return null;
  }
}

function rememberTrackPlateSnapshot(
  track: ActiveTrack,
  cropCanvas: HTMLCanvasElement,
  qualityScore: number,
  ocrText: string,
  ocrConfidence: number
): string {
  const dataUrl = canvasToJpegDataUrl(cropCanvas, 0.82);
  if (!dataUrl) return track.cropSamples.find((sample) => sample.dataUrl)?.dataUrl || '';

  track.cropSamples.unshift({
    dataUrl,
    qualityScore,
    timestamp: Date.now(),
    ocrText,
    ocrConfidence,
  });
  track.cropSamples = track.cropSamples.slice(0, 3);

  return dataUrl;
}



const RECENT_DETECTIONS_STORAGE_KEY = 'track_recent_live_detections';
const DETECTION_TARGET_INTERVAL_MS = 70;
const DETECTION_BUSY_INTERVAL_MS = 110;
const DETECTION_MIN_DELAY_MS = 16;
const DETECTOR_VALIDATION_INTERVAL_MS = 2000;
const CROP_SAMPLE_FAST_MS = 90;
const CROP_SAMPLE_NORMAL_MS = 160;
const OCR_FIRST_READ_RETRY_MS = 80;
const OCR_REPEAT_READ_RETRY_MS = 180;
const OCR_MIN_TRACK_FRAMES = 1;
const OCR_MIN_BUFFERED_CROPS = 1;
const OCR_FIRST_READ_MIN_TRACK_CONFIDENCE = 0.30;
const OCR_MIN_TRACK_CONFIDENCE = 0.50;
const OCR_FAST_FIRST_READ_MIN_DETECTOR_CONFIDENCE = 0.25;
const OCR_DEFAULT_MIN_READABLE_WIDTH = 18;
const OCR_MAX_BEST_CROP_AGE_MS = 1100;
const OCR_FIRST_READ_MIN_QUALITY = 0.20;
const OCR_REPEAT_READ_MIN_QUALITY = 0.18;
const OCR_MAX_CONCURRENCY = 6;
// Lost overlays expire promptly, but captured OCR evidence remains eligible
// for a bounded follow-up read after a fast pan/drive-by.
const OCR_RECENT_LOST_RESULT_GRACE_MS = 3500;
// A plate that was only visible for 1 frame must have enough grace time for
// OCR to complete in the background after the plate leaves the camera.
const OCR_RECENT_LOST_FIRST_READ_GRACE_MS = 5000;
const OCR_MOVING_FIRST_CROP_MAX_AGE_MS = 850;
const OCR_MOVING_REPEAT_CROP_MAX_AGE_MS = 620;
const SAMPLE_VIDEO_LOOP_RESET_THRESHOLD_SECONDS = 0.35;
const SAMPLE_VIDEO_END_HOLD_MS = 3000;
const SAMPLE_VIDEO_END_SETTLE_MAX_MS = 15000;
// A single clean read at this confidence is sufficient for immediate commit.
const OCR_SINGLE_READ_COMMIT_MIN_CONFIDENCE = 0.85;
const OCR_SINGLE_READ_COMMIT_MIN_SCORE = 0.68;
// Fast-path instant commit: the FIRST (ORIGINAL) crop at this threshold exits
// the crop loop immediately without running enhancement passes.
const OCR_INSTANT_COMMIT_CONFIDENCE = 0.85;
const OCR_FINAL_LOCK_MIN_CONFIDENCE = 0.95;
const OCR_DB_EXACT_LOCK_MIN_CONFIDENCE = 0.58;
const OCR_DB_POSSIBLE_LOCK_MIN_CONFIDENCE = 0.56;
const OCR_NO_MATCH_COMMIT_MIN_CONFIDENCE = 0.50;
const OCR_DESKEW_MIN_ANGLE_RAD = 0.055;
const MOTION_NORMAL_MAX = 0.15;
const MOTION_UNSTABLE_MAX = 0.30;
const MOTION_COLLECT_ONLY_MAX = 0.50;
const OVERLAY_ANGLE_SAMPLE_MS = 140;
const MAX_OVERLAY_TILT_RAD = 0.35;
const SCANNER_MAINTENANCE_INTERVAL_MS = 1000;
const COOLDOWN_MAP_MAX_ENTRIES = 120;
const PERFORMANCE_ADAPTATION_CHECK_MS = 5000;
const PERFORMANCE_ADAPTATION_COOLDOWN_MS = 20000;
const PERFORMANCE_RECOVERY_COOLDOWN_MS = 8000;
const CAMERA_CONSTRAINT_APPLY_COOLDOWN_MS = 10000;
const ENVIRONMENT_SAMPLE_INTERVAL_MS = 1200;
const DATASET_SAMPLE_LIMIT = 20;
const MOBILE_SCANNER_PREVENTIVE_REFRESH_MS = 20 * 60 * 1000;
const MOBILE_SCANNER_RELOAD_MIN_UPTIME_MS = 90 * 1000;
const MOBILE_SCANNER_RELOAD_COOLDOWN_MS = 2 * 60 * 1000;
const MOBILE_SCANNER_RELOAD_NOTICE_MS = 3500;
const MOBILE_SCANNER_ISSUE_CONFIRM_MS = 12 * 1000;
const MOBILE_SCANNER_STREAM_CONFIRM_MS = 2500;
const MOBILE_SCANNER_STREAM_COOLDOWN_MS = 15000;
const MOBILE_SCANNER_LOW_FPS_THRESHOLD = 7;
const MOBILE_SCANNER_MEMORY_GROWTH_PERCENT = 18;
const MOBILE_SCANNER_OCR_QUEUE_DEPTH = 6;
const SCANNER_CAMERA_STARTUP_SETTLE_MS = 900;
const SCANNER_CAMERA_RELOAD_SETTLE_MS = 1200;
const MOBILE_SCANNER_CAMERA_STARTUP_SETTLE_MS = 1800;
const MOBILE_SCANNER_CAMERA_RELOAD_SETTLE_MS = 2200;
const SCANNER_UI_FLUSH_INTERVAL_MS = 500;

type MotionOcrMode = MotionBucket;
type OcrQueuePressure = 'EMPTY' | 'MODERATE' | 'LARGE' | 'CRITICAL';

function getTrackColor(track: ActiveTrack): string {
  if (track.matchType === 'EXACT') return '#ef4444';
  if (track.matchType === 'POSSIBLE') return '#f59e0b';
  if (track.matchType === 'NONE') return '#06b6d4';
  if (track.ocrState === 'COOLDOWN') return '#64748b';
  return '#06b6d4';
}

function getTrackStatusLabel(track: ActiveTrack): string {
  if (track.matchType === 'EXACT') return 'MATCH';
  if (track.matchType === 'POSSIBLE') return 'POSSIBLE';
  if (track.matchType === 'NONE') return 'NO CASE';

  switch (track.ocrState) {
    case 'DETECTED':
      return 'DETECTED';
    case 'COLLECTING':
      return 'COLLECTING';
    case 'OCR_RUNNING':
      return 'READING';
    case 'CONSENSUS_BUILDING':
      return 'ANALYSING';
    case 'DB_CHECKING':
      return 'CHECKING';
    case 'COOLDOWN':
      return 'COOLDOWN';
    default:
      return 'SCANNING';
  }
}

function getTrackSeenPlateTone(track: ActiveTrack): SeenPlateTone {
  if (track.matchType === 'EXACT') return 'EXACT';
  if (track.matchType === 'POSSIBLE') return 'POSSIBLE';
  if (track.matchType === 'NONE') return 'NONE';
  if (track.ocrState === 'DB_CHECKING') return 'CHECKING';
  if (track.ocrState === 'OCR_RUNNING' || track.pipelineState === 'READING') return 'READING';
  if (getTrackVoteCount(track) > 0 || track.stabilizedPlate) return 'CHECKING';
  return 'READING';
}

function getDetectionSeenPlateTone(detection: SessionDetection): SeenPlateTone {
  if (detection.matchType === 'EXACT' || detection.matched) return 'EXACT';
  if (detection.matchType === 'POSSIBLE') return 'POSSIBLE';
  return 'NONE';
}

function isUnreviewedAlertDetection(detection?: SessionDetection | null): boolean {
  return Boolean(
    detection &&
      (detection.matchType === 'EXACT' || detection.matched) &&
      detection.vehicleId &&
      detection.actionStatus !== 'REVIEWED'
  );
}

function getSeenPlateStatusLabel(tone: SeenPlateTone, language: string): string {
  const isBm = language === 'BM';
  if (tone === 'EXACT') return isBm ? 'Padan' : 'Match';
  if (tone === 'POSSIBLE') return isBm ? 'Semak' : 'Review';
  if (tone === 'NONE') return isBm ? 'Tiada' : 'None';
  if (tone === 'CHECKING') return isBm ? 'Semak DB' : 'DB Check';
  return isBm ? 'Membaca' : 'Reading';
}

function getSampleDetectionTiming(detection: SessionDetection, language: string): string | undefined {
  if (detection.detectionLatencyMs === undefined || detection.readLatencyMs === undefined) {
    return undefined;
  }

  const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  const detected = formatMs(detection.detectionLatencyMs);
  const read = formatMs(detection.readLatencyMs);
  const elapsed = formatMs(detection.processingDurationMs ?? (detection.detectionLatencyMs + detection.readLatencyMs));
  return language === 'BM'
    ? `Dikesan ${detected} · Dibaca ${read} · Total ${elapsed}`
    : `Detected ${detected} · Read ${read} · Total ${elapsed}`;
}

function getSeenPlateBorderClass(tone: SeenPlateTone): string {
  if (tone === 'EXACT') return 'border-red-800/70 bg-red-950/25';
  if (tone === 'POSSIBLE') return 'border-amber-800/70 bg-amber-950/20';
  if (tone === 'NONE') return 'border-slate-800 bg-slate-900/80';
  if (tone === 'CHECKING') return 'border-cyan-800 bg-cyan-950/25';
  return 'border-slate-800 bg-slate-950/80';
}

function getSeenPlateBadgeClass(tone: SeenPlateTone): string {
  if (tone === 'EXACT') return 'bg-red-600 text-white';
  if (tone === 'POSSIBLE') return 'bg-amber-500 text-slate-950';
  if (tone === 'NONE') return 'bg-slate-800/90 text-slate-300';
  if (tone === 'CHECKING') return 'border border-cyan-700 bg-cyan-950 text-cyan-200';
  return 'border border-slate-700 bg-slate-950 text-slate-300';
}

function getTrackDisplayConfidencePercent(track: ActiveTrack): number {
  if (track.stabilizedConfidence !== undefined) {
    return Math.round(clampNumber(track.stabilizedConfidence, 0, 1) * 100);
  }

  let topAverageConfidence = 0;
  track.votes?.forEach((vote) => {
    if (vote.count > 0) {
      topAverageConfidence = Math.max(topAverageConfidence, vote.totalConfidence / vote.count);
    }
  });

  const confidence = Math.max(
    topAverageConfidence,
    track.qualityScore ?? 0,
    track.trackConfidence ?? 0,
    track.bbox.confidence ?? 0
  );

  return Math.round(clampNumber(confidence, 0, 1) * 100);
}

function getTrackPlateText(track: ActiveTrack): string {
  if (track.committedPlate && track.labelLocked) return track.committedPlate;
  if (track.stabilizedPlate) return track.stabilizedPlate;
  return getTrackBestObservedPlate(track);
}

function getTrackBestObservedPlate(track: ActiveTrack): string {
  if (track.stabilizedPlate) return track.stabilizedPlate;
  const consensus = evaluateConsensus(track, 1, 0.50);
  if (consensus.normalizedPlate) return consensus.normalizedPlate;

  const candidates = Array.from(track.votes.entries())
    .map(([plate, vote]) => {
      const normalized = cleanPlateNumber(plate);
      const pattern = validateMalaysianPattern(normalized);
      return {
        normalized,
        count: vote.count,
        averageConfidence: vote.count > 0 ? vote.totalConfidence / vote.count : 0,
        pattern,
      };
    })
    .filter(({ normalized, pattern }) =>
      normalized.length >= 4 &&
      /[A-Z]/.test(normalized) &&
      /[0-9]/.test(normalized) &&
      (pattern.isValid || pattern.score >= 0.55)
    )
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      const confidenceDifference = right.averageConfidence - left.averageConfidence;
      if (Math.abs(confidenceDifference) > 0.025) return confidenceDifference;
      const patternDifference = right.pattern.score - left.pattern.score;
      if (Math.abs(patternDifference) > 0.025) return patternDifference;
      return right.normalized.length - left.normalized.length;
    });

  return candidates[0]?.normalized || '';
}

function isRuntimeScanningReady(state: ANPRRuntimeState): boolean {
  return state === 'READY_WEBGPU' || state === 'READY_WASM' || state === 'DEGRADED_PERFORMANCE';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampPercentToThreshold(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clampNumber(value / 100, min, max);
}

function getPlateEditDistance(leftValue: string, rightValue: string): number {
  const left = cleanPlateNumber(leftValue);
  const right = cleanPlateNumber(rightValue);
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }

  return previous[right.length];
}

function isSamePhysicalPlateReading(left: string, right: string): boolean {
  const normalizedLeft = cleanPlateNumber(left);
  const normalizedRight = cleanPlateNumber(right);
  if (normalizedLeft === normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight) return false;
  if (arePlatesSameVehicleFamily(normalizedLeft, normalizedRight)) return true;
  if (Math.min(normalizedLeft.length, normalizedRight.length) < 4) return false;
  if (Math.abs(normalizedLeft.length - normalizedRight.length) > 2) return false;
  return getPlateEditDistance(normalizedLeft, normalizedRight) <= 2;
}

function isSubsequencePlateReading(shorter: string, longer: string): boolean {
  const normShorter = cleanPlateNumber(shorter);
  const normLonger = cleanPlateNumber(longer);
  if (!normShorter || !normLonger || normShorter.length >= normLonger.length) return false;
  let si = 0;
  for (let li = 0; li < normLonger.length && si < normShorter.length; li++) {
    if (normLonger[li] === normShorter[si]) si++;
  }
  return si === normShorter.length;
}

function getExpectedMinPlateChars(crop: HTMLCanvasElement): number {
  const aspect = crop.width / Math.max(1, crop.height);
  if (aspect >= 3.0) return 4;
  if (aspect >= 2.3) return 4;
  return 2;
}

function countPlateChars(text: string): { letters: number; digits: number } {
  return {
    letters: (text.match(/[A-Z]/g) || []).length,
    digits: (text.match(/[0-9]/g) || []).length,
  };
}

function hasStrongShortPlateEvidence(confidence: number, score: number, voteCount: number): boolean {
  return voteCount >= 4 && confidence >= 0.92 && score >= 0.80;
}

function isPlausiblePlateCandidate(text: string, expectedMinChars: number, patternScore: number): boolean {
  if (!text || text.length < 2) return false;

  const { letters, digits } = countPlateChars(text);
  if (letters === 0 || digits === 0) return false;

  const pattern = validateMalaysianPattern(text);
  if (text.length > 9 && pattern.category !== 'SPECIAL_SERIES' && pattern.category !== 'PUTRAJAYA') return false;

  const highValueShortPlate = text.length <= 3 && pattern.isValid && pattern.score >= 0.70;
  if (highValueShortPlate) return true;

  const hasEnoughLength = text.length >= expectedMinChars || (text.length >= 3 && Math.max(patternScore, pattern.score) >= 0.85);
  if (!hasEnoughLength) return false;

  if (/^([A-Z0-9]{2,4})\1$/.test(text)) return false;

  return true;
}

function canCommitFinalPlateOutcome(text: string, voteCount: number = 1): boolean {
  const pattern = validateMalaysianPattern(text);
  const { letters, digits } = countPlateChars(text);

  if (!pattern.isValid || pattern.score < 0.55) return false;
  if (letters === 0 || digits === 0) return false;
  if (voteCount < 2 && !isCompleteSingleReadCandidate(text, pattern, voteCount)) return false;

  return true;
}

function canCommitNoMatchOutcome(text: string, confidence: number, score: number, _voteCount: number): boolean {
  const pattern = validateMalaysianPattern(text);
  const { letters, digits } = countPlateChars(text);

  if (text.length < 2 || letters === 0 || digits === 0) return false;
  if (!pattern.isValid) return false;
  if (Math.max(confidence, score) < OCR_NO_MATCH_COMMIT_MIN_CONFIDENCE) return false;

  return true;
}

function isCompleteNoMatchCandidate(
  text: string,
  pattern: ReturnType<typeof validateMalaysianPattern>,
  _confidence: number,
  _score: number,
  _voteCount: number
): boolean {
  const { letters, digits } = countPlateChars(text);
  if (!pattern.isValid || letters === 0 || digits === 0 || text.length < 2) return false;
  if (pattern.category === 'UNKNOWN_VALID_CANDIDATE') return false;
  return true;
}

function isCompleteSingleReadCandidate(
  text: string,
  pattern: ReturnType<typeof validateMalaysianPattern>,
  voteCount: number = 1
): boolean {
  const { letters, digits } = countPlateChars(text);
  const category = pattern.category;
  const patternId = pattern.pattern?.id ?? '';

  if (letters === 0 || digits === 0) return false;
  if (text.length < 2) return false;
  if (text.length > 10 && pattern.score < 0.80) return false;
  if (text.length <= 3) return pattern.isValid && pattern.score >= 0.70;

  if (category === 'STANDARD') {
    return digits >= 1 && digits <= 4;
  }

  if (category === 'LETTER_NUMBER_SUFFIX') {
    return pattern.hasTrailingSuffix && digits >= 2;
  }

  if (category === 'LANGKAWI' || category === 'SABAH' || category === 'SARAWAK') {
    if (pattern.hasTrailingSuffix) return digits >= 2;
    return digits >= 4 || text.length >= 6;
  }

  if (category === 'EV_SPECIAL') {
    return digits >= 3 || text.length <= 4;
  }

  if (category === 'DIPLOMATIC') {
    return text.length >= 5 && digits >= 2;
  }

  if (category === 'GOVERNMENT' || category === 'SPECIAL_SERIES') {
    return digits >= 3 || pattern.score >= 0.82;
  }

  if (patternId === 'GENERIC_MALAYSIAN') return false;

  return true;
}

function canCommitSingleReadOutcome(
  text: string,
  confidence: number,
  score: number,
  isSampleVideo = false
): boolean {
  const pattern = validateMalaysianPattern(text);

  if (!pattern.isValid || pattern.score < 0.58) return false;
  if (!isCompleteSingleReadCandidate(text, pattern, 1)) return false;

  // A single observation with valid Malaysian pattern clears the instant-read threshold.
  const minConfidence = 0.80;
  const minScore = 0.58;
  return confidence >= minConfidence && score >= minScore;
}

function getDatabaseFinalLockMinConfidence(
  resolvedMatchType: 'EXACT' | 'POSSIBLE' | 'NONE',
  commitNoCase: boolean,
  recognitionThreshold: number
): number {
  if (resolvedMatchType === 'EXACT') {
    // Exact normalized equality with an active repository record is stronger
    // evidence than a free-form OCR result. Do not let the general OCR setting
    // prevent that lookup after the exact-match gate has already passed.
    return OCR_DB_EXACT_LOCK_MIN_CONFIDENCE;
  }
  if (resolvedMatchType === 'POSSIBLE') {
    return Math.max(OCR_DB_POSSIBLE_LOCK_MIN_CONFIDENCE, Math.min(recognitionThreshold, 0.62));
  }
  if (resolvedMatchType === 'NONE' && commitNoCase) {
    return OCR_NO_MATCH_COMMIT_MIN_CONFIDENCE;
  }

  return OCR_FINAL_LOCK_MIN_CONFIDENCE;
}

function getTrackVoteCount(track: ActiveTrack): number {
  return Array.from(track.votes.values()).reduce((sum, vote) => sum + vote.count, 0);
}

/**
 * A track is "available for reading" (crop sampling) when the plate is
 * physically present in the current frame OR was lost very recently with
 * evidence still pending (within 300 ms). This ensures a plate seen for
 * only one frame still gets its crop captured before the track expires.
 */
function isTrackAvailableForReading(track: ActiveTrack): boolean {
  // Plate is live right now — always sample.
  if (track.trackState === 'VISIBLE' && track.visibleThisFrame !== false && (track.missedFrames ?? 0) === 0) return true;
  // Plate just left (≤300 ms ago) and we haven't captured evidence yet —
  // let the crop loop run once more so the already-drawn frame is preserved.
  const recentlyLost = track.trackState === 'LOST' && track.ocrEvidencePending === false &&
    (Date.now() - (track.lastSeenTimestamp || 0)) <= 300;
  return recentlyLost;
}

function isOcrResultStillUseful(track: ActiveTrack, now: number = Date.now(), cropCapturedAt?: number): boolean {
  if (track.trackState === 'REMOVED' || track.cooldownActive) return false;
  // visibleThisFrame check — current detection loop iteration.
  if (track.visibleThisFrame === true) return true;

  const lostAgeMs = now - (track.lastSeenTimestamp || 0);
  const cropAgeMs = cropCapturedAt ? now - cropCapturedAt : lostAgeMs;
  const allowedGraceMs =
    track.ocrRunning ? 5000 : track.ocrEvidencePending
      ? OCR_RECENT_LOST_FIRST_READ_GRACE_MS
      : getTrackVoteCount(track) === 0
      ? OCR_RECENT_LOST_FIRST_READ_GRACE_MS
      : OCR_RECENT_LOST_RESULT_GRACE_MS;

  return lostAgeMs <= allowedGraceMs && cropAgeMs <= allowedGraceMs;
}

function isTrackDrawable(
  track: ActiveTrack,
  preserveEndedSampleFrame = false,
  displayedMediaTimeSeconds?: number
): boolean {
  if (track.trackState === 'REMOVED') return false;
  if (
    Number.isFinite(displayedMediaTimeSeconds) &&
    Number.isFinite(track.lastSeenMediaTimeSeconds) &&
    displayedMediaTimeSeconds! - track.lastSeenMediaTimeSeconds! > 0.85
  ) return false;

  if (preserveEndedSampleFrame) {
    const frameAgeMs = Date.now() - (track.lastRealDetectionTimestamp || track.lastSeenTimestamp);
    return (track.trackState === 'VISIBLE' || track.trackState === 'LOST') && frameAgeMs <= SAMPLE_VIDEO_END_HOLD_MS + 500;
  }

  // Filter out non-plate geometry (plants, square windows, fences, tall objects)
  const box = track.bbox;
  if (box) {
    const ar = box.width / Math.max(1, box.height);
    if (ar < 1.15 || ar > 6.8) return false;
    if (box.width < 18 || box.height < 6) return false;
  }

  // Eliminate unconfirmed 1-frame false positives (e.g. noise on bushes, car roofs)
  if (track.framesSeen <= 1 && !track.isConfirmed && !track.stabilizedPlate && !track.committedPlate && (track.trackConfidence ?? 0) < 0.40) {
    return false;
  }

  // Strict visual detection lifetime:
  // Cyan bounding box represents ONLY verified recent visual detections, not background OCR lifetime.
  const now = Date.now();
  const overlayAgeMs = track.overlayAgeMs !== undefined
    ? track.overlayAgeMs
    : now - (track.lastRealDetectionTimestamp || track.lastSeenTimestamp || now);

  if (track.trackState === 'LOST' || overlayAgeMs > 200) {
    return false;
  }
  const consecutiveMisses = track.missedFrames ?? 0;
  if (consecutiveMisses > 1) return false;

  return track.trackState === 'VISIBLE';
}

function getMotionOcrMode(track: ActiveTrack): MotionOcrMode {
  const score = track.motionScore ?? 0;
  if (score < MOTION_NORMAL_MAX) return 'NORMAL';
  if (score < MOTION_UNSTABLE_MAX) return 'UNSTABLE';
  if (score < MOTION_COLLECT_ONLY_MAX) return 'COLLECT_ONLY';
  return 'PAUSED';
}

function isFastFirstReadCandidate(track: ActiveTrack, voteCount: number = getTrackVoteCount(track)): boolean {
  if (voteCount > 0 || track.cooldownActive || track.ocrRunning || track.ocrJobQueued) return false;

  return (track.bbox.confidence ?? 0) >= OCR_FAST_FIRST_READ_MIN_DETECTOR_CONFIDENCE;
}

function canAttemptOcrForMotion(track: ActiveTrack, mode: MotionOcrMode): boolean {
  if (isFastFirstReadCandidate(track)) return true;
  if (mode === 'NORMAL') return true;
  if (mode === 'UNSTABLE') return getTrackVoteCount(track) === 0 || track.framesSeen % 2 === 0;
  if (mode === 'COLLECT_ONLY') {
    return getTrackVoteCount(track) === 0 && (track.bbox.confidence >= 0.55 || track.framesSeen >= OCR_MIN_TRACK_FRAMES);
  }
  return getTrackVoteCount(track) === 0 && track.bbox.confidence >= 0.65;
}

function getOcrQueuePressure(
  queueDepth: number,
  activeJobs: number,
  maxConcurrency: number
): OcrQueuePressure {
  if (queueDepth === 0) return 'EMPTY';
  if (activeJobs >= maxConcurrency && queueDepth >= maxConcurrency * 2) return 'CRITICAL';
  if (queueDepth > maxConcurrency * 2) return 'LARGE';
  if (queueDepth > maxConcurrency) return 'MODERATE';
  return 'EMPTY';
}

function shouldSkipTrackForOcrPressure(
  track: ActiveTrack,
  pressure: OcrQueuePressure,
  priorityIndex: number,
  maxConcurrency: number,
  qualityScore: number
): boolean {
  if (pressure === 'EMPTY') return false;
  const voteCount = getTrackVoteCount(track);
  const timeSinceAttempt = track.lastOcrAttemptAt ? Date.now() - track.lastOcrAttemptAt : Number.POSITIVE_INFINITY;
  const needsFirstRead = voteCount === 0;
  const starving = timeSinceAttempt > 1400;

  if (needsFirstRead && qualityScore >= 0.30 && (track.trackConfidence ?? 0) >= OCR_FIRST_READ_MIN_TRACK_CONFIDENCE) {
    return false;
  }

  if (pressure === 'MODERATE') return !starving && track.framesSeen % 2 !== 0;
  if (pressure === 'LARGE') {
    return priorityIndex >= maxConcurrency * 2 || (track.trackConfidence ?? 0) < 0.78 || qualityScore < 0.36;
  }

  return priorityIndex >= Math.max(1, maxConcurrency) || (track.trackConfidence ?? 0) < 0.86 || qualityScore < 0.48;
}

function getMotionAwareDetectorTargetMs(
  adaptiveConfig: AdaptiveScannerConfig,
  tier: DeviceTier,
  tracks: ActiveTrack[]
): number {
  const tierTarget = getTierDetectorTargetMs(tier);
  const peakMotion = tracks.reduce((max, track) => Math.max(max, track.motionScore ?? 0), 0);
  const movingEnvironment = adaptiveConfig.environment.label === 'HIGHWAY' || adaptiveConfig.environment.label === 'TRAFFIC';

  const parkedEnvironment = adaptiveConfig.environment.label === 'PARKING';

  if (movingEnvironment || peakMotion >= MOTION_UNSTABLE_MAX) {
    return Math.max(DETECTION_MIN_DELAY_MS, Math.min(adaptiveConfig.detector.targetIntervalMs, Math.round(tierTarget * 0.72)));
  }

  if (peakMotion >= MOTION_NORMAL_MAX) {
    return Math.max(DETECTION_MIN_DELAY_MS, Math.min(tierTarget, adaptiveConfig.detector.targetIntervalMs));
  }

  if (parkedEnvironment && tracks.length > 0) {
    return Math.max(adaptiveConfig.detector.targetIntervalMs, Math.round(tierTarget * 1.25));
  }

  return Math.max(adaptiveConfig.detector.targetIntervalMs, tierTarget);
}

function getMotionAwareCropSampleIntervalMs(
  track: ActiveTrack,
  baseIntervalMs: number,
  adaptiveConfig: AdaptiveScannerConfig
): number {
  const motion = track.motionScore ?? 0;
  const movingEnvironment = adaptiveConfig.environment.label === 'HIGHWAY' || adaptiveConfig.environment.label === 'TRAFFIC';
  const multiplier = movingEnvironment || motion >= MOTION_UNSTABLE_MAX
    ? 0.45
    : motion >= MOTION_NORMAL_MAX
      ? 0.65
      : 1;

  return Math.max(35, Math.round(baseIntervalMs * adaptiveConfig.buffer.cropSampleIntervalMultiplier * multiplier));
}

function getTrackReadableCropAgeLimitMs(
  track: ActiveTrack,
  adaptiveConfig: AdaptiveScannerConfig,
  voteCount: number
): number {
  const configuredMaxAge = Math.min(
    OCR_MAX_BEST_CROP_AGE_MS,
    Math.max(250, adaptiveConfig.ocr.maxBestCropAgeMs)
  );
  const motion = track.motionScore ?? 0;
  const movingEnvironment = adaptiveConfig.environment.label === 'HIGHWAY' || adaptiveConfig.environment.label === 'TRAFFIC';

  // A first-read crop was captured while the plate was visible. It remains
  // legitimate evidence after visual tracking expires and must get one queue
  // opportunity instead of being discarded as an old video frame.
  // Use the full first-read grace window (5 s) so fast pans and drive-bys
  // don't have their crops rejected as stale before OCR completes.
  if (!isTrackAvailableForReading(track) && track.ocrEvidencePending) {
    return 5000;
  }

  if (movingEnvironment || motion >= MOTION_UNSTABLE_MAX) {
    return Math.min(configuredMaxAge, voteCount === 0 ? OCR_MOVING_FIRST_CROP_MAX_AGE_MS : OCR_MOVING_REPEAT_CROP_MAX_AGE_MS);
  }

  if (motion >= MOTION_NORMAL_MAX) {
    return Math.min(configuredMaxAge, voteCount === 0 ? 950 : 760);
  }

  return configuredMaxAge;
}

function pruneCooldownMap(cooldowns: Map<string, number>, cooldownMs: number, now: number): void {
  const maxAgeMs = Math.max(cooldownMs * 2, 30000);
  for (const [plate, timestamp] of cooldowns.entries()) {
    if (now - timestamp > maxAgeMs) {
      cooldowns.delete(plate);
    }
  }

  if (cooldowns.size <= COOLDOWN_MAP_MAX_ENTRIES) return;

  const entries = Array.from(cooldowns.entries()).sort((a, b) => b[1] - a[1]);
  cooldowns.clear();
  entries.slice(0, COOLDOWN_MAP_MAX_ENTRIES).forEach(([plate, timestamp]) => {
    cooldowns.set(plate, timestamp);
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }

  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function estimatePlateOverlayAngle(
  sourceCanvas: HTMLCanvasElement,
  bbox: { x: number; y: number; width: number; height: number },
  previousAngle = 0
): number {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const x = clampNumber(Math.round(bbox.x), 0, Math.max(0, sourceWidth - 1));
  const y = clampNumber(Math.round(bbox.y), 0, Math.max(0, sourceHeight - 1));
  const width = clampNumber(Math.round(bbox.width), 1, sourceWidth - x);
  const height = clampNumber(Math.round(bbox.height), 1, sourceHeight - y);

  if (width < 30 || height < 10) return previousAngle;

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return previousAngle;

  try {
    const image = ctx.getImageData(x, y, width, height);
    const { data } = image;
    const step = Math.max(1, Math.floor(Math.max(width, height) / 90));
    let weightSum = 0;
    let meanX = 0;
    let meanY = 0;

    const lumaAt = (px: number, py: number) => {
      const idx = (py * width + px) * 4;
      return data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
    };

    for (let py = step; py < height - step; py += step) {
      for (let px = step; px < width - step; px += step) {
        const gx = Math.abs(lumaAt(px + step, py) - lumaAt(px - step, py));
        const gy = Math.abs(lumaAt(px, py + step) - lumaAt(px, py - step));
        const edge = gx + gy;
        if (edge < 28) continue;
        weightSum += edge;
        meanX += px * edge;
        meanY += py * edge;
      }
    }

    if (weightSum < 1) return previousAngle;

    meanX /= weightSum;
    meanY /= weightSum;

    let covXX = 0;
    let covXY = 0;
    let covYY = 0;

    for (let py = step; py < height - step; py += step) {
      for (let px = step; px < width - step; px += step) {
        const gx = Math.abs(lumaAt(px + step, py) - lumaAt(px - step, py));
        const gy = Math.abs(lumaAt(px, py + step) - lumaAt(px, py - step));
        const edge = gx + gy;
        if (edge < 28) continue;
        const dx = px - meanX;
        const dy = py - meanY;
        covXX += dx * dx * edge;
        covXY += dx * dy * edge;
        covYY += dy * dy * edge;
      }
    }

    let angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    if (Math.abs(angle) > MAX_OVERLAY_TILT_RAD) angle = previousAngle;

    return previousAngle * 0.6 + angle * 0.4;
  } catch {
    return previousAngle;
  }
}

function getCameraPreflightError(): string | null {
  if (typeof window === 'undefined') return null;

  if (!window.isSecureContext) {
    return `Camera access is blocked on this address (${window.location.host}). Open the scanner over HTTPS, or use localhost.`;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not expose camera access. Open the scanner in the latest Chrome or Edge on Windows/macOS and allow camera permission.';
  }

  return null;
}

function canRunMultiCameraOnCurrentDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const phoneLikeUserAgent = /Mobi|Android|iPhone|iPod|Windows Phone/i.test(userAgent);
  const narrowViewport = window.matchMedia('(max-width: 767px)').matches;

  return !phoneLikeUserAgent && !narrowViewport;
}

function getSelectableCameraDeviceCount(devices: DesktopCameraDevice[]): number {
  const deviceIds = new Set(devices.map((device) => device.deviceId).filter(Boolean));
  return deviceIds.size;
}

function getUnusedCameraDeviceId(devices: DesktopCameraDevice[], slots: CameraSlot[]): string {
  const usedDeviceIds = new Set(slots.map((slot) => slot.deviceId).filter(Boolean));
  return devices.find((device) => device.deviceId && !usedDeviceIds.has(device.deviceId))?.deviceId || '';
}

function resolveUniqueCameraSlots(slots: CameraSlot[], devices: DesktopCameraDevice[]): CameraSlot[] {
  const usedDeviceIds = new Set<string>();

  return slots.map((slot, index) => {
    let deviceId = slot.deviceId;
    if (!deviceId || usedDeviceIds.has(deviceId)) {
      deviceId =
        devices.find((device) => device.deviceId && !usedDeviceIds.has(device.deviceId))?.deviceId ||
        devices[index]?.deviceId ||
        deviceId ||
        '';
    }

    if (deviceId) usedDeviceIds.add(deviceId);
    return { ...slot, deviceId };
  });
}

function isMobileScannerDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const phoneLikeUserAgent = /Mobi|Android|iPhone|iPod|iPad|Windows Phone/i.test(userAgent);
  const narrowViewport = window.matchMedia('(max-width: 767px)').matches;

  return phoneLikeUserAgent || narrowViewport;
}

function getMobileScannerReloadTrigger(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number,
  streams: MediaStream[],
  lastReloadAt: number,
  now: number
): ScannerReloadTrigger | null {
  if (streams.some(streamNeedsReconnect)) {
    return {
      code: 'STREAM_RECONNECT',
      message: 'Camera stream stalled',
      confirmationMs: MOBILE_SCANNER_STREAM_CONFIRM_MS,
    };
  }

  return null;
}

function mapVehicleToCase(vehicle: Vehicle): VehicleCase {
  const normalizedPlate = cleanPlateNumber(vehicle.plate);

  // Map the storage-layer Vehicle status to the VehicleCase CaseStatus used by
  // the matching engine. Only CLOSED cases are excluded from DB matching.
  // FLAGGED and PENDING are active pursuit cases — map them to ON_HOLD so the
  // matching engine still finds them. CLEARED cases are treated as RECOVERED.
  const statusMap: Record<string, VehicleCase['status']> = {
    ACTIVE: 'ACTIVE',
    FLAGGED: 'ON_HOLD',
    PENDING: 'ON_HOLD',
    CLEARED: 'RECOVERED',
  };
  const caseStatus: VehicleCase['status'] = statusMap[vehicle.status] ?? 'ACTIVE';

  return {
    id: vehicle.id,
    plateNumber: normalizedPlate,
    normalizedPlate,
    customerName: vehicle.customerName,
    customerReference: vehicle.customerId,
    vehicleMake: vehicle.brand,
    vehicleModel: vehicle.model,
    vehicleColor: vehicle.colour,
    vehicleYear: vehicle.year,
    financeCompany: vehicle.financeCompany,
    outstandingAmount: vehicle.outstandingAmount,
    caseReference: vehicle.reference,
    status: caseStatus,
    notes: vehicle.remark,
    createdAt: vehicle.createdDate,
    updatedAt: vehicle.updatedDate,
  };
}

export default function ScannerPage() {
  const { t, language } = useLanguage();
  const { vehicles, addHistoryLog, updateVehicle, updateVehicleLastSeen, settings } = useStorage();
  const { role } = useAuth();
  const canUseDiagnostics = process.env.NODE_ENV !== 'production';

  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const slotRuntimesRef = useRef<Record<string, SlotScannerRuntime>>({});
  const slotMetricsRef = useRef<Record<string, SlotMetrics>>({});
  const activeStreamsRef = useRef<Record<string, MediaStream>>({});
  const activeCameraSlotIdRef = useRef('camera-slot-1');
  const cameraSlotsRef = useRef<CameraSlot[]>([{ id: 'camera-slot-1', deviceId: '' }]);
  const availableCamerasRef = useRef<DesktopCameraDevice[]>([]);
  const cameraMetadataBySlotRef = useRef<Record<string, CameraRuntimeMetadata>>({});
  const supportsMultiCameraScanRef = useRef(false);
  const reviewedAlertDetectionIdsRef = useRef<Set<string>>(new Set());
  const isCameraReadyRef = useRef(false);
  const isScanningRef = useRef(false);
  const developerModeRef = useRef(false);
  const datasetModeRef = useRef(false);
  const runtimeStateRef = useRef<ANPRRuntimeState>('UNINITIALIZED');
  const vehicleLookup = useMemo(() => ({
    index: buildVehicleMatchIndex(vehicles.map(mapVehicleToCase)),
    byId: new Map(vehicles.map(vehicle => [vehicle.id, vehicle])),
  }), [vehicles]);
  const vehicleLookupRef = useRef(vehicleLookup);
  const addHistoryLogRef = useRef(addHistoryLog);
  const updateVehicleLastSeenRef = useRef(updateVehicleLastSeen);
  const soundEnabledRef = useRef(true);
  const settingsRef = useRef<ScannerSettings>({ ...INITIAL_SETTINGS, debugMode: false });
  const cooldownMap = useRef<Map<string, number>>(new Map());
  const recentPlateFamiliesRef = useRef<Map<string, RecentPlateFamily>>(new Map());
  const ocrWorkPool = useRef(new OcrWorkPool());
  const lastMetricsFlushTs = useRef(Date.now());
  const runtimeMetricsRef = useRef<ScannerRuntimeMetrics>(createInitialRuntimeMetrics());
  const completedTrackEventsRef = useRef<CompletedTrackEvent[]>([]);
  const datasetSamplesRef = useRef<DatasetSample[]>([]);
  const lostTrackIdsRef = useRef<Set<string>>(new Set());
  const adaptiveConfigRef = useRef<AdaptiveScannerConfig>(
    createAdaptiveScannerConfig(createDefaultEnvironmentProfile())
  );
  const environmentProfileRef = useRef<EnvironmentProfile>(createDefaultEnvironmentProfile());
  const environmentStatsRef = useRef<FrameImageStats | undefined>(undefined);
  const environmentInferenceRunningRef = useRef(false);
  const lastPerformanceAdaptationAtRef = useRef(0);
  const lastCameraConstraintApplyAtRef = useRef(0);
  const cameraOperationIdRef = useRef(0);
  const stopCameraRef = useRef<(options?: CameraStopOptions) => void>(() => undefined);
  const startVisibleCamerasRef = useRef<(options?: { resumeScanning?: boolean }) => Promise<boolean>>(async () => false);
  const scannerReloadInFlightRef = useRef(false);
  const scannerStartupInFlightRef = useRef(false);
  const startupRequestRef = useRef(0);
  const [isScannerPreparing, setIsScannerPreparing] = useState(false);
  const scannerProcessingPausedRef = useRef(false);
  const lastScannerReloadAtRef = useRef(0);
  const scannerReloadIssueRef = useRef<{ code: ScannerReloadTriggerCode; firstSeenAt: number } | null>(null);
  const scannerReloadNoticeTimerRef = useRef<number | null>(null);
  const mobilePinchZoomRef = useRef<{ startDistance: number; startZoom: number } | null>(null);
  const mobileFacingModeRef = useRef<MobileFacingMode>('environment');
  const resetLiveScanUiRef = useRef<() => void>(() => undefined);
  const [isFinishingSample, setIsFinishingSample] = useState(false);
  const sampleEndTimersRef = useRef<Record<string, number>>({});

  const [scannerSourceMode, setScannerSourceMode] = useState<'CAMERA' | 'SAMPLE_VIDEO'>('CAMERA');
  const [selectedTrainingVideoId, setSelectedTrainingVideoId] = useState<string>('clip-2');
  const [customUploadedVideoUrl, setCustomUploadedVideoUrl] = useState<string | null>(null);
  const scannerSourceModeRef = useRef<'CAMERA' | 'SAMPLE_VIDEO'>('CAMERA');
  const selectedTrainingVideoIdRef = useRef<string>('clip-2');
  const customUploadedVideoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    scannerSourceModeRef.current = scannerSourceMode;
  }, [scannerSourceMode]);

  useEffect(() => {
    selectedTrainingVideoIdRef.current = selectedTrainingVideoId;
  }, [selectedTrainingVideoId]);

  useEffect(() => {
    customUploadedVideoUrlRef.current = customUploadedVideoUrl;
  }, [customUploadedVideoUrl]);

  const [availableCameras, setAvailableCameras] = useState<DesktopCameraDevice[]>([]);
  const [cameraSlots, setCameraSlots] = useState<CameraSlot[]>([{ id: 'camera-slot-1', deviceId: '' }]);
  const [cameraSlotStatuses, setCameraSlotStatuses] = useState<Record<string, CameraSlotStatus>>({});
  const cameraSlotStatusRef = useRef<Record<string, CameraSlotStatus>>({});
  const [cameraSlotErrors, setCameraSlotErrors] = useState<Record<string, string>>({});
  const cameraSlotErrorsRef = useRef<Record<string, string>>({});
  const [activeCameraSlotId, setActiveCameraSlotId] = useState('camera-slot-1');
  const [supportsMultiCameraScan, setSupportsMultiCameraScan] = useState(false);
  const [previewSlotIds, setPreviewSlotIds] = useState<string[]>([]);
  // Keep a ref so the detection loop effect can read the latest value without
  // being in its dependency array — avoids restarting all runners on every preview change.
  const previewSlotIdsRef = useRef<string[]>([]);
  previewSlotIdsRef.current = previewSlotIds;

  const [cameraMetadataBySlot, setCameraMetadataBySlot] = useState<Record<string, CameraRuntimeMetadata>>({});
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  // This is deliberately a preview-only transform. The detector and OCR keep
  // receiving the native camera pixels, so switching the operator's view can
  // never reverse text or invalidate detector/overlay coordinates.
  const [isCameraPreviewMirrored, setIsCameraPreviewMirrored] = useState(false);
  const isCameraPreviewMirroredRef = useRef(isCameraPreviewMirrored);
  isCameraPreviewMirroredRef.current = isCameraPreviewMirrored;
  const [scannerProcessingPaused, setScannerProcessingPausedState] = useState(false);
  const [mobileCameraZoom, setMobileCameraZoom] = useState(1);
  const [mobileFacingMode, setMobileFacingMode] = useState<MobileFacingMode>('environment');
  const [scannerReloadNotice, setScannerReloadNotice] = useState<ScannerReloadNotice | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [isRefreshingCameras, setIsRefreshingCameras] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [developerMode, setDeveloperMode] = useState(false);
  const [datasetMode, setDatasetMode] = useState(false);
  const [environmentProfile, setEnvironmentProfile] = useState<EnvironmentProfile>(() => createDefaultEnvironmentProfile());
  const [adaptiveConfigSnapshot, setAdaptiveConfigSnapshot] = useState<AdaptiveScannerConfig>(() =>
    createAdaptiveScannerConfig(createDefaultEnvironmentProfile())
  );
  const [, setCurrentPlate] = useState('READY');
  const [, setLastDetectedSlotId] = useState('');
  const [activeAlertMatchesBySlot, setActiveAlertMatchesBySlot] = useState<Record<string, AlertMatch>>({});
  const [liveDetections, setLiveDetections] = useState<SessionDetection[]>([]);
  const [expandedDetectionId, setExpandedDetectionId] = useState<string | null>(null);
  const [runtimeState, setRuntimeState] = useState<ANPRRuntimeState>('UNINITIALIZED');
  const [benchmarkResult, setBenchmarkResult] = useState<AdmissionBenchmarkResult | null>(null);
  const [runtimeErrorMessage, setRuntimeErrorMessage] = useState<string | null>(null);
  const [detectorProvider, setDetectorProvider] = useState<ActiveExecutionProvider>('NONE');
  const [ocrProvider, setOcrProvider] = useState<ActiveOcrProvider>('NONE');
  const [camFps, setCamFps] = useState(0);
  const [detFps, setDetFps] = useState(0);
  const [, setPlatesVisible] = useState(0);
  const [activeTracksCount, setActiveTracksCount] = useState(0);
  const [tracksList, setTracksList] = useState<ActiveTrack[]>([]);
  const [runtimeMetricsSnapshot, setRuntimeMetricsSnapshot] = useState<ScannerMetricsSnapshot>(() =>
    createMetricsSnapshot(createInitialRuntimeMetrics(), [])
  );
  const [systemHealthSnapshot, setSystemHealthSnapshot] = useState<SystemHealthSnapshot>(() =>
    createSystemHealthSnapshot(createMetricsSnapshot(createInitialRuntimeMetrics(), []), 0, 0)
  );
  const [healthSnapshot, setHealthSnapshot] = useState<HealthSnapshot>({
    slotId: 'slot-1',
    state: 'AKTIF',
    detailedReason: 'NONE',
    statusMessage: 'Pengimbas & AI Berfungsi',
    lastFrameTimeMs: Date.now(),
    lastYoloSuccessMs: Date.now(),
    lastOcrSuccessMs: Date.now(),
    yoloConsecutiveFailures: 0,
    ocrConsecutiveFailures: 0,
    ocrQueueDepth: 0,
    avgYoloLatencyMs: 0,
    avgOcrLatencyMs: 0,
    recoveryAttempts: 0,
    canManualRetry: false,
  });
  const healthMonitorsRef = useRef<Record<string, CameraHealthMonitor>>({});
  const [showUnsupportedBrowserWarning, setShowUnsupportedBrowserWarning] = useState(false);
  const [diagCounters, setDiagCounters] = useState({
    detected: 0,
    crops: 0,
    ocrQueued: 0,
    ocrStarted: 0,
    ocrReturned: 0,
    ocrAccepted: 0,
    committed: 0,
  });
  const diagCountersRef = useRef({
    detected: 0,
    crops: 0,
    ocrQueued: 0,
    ocrStarted: 0,
    ocrReturned: 0,
    ocrAccepted: 0,
    committed: 0,
  });
  const bumpDiag = useCallback((key: keyof typeof diagCountersRef.current) => {
    diagCountersRef.current[key]++;
    setDiagCounters({ ...diagCountersRef.current });
  }, []);
  const [latestOcrCropInfo, setLatestOcrCropInfo] = useState<{ dataUrl: string; dimensions: string; rawText?: string; conf?: number } | null>(null);
  const [closedOverlaySlotIds, setClosedOverlaySlotIds] = useState<string[]>([]);
  const [collapsedOverlaySlotIds, setCollapsedOverlaySlotIds] = useState<string[]>([]);
  const [expandedOverlaySlotIds, setExpandedOverlaySlotIds] = useState<string[]>([]);

  const isSlotOverlayClosed = useCallback((slotId: string) => closedOverlaySlotIds.includes(slotId), [closedOverlaySlotIds]);
  const isSlotOverlayCollapsed = useCallback((slotId: string) => collapsedOverlaySlotIds.includes(slotId), [collapsedOverlaySlotIds]);
  const isSlotOverlayExpanded = useCallback((slotId: string) => expandedOverlaySlotIds.includes(slotId), [expandedOverlaySlotIds]);

  const toggleSlotOverlayClosed = useCallback((slotId: string, closed: boolean) => {
    setClosedOverlaySlotIds((ids) =>
      closed ? (ids.includes(slotId) ? ids : [...ids, slotId]) : ids.filter((id) => id !== slotId)
    );
  }, []);

  const toggleSlotOverlayCollapsed = useCallback((slotId: string) => {
    setCollapsedOverlaySlotIds((ids) =>
      ids.includes(slotId) ? ids.filter((id) => id !== slotId) : [...ids, slotId]
    );
  }, []);

  const toggleSlotOverlayExpanded = useCallback((slotId: string) => {
    setExpandedOverlaySlotIds((ids) =>
      ids.includes(slotId) ? ids.filter((id) => id !== slotId) : [...ids, slotId]
    );
  }, []);

  type LiveTrackItem = {
    trackId: string;
    trackNumber: number;
    cropDataUrl?: string;
    plate?: string;
    confidence?: number;
    status: 'captured' | 'reading' | 'recognised' | 'finished';
    matchType?: 'EXACT' | 'POSSIBLE' | 'NONE';
    detectedAtMs: number;
    updatedAtMs: number;
    lastDetectorLatencyMs?: number;
    lastOcrLatencyMs?: number;
    timestampStr: string;
  };

  const [liveTrackItems, setLiveTrackItems] = useState<LiveTrackItem[]>([]);
  const liveTrackItemsRef = useRef<LiveTrackItem[]>([]);
  const lastLiveTrackUiFlushTs = useRef(0);
  const liveTrackFlushTimer = useRef<number | null>(null);

  const flushLiveTrackUi = useCallback(() => {
    liveTrackFlushTimer.current = null;
    lastLiveTrackUiFlushTs.current = Date.now();
    setLiveTrackItems([...liveTrackItemsRef.current]);
  }, []);

  const updateLiveTrackItem = useCallback((update: Partial<LiveTrackItem> & { trackId: string }) => {
    const current = liveTrackItemsRef.current;
    const existingIdx = current.findIndex(item => item.trackId === update.trackId);
    const now = Date.now();
    const timestampStr = new Date(now).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let updatedList: LiveTrackItem[];
    const isMajorStatus = !existingIdx || update.status === 'recognised' || update.status === 'finished' || Boolean(update.matchType);
    if (existingIdx >= 0) {
      const existing = current[existingIdx];
      const updatedItem: LiveTrackItem = {
        ...existing,
        ...update,
        cropDataUrl: update.cropDataUrl || existing.cropDataUrl,
        plate: update.plate || existing.plate,
        confidence: update.confidence !== undefined ? update.confidence : existing.confidence,
        status: update.status || existing.status,
        matchType: update.matchType || existing.matchType,
        lastDetectorLatencyMs: update.lastDetectorLatencyMs !== undefined ? update.lastDetectorLatencyMs : existing.lastDetectorLatencyMs,
        lastOcrLatencyMs: update.lastOcrLatencyMs !== undefined ? update.lastOcrLatencyMs : existing.lastOcrLatencyMs,
        updatedAtMs: now,
      };
      updatedList = [...current];
      updatedList[existingIdx] = updatedItem;
    } else {
      const newItem: LiveTrackItem = {
        trackId: update.trackId,
        trackNumber: update.trackNumber || 1,
        cropDataUrl: update.cropDataUrl,
        plate: update.plate,
        confidence: update.confidence,
        status: update.status || 'captured',
        matchType: update.matchType,
        detectedAtMs: now,
        updatedAtMs: now,
        lastDetectorLatencyMs: update.lastDetectorLatencyMs,
        lastOcrLatencyMs: update.lastOcrLatencyMs,
        timestampStr,
      };
      updatedList = [newItem, ...current].slice(0, 20);
    }
    liveTrackItemsRef.current = updatedList;

    if (isMajorStatus || now - lastLiveTrackUiFlushTs.current >= 120) {
      lastLiveTrackUiFlushTs.current = now;
      if (liveTrackFlushTimer.current) {
        window.clearTimeout(liveTrackFlushTimer.current);
        liveTrackFlushTimer.current = null;
      }
      setLiveTrackItems(updatedList);
    } else if (!liveTrackFlushTimer.current) {
      liveTrackFlushTimer.current = window.setTimeout(flushLiveTrackUi, 100);
    }
  }, [flushLiveTrackUi]);
  const effectiveDeveloperMode = canUseDiagnostics && developerMode;
  const effectiveDatasetMode = canUseDiagnostics && datasetMode;

  const getSlotRuntime = useCallback((slotId: string): SlotScannerRuntime => {
    if (!slotRuntimesRef.current[slotId]) {
      const bestFrameSelector = new BestFrameSelector();
      bestFrameSelector.configure({ maxBufferSize: 12, maxEntryAgeMs: 5000 });
      slotRuntimesRef.current[slotId] = {
        tracker: new PlateTracker(20, 8),
        bestFrameSelector,
        processingCanvas: null,
        sourceFrameCanvas: null,
        lastMaintenanceTs: 0,
        ocrGeneration: 0,
      };
    }

    return slotRuntimesRef.current[slotId];
  }, []);

  const ensureSlotMetrics = useCallback((slotId: string): SlotMetrics => {
    if (!slotMetricsRef.current[slotId]) {
      slotMetricsRef.current[slotId] = {
        camFrames: 0,
        detFrames: 0,
        platesVisible: 0,
        activeTracks: 0,
        tracks: [],
      };
    }

    return slotMetricsRef.current[slotId];
  }, []);

  const applyActiveCameraConstraints = useCallback(async () => {
    const now = Date.now();
    if (now - lastCameraConstraintApplyAtRef.current < CAMERA_CONSTRAINT_APPLY_COOLDOWN_MS) return;
    lastCameraConstraintApplyAtRef.current = now;

    const metrics = runtimeMetricsRef.current;
    const adaptiveCamera = getActiveCameraCaptureConfig(
      adaptiveConfigRef.current.camera,
      metrics.adaptationLevel
    );
    const constraints: MediaTrackConstraints = {
      ...getCameraPerformanceConstraints(metrics.adaptationLevel),
      width: { ideal: adaptiveCamera.idealWidth },
      height: { ideal: adaptiveCamera.idealHeight },
      frameRate: { ideal: adaptiveCamera.idealFps, max: 30 },
    };
    const tracks = Object.values(activeStreamsRef.current).flatMap((stream) => stream.getVideoTracks());

    await Promise.all(
      tracks.map(async (track) => {
        if (typeof track.applyConstraints !== 'function') return;
        try {
          await track.applyConstraints(constraints);
        } catch {
          // Some desktop webcams expose fixed capture modes and reject live renegotiation.
        }
      })
    );

    metrics.cameraProfile = getCameraProfileLabel(
      metrics.deviceTier,
      metrics.adaptationLevel,
      isMobileScannerDevice()
    );
  }, []);

  const maybeAdaptRuntimePerformance = useCallback(
    (snapshot: ScannerMetricsSnapshot, detectorFps: number, cameraFps: number) => {
      const now = Date.now();
      if (now - lastPerformanceAdaptationAtRef.current < PERFORMANCE_ADAPTATION_CHECK_MS) return;

      const metrics = runtimeMetricsRef.current;
      const baseTier = classifyDeviceTier(getLatestBenchmarkResult(), runtimeStateRef.current);
      const reason = getRuntimeAdaptationReason(snapshot, detectorFps, cameraFps);

      if (
        reason &&
        metrics.adaptationLevel < 3 &&
        now - lastPerformanceAdaptationAtRef.current >= PERFORMANCE_ADAPTATION_COOLDOWN_MS
      ) {
        applyRuntimePerformanceProfile(metrics, baseTier, metrics.adaptationLevel + 1, reason);
        lastPerformanceAdaptationAtRef.current = now;
        void applyActiveCameraConstraints();
        return;
      }

      if (
        !reason &&
        metrics.adaptationLevel > 0 &&
        now - lastPerformanceAdaptationAtRef.current >= PERFORMANCE_RECOVERY_COOLDOWN_MS &&
        canRecoverRuntimeProfile(snapshot, detectorFps, cameraFps)
      ) {
        applyRuntimePerformanceProfile(metrics, baseTier, metrics.adaptationLevel - 1, 'Recovered sustained performance');
        lastPerformanceAdaptationAtRef.current = now;
        void applyActiveCameraConstraints();
        return;
      }

      applyRuntimePerformanceProfile(metrics, baseTier, metrics.adaptationLevel, metrics.performanceModeReason);
    },
    [applyActiveCameraConstraints]
  );

  const clearScannerReloadNoticeTimer = useCallback(() => {
    if (scannerReloadNoticeTimerRef.current) {
      window.clearTimeout(scannerReloadNoticeTimerRef.current);
      scannerReloadNoticeTimerRef.current = null;
    }
  }, []);

  const setScannerProcessingPaused = useCallback((paused: boolean) => {
    scannerProcessingPausedRef.current = paused;
    setScannerProcessingPausedState(paused);
  }, []);

  const requestScannerOnlyReload = useCallback(
    async (trigger: ScannerReloadTrigger) => {
      if (scannerReloadInFlightRef.current || !isScanningRef.current) return false;

      scannerReloadInFlightRef.current = true;
      scannerReloadIssueRef.current = null;
      clearScannerReloadNoticeTimer();

      const startedAt = Date.now();
      lastScannerReloadAtRef.current = startedAt;
      setScannerProcessingPaused(true);
      setCurrentPlate('RELOADING');
      setScannerReloadNotice((prev) => ({
        isReloading: true,
        reason: trigger.message,
        startedAt,
        count: (prev?.count ?? 0) + 1,
        mode: 'RELOADING',
      }));

      try {
        // Reset tracker/OCR/best-frame state before reconnecting so stale
        // track data from the previous stream does not bleed into the new one.
        resetLiveScanUiRef.current();

        const started = await startVisibleCamerasRef.current({ resumeScanning: true });
        if (started) {
          await waitMs(getScannerCameraSettleMs('RELOADING'));
          resetLiveScanUiRef.current();
        }
        const completedAt = Date.now();

        if (!started) {
          setScannerProcessingPaused(false);
          setIsScanning(false);
          setCurrentPlate('READY');
        } else {
          setScannerProcessingPaused(false);
          setCurrentPlate('SCANNING');
        }

        setScannerReloadNotice((prev) =>
          prev?.startedAt === startedAt
            ? {
              ...prev,
              isReloading: false,
              completedAt,
              reason: started ? `${trigger.message} complete` : trigger.message,
            }
            : prev
        );

        scannerReloadNoticeTimerRef.current = window.setTimeout(() => {
          setScannerReloadNotice((prev) => (prev && !prev.isReloading ? null : prev));
          scannerReloadNoticeTimerRef.current = null;
        }, MOBILE_SCANNER_RELOAD_NOTICE_MS);

        return started;
      } finally {
        if (scannerReloadInFlightRef.current) {
          setScannerProcessingPaused(false);
        }
        scannerReloadInFlightRef.current = false;
      }
    },
    [clearScannerReloadNoticeTimer, setScannerProcessingPaused]
  );

  const maybeAutoReloadMobileScanner = useCallback(
    (snapshot: ScannerMetricsSnapshot, detectorFps: number, cameraFps: number) => {
      if (!isScanningRef.current || !isCameraReadyRef.current || !isMobileScannerDevice()) {
        scannerReloadIssueRef.current = null;
        return;
      }

      if (scannerReloadInFlightRef.current) return;

      const now = Date.now();
      const streams = Object.values(activeStreamsRef.current);
      if (streams.length === 0) return;

      const trigger = getMobileScannerReloadTrigger(
        snapshot,
        detectorFps,
        cameraFps,
        streams,
        lastScannerReloadAtRef.current,
        now
      );

      if (!trigger) {
        scannerReloadIssueRef.current = null;
        return;
      }

      const freshScannerRuntime =
        now - Math.max(snapshot.sessionStartedAt, lastScannerReloadAtRef.current || 0) < MOBILE_SCANNER_RELOAD_MIN_UPTIME_MS;
      if (freshScannerRuntime && trigger.code !== 'STREAM_RECONNECT') return;

      const reloadCooldownMs =
        trigger.code === 'STREAM_RECONNECT' ? MOBILE_SCANNER_STREAM_COOLDOWN_MS : MOBILE_SCANNER_RELOAD_COOLDOWN_MS;
      if (lastScannerReloadAtRef.current && now - lastScannerReloadAtRef.current < reloadCooldownMs) return;

      const existingIssue = scannerReloadIssueRef.current;
      if (!existingIssue || existingIssue.code !== trigger.code) {
        scannerReloadIssueRef.current = {
          code: trigger.code,
          firstSeenAt: now,
        };
        if (trigger.confirmationMs > 0) return;
      }

      const issueFirstSeenAt = scannerReloadIssueRef.current?.firstSeenAt ?? now;
      if (now - issueFirstSeenAt < trigger.confirmationMs) return;

      void requestScannerOnlyReload(trigger);
    },
    [requestScannerOnlyReload]
  );

  const flushScannerMetrics = useCallback(() => {
    const metrics = Object.values(slotMetricsRef.current);
    const aggregate = metrics.reduce(
      (acc, item) => {
        acc.camFrames += item.camFrames;
        acc.detFrames += item.detFrames;
        acc.platesVisible += item.platesVisible;
        acc.activeTracks += item.activeTracks;
        acc.tracks.push(...item.tracks);
        return acc;
      },
      { camFrames: 0, detFrames: 0, platesVisible: 0, activeTracks: 0, tracks: [] as ActiveTrack[] }
    );

    setCamFps(aggregate.camFrames);
    setDetFps(aggregate.detFrames);
    setPlatesVisible(aggregate.platesVisible);
    setActiveTracksCount(aggregate.activeTracks);
    setTracksList(aggregate.tracks);
    runtimeMetricsRef.current.memoryCurrentMb = getUsedHeapMb() ?? runtimeMetricsRef.current.memoryCurrentMb;
    runtimeMetricsRef.current.cameraHealth = createCameraHealthSnapshot(
      environmentStatsRef.current,
      aggregate.camFrames,
      runtimeMetricsRef.current.droppedFrameCount
    );
    const snapshot = createMetricsSnapshot(runtimeMetricsRef.current, aggregate.tracks);
    maybeAdaptRuntimePerformance(snapshot, aggregate.detFrames, aggregate.camFrames);
    const adaptedSnapshot = createMetricsSnapshot(runtimeMetricsRef.current, aggregate.tracks);
    setRuntimeMetricsSnapshot(adaptedSnapshot);
    setSystemHealthSnapshot(createSystemHealthSnapshot(adaptedSnapshot, aggregate.detFrames, aggregate.camFrames));
    maybeAutoReloadMobileScanner(adaptedSnapshot, aggregate.detFrames, aggregate.camFrames);

    Object.values(slotMetricsRef.current).forEach((item) => {
      item.camFrames = 0;
      item.detFrames = 0;
    });
  }, [maybeAdaptRuntimePerformance, maybeAutoReloadMobileScanner]);

  const resetLiveScanUi = useCallback(() => {
    Object.values(slotRuntimesRef.current).forEach((runtime) => {
      runtime.ocrGeneration++;
      runtime.tracker.clear();
      runtime.bestFrameSelector.resetAll();
      runtime.drainDeadline = undefined;
      runtime.lastProcessedMediaTime = undefined;
      runtime.processingCanvas = null;
      if (runtime.sourceFrameCanvas) releaseCanvasMemory(runtime.sourceFrameCanvas);
      runtime.sourceFrameCanvas = null;
      runtime.lastMaintenanceTs = 0;
    });
    slotMetricsRef.current = {};
    lastMetricsFlushTs.current = Date.now();
    runtimeMetricsRef.current = createInitialRuntimeMetrics(
      classifyDeviceTier(getLatestBenchmarkResult(), runtimeStateRef.current)
    );
    lastPerformanceAdaptationAtRef.current = Date.now();
    lastCameraConstraintApplyAtRef.current = 0;
    completedTrackEventsRef.current = [];
    lostTrackIdsRef.current.clear();
    cooldownMap.current.clear();
    recentPlateFamiliesRef.current.clear();
    reviewedAlertDetectionIdsRef.current.clear();
    const emptySnapshot = createMetricsSnapshot(runtimeMetricsRef.current, []);
    setRuntimeMetricsSnapshot(emptySnapshot);
    setSystemHealthSnapshot(createSystemHealthSnapshot(emptySnapshot, 0, 0));
    setTracksList([]);
    setActiveAlertMatchesBySlot({});
    setCurrentPlate('READY');
    setLastDetectedSlotId('');
    setPlatesVisible(0);
    setActiveTracksCount(0);
    setCamFps(0);
    setDetFps(0);
    Object.values(canvasRefs.current).forEach((canvas) => {
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    });
  }, []);

  const syncRuntimeStatus = useCallback(() => {
    const nextState = getANPRRuntimeState();
    const latestBenchmark = getLatestBenchmarkResult();
    runtimeStateRef.current = nextState;
    setRuntimeState((prev) => (prev === nextState ? prev : nextState));
    setBenchmarkResult(latestBenchmark);
    setRuntimeErrorMessage(getRuntimeErrorMessage());
    setDetectorProvider(getActiveDetectorProvider());
    setOcrProvider(getActivePpOcrProvider());
    applyRuntimePerformanceProfile(
      runtimeMetricsRef.current,
      classifyDeviceTier(latestBenchmark, nextState),
      runtimeMetricsRef.current.adaptationLevel,
      runtimeMetricsRef.current.performanceModeReason
    );
  }, []);

  const startRuntimeInit = useCallback(async () => {
    const initialization = initializeANPRRuntime();
    syncRuntimeStatus();
    const progressTimer = window.setInterval(syncRuntimeStatus, 500);
    try {
      const res = await initialization;
      runtimeStateRef.current = res.state;
      setRuntimeState(res.state);
      if (res.benchmark) setBenchmarkResult(res.benchmark);
    } finally {
      window.clearInterval(progressTimer);
      syncRuntimeStatus();
    }
  }, [syncRuntimeStatus]);

  useEffect(() => {
    vehicleLookupRef.current = vehicleLookup;
  }, [vehicleLookup]);

  useEffect(() => {
    cameraSlotsRef.current = cameraSlots;
  }, [cameraSlots]);

  useEffect(() => {
    availableCamerasRef.current = availableCameras;
  }, [availableCameras]);

  useEffect(() => {
    cameraMetadataBySlotRef.current = cameraMetadataBySlot;
  }, [cameraMetadataBySlot]);

  useEffect(() => {
    activeCameraSlotIdRef.current = activeCameraSlotId;
  }, [activeCameraSlotId]);

  useEffect(() => {
    isCameraReadyRef.current = isCameraReady;
  }, [isCameraReady]);

  useEffect(() => {
    isScanningRef.current = isScanning;
  }, [isScanning]);

  useEffect(() => {
    developerModeRef.current = effectiveDeveloperMode;
  }, [effectiveDeveloperMode]);

  useEffect(() => {
    datasetModeRef.current = effectiveDatasetMode;
  }, [effectiveDatasetMode]);

  useEffect(() => {
    supportsMultiCameraScanRef.current = supportsMultiCameraScan;
  }, [supportsMultiCameraScan]);

  useEffect(() => {
    const updateCapability = () => {
      const nextSupportsMultiCamera = canRunMultiCameraOnCurrentDevice();
      supportsMultiCameraScanRef.current = nextSupportsMultiCamera;
      setSupportsMultiCameraScan(nextSupportsMultiCamera);
      void applyActiveCameraConstraints();

      if (!nextSupportsMultiCamera) {
        setCameraSlots((slots) => {
          const selectedSlot = slots.find((slot) => slot.id === activeCameraSlotIdRef.current) || slots[0];
          return selectedSlot ? [selectedSlot] : slots;
        });
        setPreviewSlotIds((ids) => ids.filter((id) => id === activeCameraSlotIdRef.current));
      }
    };

    const id = window.setTimeout(updateCapability, 0);
    window.addEventListener('resize', updateCapability);
    window.addEventListener('orientationchange', updateCapability);

    return () => {
      window.clearTimeout(id);
      window.removeEventListener('resize', updateCapability);
      window.removeEventListener('orientationchange', updateCapability);
    };
  }, [applyActiveCameraConstraints]);

  useEffect(() => {
    addHistoryLogRef.current = addHistoryLog;
  }, [addHistoryLog]);

  useEffect(() => {
    updateVehicleLastSeenRef.current = updateVehicleLastSeen;
  }, [updateVehicleLastSeen]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    settingsRef.current = {
      ...settingsRef.current,
      soundEnabled: soundEnabled && settings.soundAlerts,
      detectionThreshold: clampPercentToThreshold(
        settings.detectionConfidence,
        INITIAL_SETTINGS.detectionThreshold,
        0.25,
        0.65
      ),
      recognitionThreshold: clampPercentToThreshold(
        settings.ocrConfidence,
        INITIAL_SETTINGS.recognitionThreshold,
        0.35,
        0.7
      ),
      debugMode: effectiveDeveloperMode,
      showCenterGuide: false,
    };
  }, [effectiveDeveloperMode, settings, soundEnabled]);

  useEffect(() => {
    const initTimer = window.setTimeout(() => {
      void startRuntimeInit();
    }, 0);
    const id = window.setInterval(syncRuntimeStatus, 1000);
    return () => {
      window.clearTimeout(initTimer);
      window.clearInterval(id);
    };
  }, [startRuntimeInit, syncRuntimeStatus]);

  useEffect(() => {
    stopCameraRef.current = stopCamera;
    startVisibleCamerasRef.current = startVisibleCameras;
    resetLiveScanUiRef.current = resetLiveScanUi;
  });

  useEffect(() => {
    return () => {
      clearScannerReloadNoticeTimer();
    };
  }, [clearScannerReloadNoticeTimer]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowUnsupportedBrowserWarning(!isSupportedDesktopScannerBrowser());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        if (scannerSourceModeRef.current === 'SAMPLE_VIDEO') {
          localStorage.removeItem(RECENT_DETECTIONS_STORAGE_KEY);
        } else {
          const storedDetections = localStorage.getItem(RECENT_DETECTIONS_STORAGE_KEY);
          if (storedDetections) {
            const parsedDetections = (JSON.parse(storedDetections) as SessionDetection[])
              .filter((detection) => canPublishPlate(
                detection.plate,
                detection.confidence / 100,
                settingsRef.current.recognitionThreshold,
                detection.evidenceCount ?? 2
              ));
            reviewedAlertDetectionIdsRef.current = new Set(
              parsedDetections
                .filter((detection) => detection.actionStatus === 'REVIEWED')
                .map((detection) => detection.id)
            );
            setLiveDetections(parsedDetections.slice(0, 50));
            if (parsedDetections[0]) {
              setCurrentPlate(parsedDetections[0].plate);
              setLastDetectedSlotId(parsedDetections[0].cameraId);
            }
          }
        }
      } catch {
        localStorage.removeItem(RECENT_DETECTIONS_STORAGE_KEY);
      }

      void refreshCameraList();
    }, 0);

    return () => {
      window.clearTimeout(restoreTimer);
      stopCameraRef.current();
    };
  }, []);

  // Track the previous slot IDs so we can detect which slots are newly added.
  const prevSlotIdsRef = useRef<Set<string>>(new Set(cameraSlots.map((s) => s.id)));
  useEffect(() => {
    const prevIds = prevSlotIdsRef.current;
    const newlyAddedSlots = cameraSlots.filter((s) => !prevIds.has(s.id));
    prevSlotIdsRef.current = new Set(cameraSlots.map((s) => s.id));

    // Only auto-start newly added slots when a scanning session is already live.
    // Do NOT restart already-running slots — that's the bug that caused Camera 3
    // to not appear until Camera 4 was added.
    if (newlyAddedSlots.length === 0 || !isScanningRef.current) return;

    newlyAddedSlots.forEach((slot) => {
      if (cameraSlotStatusRef.current[slot.id] !== 'RUNNING') {
        void handleStartSlotCamera(slot.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraSlots.length]);

  async function refreshCameraList() {
    setIsRefreshingCameras(true);
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraError('Camera devices are not available in this browser.');
      setIsRefreshingCameras(false);
      return [] as DesktopCameraDevice[];
    }

    try {
      const videoDevices = await enumerateDesktopCameras();
      const rememberedDeviceId = getRememberedCameraId();
      const preferredCamera = selectPreferredCamera(videoDevices, rememberedDeviceId);
      setCameraSlots((slots) =>
        resolveUniqueCameraSlots(
          slots.map((slot, index) => ({
            ...slot,
            deviceId:
              slot.deviceId ||
              (index === 0 ? preferredCamera?.deviceId : videoDevices[index]?.deviceId) ||
              videoDevices[0]?.deviceId ||
              '',
          })),
          videoDevices
        )
      );
      setAvailableCameras(videoDevices);
      setCameraError('');
      return videoDevices;
    } catch {
      setCameraError('Unable to read camera list. Please allow camera access.');
      return [] as DesktopCameraDevice[];
    } finally {
      window.setTimeout(() => {
        setIsRefreshingCameras(false);
      }, 350);
    }
  }

  function getCameraSlotLabel(slot: CameraSlot | undefined, index: number) {
    if (!slot) return language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera';
    const device = availableCameras.find((cameraDevice) => cameraDevice.deviceId === slot.deviceId);
    return device?.label || (index === 0 ? (language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera') : `Camera ${index + 1}`);
  }

  function stopCamera(options: CameraStopOptions = {}) {
    const preserveScanningState = options.preserveScanningState ?? false;
    const invalidatePendingStarts = options.invalidatePendingStarts ?? !preserveScanningState;

    if (invalidatePendingStarts) {
      cameraOperationIdRef.current++;
      startupRequestRef.current++;
      scannerStartupInFlightRef.current = false;
      setIsScannerPreparing(false);
    }

    isCameraReadyRef.current = false;
    if (!preserveScanningState) {
      isScanningRef.current = false;
      scannerReloadInFlightRef.current = false;
      if (!scannerStartupInFlightRef.current) setScannerProcessingPaused(false);
    }

    Object.values(activeStreamsRef.current).forEach((stream) => {
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
    });
    activeStreamsRef.current = {};

    Object.values(sampleEndTimersRef.current).forEach((timerId) => window.clearTimeout(timerId));
    sampleEndTimersRef.current = {};
    setIsFinishingSample(false);

    Object.values(videoRefs.current).forEach((video) => {
      if (!video) return;
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // Older mobile browsers can reject load() after a stream is detached.
      }
    });

    scannerReloadIssueRef.current = null;
    setPreviewSlotIds([]);
    setCameraMetadataBySlot({});
    setIsCameraReady(false);
    if (!preserveScanningState) {
      if (!scannerStartupInFlightRef.current) {
        clearScannerReloadNoticeTimer();
        setScannerReloadNotice(null);
      }
      setIsScanning(false);
    }
    resetLiveScanUi();
  }

  async function startCameraForSlot(slot: CameraSlot, operationId = cameraOperationIdRef.current) {
    await startRuntimeInit();
    if (operationId !== cameraOperationIdRef.current) return false;
    if (!isRuntimeScanningReady(runtimeStateRef.current) || !isPpOcrReady()) {
      setCameraError('AI engines are not ready. Retry model initialization before scanning.');
      return false;
    }

    if (scannerSourceModeRef.current === 'SAMPLE_VIDEO') {
      try {
        if (operationId !== cameraOperationIdRef.current) return false;
        const targetMeta = getTrainingVideoById(selectedTrainingVideoIdRef.current) || TRAINING_VIDEOS[0];
        const targetUrl = customUploadedVideoUrlRef.current || targetMeta.url;
        const video = videoRefs.current[slot.id];
        if (!video) throw new Error('Video preview is not mounted.');
        if (video) {
          if (operationId !== cameraOperationIdRef.current) return false;
          video.pause();
          video.srcObject = null;
          video.src = targetUrl;
          video.loop = false;
          video.muted = true;
          video.playsInline = true;
          video.setAttribute('playsinline', 'true');
          video.setAttribute('webkit-playsinline', 'true');
          video.preload = 'auto';
          video.load();
          await waitForDecodedFrame(video);
          if (operationId !== cameraOperationIdRef.current) return false;
        }
        const cameraMetadata: CameraRuntimeMetadata = {
          deviceId: 'sample-video-' + selectedTrainingVideoIdRef.current,
          label: customUploadedVideoUrlRef.current ? 'Custom Video File' : targetMeta.title,
          kind: 'UNKNOWN_CAMERA',
          width: targetMeta.resolution.width,
          height: targetMeta.resolution.height,
          fps: 30,
          aspectRatio: targetMeta.resolution.width / Math.max(1, targetMeta.resolution.height),
        };
        setCameraMetadataBySlot((prev) => ({ ...prev, [slot.id]: cameraMetadata }));
        setPreviewSlotIds((ids) => (ids.includes(slot.id) ? ids : [...ids, slot.id]));
        setCameraError('');
        isCameraReadyRef.current = true;
        setIsCameraReady(true);
        return true;
      } catch {
        setCameraError('Unable to load sample training video.');
        return false;
      }
    }

    const preflightError = getCameraPreflightError();
    if (preflightError) {
      setCameraError(preflightError);
      return false;
    }

    try {
      if (operationId !== cameraOperationIdRef.current) return false;

      const facingMode = isMobileScannerDevice() ? mobileFacingModeRef.current : undefined;
      const cameraDeviceId = facingMode ? '' : slot.deviceId;
      const streamKey = slot.id;
      let stream = activeStreamsRef.current[streamKey];

      if (!stream) {
        stream = await openDesktopCameraStream(
          cameraDeviceId,
          getActiveCameraCaptureConfig(
            adaptiveConfigRef.current.camera,
            runtimeMetricsRef.current.adaptationLevel
          ),
          facingMode
        );
        if (operationId !== cameraOperationIdRef.current) {
          stream.getTracks().forEach((track) => {
            track.onended = null;
            track.stop();
          });
          return false;
        }
        activeStreamsRef.current[streamKey] = stream;
      }

      if (operationId !== cameraOperationIdRef.current) return false;
      const cameraDevice = cameraDeviceId
        ? availableCamerasRef.current.find((device) => device.deviceId === cameraDeviceId) || null
        : null;
      const cameraMetadata = getCameraRuntimeMetadata(stream, cameraDevice);

      const video = videoRefs.current[slot.id];
      if (video) {
        if (operationId !== cameraOperationIdRef.current) return false;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.srcObject = stream;
        await video.play();
        await waitForDecodedFrame(video);
        if (operationId !== cameraOperationIdRef.current) return false;
      } else {
        throw new Error('Camera preview is not mounted.');
      }

      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          if (operationId !== cameraOperationIdRef.current) return;
          if (cameraSlotStatusRef.current[slot.id] !== 'RUNNING') return;
          console.warn(`[Camera:${slot.id}] Stream track ended unexpectedly.`);
          cameraSlotStatusRef.current[slot.id] = 'ERROR';
          setCameraSlotStatuses((prev) => ({ ...prev, [slot.id]: 'ERROR' }));
          setCameraSlotErrors((prev) => ({
            ...prev,
            [slot.id]: language === 'BM' ? 'Kamera terputus. Menyambung semula...' : 'Camera disconnected. Reconnecting...',
          }));
          window.setTimeout(() => {
            if (operationId !== cameraOperationIdRef.current) return;
            if (cameraSlotStatusRef.current[slot.id] === 'ERROR') {
              void handleStartSlotCamera(slot.id);
            }
          }, 1500);
        };
      });

      if (!facingMode) rememberSelectedCamera(slot.deviceId || cameraMetadata.deviceId);
      setCameraMetadataBySlot((prev) => ({ ...prev, [slot.id]: cameraMetadata }));
      setPreviewSlotIds((ids) => (ids.includes(slot.id) ? ids : [...ids, slot.id]));
      setCameraError('');
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unable to start camera. Please allow camera permission and try again.';
      cameraSlotStatusRef.current[slot.id] = 'ERROR';
      setCameraSlotStatuses((prev) => ({ ...prev, [slot.id]: 'ERROR' }));
      cameraSlotErrorsRef.current[slot.id] = errMsg;
      setCameraSlotErrors((prev) => ({ ...prev, [slot.id]: errMsg }));
      setCameraError(errMsg);
      return false;
    }
  }

  const handleStartSlotCamera = async (slotId: string) => {
    const slot = cameraSlotsRef.current.find((s) => s.id === slotId) || { id: slotId, deviceId: '' };

    cameraSlotStatusRef.current[slotId] = 'STARTING';
    setCameraSlotStatuses((prev) => ({ ...prev, [slotId]: 'STARTING' }));
    cameraSlotErrorsRef.current[slotId] = '';
    setCameraSlotErrors((prev) => ({ ...prev, [slotId]: '' }));

    try {
      await startRuntimeInit();
      if (!isRuntimeScanningReady(runtimeStateRef.current) || !isPpOcrReady()) {
        throw new Error(language === 'BM' ? 'Enjin AI belum bersedia. Sila tunggu sebentar...' : 'AI engines are initializing. Please wait...');
      }

      const started = await startCameraForSlot(slot);
      if (!started) {
        throw new Error(language === 'BM' ? 'Gagal memulakan kamera.' : 'Unable to start camera.');
      }

      const runtime = getSlotRuntime(slotId);
      runtime.ocrGeneration++;
      runtime.tracker.clear();
      runtime.bestFrameSelector.resetAll();
      runtime.drainDeadline = undefined;
      runtime.lastProcessedMediaTime = undefined;
      runtime.lastMaintenanceTs = 0;

      cameraSlotStatusRef.current[slotId] = 'RUNNING';
      setCameraSlotStatuses((prev) => ({ ...prev, [slotId]: 'RUNNING' }));
      setPreviewSlotIds((ids) => (ids.includes(slotId) ? ids : [...ids, slotId]));
      isCameraReadyRef.current = true;
      setIsCameraReady(true);
      isScanningRef.current = true;
      setIsScanning(true);
      setCurrentPlate('SCANNING');
      setCameraError('');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error starting camera';
      cameraSlotStatusRef.current[slotId] = 'ERROR';
      setCameraSlotStatuses((prev) => ({ ...prev, [slotId]: 'ERROR' }));
      cameraSlotErrorsRef.current[slotId] = msg;
      setCameraSlotErrors((prev) => ({ ...prev, [slotId]: msg }));
      return false;
    }
  };

  const handleStopSlotCamera = (slotId: string) => {
    cameraSlotStatusRef.current[slotId] = 'STOPPING';
    setCameraSlotStatuses((prev) => ({ ...prev, [slotId]: 'STOPPING' }));

    const stream = activeStreamsRef.current[slotId];
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      delete activeStreamsRef.current[slotId];
    }

    const video = videoRefs.current[slotId];
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      try { video.load(); } catch {}
    }

    const overlayCanvas = canvasRefs.current[slotId];
    if (overlayCanvas) {
      overlayCanvas.getContext('2d')?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    const metrics = slotMetricsRef.current[slotId];
    if (metrics) {
      metrics.platesVisible = 0;
      metrics.activeTracks = 0;
      metrics.tracks = [];
    }

    lostTrackIdsRef.current = new Set(
      Array.from(lostTrackIdsRef.current).filter((key) => !key.startsWith(`${slotId}:`))
    );

    cameraSlotStatusRef.current[slotId] = 'STOPPED';
    setCameraSlotStatuses((prev) => ({ ...prev, [slotId]: 'STOPPED' }));
    setPreviewSlotIds((prev) => prev.filter((id) => id !== slotId));

    const anyRunning = Object.entries(cameraSlotStatusRef.current).some(
      ([id, status]) => id !== slotId && status === 'RUNNING'
    );
    if (!anyRunning) {
      isCameraReadyRef.current = false;
      setIsCameraReady(false);
      isScanningRef.current = false;
      setIsScanning(false);
      setCurrentPlate('READY');
    }
  };

  const handleStartAllCameras = async () => {
    const slots = cameraSlotsRef.current;
    await Promise.all(
      slots.map((slot) => {
        if (cameraSlotStatusRef.current[slot.id] !== 'RUNNING') {
          return handleStartSlotCamera(slot.id);
        }
        return Promise.resolve(true);
      })
    );
  };

  const handleStopAllCameras = () => {
    cameraSlotsRef.current.forEach((slot) => {
      handleStopSlotCamera(slot.id);
    });
    stopCamera();
    setCurrentPlate('READY');
  };

  async function startVisibleCameras(options: { resumeScanning?: boolean } = {}) {
    const slots = cameraSlotsRef.current;
    const results = await Promise.all(slots.map((s) => handleStartSlotCamera(s.id)));
    return results.some(Boolean);
  }

  const handleUseCamera = async (slot: CameraSlot, index: number) => {
    const devices = await refreshCameraList();
    const resolvedSlot = {
      ...slot,
      deviceId: slot.deviceId || devices[index]?.deviceId || devices[0]?.deviceId || '',
    };
    setCameraSlots((slots) => slots.map((item) => (item.id === slot.id ? resolvedSlot : item)));
    handleSelectActiveSlot(slot.id);
    await handleStartSlotCamera(slot.id);
  };

  const handleSelectActiveSlot = (slotId: string) => {
    setActiveCameraSlotId(slotId);
    if (isScanning) {
      setLastDetectedSlotId(slotId);
      setCurrentPlate((plate) => (plate === 'READY' || plate === 'PAUSED' ? 'SCANNING' : plate));
    }
  };

  const handleCameraSlotDeviceChange = async (slotId: string, deviceId: string) => {
    const duplicateDeviceSelected = Boolean(
      deviceId && cameraSlotsRef.current.some((slot) => slot.id !== slotId && slot.deviceId === deviceId)
    );
    if (duplicateDeviceSelected) {
      setCameraError(
        language === 'BM'
          ? 'Kamera itu sudah digunakan. Pilih kamera lain untuk pengimbas kedua.'
          : 'That camera is already in use. Choose another camera for the second scanner.'
      );
      return;
    }

    const isRunning = cameraSlotStatusRef.current[slotId] === 'RUNNING';
    rememberSelectedCamera(deviceId);
    const updatedSlot: CameraSlot = { id: slotId, deviceId };
    setCameraSlots((slots) => slots.map((slot) => (slot.id === slotId ? updatedSlot : slot)));
    handleSelectActiveSlot(slotId);

    if (isRunning) {
      handleStopSlotCamera(slotId);
      await handleStartSlotCamera(slotId);
    }
  };

  const handleSelectTrainingVideo = async (videoId: string) => {
    setSelectedTrainingVideoId(videoId);
    setCustomUploadedVideoUrl(null);
    selectedTrainingVideoIdRef.current = videoId;
    customUploadedVideoUrlRef.current = null;

    const resume = isScanningRef.current || isCameraReadyRef.current || scannerStartupInFlightRef.current;
    stopCamera();
    if (resume) await handleStartScanning();
  };

  const handleCustomVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setCustomUploadedVideoUrl(objectUrl);
    customUploadedVideoUrlRef.current = objectUrl;
    const resume = isScanningRef.current || isCameraReadyRef.current || scannerStartupInFlightRef.current;
    stopCamera();
    if (resume) await handleStartScanning();
  };

  const handleSampleVideoEnded = (slotId: string) => {
    const existingTimer = sampleEndTimersRef.current[slotId];
    if (existingTimer) window.clearTimeout(existingTimer);

    if (!isScanningRef.current) return;
    const runtime = getSlotRuntime(slotId);
    const generation = runtime.ocrGeneration;
    runtime.drainDeadline = Date.now() + SAMPLE_VIDEO_END_SETTLE_MAX_MS;
    runtime.bestFrameSelector.retainForDrain(runtime.drainDeadline);
    setIsFinishingSample(true);
    const settle = () => {
      const video = videoRefs.current[slotId];
      if (!video || runtime.ocrGeneration !== generation || !isScanningRef.current) return;
      const eligible = runtime.tracker.getActiveTracks(false).some(track =>
        !track.cooldownActive && !track.scanEventId && track.bbox.width >= 24 &&
        runtime.bestFrameSelector.getTopCrops(track.trackNumber, 16).some(crop =>
          canDrainOcrCrop(track.stats?.ocrAttempts ?? 0, crop.id, track.ocrAttemptedCropIds)
        )
      );
      const finalFramePending = (runtime.lastProcessedMediaTime ?? -1) < video.currentTime - 0.001;
      if (shouldContinueSampleDrain(
        ocrWorkPool.current.activeCount + (runtime.detectorRunning ? 1 : 0),
        finalFramePending, eligible, Date.now(), runtime.drainDeadline ?? 0
      )) {
        sampleEndTimersRef.current[slotId] = window.setTimeout(settle, 100);
        return;
      }
      delete sampleEndTimersRef.current[slotId];
      runtime.drainDeadline = undefined;
      runtime.bestFrameSelector.retainForDrain(0);
      setIsFinishingSample(false);
      handleStopSlotCamera(slotId);
    };
    sampleEndTimersRef.current[slotId] = window.setTimeout(settle, 100);
  };

  const handleStartScanning = async () => {
    await handleStartAllCameras();
  };

  const handleStopScanning = () => {
    handleStopAllCameras();
  };

  const handleMobileFacingModeChange = (mode: MobileFacingMode) => {
    if (mobileFacingModeRef.current === mode) return;

    mobileFacingModeRef.current = mode;
    setMobileFacingMode(mode);

    if (!isMobileScannerDevice()) return;

    const wasScanning = isScanningRef.current;
    const hadCameraOpen = isCameraReadyRef.current || previewSlotIds.length > 0;
    if (!hadCameraOpen && !wasScanning) return;

    stopCamera({ preserveScanningState: wasScanning, invalidatePendingStarts: false });
    void startVisibleCamerasRef.current({ resumeScanning: wasScanning });
  };

  const handleAddCamera = async () => {
    if (!supportsMultiCameraScanRef.current) return;

    const devices = await refreshCameraList();
    const nextDeviceId = getUnusedCameraDeviceId(devices, cameraSlotsRef.current);
    if (!nextDeviceId) {
      setCameraError(
        language === 'BM'
          ? 'Sambung atau benarkan kamera kedua sebelum tambah pengimbas.'
          : 'Connect or allow a second camera before adding another scanner.'
      );
      return;
    }

    setCameraSlots((slots) => {
      if (slots.length >= 4) return slots;
      return [...slots, { id: `camera-slot-${Date.now()}`, deviceId: nextDeviceId }];
    });
    setCameraError('');
  };

  const handleRemoveCamera = (slotId: string) => {
    // ── 1. Stop the MediaStream tracks for this slot only ──────────────────
    const stream = activeStreamsRef.current[slotId];
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      delete activeStreamsRef.current[slotId];
    }

    // ── 2. Tear down the video element ─────────────────────────────────────
    const video = videoRefs.current[slotId];
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
    }

    // ── 3. Clear the overlay canvas for this slot ──────────────────────────
    const overlayCanvas = canvasRefs.current[slotId];
    if (overlayCanvas) {
      overlayCanvas.getContext('2d')?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    // ── 4. Clear slot runtime (tracker, best-frame selector, canvases) ─────
    const runtime = slotRuntimesRef.current[slotId];
    if (runtime) {
      runtime.tracker.clear();
      runtime.bestFrameSelector.resetAll();
      // Increment generation so any in-flight OCR tasks abort cleanly.
      runtime.ocrGeneration++;
      runtime.drainDeadline = undefined;
      runtime.lastProcessedMediaTime = undefined;
      if (runtime.processingCanvas) {
        releaseCanvasMemory(runtime.processingCanvas);
        runtime.processingCanvas = null;
      }
      if (runtime.sourceFrameCanvas) {
        releaseCanvasMemory(runtime.sourceFrameCanvas);
        runtime.sourceFrameCanvas = null;
      }
      delete slotRuntimesRef.current[slotId];
    }

    // ── 5. Clear slot metrics ──────────────────────────────────────────────
    delete slotMetricsRef.current[slotId];

    // ── 6. Clear lost-track ids for this slot ─────────────────────────────
    lostTrackIdsRef.current = new Set(
      Array.from(lostTrackIdsRef.current).filter((key) => !key.startsWith(`${slotId}:`))
    );

    // ── 7. Clear slot status / errors ─────────────────────────────────────
    delete cameraSlotStatusRef.current[slotId];
    delete cameraSlotErrorsRef.current[slotId];
    setCameraSlotStatuses((prev) => { const next = { ...prev }; delete next[slotId]; return next; });
    setCameraSlotErrors((prev) => { const next = { ...prev }; delete next[slotId]; return next; });

    // ── 8. Update UI overlay state ─────────────────────────────────────────
    setClosedOverlaySlotIds((ids) => ids.filter((id) => id !== slotId));
    setCollapsedOverlaySlotIds((ids) => ids.filter((id) => id !== slotId));
    setExpandedOverlaySlotIds((ids) => ids.filter((id) => id !== slotId));

    // ── 9. Remove the slot from the camera list ────────────────────────────
    setCameraSlots((slots) => {
      if (slots.length <= 1) return slots;
      const nextSlots = slots.filter((slot) => slot.id !== slotId);

      if (activeCameraSlotId === slotId) {
        setActiveCameraSlotId(nextSlots[0]?.id || 'camera-slot-1');
      }
      setPreviewSlotIds((ids) => ids.filter((id) => id !== slotId));
      setActiveAlertMatchesBySlot((alerts) => {
        if (!alerts[slotId]) return alerts;
        const nextAlerts = { ...alerts };
        delete nextAlerts[slotId];
        return nextAlerts;
      });

      // If any other slot is still running keep scanning state intact;
      // only clear it when this was the very last running slot.
      const anyStillRunning = Object.entries(cameraSlotStatusRef.current).some(
        ([id, status]) => id !== slotId && status === 'RUNNING'
      );
      if (!anyStillRunning) {
        isCameraReadyRef.current = false;
        setIsCameraReady(false);
        isScanningRef.current = false;
        setIsScanning(false);
        setCurrentPlate('READY');
      }

      return nextSlots;
    });
  };

  function playAlertChime() {
    if (!soundEnabledRef.current) return;
    try {
      const audioWindow = window as AudioWindow;
      const AudioCtor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
      if (!AudioCtor) return;
      const audioCtx = new AudioCtor();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch {
      // Silent fallback when audio playback is blocked by the browser.
    }
  }

  const getCameraSlotLabelFromRefs = useCallback(
    (slotId: string) => {
      const runtimeLabel = cameraMetadataBySlotRef.current[slotId]?.label;
      if (runtimeLabel) return runtimeLabel;
      const slots = cameraSlotsRef.current;
      const slotIndex = slots.findIndex((slot) => slot.id === slotId);
      const slot = slots[slotIndex] || slots[0];
      if (!slot) return language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera';
      const device = availableCamerasRef.current.find((cameraDevice) => cameraDevice.deviceId === slot.deviceId);
      return (
        device?.label ||
        (slotIndex <= 0 ? (language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera') : `Camera ${slotIndex + 1}`)
      );
    },
    [language]
  );

  const runDatabaseMatch = useCallback(
    async (
      track: ActiveTrack,
      plate: string,
      confidence: number,
      slotId: string,
      options: { commitNoCase?: boolean; plateSnapshotDataUrl?: string; ocrStartedAt?: number; ocrElapsedMs?: number; observationBox?: BoundingBox; capturedAt?: number; corroboratingObservations?: number } = {}
    ) => {
      const commitNoCase = options.commitNoCase ?? true;
      const normalizedPlate = cleanPlateNumber(plate);
      // One publication gate applies to samples, live cameras and DB matches.
      if (!canPublishPlate(
        normalizedPlate,
        confidence,
        settingsRef.current.recognitionThreshold,
        options.corroboratingObservations,
        {
          detectorConfidence: track.bbox.confidence,
          cropWidth: options.observationBox?.width ?? track.bbox.width,
          cropHeight: options.observationBox?.height ?? track.bbox.height,
          aspectRatio: (options.observationBox?.width ?? track.bbox.width) / Math.max(1, options.observationBox?.height ?? track.bbox.height),
          qualityScore: track.qualityScore,
        }
      )) {
        track.ocrState = 'CONSENSUS_BUILDING';
        track.pipelineState = 'CONSENSUS';
        return;
      }
      const cooldownMs = settingsRef.current.duplicateCooldown * 1000;
      const now = Date.now();
      const cooldownKey = `${slotId}:${normalizedPlate}`;
      const lastSearch = cooldownMap.current.get(cooldownKey) ?? 0;

      if (commitNoCase && now - lastSearch < cooldownMs) {
        track.ocrState = 'COOLDOWN';
        track.pipelineState = 'COOLDOWN';
        track.cooldownActive = true;
        track.cooldownStartedAt = now;
        runtimeMetricsRef.current.duplicateOcrSkippedCount++;
        return;
      }

      track.lastSearchedAt = now;
      track.ocrState = 'DB_CHECKING';
      track.pipelineState = 'CONSENSUS';

      const vehicleCases = vehicleLookupRef.current.index;
      const evaluation = evaluateDatabaseMatch(
        normalizedPlate,
        confidence,
        vehicleCases,
        undefined,
        Math.max(settingsRef.current.recognitionThreshold, OCR_DB_EXACT_LOCK_MIN_CONFIDENCE)
      );
      const matchedVehicle =
        evaluation.matchedVehicle ? vehicleLookupRef.current.byId.get(evaluation.matchedVehicle.id) || null : null;
      const possibleVehicles = evaluation.possibleMatches
        .map((possibleVehicle) => vehicleLookupRef.current.byId.get(possibleVehicle.id) || null)
        .filter((vehicle): vehicle is Vehicle => Boolean(vehicle));

      if (evaluation.matchType === 'INSUFFICIENT_CONFIDENCE') {
        track.ocrState = 'CONSENSUS_BUILDING';
        track.pipelineState = 'CONSENSUS';
        return;
      }

      const resolvedMatchType =
        evaluation.matchType === 'EXACT' && matchedVehicle
          ? 'EXACT'
          : evaluation.matchType === 'POSSIBLE' && possibleVehicles.length > 0
          ? 'POSSIBLE'
          : 'NONE';
      const resolvedPlate = cleanPlateNumber(evaluation.normalizedPlate || normalizedPlate);
      const resolvedConfidence = Math.min(confidence, evaluation.confidence);
      if (track.scanEventId && track.matchType === resolvedMatchType && track.stabilizedPlate === resolvedPlate) return;

      updateLiveTrackItem({
        trackId: track.trackId,
        trackNumber: track.trackNumber,
        plate: resolvedPlate,
        confidence: resolvedConfidence,
        status: 'recognised',
        matchType: resolvedMatchType,
        lastDetectorLatencyMs: track.stats?.lastDetectorLatencyMs,
        lastOcrLatencyMs: options.ocrElapsedMs,
      });

      if (resolvedMatchType === 'POSSIBLE') {
        const samePossibleFamily =
          Boolean(track.possibleVerificationPlate) &&
          isSamePhysicalPlateReading(track.possibleVerificationPlate || '', resolvedPlate) &&
          now - (track.possibleVerificationStartedAt ?? 0) <= 2500;
        track.possibleVerificationPlate = resolvedPlate;
        track.possibleVerificationCount = samePossibleFamily
          ? (track.possibleVerificationCount ?? 0) + 1
          : 1;
        track.possibleVerificationStartedAt = samePossibleFamily
          ? track.possibleVerificationStartedAt
          : now;

        // A near-match still needs confirmation, but two observations are
        // enough for a moving vehicle. Plate-family deduplication below keeps
        // AN7569/ANN7569-style corrections in one result card.
        if ((track.possibleVerificationCount ?? 0) < 2) {
          track.ocrState = 'CONSENSUS_BUILDING';
          track.pipelineState = 'CONSENSUS';
          return;
        }
      } else {
        track.possibleVerificationPlate = undefined;
        track.possibleVerificationCount = undefined;
        track.possibleVerificationStartedAt = undefined;
      }

      if (!commitNoCase && resolvedMatchType === 'NONE') {
        track.ocrState = 'CONSENSUS_BUILDING';
        track.pipelineState = 'CONSENSUS';
        return;
      }

      const finalLockMinConfidence = getDatabaseFinalLockMinConfidence(
        resolvedMatchType,
        commitNoCase,
        settingsRef.current.recognitionThreshold
      );

      if (resolvedConfidence < finalLockMinConfidence) {
        if (!commitNoCase) {
          track.ocrState = 'CONSENSUS_BUILDING';
          track.pipelineState = 'CONSENSUS';
          track.matchType = undefined;
          track.matchedVehicle = undefined;
          track.possibleMatchVehicles = undefined;
          track.scanEventId = undefined;
          track.cooldownActive = false;
          track.cooldownStartedAt = undefined;
          if (!track.scanEventId) {
            track.stabilizedPlate = undefined;
            track.stabilizedConfidence = undefined;
          }
          return;
        }
      }

      const evidenceCount = Math.max(1, track.ocrFrameCandidates?.size
        ? [...track.ocrFrameCandidates.values()].filter(frame => (frame.get(normalizedPlate) ?? 0) >= 0.90).length
        : track.votes.get(normalizedPlate)?.count ?? 1);
      const recentFamilyEntry = Array.from(recentPlateFamiliesRef.current.entries()).find(([familyKey, family]) =>
        familyKey.startsWith(`${slotId}:`) &&
        family.timestamp >= now - Math.min(cooldownMs, 12000) &&
        (cleanPlateNumber(family.plate) === normalizedPlate || family.detectionId === track.scanEventId ||
          isSameRecentPlateObservation(family.plate, normalizedPlate, family.bbox, options.observationBox ?? track.bbox, Math.abs((options.capturedAt ?? now) - family.capturedAt)))
      );
      const recentFamily = recentFamilyEntry?.[1];
      const recentClean = recentFamily ? cleanPlateNumber(recentFamily.plate) : '';
      const recentPattern = recentFamily ? validateMalaysianPattern(recentClean) : null;
      const resolvedPattern = validateMalaysianPattern(normalizedPlate);

      const incomingIsClearUpgrade = Boolean(
        recentFamily &&
        ((resolvedPattern.isValid && !recentPattern?.isValid) ||
          (evidenceCount > recentFamily.evidenceCount && resolvedPattern.isValid) ||
          (normalizedPlate.length === recentClean.length && resolvedConfidence > recentFamily.confidence + 0.01))
      );

      const recentIsStronger = Boolean(
        recentFamily &&
        !incomingIsClearUpgrade &&
        (recentFamily.matchType === 'EXACT' ||
          (resolvedMatchType !== 'EXACT' &&
            recentFamily.evidenceCount >= evidenceCount &&
            recentFamily.confidence >= resolvedConfidence - 0.05))
      );

      if (recentFamily && recentIsStronger) {
        track.ocrState = 'COOLDOWN';
        track.pipelineState = 'COOLDOWN';
        track.cooldownActive = true;
        track.cooldownStartedAt = now;
        track.scanEventId = recentFamily.detectionId;
        runtimeMetricsRef.current.duplicateOcrSkippedCount++;
        return;
      }

      const shouldSuppressResolvedDuplicate = resolvedMatchType !== 'POSSIBLE';
      const resolvedLastSearch = cooldownMap.current.get(`${slotId}:${resolvedPlate}`) ?? 0;
      if (shouldSuppressResolvedDuplicate && now - resolvedLastSearch < cooldownMs) {
        track.ocrState = 'COOLDOWN';
        track.pipelineState = 'COOLDOWN';
        track.cooldownActive = true;
        track.cooldownStartedAt = now;
        runtimeMetricsRef.current.duplicateOcrSkippedCount++;
        return;
      }

      if (resolvedMatchType !== 'POSSIBLE') cooldownMap.current.set(`${slotId}:${resolvedPlate}`, now);
      track.stabilizedPlate = resolvedPlate;
      track.stabilizedConfidence = resolvedConfidence;
      track.committedPlate = resolvedPlate;
      track.labelShown = true;
      track.labelLocked = true;
      track.ocrEvidencePending = false;

      const timestamp = new Date();
      const scanCameraName = getCameraSlotLabelFromRefs(slotId);
      const scanLocation: ScanLocation = { name: scanCameraName, gps: 'Unavailable' };
      const confidencePercent = Number((resolvedConfidence * 100).toFixed(1));
      const detectionId = recentFamily?.detectionId || track.scanEventId || `det-${crypto.randomUUID()}`;
      const sampleVideo = scannerSourceModeRef.current === 'SAMPLE_VIDEO' ? videoRefs.current[slotId] : null;
      const detectedAtVideoSeconds = track.firstSeenMediaTimeSeconds;
      const readAtVideoSeconds = sampleVideo?.currentTime;
      const newDetection: SessionDetection = {
        id: detectionId,
        plate: resolvedPlate,
        confidence: confidencePercent,
        matched: resolvedMatchType === 'EXACT',
        vehicleId: matchedVehicle?.id,
        timestamp: timestamp.toLocaleTimeString('en-GB'),
        cameraId: slotId || 'laptop-camera',
        cameraName: scanCameraName,
        name: scanLocation.name,
        gps: scanLocation.gps,
        matchType: resolvedMatchType,
        possibleVehicleIds: possibleVehicles.map((vehicle) => vehicle.id),
        recordedAtMs: now,
        evidenceCount,
        detectedAtVideoSeconds,
        readAtVideoSeconds,
        recognitionDurationMs: Math.max(0, now - track.firstSeenTimestamp),
        // All timing values are wall-clock durations from the source frame;
        // media timeline positions remain separate metadata for sample clips.
        detectionLatencyMs: track.stats?.lastDetectorLatencyMs ?? 0,
        readLatencyMs: Math.round(options.ocrElapsedMs ?? track.stats?.lastOcrLatencyMs ?? 0),
        processingDurationMs: Math.round(
          (track.stats?.lastDetectorLatencyMs ?? 0) +
          (track.stats?.queueWaitMs ?? 0) +
          (options.ocrElapsedMs ?? track.stats?.lastOcrLatencyMs ?? 0)
        ),
        frameAgeMs: Math.max(0, now - (track.lastSeenFrameCapturedAt ?? now)),
        snapshotDataUrl: options.plateSnapshotDataUrl || track.cropSamples.find((sample) => sample.dataUrl)?.dataUrl,
        actionStatus: resolvedMatchType === 'EXACT' && matchedVehicle ? 'PENDING' : undefined,
      };

      bumpDiag('committed');
      console.info(`[ANPR:COMMITTED] trackId=${track.trackId} finalNormalizedPlate="${resolvedPlate}" confidence=${resolvedConfidence.toFixed(2)} matchType=${resolvedMatchType}`);

      if (settingsRef.current.debugMode) {
        console.debug(`[ANPR:${slotId}] confirmed detection`, {
          trackId: track.trackId,
          detectorBox: options.observationBox ?? track.bbox,
          plate: resolvedPlate,
          confidence: resolvedConfidence,
          evidenceCount,
          matchType: resolvedMatchType,
          timestamp: timestamp.toISOString(),
        });
      }

      setCurrentPlate(resolvedPlate);
      setLastDetectedSlotId(slotId);
      setLiveDetections((prevStream) => {
        const newClean = cleanPlateNumber(newDetection.plate);
        if (!newClean) return prevStream;

        let existingIndex = -1;
        for (let i = 0; i < prevStream.length; i++) {
          const item = prevStream[i];
          if (item.id === newDetection.id) {
            existingIndex = i;
            break;
          }
          if (item.cameraId === newDetection.cameraId) {
            const itemClean = cleanPlateNumber(item.plate);
            if (itemClean === newClean || arePlatesSameVehicleFamily(itemClean, newClean)) {
              existingIndex = i;
              break;
            }
          }
        }

        if (existingIndex >= 0) {
          const existingItem = prevStream[existingIndex];
          const newValid = validateMalaysianPattern(newClean).isValid;
          const existingValid = validateMalaysianPattern(cleanPlateNumber(existingItem.plate)).isValid;

          // Same-event corrections may be shorter or longer. Length alone
          // must never promote an inserted OCR digit.
          const isNewBetter = newValid && (!existingValid ||
            newDetection.confidence > existingItem.confidence ||
            (newDetection.evidenceCount ?? 1) > (existingItem.evidenceCount ?? 1));

          const updatedItem: SessionDetection = isNewBetter
            ? {
                ...newDetection,
                id: existingItem.id || newDetection.id,
                evidenceCount: Math.max(existingItem.evidenceCount ?? 1, newDetection.evidenceCount ?? 1),
                snapshotDataUrl: newDetection.snapshotDataUrl || existingItem.snapshotDataUrl,
              }
            : {
                ...existingItem,
                evidenceCount: Math.max(existingItem.evidenceCount ?? 1, newDetection.evidenceCount ?? 1),
                snapshotDataUrl: existingItem.snapshotDataUrl || newDetection.snapshotDataUrl,
              };

          const nextStream = [...prevStream];
          nextStream.splice(existingIndex, 1);
          nextStream.unshift(updatedItem);

          localStorage.setItem(
            RECENT_DETECTIONS_STORAGE_KEY,
            JSON.stringify(nextStream.slice(0, 100), (key, value) =>
              key === 'snapshotDataUrl' ? undefined : value
            )
          );
          return nextStream;
        }

        const nextStream = [newDetection, ...prevStream];
        // The visible session list is append-only (apart from same-plate
        // deduplication), so a confirmed plate does not disappear when later
        // vehicles are read. Persist a bounded metadata-only copy to avoid
        // filling localStorage with base64 snapshots.
        localStorage.setItem(
          RECENT_DETECTIONS_STORAGE_KEY,
          JSON.stringify(nextStream.slice(0, 100), (key, value) =>
            key === 'snapshotDataUrl' ? undefined : value
          )
        );
        return nextStream;
      });
      if (recentFamilyEntry) recentPlateFamiliesRef.current.delete(recentFamilyEntry[0]);
      recentPlateFamiliesRef.current.set(`${slotId}:${detectionId}`, {
        bbox: { ...(options.observationBox ?? track.bbox) },
        capturedAt: options.capturedAt ?? now,
        plate: resolvedPlate,
        detectionId,
        confidence: resolvedConfidence,
        evidenceCount,
        matchType: resolvedMatchType,
        timestamp: now,
      });

      addHistoryLogRef.current({
        type: 'DETECTION',
        action:
          resolvedMatchType === 'EXACT'
            ? `Tanda Tindakan (Pengimbas): ${resolvedPlate}`
            : resolvedMatchType === 'POSSIBLE'
            ? `Possible Match (Pengimbas): ${resolvedPlate}`
            : `Live Scan: ${resolvedPlate}`,
        plate: resolvedPlate,
        details:
          resolvedMatchType === 'EXACT' && matchedVehicle
            ? `AI Confidence: ${confidencePercent}% - Tanda Tindakan: ${matchedVehicle.brand} ${matchedVehicle.model} - Location: ${scanLocation.name} (${scanLocation.gps})`
            : resolvedMatchType === 'POSSIBLE'
            ? `AI Confidence: ${confidencePercent}% - Possible Match: ${possibleVehicles
                .map((vehicle) => vehicle.plate)
                .join(', ')} - Location: ${scanLocation.name} (${scanLocation.gps})`
            : `AI Confidence: ${confidencePercent}% - No Match Found - Location: ${scanLocation.name} (${scanLocation.gps})`,
        note:
          resolvedMatchType === 'EXACT' && matchedVehicle
            ? `Match Found: ${matchedVehicle.brand} ${matchedVehicle.model} via ${scanCameraName} at ${scanLocation.name}`
            : resolvedMatchType === 'POSSIBLE'
            ? `Possible match from ${scanCameraName}: ${possibleVehicles.map((vehicle) => vehicle.plate).join(', ')}`
            : `No match from ${scanCameraName} at ${scanLocation.name}`,
        cameraId: slotId || 'laptop-camera',
        cameraName: scanCameraName,
        userRole: role,
        statusMatch: resolvedMatchType,
      });

      const completedAt = Date.now();
      const startedAt = track.stats?.startedAt ?? completedAt;
      const consensusCount = Array.from(track.votes.values()).reduce((sum, vote) => sum + vote.count, 0);
      const processingTimeMs = Math.max(0, completedAt - startedAt);
      if (!track.scanEventId) runtimeMetricsRef.current.completedTrackCount++;
      runtimeMetricsRef.current.trackLifetimeTotalMs += processingTimeMs;
      if (track.stats) {
        track.stats.finishedAt = completedAt;
        track.stats.finalConfidence = confidence;
      }
      completedTrackEventsRef.current = completedTrackEventsRef.current.filter(event => event.id !== detectionId);
      completedTrackEventsRef.current.unshift({
        id: detectionId,
        trackId: track.trackId,
        cameraId: slotId || 'laptop-camera',
        cameraName: scanCameraName,
        plate: resolvedPlate,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(completedAt).toISOString(),
        durationMs: processingTimeMs,
        detectorConfidence: Math.round((track.bbox.confidence ?? 0) * 100) / 100,
        detectorLatencyMs: track.stats?.lastDetectorLatencyMs ?? Math.round(runtimeMetricsRef.current.detectorLatencySamples > 0
          ? runtimeMetricsRef.current.detectorLatencyTotalMs / runtimeMetricsRef.current.detectorLatencySamples
          : 0),
        trackConfidence: Math.round((track.trackConfidence ?? 0) * 100) / 100,
        confidenceComponents: track.confidenceComponents,
        ocrConfidence: Math.round(confidence * 100) / 100,
        ocrLatencyMs: track.stats?.lastOcrLatencyMs ?? Math.round(runtimeMetricsRef.current.ocrLatencySamples > 0
          ? runtimeMetricsRef.current.ocrLatencyTotalMs / runtimeMetricsRef.current.ocrLatencySamples
          : 0),
        consensusCount,
        matchType: resolvedMatchType,
        motionLevel: getMotionOcrMode(track),
        cropQuality: Math.round((track.stats?.bestCropQuality ?? 0) * 100) / 100,
        processingTimeMs,
        reasonForCompletion:
          resolvedMatchType === 'EXACT'
            ? 'DATABASE_EXACT_MATCH'
            : resolvedMatchType === 'POSSIBLE'
            ? 'DATABASE_POSSIBLE_MATCH'
            : 'DATABASE_NO_MATCH',
        deviceTier: runtimeMetricsRef.current.deviceTier,
        environment: runtimeMetricsRef.current.currentEnvironment,
        environmentConfidence: runtimeMetricsRef.current.currentEnvironmentConfidence,
        qualityClass: runtimeMetricsRef.current.currentQuality,
        qualityConfidence: runtimeMetricsRef.current.currentQualityConfidence,
      });
      if (completedTrackEventsRef.current.length > 50) {
        completedTrackEventsRef.current.length = 50;
      }

      track.matchType = resolvedMatchType;
      track.matchedVehicle = matchedVehicle ?? undefined;
      track.possibleMatchVehicles = possibleVehicles;
      track.ocrState =
        resolvedMatchType === 'EXACT' ? 'MATCHED' : resolvedMatchType === 'POSSIBLE' ? 'POSSIBLE MATCH' : 'NO CASE';
      track.pipelineState = resolvedMatchType === 'EXACT' ? 'MATCHED' : 'COOLDOWN';
      track.scanEventId = detectionId;

      if (resolvedMatchType === 'EXACT' && matchedVehicle) {
        updateVehicleLastSeenRef.current(matchedVehicle.id, {
          camera: scanCameraName,
          confidence: confidencePercent,
          timestamp: new Date().toISOString(),
        });

        const alertSlotId = slotId || 'laptop-camera';
        setActiveAlertMatchesBySlot((prev) => ({
          ...prev,
          [alertSlotId]: {
            vehicle: matchedVehicle,
            cameraName: scanCameraName,
            cameraId: alertSlotId,
            detectionId,
            snapshotDataUrl: newDetection.snapshotDataUrl,
            confidence: confidencePercent,
            timestamp: newDetection.timestamp,
            actionStatus: 'PENDING',
          },
        }));
        playAlertChime();
      }

      track.ocrState = resolvedMatchType === 'POSSIBLE' ? 'CONSENSUS_BUILDING' : 'COOLDOWN';
      track.pipelineState = resolvedMatchType === 'POSSIBLE' ? 'CONSENSUS' : 'COOLDOWN';
      track.cooldownActive = resolvedMatchType !== 'POSSIBLE';
      track.cooldownStartedAt = track.cooldownActive ? Date.now() : undefined;
    },
    [getCameraSlotLabelFromRefs, role]
  );

  const queueEnvironmentSample = useCallback(
    (sourceCanvas: HTMLCanvasElement, cameraFpsEstimate: number) => {
      if (environmentInferenceRunningRef.current || sourceCanvas.width === 0 || sourceCanvas.height === 0) return;

      environmentInferenceRunningRef.current = true;
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = sourceCanvas.width;
      sampleCanvas.height = sourceCanvas.height;
      const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
      if (!sampleCtx) {
        environmentInferenceRunningRef.current = false;
        return;
      }

      sampleCtx.drawImage(sourceCanvas, 0, 0);

      void (async () => {
        try {
          const profile = await classifyEnvironment(sampleCanvas, environmentStatsRef.current);
          const shouldAdapt = isEnvironmentProfileActionable(profile);
          environmentStatsRef.current = profile.stats;

          const metrics = runtimeMetricsRef.current;
          metrics.environmentDistribution = incrementDistribution(metrics.environmentDistribution, profile.label);
          metrics.cameraHealth = createCameraHealthSnapshot(
            profile.stats,
            cameraFpsEstimate,
            metrics.droppedFrameCount
          );

          if (shouldAdapt) {
            environmentProfileRef.current = profile;
            const nextConfig = createAdaptiveScannerConfig(profile);
            adaptiveConfigRef.current = nextConfig;

            metrics.currentEnvironment = profile.label;
            metrics.currentEnvironmentConfidence = profile.confidence;
            metrics.currentEnvironmentSource = profile.source;

            setEnvironmentProfile(profile);
            setAdaptiveConfigSnapshot(nextConfig);

            Object.values(slotRuntimesRef.current).forEach((runtime) => {
              runtime.bestFrameSelector.configure({
                maxBufferSize: Math.max(12, nextConfig.buffer.maxSize),
                maxEntryAgeMs: Math.max(5000, nextConfig.buffer.maxEntryAgeMs),
              });
            });

            void applyActiveCameraConstraints();
          } else {
            const activeProfile = environmentProfileRef.current;
            metrics.currentEnvironment = activeProfile.label;
            metrics.currentEnvironmentConfidence = activeProfile.confidence;
            metrics.currentEnvironmentSource = activeProfile.source;
          }
        } catch (err) {
          console.warn('[Scanner] Environment classifier failed:', err);
        } finally {
          releaseCanvasMemory(sampleCanvas);
          environmentInferenceRunningRef.current = false;
        }
      })();
    },
    [applyActiveCameraConstraints]
  );

  const collectDatasetSample = useCallback(
    (args: {
      sourceCanvas: HTMLCanvasElement;
      cropCanvas: HTMLCanvasElement;
      sourceSlotId: string;
      environment: EnvironmentClass;
      environmentConfidence: number;
      qualityClass: PlateQualityClass;
      qualityConfidence: number;
      qualityScore: number;
      qualityBackend: PlateQualityAssessment['backend'];
      qualityRejectionReasons: string[];
      selectedPreprocessing: string[];
      ocrResult: string;
      ocrConfidence: number;
      detectorConfidence: number;
      trackConfidence: number;
    }) => {
      if (!datasetModeRef.current) return;

      const timestamp = new Date().toISOString();
      const id = `sample-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const folderPath = `dataset/${args.environment.toLowerCase()}/${args.qualityClass.toLowerCase()}/${id}`;
      const sample: DatasetSample = {
        id,
        timestamp,
        folderPath,
        originalImageDataUrl: canvasToJpegDataUrl(args.sourceCanvas, 0.72),
        plateCropDataUrl: canvasToJpegDataUrl(args.cropCanvas, 0.88),
        environmentClass: args.environment,
        environmentConfidence: args.environmentConfidence,
        qualityClass: args.qualityClass,
        qualityConfidence: args.qualityConfidence,
        qualityScore: args.qualityScore,
        qualityBackend: args.qualityBackend,
        qualityRejectionReasons: args.qualityRejectionReasons,
        selectedPreprocessing: args.selectedPreprocessing,
        ocrResult: args.ocrResult,
        ocrConfidence: args.ocrConfidence,
        detectorConfidence: args.detectorConfidence,
        trackConfidence: args.trackConfidence,
        camera: cameraMetadataBySlotRef.current[args.sourceSlotId] ?? null,
      };

      datasetSamplesRef.current.unshift(sample);
      if (datasetSamplesRef.current.length > DATASET_SAMPLE_LIMIT) {
        datasetSamplesRef.current.length = DATASET_SAMPLE_LIMIT;
      }
    },
    []
  );

  // ─── Stable registries shared between the detection effect and the slot-sync ───
  // The detection useEffect owns the scheduler and writes runners here.
  // The slot-sync useEffect adds/removes individual runners without restarting the scheduler.
  const slotRunnersRegistryRef = useRef<Map<string, { runDetection: () => Promise<number | void> }>>(new Map());
  const slotAnimCleanupRef = useRef<Map<string, () => void>>(new Map());
  // A session-level stopped flag shared across both effects so dynamically
  // added runners can honour the same stop signal as the initial runners.
  const stoppedSessionRef = useRef(false);
  // Factory function ref: the main detection effect writes a slot-runner
  // factory here; the slot-sync effect calls it to register new slots.
  type SlotRunnerFactory = (slotId: string) => (() => void);
  const registerSlotRunnerRef = useRef<SlotRunnerFactory | null>(null);

  useEffect(() => {
    if (!isCameraReady || !isScanning || scannerProcessingPaused) return;

    let stopped = false;
    stoppedSessionRef.current = false;
    registerSlotRunnerRef.current = null;

    // Read the current slots from the ref so we don't capture stale state.
    // The scheduler's getSlotIds() also reads refs, so dynamic slot changes
    // are picked up without restarting this effect.
    const slotsToScan = cameraSlotsRef.current.filter(
      (slot) => previewSlotIdsRef.current.includes(slot.id) && videoRefs.current[slot.id]
    );

    if (slotsToScan.length === 0) return;

    // Point the shared registry at the local map so the slot-sync effect can update it.
    const slotRunners = slotRunnersRegistryRef.current;
    slotRunners.clear();
    const animCleanup = slotAnimCleanupRef.current;
    animCleanup.clear();

    const makeSlotRunner = (slotId: string): (() => void) => {
      // Idempotency guard: ensure exactly one active runner per camera slot.
      if (animCleanup.has(slotId)) {
        animCleanup.get(slotId)?.();
      }

      const runtime = getSlotRuntime(slotId);
      const metrics = ensureSlotMetrics(slotId);
      let animId: number;
      let lastVideoTime = -1;
      const frameAdmission = new VideoFrameAdmission();
      let lastDetectorValidationAt = 0;
      let lastEnvironmentSampleAt = 0;
      let emptyDetectionStreak = 0;
      let adaptiveDetectorIntervalMs = getTierDetectorTargetMs(runtimeMetricsRef.current.deviceTier);

      const resetSlotRuntimeForVideoLoop = () => {
        runtime.ocrGeneration++;
        runtime.tracker.clear();
        runtime.bestFrameSelector.resetAll();
        runtime.drainDeadline = undefined;
        runtime.lastProcessedMediaTime = undefined;
        runtime.lastMaintenanceTs = 0;
        metrics.platesVisible = 0;
        metrics.activeTracks = 0;
        metrics.tracks = [];
        lostTrackIdsRef.current = new Set(
          Array.from(lostTrackIdsRef.current).filter((trackKey) => !trackKey.startsWith(`${slotId}:`))
        );
      };

      const runDetection = async (): Promise<number | void> => {
        if (stopped) return;
        if (cameraSlotStatusRef.current[slotId] !== 'RUNNING') return 150;

        const video = videoRefs.current[slotId];

        if (!video) {
          return 150;
        }

        if (!isRuntimeScanningReady(runtimeStateRef.current)) {
          return 250;
        }

        if (video.readyState < 2 || video.videoWidth === 0) {
          return 150;
        }

        const decodedFrame = video.getVideoPlaybackQuality?.().totalVideoFrames;
        if (!frameAdmission.accept(video.currentTime, decodedFrame)) {
          if (video.ended) runtime.lastProcessedMediaTime = video.currentTime;
          // Drain saved crops even after playback ends; do not count the frozen
          // image as a fresh detector observation.
          if (runtime.processingCanvas) {
            void processOcrQueue(runtime.tracker.getTracksEligibleForOcr(false), runtime.processingCanvas, settingsRef.current, runtime, slotId);
          }
          return 16;
        }

        if (!runtime.processingCanvas) {
          runtime.processingCanvas = document.createElement('canvas');
        }

        const processingCanvas = runtime.processingCanvas;
        const adaptiveConfig = adaptiveConfigRef.current;
        const processingDimensions = getProcessingDimensions(
          video.videoWidth,
          video.videoHeight,
          runtimeMetricsRef.current.deviceTier,
          runtimeMetricsRef.current.adaptationLevel,
          adaptiveConfig.processing.maxLongEdge
        );
        if (processingCanvas.width !== processingDimensions.width || processingCanvas.height !== processingDimensions.height) {
          processingCanvas.width = processingDimensions.width;
          processingCanvas.height = processingDimensions.height;
        }

        const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });
        if (!processingCtx) {
          return 150;
        }

        const detectionStartedAt = performance.now();
        // Boxes must remain associated with the copied source frame, rather
        // than the newer frame displayed after detector inference finishes.
        const frameCapturedAt = Date.now();
        const frameMediaTimeSeconds = video.currentTime;
        const detectionGeneration = runtime.ocrGeneration;
        // OCR must retain source pixels; detector resizing can erase a thin
        // stroke on a distant plate. Both paths use the same captured frame.
        runtime.sourceFrameCanvas ??= document.createElement('canvas');
        const sourceFrame = runtime.sourceFrameCanvas;
        if (sourceFrame.width !== video.videoWidth || sourceFrame.height !== video.videoHeight) {
          sourceFrame.width = video.videoWidth; sourceFrame.height = video.videoHeight;
        }
        const sourceCtx = sourceFrame.getContext('2d');
        if (!sourceCtx) { return 150; }
        if (scannerSourceModeRef.current === 'CAMERA' && isCameraPreviewMirroredRef.current) {
          sourceCtx.save();
          sourceCtx.translate(sourceFrame.width, 0);
          sourceCtx.scale(-1, 1);
          sourceCtx.drawImage(video, 0, 0, sourceFrame.width, sourceFrame.height);
          sourceCtx.restore();
        } else {
          sourceCtx.drawImage(video, 0, 0, sourceFrame.width, sourceFrame.height);
        }
        processingCtx.drawImage(sourceFrame, 0, 0, processingCanvas.width, processingCanvas.height);
        await yieldToBrowser();

        const sampleNow = Date.now();
        if (sampleNow - lastEnvironmentSampleAt >= ENVIRONMENT_SAMPLE_INTERVAL_MS) {
          lastEnvironmentSampleAt = sampleNow;
          queueEnvironmentSample(processingCanvas, metrics.camFrames);
        }

        const scannerSettings = settingsRef.current;
        runtime.tracker.setLostTrackTimeout(
          Math.round((scannerSettings.lostTrackTimeout || INITIAL_SETTINGS.lostTrackTimeout) * adaptiveConfigRef.current.track.lifetimeMultiplier)
        );
        runtime.tracker.configureRuntime({
          maxPredictionFrames: adaptiveConfigRef.current.track.maxPredictionFrames,
          lostTrackTimeoutMs: adaptiveConfigRef.current.track.lostTrackTimeoutMs,
          unconfirmedTrackTimeoutMs: adaptiveConfigRef.current.track.unconfirmedTrackTimeoutMs,
        });
        runtime.tracker.setMaxActiveTracks(scannerSettings.maxTracks || INITIAL_SETTINGS.maxTracks);
        let detectedPlates: Awaited<ReturnType<typeof detectMalaysianPlates>> = [];

        runtime.detectorRunning = true;
        try {
          const deviceTier = runtimeMetricsRef.current.deviceTier;
          detectedPlates = await detectMalaysianPlates(processingCanvas, {
            minConfidence: Math.max(0.24, Math.min(scannerSettings.detectionThreshold || 0.30, 0.38)),
            enginePreference: scannerSettings.detectorEngine,
            developerMode: scannerSettings.debugMode,
            enhanceSmallPlates: deviceTier !== 'D',
            recoveryVariant: planDetectorRecovery(adaptiveConfig.environment.label, emptyDetectionStreak, environmentStatsRef.current),
          });
        } catch (err) {
          console.warn(`[Scanner:${slotId}] Detector frame failed:`, err);
        } finally {
          runtime.detectorRunning = false;
        }

        if (stopped || runtime.ocrGeneration !== detectionGeneration) {
          return 0;
        }
        const detectorElapsedMs = performance.now() - detectionStartedAt;
        emptyDetectionStreak = detectedPlates.length === 0 ? (emptyDetectionStreak + 1) % 12 : 0;
        const runtimeMetrics = runtimeMetricsRef.current;
        runtimeMetrics.detectorLatencyTotalMs += detectorElapsedMs;
        runtimeMetrics.detectorLatencySamples++;
        pushBoundedMetricSample(runtimeMetrics.detectorLatencyHistoryMs, detectorElapsedMs);
        addEnvironmentDetectorSample(runtimeMetrics, runtimeMetrics.currentEnvironment, detectorElapsedMs);
        if (detectorElapsedMs > adaptiveDetectorIntervalMs * 1.5) {
          runtimeMetrics.droppedFrameCount++;
        }

        if (detectedPlates.length === 0) {
          const now = Date.now();
          if (now - lastDetectorValidationAt > DETECTOR_VALIDATION_INTERVAL_MS) {
            lastDetectorValidationAt = now;
            await validateDetector();
          }
        }

        const appearanceCanvas = document.createElement('canvas');
        const bboxList = detectedPlates.map((plateBox) => ({
          appearance: capturePlateAppearance(processingCanvas, plateBox.bbox, appearanceCanvas),
          x: plateBox.bbox.x,
          y: plateBox.bbox.y,
          width: plateBox.bbox.width,
          height: plateBox.bbox.height,
          confidence: plateBox.confidence,
        }));

        releaseCanvasMemory(appearanceCanvas);
        const allTracks = runtime.tracker.updateTracks(bboxList, {
          capturedAt: frameCapturedAt,
          mediaTimeSeconds: frameMediaTimeSeconds,
        });
        allTracks.forEach((track) => {
          if (track.visibleThisFrame === true) {
            bumpDiag('detected');
            console.info(`[ANPR:DETECTED] trackId=${track.trackId} YOLO_confidence=${(track.bbox.confidence ?? 0).toFixed(2)} bbox=${Math.round(track.bbox.width)}x${Math.round(track.bbox.height)}`);
          }
        });

        const confirmedTracks = runtime.tracker.getActiveTracks(true);
        const readableConfirmedTracks = confirmedTracks.filter(isTrackAvailableForReading);
        const displayTracks = allTracks.filter((track) => isTrackDrawable(track));
        const loopNow = Date.now();

        confirmedTracks.forEach((track) => {
          const slotTrackKey = `${slotId}:${track.trackId}`;
          if (track.trackState === 'LOST' && !lostTrackIdsRef.current.has(slotTrackKey)) {
            lostTrackIdsRef.current.add(slotTrackKey);
            runtimeMetricsRef.current.lostTrackObservations++;
          } else if (track.trackState === 'VISIBLE' && lostTrackIdsRef.current.has(slotTrackKey)) {
            lostTrackIdsRef.current.delete(slotTrackKey);
            runtimeMetricsRef.current.reacquiredTrackCount++;
          }

          if (track.trackState === 'VISIBLE' && track.stats) {
            track.stats.lastDetectorLatencyMs = Math.round(detectorElapsedMs);
          }

          if (!runtime.drainDeadline && track.trackState !== 'VISIBLE' && !isOcrResultStillUseful(track, loopNow)) {
            runtime.bestFrameSelector.clearTrack(track.trackNumber);
            track.lastCropSampledAt = undefined;
          }

          if (track.cooldownActive && !track.cooldownStartedAt) {
            track.cooldownStartedAt = loopNow;
          }
        });

        if (loopNow - runtime.lastMaintenanceTs >= SCANNER_MAINTENANCE_INTERVAL_MS) {
          const activeTrackNumbers = new Set(allTracks.map((track) => track.trackNumber));
          runtime.bestFrameSelector.clearExcept(activeTrackNumbers);
          runtime.bestFrameSelector.pruneStale(undefined, activeTrackNumbers, loopNow);
          pruneCooldownMap(cooldownMap.current, scannerSettings.duplicateCooldown * 1000, loopNow);
          runtime.lastMaintenanceTs = loopNow;
        }

        metrics.platesVisible = bboxList.length;
        metrics.activeTracks = readableConfirmedTracks.length;
        metrics.tracks = [...displayTracks];

        const cropSampleNow = loopNow;
        // Crop sampling runs on ALL tracks that were visible this frame.
        // Use visibleThisFrame directly so a 1-frame plate that the tracker
        // has already marked LOST still gets its crop captured before the
        // next detection cycle clears the processing canvas.
        allTracks.forEach((track) => {
          // Never crop a new frame using a lost track's old coordinates.
          // Its saved crops remain available to the independent OCR queue.
          if (track.visibleThisFrame !== true) return;

          if (
            !track.lastOverlayAngleAt ||
            cropSampleNow - track.lastOverlayAngleAt >= OVERLAY_ANGLE_SAMPLE_MS
          ) {
            track.overlayAngle = estimatePlateOverlayAngle(processingCanvas, track.bbox, track.overlayAngle ?? 0);
            track.lastOverlayAngleAt = cropSampleNow;
          }

          if (track.ocrState === 'COOLDOWN' || track.ocrState === 'MATCHED') return;
          const motionMode = getMotionOcrMode(track);
          runtimeMetricsRef.current.motionBuckets[motionMode]++;


          const existingCrop = runtime.bestFrameSelector.getBestCrop(track.trackNumber);
          const baseSampleInterval = getTierCropSampleIntervalMs(
            track.bbox.confidence >= 0.7 ? CROP_SAMPLE_FAST_MS : CROP_SAMPLE_NORMAL_MS,
            runtimeMetricsRef.current.deviceTier
          );
          const sampleInterval = getMotionAwareCropSampleIntervalMs(track, baseSampleInterval, adaptiveConfigRef.current);
          if (!video.ended && existingCrop && track.lastCropSampledAt && cropSampleNow - track.lastCropSampledAt < sampleInterval) {
            return;
          }

          track.pipelineState = 'COLLECTING';
          const previousBestId = existingCrop?.id;
          const sourceBbox = scaleBoundingBox(track.bbox,
            sourceFrame.width / processingCanvas.width, sourceFrame.height / processingCanvas.height);
          const cropAngle = track.overlayAngle ?? 0;
          const isTwoLineAspect = sourceBbox.width / Math.max(1, sourceBbox.height) < 1.85;
          // Deskew is optional evidence, not the primary crop. Avoid applying
          // a noisy angle estimate to a one-frame/low-confidence detection, and
          // NEVER deskew square/two-line plates where 2D rotation clips corner characters.
          const shouldDeskewCrop =
            !isTwoLineAspect &&
            Math.abs(cropAngle) >= OCR_DESKEW_MIN_ANGLE_RAD &&
            track.framesSeen >= 2 &&
            (track.bbox.confidence ?? 0) >= 0.55 &&
            (track.motionScore ?? 0) < MOTION_COLLECT_ONLY_MAX;
          const originalCropCanvas = cropCanvasRegionFast(sourceFrame, sourceBbox);

          const envLabel = adaptiveConfigRef.current.environment.label;
          const isNight = envLabel === 'NIGHT' || envLabel === 'LOW_LIGHT';
          const isGlare = envLabel === 'BACKLIGHT';
          const visualReport = evaluateMalaysianPlateVisualCandidate(
            originalCropCanvas,
            { width: sourceBbox.width, height: sourceBbox.height, confidence: track.bbox.confidence ?? 0.5 },
            { width: sourceFrame.width, height: sourceFrame.height },
            { isNight, isGlare, isBlur: (track.motionScore ?? 0) > 0.6, isSlanted: Math.abs(cropAngle) > 0.1 }
          );

          track.visualCandidateScore = visualReport.malaysiaVisualCandidateScore;
          track.malaysianColourProfile = visualReport.colourProfile;
          track.cameraId = slotId;

          console.info(
            `[ANPR:CANDIDATE_GATE] candidateId=${track.trackId} YOLO=${(track.bbox.confidence ?? 0).toFixed(2)} Colour=${visualReport.colourProfile} ` +
            `Geom=${visualReport.geometryEvidenceScore.toFixed(2)} Stroke=${visualReport.strokeEvidenceScore.toFixed(2)} ` +
            `Score=${visualReport.malaysiaVisualCandidateScore.toFixed(2)} Decision=${visualReport.decision}` +
            (visualReport.rejectionReason ? ` Reason="${visualReport.rejectionReason}"` : '')
          );

          if (visualReport.decision === 'OBVIOUS_NON_PLATE') {
            track.candidateState = 'REJECTED_NON_PLATE';
            track.isConfirmed = false;
            track.ocrEvidencePending = false;
            runtime.bestFrameSelector.clearTrack(track.trackNumber);
            return;
          }

          track.candidateState = 'PLATE_CANDIDATE';

          const cropCanvas = shouldDeskewCrop
            ? cropDeskewedCanvasRegionFast(sourceFrame, sourceBbox, cropAngle)
            : originalCropCanvas;
          const basePerspective = Math.max(0.75, 1 - Math.abs(cropAngle) * 0.35);
          const perspectiveScore = shouldDeskewCrop
            ? Math.max(0.70, 1 - Math.abs(cropAngle) / (MAX_OVERLAY_TILT_RAD * 2.6))
            : basePerspective;
          const cropQuality = runtime.bestFrameSelector.addCropCandidate(track.trackNumber, cropCanvas, sourceBbox, {
            trackStability: track.trackConfidence ?? 0.55,
            perspectiveScore,
            capturedAt: frameCapturedAt,
            mediaTimeSeconds: frameMediaTimeSeconds,
            cropKind: shouldDeskewCrop ? 'DESKEWED' : 'ORIGINAL',
          });
          bumpDiag('crops');
          updateLiveTrackItem({
            trackId: track.trackId,
            trackNumber: track.trackNumber,
            status: track.ocrState === 'CONSENSUS' || track.ocrState === 'POSSIBLE MATCH' ? 'recognised' : 'captured',
            lastDetectorLatencyMs: track.stats?.lastDetectorLatencyMs,
          });
          console.info(`[ANPR:CROP_CAPTURED] trackId=${track.trackId} cropDimensions=${cropCanvas.width}x${cropCanvas.height} cropTimestamp=${frameCapturedAt} valid=${cropCanvas.width > 0 && cropCanvas.height > 0}`);
          // Perspective correction is a comparison candidate, never a
          // replacement for the detector crop. This retains thin edge and
          // repeated characters and gives two-line OCR the original ordering.
          if (shouldDeskewCrop) {
            runtime.bestFrameSelector.addCropCandidate(track.trackNumber, originalCropCanvas, sourceBbox, {
              trackStability: track.trackConfidence ?? 0.55,
              perspectiveScore: 0.95,
              capturedAt: frameCapturedAt,
              mediaTimeSeconds: frameMediaTimeSeconds,
              cropKind: 'ORIGINAL',
            });
          }
          // Keep the detector-tight pixels as an independent OCR candidate for
          // small single-line plates. The labelled ANN7569 frame is exact on
          // this crop but loses an N after the normal 9%/12% padding resize.
          // This is image evidence only; no expected plate string is injected.
          if (sourceBbox.width / Math.max(1, sourceBbox.height) >= 2.3 || isTwoLineAspect) {
            const tightPadding = isTwoLineAspect ? 0 : 0.03;
            const tightCropCanvas = cropCanvasRegionFast(sourceFrame, sourceBbox, 360, 108, tightPadding, tightPadding);
            runtime.bestFrameSelector.addCropCandidate(track.trackNumber, tightCropCanvas, sourceBbox, {
              trackStability: track.trackConfidence ?? 0.55,
              perspectiveScore,
              capturedAt: frameCapturedAt,
              mediaTimeSeconds: frameMediaTimeSeconds,
              cropKind: 'TIGHT',
            });
          }
          // Retain the detector-resolution sampling too. Thin strokes can
          // survive one sampling scale better than another; both remain one
          // source observation, never extra temporal votes.
          if (isTwoLineAspect && sourceFrame.width !== processingCanvas.width) {
            const detectorCrop = cropCanvasRegionFast(processingCanvas, track.bbox, 360, 108, 0, 0);
            runtime.bestFrameSelector.addCropCandidate(track.trackNumber, detectorCrop, track.bbox, {
              trackStability: track.trackConfidence ?? 0.55,
              perspectiveScore,
              capturedAt: frameCapturedAt,
              mediaTimeSeconds: frameMediaTimeSeconds,
              cropKind: 'DETECTOR',
            });
          }
          const nextBestId = runtime.bestFrameSelector.getBestCrop(track.trackNumber)?.id;
          if (previousBestId && nextBestId && previousBestId !== nextBestId) {
            runtimeMetricsRef.current.bestFrameReplacementCount++;
            if (track.stats) {
              track.stats.bestFrameReplacementCount = (track.stats.bestFrameReplacementCount ?? 0) + 1;
            }
          }
          runtimeMetricsRef.current.cropQualityTotal += cropQuality.overallScore;
          runtimeMetricsRef.current.cropQualitySamples++;
          if (track.stats) {
            track.stats.bestCropQuality = Math.max(track.stats.bestCropQuality ?? 0, cropQuality.overallScore);
          }
          if (track.telemetry) {
            track.telemetry.cropSavedAt = frameCapturedAt;
            track.telemetry.cropWidth = originalCropCanvas.width;
            track.telemetry.cropHeight = originalCropCanvas.height;
            track.telemetry.cropComplete = !cropQuality.isPartialCrop;
          }
          track.ocrEvidencePending = true;
          track.lastCropSampledAt = cropSampleNow;
        });

        runtime.lastProcessedMediaTime = frameMediaTimeSeconds;
        const ocrCandidateTracks = runtime.tracker.getTracksEligibleForOcr(false).filter((track) =>
          isOcrResultStillUseful(track)
        );
        const preparingFirstSampleFrame = scannerSourceModeRef.current === 'SAMPLE_VIDEO' && video.paused && !video.ended;
        const firstReadPreparation = processOcrQueue(ocrCandidateTracks, processingCanvas, scannerSettings, runtime, slotId);
        if (preparingFirstSampleFrame) {
          // Include the first real crop pass in preparation. Starting playback
          // while its quality/OCR work was still being admitted caused the
          // next detector turn to miss cars at the beginning of a short clip.
          await firstReadPreparation;
          const firstPassDeadline = performance.now() + 1500;
          while (!stopped && runtime.ocrGeneration === detectionGeneration &&
                 ocrWorkPool.current.activeCount > 0 && performance.now() < firstPassDeadline) {
            await new Promise(resolve => window.setTimeout(resolve, 10));
          }
        }
        if (stopped || runtime.ocrGeneration !== detectionGeneration) return 0;
        // Playback runs at source speed after this initial preparation barrier.
        if (preparingFirstSampleFrame) {
          try { await video.play(); } catch {
            setCameraError('Unable to start sample playback. Please retry.');
            scannerStartupInFlightRef.current = false;
            setIsScannerPreparing(false);
            isScanningRef.current = false;
            setIsScanning(false);
            return 0;
          }
        }
        if (stopped) return 0;
        scannerStartupInFlightRef.current = false;
        setIsScannerPreparing(false);
        setScannerReloadNotice((notice) => notice?.mode === 'STARTING' ? null : notice);

        metrics.detFrames++;

        const motionAwareTargetMs = getMotionAwareDetectorTargetMs(
          adaptiveConfigRef.current,
          runtimeMetricsRef.current.deviceTier,
          readableConfirmedTracks
        );
        const latencyDrivenInterval = clampNumber(
          Math.round(detectorElapsedMs * 1.45),
          motionAwareTargetMs,
          Math.max(250, adaptiveConfigRef.current.detector.busyIntervalMs)
        );
        adaptiveDetectorIntervalMs = Math.round(
          adaptiveDetectorIntervalMs * 0.75 + latencyDrivenInterval * 0.25
        );
        const activeRunningSlots = cameraSlots.filter(
          (s) => cameraSlotStatusRef.current[s.id] === 'RUNNING'
        );
        const isMultiCam = activeRunningSlots.length > 1;
        const nextDelay = isMultiCam ? Math.max(16, Math.min(50, Math.round(adaptiveDetectorIntervalMs * 0.35))) : 0;
        return nextDelay;
      };

      const processOcrQueue = async (
        candidateTracks: ActiveTrack[],
        canvas: HTMLCanvasElement,
        scannerSettings: ScannerSettings,
        slotRuntime: SlotScannerRuntime,
        sourceSlotId: string
      ) => {
        const adaptiveConfig = adaptiveConfigRef.current;

        if (!isPpOcrReady()) {
          candidateTracks.forEach((track) => {
            if (!track.cooldownActive && track.ocrState !== 'MATCHED') {
              track.ocrState = 'COLLECTING';
              track.pipelineState = 'COLLECTING';
            }
          });
          return;
        }

        const requestedOcrConcurrency = Math.max(
          1,
          scannerSettings.maxOcrConcurrency || INITIAL_SETTINGS.maxOcrConcurrency,
          3
        );
        const adaptiveOcrConcurrency = Math.max(3, adaptiveConfig.ocr.maxConcurrency);
        const maxOcrConcurrency = Math.min(
          OCR_MAX_CONCURRENCY,
          getTierOcrConcurrencyLimit(runtimeMetricsRef.current.deviceTier),
          adaptiveOcrConcurrency,
          requestedOcrConcurrency
        );
        const priorityIds = prioritiseTracks(
          candidateTracks.map((track) => ({
            trackId: track.trackId,
            bbox: track.bbox,
            framesSeen: track.framesSeen,
            ocrState: track.ocrState,
            lastOcrAttemptAt: track.lastOcrAttemptAt,
            voteCount: getTrackVoteCount(track),
          })),
          canvas.width,
          canvas.height,
          Math.max(maxOcrConcurrency, candidateTracks.length)
        ).sort((leftId, rightId) => {
          const leftTrack = slotRuntime.tracker.getTrack(leftId);
          const rightTrack = slotRuntime.tracker.getTrack(rightId);
          if (!leftTrack || !rightTrack) return 0;

          // FAIR MULTI-TRACK PRIORITY (Requirement 8):
          // Priority 1: first OCR for new tracks (ocrAttempts === 0)
          // Priority 2: verification OCR for unresolved tracks (ocrAttempts === 1)
          // Priority 3: final targeted retry (ocrAttempts === 2)
          const leftAttempts = leftTrack.stats?.ocrAttempts ?? 0;
          const rightAttempts = rightTrack.stats?.ocrAttempts ?? 0;
          if (leftAttempts !== rightAttempts) {
            return leftAttempts - rightAttempts;
          }

          const leftVotes = getTrackVoteCount(leftTrack);
          const rightVotes = getTrackVoteCount(rightTrack);
          if (leftVotes === 0 && rightVotes > 0) return -1;
          if (rightVotes === 0 && leftVotes > 0) return 1;

          if (adaptiveConfig.track.prioritizeHighestConfidence) {
            const leftConfidence = (leftTrack.trackConfidence ?? 0) + (leftTrack.bbox.confidence ?? 0);
            const rightConfidence = (rightTrack.trackConfidence ?? 0) + (rightTrack.bbox.confidence ?? 0);
            if (Math.abs(leftConfidence - rightConfidence) > 0.05) return rightConfidence - leftConfidence;
          }

          const leftLastAttempt = leftTrack.lastOcrAttemptAt ?? 0;
          const rightLastAttempt = rightTrack.lastOcrAttemptAt ?? 0;
          if (Math.abs(leftLastAttempt - rightLastAttempt) > 300) {
            return leftLastAttempt - rightLastAttempt;
          }

          return 0;
        });
        const ocrQueuePressure = getOcrQueuePressure(
          priorityIds.length,
          ocrWorkPool.current.activeCount,
          maxOcrConcurrency
        );
        runtimeMetricsRef.current.lastOcrQueueDepth = priorityIds.length;
        runtimeMetricsRef.current.maxOcrQueueDepth = Math.max(
          runtimeMetricsRef.current.maxOcrQueueDepth,
          priorityIds.length
        );
        runtimeMetricsRef.current.tracksWaitingForBetterCrop = 0;

        const processTrack = async (trackId: string, priorityIndex: number) => {
          const track = slotRuntime.tracker.getTrack(trackId);
          if (!track || track.cooldownActive) return;

          const now = Date.now();
          const draining = slotRuntime.drainDeadline !== undefined;
          if (draining && now >= slotRuntime.drainDeadline!) return;
          const attempts = track.stats?.ocrAttempts ?? 0;
          const ocrElapsedMs = track.firstOcrStartedAt ? performance.now() - track.firstOcrStartedAt : 0;
          const availableCrops = slotRuntime.bestFrameSelector.getTopCrops(track.trackNumber, 16);
          const newestCapturedAt = Math.max(-Infinity, ...availableCrops.map(crop => crop.capturedAt ?? crop.timestamp));
          if (!draining && !canScheduleOcrEvidence(attempts, ocrElapsedMs, newestCapturedAt, track.lastOcrSourceCapturedAt, Boolean(track.scanEventId), availableCrops.some(crop => !track.ocrAttemptedCropIds?.has(crop.id)))) return;
          const needsFreshEvidence = attempts >= 3 || ocrElapsedMs >= 2500;

          // Allow unconfirmed tracks through when they have a saved crop
          // waiting for OCR — the plate may have left the frame after only
          // one detection and we must not drop its evidence.
          const hasEvidence = track.ocrEvidencePending || (slotRuntime.bestFrameSelector.getCropCount(track.trackNumber) > 0);
          if (!track.isConfirmed && !hasEvidence && (track.bbox.confidence ?? 0) < 0.25) return;
          if (track.ocrRunning || track.ocrJobQueued) {
            runtimeMetricsRef.current.duplicateOcrSkippedCount++;
            return;
          }
          if (!draining && !isOcrResultStillUseful(track)) return;
          if (ocrWorkPool.current.activeCount >= maxOcrConcurrency) return;

          const voteCount = getTrackVoteCount(track);
          const fastFirstRead = isFastFirstReadCandidate(track, voteCount);
          // Low-confidence reads (<90%) or unconfirmed candidates retry immediately in ~35ms
          const needsFastRetry = attempts > 0 && attempts < 3 && !track.committedPlate;
          const retryDelay =
            voteCount === 0
              ? Math.max(OCR_FIRST_READ_RETRY_MS, adaptiveConfig.ocr.firstReadRetryMs)
              : needsFastRetry
                ? 35
                : Math.max(OCR_REPEAT_READ_RETRY_MS, adaptiveConfig.ocr.repeatReadRetryMs);
          if (track.lastOcrAttemptAt && now - track.lastOcrAttemptAt < retryDelay) return;

          const configuredMinTrackConfidence =
            voteCount === 0
              ? Math.max(OCR_FIRST_READ_MIN_TRACK_CONFIDENCE, adaptiveConfig.ocr.firstReadMinTrackConfidence)
              : Math.max(OCR_MIN_TRACK_CONFIDENCE, adaptiveConfig.ocr.minTrackConfidence);
          const minTrackConfidence = fastFirstRead
            ? Math.min(configuredMinTrackConfidence, OCR_FIRST_READ_MIN_TRACK_CONFIDENCE)
            : configuredMinTrackConfidence;
          if ((track.trackConfidence ?? 0) < minTrackConfidence && track.bbox.confidence < 0.25) {
            track.ocrState = 'COLLECTING';
            track.pipelineState = 'TRACKING';
            return;
          }

          const configuredMinReadableWidth = Math.max(
            OCR_DEFAULT_MIN_READABLE_WIDTH,
            scannerSettings.minCropWidth || INITIAL_SETTINGS.minCropWidth
          );
          const minReadableWidth = Math.min(configuredMinReadableWidth, 24);
          const bufferedCropCount = slotRuntime.bestFrameSelector.getCropCount(track.trackNumber);
          const requiredCropCount =
            !draining && voteCount === 0
              ? Math.max(OCR_MIN_BUFFERED_CROPS, adaptiveConfig.ocr.requiredBufferedCrops)
              : 1;
          const hasEnoughBufferedCrops = bufferedCropCount >= requiredCropCount;
          const canReadFirstFrame = track.framesSeen >= OCR_MIN_TRACK_FRAMES || fastFirstRead;

          if (
            !canReadFirstFrame ||
            !hasEnoughBufferedCrops ||
            track.bbox.width < minReadableWidth
          ) {
            track.ocrState = 'COLLECTING';
            track.pipelineState = 'COLLECTING';
            return;
          }

          const minQualityForOcr = Math.max(
            scannerSettings.minCropQuality || INITIAL_SETTINGS.minCropQuality,
            adaptiveConfig.ocr.minQuality,
            voteCount === 0
              ? Math.max(OCR_FIRST_READ_MIN_QUALITY, adaptiveConfig.ocr.firstReadMinQuality)
              : Math.max(OCR_REPEAT_READ_MIN_QUALITY, adaptiveConfig.ocr.repeatReadMinQuality)
          );

          const candidateEntries = availableCrops.filter(entry =>
            draining
              ? canDrainOcrCrop(attempts, entry.id, track.ocrAttemptedCropIds)
              : !needsFreshEvidence || !track.ocrAttemptedCropIds?.has(entry.id) || (entry.capturedAt ?? entry.timestamp) > (track.lastOcrSourceCapturedAt ?? Infinity)
          ).sort((left, right) => {
            const leftUsed = draining || needsFreshEvidence
              ? track.ocrAttemptedCropIds?.has(left.id) ?? false
              : track.ocrVotedCaptureTimes?.has(left.capturedAt) ?? false;
            const rightUsed = draining || needsFreshEvidence
              ? track.ocrAttemptedCropIds?.has(right.id) ?? false
              : track.ocrVotedCaptureTimes?.has(right.capturedAt) ?? false;
            if (leftUsed !== rightUsed) return leftUsed ? 1 : -1;
            // Start from detector-tight pixels; padding and deskew remain
            // alternate crops, with the same source-frame vote identity.
            if (left.cropKind !== right.cropKind) {
              if (left.cropKind === 'TIGHT') return -1;
              if (right.cropKind === 'TIGHT') return 1;
              if (left.cropKind === 'ORIGINAL') return -1;
              if (right.cropKind === 'ORIGINAL') return 1;
            }
            return 0;
          });
          if (candidateEntries.length === 0) {
            track.ocrState = 'LOW QUALITY';
            track.pipelineState = 'COLLECTING';
            runtimeMetricsRef.current.qualityOcrAvoidedCount++;
            runtimeMetricsRef.current.tracksWaitingForBetterCrop++;
            return;
          }

          // Reserve both the global OCR slot and this track before the first
          // asynchronous quality check. Previously repeated detector cycles
          // launched duplicate preparation jobs for one track and starved the
          // other plates in a multi-vehicle frame.
          const ocrGeneration = slotRuntime.ocrGeneration;
          const releaseJob = ocrWorkPool.current.acquire(`${sourceSlotId}:${ocrGeneration}:${trackId}`, maxOcrConcurrency);
          if (!releaseJob) return;
          track.ocrJobQueued = true;
          track.ocrEnqueuedAt = performance.now();
          bumpDiag('ocrQueued');
          console.info(`[ANPR:OCR_QUEUED] trackId=${trackId} savedCrops=${candidateEntries.length} queuePosition=${priorityIndex}`);
          let jobStarted = false;
          const ownedCrops = new Set<HTMLCanvasElement>();
          try {
            let targetCrop: HTMLCanvasElement | null = null;
            let targetCropCapturedAt = 0;
            let targetCropId = '';
            let targetCropBox = { ...track.bbox };
            let targetCropKind: 'ORIGINAL' | 'DESKEWED' | 'TIGHT' | 'DETECTOR' = 'ORIGINAL';
            let modelQuality: PlateQualityAssessment | null = null;
            const maxBestCropAgeMs = draining ? Infinity : getTrackReadableCropAgeLimitMs(track, adaptiveConfig, voteCount);

            for (const entry of candidateEntries) {
              // Keep the selector's observations intact. OCR owns a snapshot,
              // allowing later passes and consensus to use clearer frames from
              // the same track rather than consuming the evidence on the first
              // quality check.
              const candidate = {
                ...entry,
                canvas: cloneCanvasSnapshot(entry.canvas),
              };
              if (!candidate.canvas) continue;
              ownedCrops.add(candidate.canvas);
              const cropCapturedAt = candidate.capturedAt ?? candidate.timestamp;
              const cropAgeMs = now - cropCapturedAt;
              if (cropAgeMs > maxBestCropAgeMs) continue;

              const assessment = await classifyPlateQuality(candidate.canvas, {
                heuristicReport: candidate.quality,
                minReadableWidth,
                minQualityScore: minQualityForOcr,
                detectorConfidence: candidate.detectorConfidence,
                trackStability: candidate.trackStability,
                perspectiveScore: candidate.perspectiveScore,
                cropAgeMs,
                maxCropAgeMs: maxBestCropAgeMs,
                acceptedClasses: adaptiveConfig.qualityGate.acceptedClasses,
                marginalClasses: adaptiveConfig.qualityGate.marginalClasses,
                minimumClassifierConfidence: adaptiveConfig.qualityGate.minimumClassifierConfidence,
              });
              if (stopped || slotRuntime.ocrGeneration !== ocrGeneration) break;
              addQualityAssessmentSample(runtimeMetricsRef.current, assessment);
              attachQualityAssessmentToTrack(track, assessment, false);

              // Quality classification selects and ranks observations; it does
              // not veto OCR for a physically readable crop. Start from the
              // unmodified snapshot and compare enhancement only afterwards.
              targetCrop = candidate.canvas;
              targetCropCapturedAt = cropCapturedAt;
              targetCropKind = candidate.cropKind;
              targetCropId = candidate.id;
              const capturedBox = { ...candidate.bbox, confidence: candidate.detectorConfidence };
              targetCropBox = candidate.cropKind === 'DETECTOR' ? capturedBox : scaleBoundingBox(
                capturedBox,
                canvas.width / (slotRuntime.sourceFrameCanvas?.width || canvas.width),
                canvas.height / (slotRuntime.sourceFrameCanvas?.height || canvas.height)
              );
              modelQuality = assessment;
              break;
            }

            if (stopped || slotRuntime.ocrGeneration !== ocrGeneration) return;
            if (!targetCrop || !modelQuality) {
              if (scannerSettings.debugMode) {
                console.debug(`[OCR:${sourceSlotId}] crop rejected`, {
                  trackId,
                  detectorBox: track.bbox,
                  candidateCount: candidateEntries.length,
                  qualityClass: track.qualityClass,
                  rejectionReasons: track.qualityRejectionReasons,
                });
              }
              track.ocrState = 'LOW QUALITY';
              track.pipelineState = 'COLLECTING';
              runtimeMetricsRef.current.qualityOcrAvoidedCount++;
              runtimeMetricsRef.current.tracksWaitingForBetterCrop++;
              return;
            }

            attachQualityAssessmentToTrack(track, modelQuality, false);

            const ocrCrop = targetCrop;
            ownedCrops.delete(ocrCrop); // The inference job now owns this snapshot.

            track.pipelineState = 'READY_FOR_OCR';
            attachQualityAssessmentToTrack(track, modelQuality, true);
            const isFirstReadAttempt = attempts === 0;
            track.ocrRunning = true;
            if (!track.firstOcrStartedAt) {
              track.firstOcrStartedAt = performance.now();
            }
            // Preserve ocrEvidencePending = true until track is resolved/finalized (Requirement 2)
            track.ocrEvidencePending = true;
            track.lastOcrAttemptAt = now;
            track.lastOcrSourceCapturedAt = targetCropCapturedAt;
            track.ocrAttemptedCaptureTimes ??= new Set();
            track.ocrAttemptedCaptureTimes.add(targetCropCapturedAt);
            track.ocrAttemptedCropIds ??= new Set();
            track.ocrAttemptedCropIds.add(targetCropId);
            track.ocrState = 'OCR_RUNNING';
            track.pipelineState = 'READING';
            if (track.stats) track.stats.ocrAttempts++;
            runtimeMetricsRef.current.ocrAttemptCount++;
            jobStarted = true;
            const ocrEnvironment = runtimeMetricsRef.current.currentEnvironment;
            const ocrEnvironmentConfidence = runtimeMetricsRef.current.currentEnvironmentConfidence;
            const ocrQualityClass = modelQuality.label;
            const ocrQualityConfidence = modelQuality.confidence;
            const ocrQualityScore = modelQuality.score;

            void (async () => {
              const ocrStartedAt = performance.now();
              // Measure queue wait: how long between job being enqueued and
              // inference actually starting (blocked by concurrency limit or
              // preceding crop-quality check).
              if (track.stats && track.ocrEnqueuedAt) {
                track.stats.queueWaitMs = Math.round(ocrStartedAt - track.ocrEnqueuedAt);
              }
              const transientCanvases: HTMLCanvasElement[] = [ocrCrop];
              const rememberTransientCanvas = (crop?: HTMLCanvasElement | null) => {
                if (crop && !transientCanvases.includes(crop)) {
                  transientCanvases.push(crop);
                }
              };

              try {
                if (stopped || slotRuntime.ocrGeneration !== ocrGeneration) return;

                const activeTrackLoad = Math.max(1, candidateTracks.length);
                const fastOcrPass =
                  isFirstReadAttempt ||
                  runtimeMetricsRef.current.deviceTier !== 'A' ||
                  activeTrackLoad >= 2 ||
                  adaptiveConfig.ocr.maxCandidateCrops <= 3;
                const ultraFastOcrPass =
                  runtimeMetricsRef.current.deviceTier === 'D' ||
                  adaptiveConfigRef.current.ocr.maxCandidateCrops <= 1;
                const isSampleVideo = scannerSourceModeRef.current === 'SAMPLE_VIDEO';
                const cropConditionAnalysis = classifyCropCondition(ocrCrop, track.bbox, track.overlayAngle ?? 0);
                const plannedVariants = planOcrRecovery(
                  modelQuality.primaryClass,
                  adaptiveConfig.environment.label,
                  attempts,
                  modelQuality.selectedPreprocessing,
                  environmentStatsRef.current
                );
                // Combine planned quality recovery with local crop condition analysis
                const combinedVariants = Array.from(
                  new Set([...cropConditionAnalysis.targetedVariants, ...plannedVariants])
                );
                const fullCropVariants = combinedVariants.length > 0 ? combinedVariants : plannedVariants;
                const recoveryMode = fullCropVariants.length > 1;
                const innerCrops = ultraFastOcrPass || targetCropKind === 'TIGHT'
                  ? []
                  : (() => {
                      if (!adaptiveConfig.ocr.useInnerTextCrop) return [];
                      const innerTextCrop = createInnerPlateTextCrop(ocrCrop);
                      rememberTransientCanvas(innerTextCrop);
                      return generateAdaptiveCrops(
                        innerTextCrop,
                        { x: 0, y: 0, width: innerTextCrop.width, height: innerTextCrop.height, confidence: 1 },
                        360,
                        108,
                        fastOcrPass ? ['ORIGINAL'] : adaptiveConfig.processing.preprocessingVariants.slice(0, 2)
                      );
                    })();
                innerCrops.forEach((crop) => {
                  rememberTransientCanvas(crop.canvas);
                  rememberTransientCanvas(crop.topLineCanvas);
                  rememberTransientCanvas(crop.bottomLineCanvas);
                });

                const adaptiveCrops = generateAdaptiveCrops(
                  ocrCrop,
                  { x: 0, y: 0, width: ocrCrop.width, height: ocrCrop.height, confidence: 1 },
                  360,
                  108,
                  [...fullCropVariants]
                );
                // generateAdaptiveCrops ranks by generic image quality. For a
                // perspective-sensitive plate that ranking can push the
                // geometry-corrected candidates out of the bounded OCR set.
                // Restore the evidence-driven variant order before slicing.
                const preprocessingPriority = new Map(
                  fullCropVariants.map((variant, index) => [variant, index])
                );
                adaptiveCrops.sort(
                  (left, right) =>
                    (preprocessingPriority.get(left.variant) ?? Number.MAX_SAFE_INTEGER) -
                    (preprocessingPriority.get(right.variant) ?? Number.MAX_SAFE_INTEGER) ||
                    right.qualityScore - left.qualityScore
                );
                adaptiveCrops.forEach((crop) => {
                  rememberTransientCanvas(crop.canvas);
                  rememberTransientCanvas(crop.topLineCanvas);
                  rememberTransientCanvas(crop.bottomLineCanvas);
                });

                const isTwoLinePlate = cropConditionAnalysis.isTwoLine || ocrCrop.width / Math.max(1, ocrCrop.height) < 1.65;
                // A difficult crop gets one model-directed correction on live
                // cameras too. Lower-power devices try it first on retries.
                const maxCandidateCrops = ultraFastOcrPass ? 1 : recoveryMode ? 2 : isFirstReadAttempt ? 1 : 2;
                // Evidence from the supplied single-line clips shows that the
                // 9%/12% padded crop can compress repeated edge characters
                // (ANN7569 -> AN7569). Try the already-generated inner/tight
                // observation first for single-line plates. Two-line plates
                // retain the existing perspective-first order used by VME7108.
                const originalCandidate = {
                  canvas: ocrCrop,
                  isTwoLine: isTwoLinePlate,
                  variant: 'ORIGINAL' as PreprocessVariant,
                };
                const enhancedCrops = adaptiveCrops.filter((crop) => crop.variant !== 'ORIGINAL');
                const candidateCrops = selectOcrRecoveryCandidates(
                  originalCandidate, enhancedCrops, innerCrops,
                  recoveryMode, attempts, maxCandidateCrops
                );
                if (scannerSourceModeRef.current === 'CAMERA') {
                  const flippedCropCanvas = document.createElement('canvas');
                  flippedCropCanvas.width = ocrCrop.width;
                  flippedCropCanvas.height = ocrCrop.height;
                  const fCtx = flippedCropCanvas.getContext('2d');
                  if (fCtx) {
                    fCtx.translate(ocrCrop.width, 0);
                    fCtx.scale(-1, 1);
                    fCtx.drawImage(ocrCrop, 0, 0);
                    rememberTransientCanvas(flippedCropCanvas);
                    candidateCrops.push({
                      canvas: flippedCropCanvas,
                      isTwoLine: isTwoLinePlate,
                      variant: 'FLIPPED' as PreprocessVariant,
                    });
                  }
                }
                const fallbackCrop = {
                  canvas: ocrCrop,
                  isTwoLine: isTwoLinePlate,
                };
                const expectedMinChars = getExpectedMinPlateChars(ocrCrop);

                let text = '';
                let conf = 0;
                let bestScore = 0;
                let bestPatternValid = false;
                let winnerVariant: string = 'ORIGINAL';
                let winnerHasCorroboratedRows = false;

                for (const [cropIndex, crop] of (candidateCrops.length > 0 ? candidateCrops : [fallbackCrop]).entries()) {
                  if (stopped || slotRuntime.ocrGeneration !== ocrGeneration) return;
                  // Bound additional variants, but allow enhanced/adaptive recovery if the initial pass was empty or weak:
                  if (cropIndex > 0 && (text && conf >= 0.50 ? performance.now() - ocrStartedAt > 800 : performance.now() - ocrStartedAt > 1500)) break;
                  await yieldToBrowser();
                  const isTwoLineLayout = 'isTwoLine' in crop ? Boolean(crop.isTwoLine) : isTwoLinePlate;
                  // Use quickMode on the first read attempt for two-line/square plates:
                  // limits the pass to 3 inferences (~700ms on WASM) instead of 7 (~1700ms),
                  // leaving budget for 1-2 retries if confidence is below threshold.
                  const useQuickMode = isTwoLineLayout && isFirstReadAttempt;
                  bumpDiag('ocrStarted');
                  console.info(`[ANPR:OCR_STARTED] trackId=${trackId} ppOcrReady=${isPpOcrReady()} callRecognizer=true variant=${'variant' in crop ? crop.variant : 'FALLBACK'}`);
                  const result = await recognizePlateFromCanvas(crop.canvas, isTwoLineLayout, {
                    maxAdaptiveVariants: 0, // Recovery is explicitly budgeted above, without nested variants.
                    quickMode: useQuickMode,
                  });
                  const resultText = result.normalizedPlate || result.text;
                  const pattern = validateMalaysianPattern(resultText);
                  const isPlausible = isPlausiblePlateCandidate(resultText, expectedMinChars, pattern.score);
                  const lengthScore = pattern.isValid ? 1 : 0;
                  const plausibilityPenalty = isPlausible ? 0 : 0.75;
                  const score =
                    result.confidence * 0.45 +
                    pattern.score * 0.3 +
                    lengthScore * 0.2 +
                    (pattern.isValid ? 0.1 : 0) -
                    plausibilityPenalty;
                  const cropVariant = 'variant' in crop && typeof crop.variant === 'string' ? crop.variant : 'ORIGINAL';
                  const candidateSource =
                    cropVariant === 'ORIGINAL' ? 'original'
                    : cropVariant === 'FLIPPED' ? 'flipped'
                    : cropVariant.startsWith('PERSPECTIVE') ? 'deskewed'
                    : cropVariant === 'TIGHT' ? 'inner'
                    : 'enhanced';
                  const sourceW = slotRuntime.sourceFrameCanvas?.width || canvas.width;
                  const sourceH = slotRuntime.sourceFrameCanvas?.height || canvas.height;
                  console.info(`[ANPR:DIMENSIONS] source=${sourceW}x${sourceH} yoloInput=${canvas.width}x${canvas.height} detectionBbox=${Math.round(track.bbox.x)},${Math.round(track.bbox.y)},${Math.round(track.bbox.width)},${Math.round(track.bbox.height)} savedCrop=${ocrCrop.width}x${ocrCrop.height} ocrInput=${crop.canvas.width}x${crop.canvas.height}`);
                  bumpDiag('ocrReturned');
                  console.info(`[ANPR:OCR_RAW_RESULT] trackId=${trackId} source=${candidateSource} rawOcrText="${result.text}" normalizedPlate="${resultText}" ocrConfidence=${result.confidence.toFixed(2)} candidateScore=${score.toFixed(2)}`);
                  if (scannerSettings.debugMode && result.text && result.text.trim().length > 0 && result.text !== '(empty)') {
                    try {
                      setLatestOcrCropInfo({
                        dataUrl: crop.canvas.toDataURL(),
                        dimensions: `${crop.canvas.width}x${crop.canvas.height}`,
                        rawText: result.text,
                        conf: result.confidence,
                      });
                    } catch {}
                  }
                  updateLiveTrackItem({
                    trackId: trackId,
                    trackNumber: track.trackNumber,
                    plate: resultText,
                    confidence: result.confidence,
                    status: 'reading',
                    lastDetectorLatencyMs: track.stats?.lastDetectorLatencyMs,
                    lastOcrLatencyMs: Math.round(performance.now() - ocrStartedAt),
                  });
                  if (scannerSettings.debugMode) {
                    console.debug(`[OCR:${sourceSlotId}] candidate`, {
                      trackId,
                      cropKind: targetCropKind,
                      capturedAt: targetCropCapturedAt,
                      draining,
                      variant: 'variant' in crop ? crop.variant : 'FALLBACK',
                      layout: crop.isTwoLine ? 'TWO_LINE' : 'SINGLE_LINE',
                      cropSize: { width: crop.canvas.width, height: crop.canvas.height },
                      text: resultText,
                      confidence: result.confidence,
                      patternScore: pattern.score,
                      plausible: isPlausible,
                      rankingScore: score,
                    });
                  }
                  if (resultText && isPlausible && pattern.isValid) {
                    addOcrCandidateEvidence(track, resultText, result.confidence, targetCropCapturedAt);
                  }
                  // Rank actual OCR evidence.
                  // Protect complete plates: do not allow a truncated subset (e.g. MH548) from a tight/inner crop
                  // to override a full valid plate reading (e.g. WMH1548).
                  const isShorterSubset =
                    Boolean(text) &&
                    text.length >= 6 &&
                    resultText.length < text.length &&
                    bestPatternValid &&
                    text.includes(resultText) &&
                    conf >= 0.70;

                  const isCompleteUpgrade =
                    Boolean(resultText) &&
                    isPlausible &&
                    pattern.isValid &&
                    (!text || (!isShorterSubset && (score > bestScore || (resultText.length > text.length && score >= bestScore - 0.08))));

                  if (isCompleteUpgrade) {
                    text = resultText;
                    conf = result.confidence;
                    bestScore = Math.max(bestScore, score);
                    bestPatternValid = pattern.isValid;
                    winnerHasCorroboratedRows = result.corroboratedRows === true;
                    winnerVariant = cropVariant;
                  }

                  // FAST-PATH INSTANT COMMIT (cropIndex 0 = FIRST crop only).
                  // Exits the crop loop immediately without running enhancement
                  // passes when the first raw result is clearly reliable.
                  // Avoid early-exit if this is a 2-letter prefix on a single-line
                  // plate when another candidate is available to check for repeated chars.
                  const isPotentialCollapsedTwoLetter =
                    candidateCrops.length > 1 &&
                    /^([A-Z]{2})([0-9]{3,4})$/.test(resultText) &&
                    result.confidence < 0.90;

                  const isPotentialCollapsedDigit =
                    candidateCrops.length > 1 &&
                    /^([A-Z]{1,3})([0-9]{1,2})$/.test(resultText) &&
                    result.confidence < 0.90;

                  if (
                    cropIndex === 0 &&
                    !isPotentialCollapsedTwoLetter &&
                    !isPotentialCollapsedDigit &&
                    resultText &&
                    isPlausible &&
                    pattern.isValid &&
                    resultText.length >= 4 &&
                    (result.confidence >= 0.85 || result.confidence >= OCR_INSTANT_COMMIT_CONFIDENCE) &&
                    !modelQuality?.isPartialCrop &&
                    canCommitSingleReadOutcome(resultText, result.confidence, score, isSampleVideo)
                  ) {
                    if (track.stats) track.stats.firstOcrMs = Math.round(performance.now() - ocrStartedAt);
                    winnerVariant = 'variant' in crop && typeof crop.variant === 'string' ? crop.variant : 'ORIGINAL';
                    break;
                  }

                  // Secondary early-exit: any crop variant that gives a fully valid
                  // long result at high confidence can stop the loop.
                  if (
                    resultText &&
                    isPlausible &&
                    result.confidence >= 0.25 &&
                    pattern.score >= 0.65 &&
                    pattern.isValid &&
                    resultText.length >= 5 &&
                    score >= 0.60 &&
                    result.confidence >= Math.max(recoveryMode ? 0.95 : 0.90, scannerSettings.recognitionThreshold)
                  ) {
                    winnerVariant = 'variant' in crop && typeof crop.variant === 'string' ? crop.variant : 'FALLBACK';
                    break;
                  }
                }

                collectDatasetSample({
                  sourceCanvas: canvas,
                  cropCanvas: ocrCrop,
                  sourceSlotId,
                  environment: ocrEnvironment,
                  environmentConfidence: ocrEnvironmentConfidence,
                  qualityClass: ocrQualityClass,
                  qualityConfidence: ocrQualityConfidence,
                  qualityScore: modelQuality.qualityScore,
                  qualityBackend: modelQuality.backend,
                  qualityRejectionReasons: modelQuality.rejectionReasons,
                  selectedPreprocessing: modelQuality.selectedPreprocessing,
                  ocrResult: text,
                  ocrConfidence: conf,
                  detectorConfidence: track.bbox.confidence ?? 0,
                  trackConfidence: track.trackConfidence ?? 0,
                });

                if (stopped || slotRuntime.ocrGeneration !== ocrGeneration) return;
                const updatedTrack = slotRuntime.tracker.getTrack(trackId) || track;
                if (!updatedTrack) return;

                const ocrAttempts = updatedTrack.stats?.ocrAttempts ?? 1;
                // STRICT OCR AGE MEASUREMENT (Requirement 1):
                // Measure how long OCR has been trying (ocrElapsedMs), NEVER track age / firstSeenTimestamp.
                const ocrElapsedMs = updatedTrack.firstOcrStartedAt
                  ? Math.round(performance.now() - updatedTrack.firstOcrStartedAt)
                  : Math.round(performance.now() - ocrStartedAt);
                // A single attempt that ran over the time limit is NOT isFinalAttempt yet:
                // the track should still be allowed one more retry on the saved crop.
                // Only lock when EITHER 3 attempts are done OR elapsed is >= 2500ms.
                const isFinalAttempt = ocrAttempts >= 3 || ocrElapsedMs >= 2500;

                if (text && conf >= 0.25) {
                  const cameraId = sourceSlotId || updatedTrack.cameraId || 'Camera 1';
                  updatedTrack.cameraId = cameraId;
                  const sourceDimensions = canvas ? { width: canvas.width, height: canvas.height } : undefined;

                  const slotConfig = cameraSlotsRef.current.find((s) => s.id === sourceSlotId);
                  let cameraMovementMode: 'STATIONARY' | 'MOVING' | 'UNKNOWN' = 'UNKNOWN';
                  if (slotConfig?.movementMode === 'STATIONARY') {
                    cameraMovementMode = 'STATIONARY';
                  } else if (slotConfig?.movementMode === 'MOBILE') {
                    cameraMovementMode = 'MOVING';
                  } else {
                    const isHighway = adaptiveConfigRef.current.environment.label === 'HIGHWAY';
                    cameraMovementMode = isHighway ? 'MOVING' : 'UNKNOWN';
                  }
                  const isMobileCamera = cameraMovementMode === 'MOVING';

                  const confirmationReport = evaluateMalaysianPlateFinalConfirmation(
                    updatedTrack,
                    text,
                    conf,
                    undefined,
                    {
                      cameraId,
                      sourceDimensions,
                      isMobileCamera,
                      cameraMovementMode,
                    }
                  );

                  const ctx = confirmationReport.contextDetails;
                  console.info(
                    `[ANPR:CONFIRMATION] Camera=${cameraId} Track=${trackId} OCR="${text}" ` +
                    `OCR_conf=${conf.toFixed(2)} Pattern=${confirmationReport.isPatternValid ? 'PASS' : 'FAIL'} ` +
                    `Colour=${updatedTrack.malaysianColourProfile || 'UNKNOWN'} ` +
                    `Repeat=${confirmationReport.temporalVoteCount}/${confirmationReport.temporalVoteCount} ` +
                    `Motion=${ctx?.motionLabel ?? 'NONE'} ScaleChange=${ctx?.scaleLabel ?? 'NONE'} Position=${ctx?.positionLabel ?? 'CENTER'} ` +
                    `StaticEvidence=${ctx?.staticEvidenceLabel ?? 'LOW'} SignEvidence=${ctx?.signEvidenceLabel ?? 'LOW'} ` +
                    `FinalScore=${confirmationReport.finalMalaysiaPlateScore.toFixed(2)} ` +
                    `Decision=${confirmationReport.decision}` +
                    (confirmationReport.rejectionReason ? ` Reason="${confirmationReport.rejectionReason}"` : '')
                  );

                  if (confirmationReport.decision === 'REJECTED_NON_PLATE') {
                    updatedTrack.candidateState = 'REJECTED_NON_PLATE';
                    updatedTrack.isConfirmed = false;
                    updatedTrack.ocrEvidencePending = false;
                    slotRuntime.bestFrameSelector.clearTrack(updatedTrack.trackNumber);
                    return;
                  }

                  if (confirmationReport.decision === 'CONFIRMED_PLATE') {
                    updatedTrack.candidateState = 'CONFIRMED_PLATE';
                    updatedTrack.isConfirmed = true;
                  }

                  bumpDiag('ocrAccepted');
                  console.info(`[ANPR:OCR_ACCEPTED] trackId=${trackId} plate="${text}" conf=${conf.toFixed(2)} score=${bestScore.toFixed(2)} votes=${(updatedTrack.votes.get(text)?.count ?? 0) + 1}`);
                  // Quality selects recovery; it is not the OCR probability.
                  // In particular, the original blur score must not suppress
                  // a confident reading from its corrected pixels.
                  addOcrVoteToTrack(updatedTrack, text, conf, 1, targetCropCapturedAt);
                  const plateSnapshotDataUrl = rememberTrackPlateSnapshot(
                    updatedTrack,
                    ocrCrop,
                    modelQuality.qualityScore,
                    text,
                    conf
                  );
                  if (updatedTrack.stats) updatedTrack.stats.ocrAccepted++;
                  runtimeMetricsRef.current.ocrAcceptedCount++;
                  updatedTrack.ocrState = 'CONSENSUS_BUILDING';
                  updatedTrack.pipelineState = 'CONSENSUS';

                  // Live webcams commonly have compression and reflected light.
                  // Require two exact source-frame reads at this lower floor;
                  // a single-frame result still uses the stricter publication
                  // threshold through canUseSingleOcrObservation.
                  const adaptiveRecognitionThreshold = Math.max(
                    MIN_CORROBORATED_OCR_CONFIDENCE,
                    scannerSettings.recognitionThreshold,
                    adaptiveConfig.ocr.recognitionThreshold
                  );
                  const strongRead = bestPatternValid && conf >= adaptiveRecognitionThreshold && bestScore >= 0.70;
                  const requiredVotes = (winnerHasCorroboratedRows && strongRead) || (!isTwoLinePlate && canUseSingleOcrObservation(conf, winnerVariant, targetCropKind) && canCommitSingleReadOutcome(text, conf, bestScore, isSampleVideo))
                      ? 1
                      : strongRead ? 2 : Math.max(scannerSettings.consensusVotes, adaptiveConfig.ocr.consensusVotes);
                  if (updatedTrack.stats) updatedTrack.stats.consensusAttempts++;
                  runtimeMetricsRef.current.consensusAttemptCount++;
                  const consensus = evaluateConsensus(updatedTrack, requiredVotes, adaptiveRecognitionThreshold, true);

                  if (consensus.isStabilized) {
                    if (stopped || slotRuntime.ocrGeneration !== ocrGeneration) return;
                    // Confidence belongs to the exact selected observation,
                    // never to a different candidate from the latest attempt.
                    const matchConfidence = consensus.confidence;

                    const targetPlate = consensus.normalizedPlate;
                    updatedTrack.stabilizedPlate = targetPlate;
                    updatedTrack.stabilizedConfidence = matchConfidence;
                    // Database publication owns the committed/locked state.
                    updatedTrack.ocrState = 'CONSENSUS_BUILDING';
                    // Clear pending evidence once resolved (Requirement 2)
                    updatedTrack.ocrEvidencePending = false;
                    const noMatchOutcomeReady = canCommitNoMatchOutcome(
                      targetPlate,
                      matchConfidence,
                      bestScore,
                      consensus.voteCount
                    );
                    const ocrPassLatencyMs = performance.now() - ocrStartedAt;
                    if (updatedTrack.stats) {
                      updatedTrack.stats.lastOcrLatencyMs = Math.round(ocrPassLatencyMs);
                      updatedTrack.stats.winnerVariant = winnerVariant;
                    }
                    if (updatedTrack.telemetry) {
                      updatedTrack.telemetry.committedAt = Date.now();
                      updatedTrack.telemetry.winnerVariant = winnerVariant;
                    }

                    if (settingsRef.current.debugMode || typeof window !== 'undefined') {
                      const yoloMs = updatedTrack.stats?.lastDetectorLatencyMs ?? 0;
                      const queueMs = updatedTrack.stats?.queueWaitMs ?? 0;
                      const ocrMs = Math.round(ocrPassLatencyMs);
                      const totalMs = yoloMs + queueMs + ocrMs;
                      console.info(`[ANPR:${sourceSlotId}] Timing: YOLO = ${yoloMs}ms | Queue Wait = ${queueMs}ms | OCR = ${ocrMs}ms | Total = ${totalMs}ms | Plate = ${targetPlate} (${winnerVariant})`);
                    }

                    await runDatabaseMatch(updatedTrack, targetPlate, matchConfidence, sourceSlotId, {
                      commitNoCase: isFinalAttempt || noMatchOutcomeReady,
                      plateSnapshotDataUrl,
                      ocrStartedAt,
                      ocrElapsedMs,
                      observationBox: targetCropBox,
                      capturedAt: targetCropCapturedAt,
                      corroboratingObservations: consensus.voteCount,
                    });
                  }
                } else if (isFinalAttempt) {
                  const rejectReason = !text ? 'EMPTY_OCR_TEXT' : conf < 0.25 ? 'OCR_CONFIDENCE_BELOW_FLOOR' : 'OCR_FAILED_FINAL_ATTEMPT';
                  console.warn(`[ANPR:OCR_REJECTED] trackId=${trackId} reason="${rejectReason}" rawText="${text}" conf=${conf.toFixed(2)} attempts=${ocrAttempts}`);
                  // No read is not a match. Leave this track eligible when a
                  // new source frame arrives, while bounding frozen retries.
                  updatedTrack.ocrState = 'COLLECTING';
                  updatedTrack.pipelineState = 'COLLECTING';
                  updatedTrack.ocrEvidencePending = false;
                } else if (updatedTrack.votes.size === 0) {
                  const rejectReason = !text ? 'EMPTY_OCR_TEXT' : conf < 0.25 ? 'OCR_CONFIDENCE_BELOW_FLOOR' : 'OCR_CANDIDATE_REJECTED_RETRYING';
                  console.warn(`[ANPR:OCR_REJECTED] trackId=${trackId} reason="${rejectReason}" rawText="${text}" conf=${conf.toFixed(2)} attempts=${ocrAttempts}`);
                  updatedTrack.ocrState = 'COLLECTING';
                  updatedTrack.pipelineState = 'COLLECTING';
                  // Preserve ocrEvidencePending = true for retry
                } else {
                  console.warn(`[ANPR:OCR_REJECTED] trackId=${trackId} reason="OCR_CANDIDATE_NOT_STABILIZED" rawText="${text}" conf=${conf.toFixed(2)} votes=${updatedTrack.votes.size}`);
                  updatedTrack.ocrState = 'CONSENSUS_BUILDING';
                  updatedTrack.pipelineState = 'CONSENSUS';
                  // Preserve ocrEvidencePending = true for retry
                }
              } catch (err) {
                console.warn(`[OCR:${sourceSlotId}] Error:`, err);
              } finally {
                transientCanvases.forEach(releaseCanvasMemory);
                const ocrPassDurationMs = performance.now() - ocrStartedAt;
                runtimeMetricsRef.current.ocrLatencyTotalMs += ocrPassDurationMs;
                runtimeMetricsRef.current.ocrLatencySamples++;
                pushBoundedMetricSample(runtimeMetricsRef.current.ocrLatencyHistoryMs, ocrPassDurationMs);
                addEnvironmentOcrSample(runtimeMetricsRef.current, ocrEnvironment, ocrPassDurationMs, ocrQualityScore);
                const refreshedTrack =
                  slotRuntime.ocrGeneration === ocrGeneration ? slotRuntime.tracker.getTrack(trackId) : undefined;
                if (refreshedTrack) {
                  refreshedTrack.ocrRunning = false;
                  refreshedTrack.ocrJobQueued = false;
                  refreshedTrack.lastOcrCompletedAt = Date.now();
                  if (refreshedTrack.stats) {
                    refreshedTrack.stats.lastOcrLatencyMs = Math.round(ocrPassDurationMs);
                  }
                  // Three attempts exhaust retries on one crop, not the
                  // unread snapshots of a passing car. Keep those alive until
                  // they are consumed or the bounded evidence lifetime ends.
                  refreshedTrack.ocrEvidencePending = !refreshedTrack.scanEventId &&
                    slotRuntime.bestFrameSelector.getTopCrops(refreshedTrack.trackNumber, 16)
                      .some(crop => !refreshedTrack.ocrAttemptedCropIds?.has(crop.id));
                  if (refreshedTrack.pipelineState === 'READING' && !refreshedTrack.cooldownActive) {
                    refreshedTrack.pipelineState = isTrackAvailableForReading(refreshedTrack) ? 'COLLECTING' : 'TRACKING';
                  }
                }
                releaseJob();
              }
            })();
          } catch (error) {
            console.warn(`[OCR:${sourceSlotId}] Crop preparation failed:`, error);
          } finally {
            ownedCrops.forEach(releaseCanvasMemory);
            if (!jobStarted) {
              track.ocrJobQueued = false;
              releaseJob();
            }
          }
        };

        await Promise.all(priorityIds.map((trackId, priorityIndex) => processTrack(trackId, priorityIndex)));
      };

      const renderLoop = () => {
        if (stopped) return;

        const video = videoRefs.current[slotId];
        const overlayCanvas = canvasRefs.current[slotId];

        if (cameraSlotStatusRef.current[slotId] !== 'RUNNING' || !video || !overlayCanvas) {
          if (overlayCanvas) {
            const overlayCtx = overlayCanvas.getContext('2d');
            overlayCtx?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
          }
          animId = requestAnimationFrame(renderLoop);
          return;
        }

        if (video.readyState >= 2 && video.videoWidth > 0) {
          const overlayDimensions = runtime.processingCanvas?.width
            ? { width: runtime.processingCanvas.width, height: runtime.processingCanvas.height }
            : getProcessingDimensions(
                video.videoWidth,
                video.videoHeight,
                runtimeMetricsRef.current.deviceTier,
                runtimeMetricsRef.current.adaptationLevel,
                adaptiveConfigRef.current.processing.maxLongEdge
              );
          if (overlayCanvas.width !== video.videoWidth || overlayCanvas.height !== video.videoHeight) {
            overlayCanvas.width = video.videoWidth;
            overlayCanvas.height = video.videoHeight;
          }

          const overlayCtx = overlayCanvas.getContext('2d');
          if (overlayCtx) {
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            const scannerSettings = settingsRef.current;
            const preserveEndedSampleFrame = scannerSourceModeRef.current === 'SAMPLE_VIDEO';

            // Scale track bounding boxes from processing canvas resolution to
            // native video resolution so bounding box overlays align precisely
            // over license plates across all video aspect ratios (landscape & portrait).
            const procW = runtime.processingCanvas?.width || video.videoWidth;
            const procH = runtime.processingCanvas?.height || video.videoHeight;
            const scaleX = video.videoWidth / procW;
            const scaleY = video.videoHeight / procH;

            const displayTracks = runtime.tracker.getActiveTracks(false)
              .filter((track) =>
                isTrackDrawable(track, preserveEndedSampleFrame && video.ended, video.currentTime)
              )
              .map((track) => ({
                ...track,
                bbox: scaleBoundingBox(track.bbox, scaleX, scaleY),
                smoothBbox: scaleBoundingBox(track.smoothBbox, scaleX, scaleY),
                predictedBbox: track.predictedBbox ? scaleBoundingBox(track.predictedBbox, scaleX, scaleY) : undefined,
              }));

            drawOverlays(
              overlayCtx,
              overlayCanvas.width,
              overlayCanvas.height,
              displayTracks,
              scannerSettings.debugMode,
              scannerSourceModeRef.current === 'CAMERA' && isCameraPreviewMirroredRef.current
            );
          }

          if (
            scannerSourceModeRef.current === 'SAMPLE_VIDEO' &&
            lastVideoTime >= 0 &&
            video.currentTime < lastVideoTime - SAMPLE_VIDEO_LOOP_RESET_THRESHOLD_SECONDS
          ) {
            resetSlotRuntimeForVideoLoop();
          }

          if (video.currentTime !== lastVideoTime) {
            metrics.camFrames++;
            lastVideoTime = video.currentTime;
          }
        }

        const now = Date.now();
        if (now - lastMetricsFlushTs.current >= SCANNER_UI_FLUSH_INTERVAL_MS) {
          lastMetricsFlushTs.current = now;
          flushScannerMetrics();
        }

        animId = requestAnimationFrame(renderLoop);
      };

      slotRunners.set(slotId, { runDetection });
      const rafCleanup = () => {
        cancelAnimationFrame(animId);
        metrics.platesVisible = 0;
        metrics.activeTracks = 0;
        metrics.tracks = [];
      };
      animCleanup.set(slotId, rafCleanup);
      animId = requestAnimationFrame(renderLoop);

      return rafCleanup;
    };

    const cleanupRunners = slotsToScan.map((slot) => makeSlotRunner(slot.id));

    const scheduler = new CameraDetectionScheduler({
      getSlotIds: () => {
        // Always read from refs — this callback is called every scheduler tick
        // so it automatically reflects the current set of running slots without
        // needing cameraSlots or previewSlotIds in the effect dependency array.
        return cameraSlotsRef.current
          .filter((slot) => {
            const status = cameraSlotStatusRef.current[slot.id];
            const hasVideo = Boolean(videoRefs.current[slot.id]);
            const hasStreamOrSample = Boolean(activeStreamsRef.current[slot.id] || scannerSourceModeRef.current === 'SAMPLE_VIDEO');
            return previewSlotIdsRef.current.includes(slot.id) && status === 'RUNNING' && hasVideo && hasStreamOrSample;
          })
          .map((slot) => slot.id);
      },
      runTurn: async ({ slotId }) => {
        if (stopped) return;
        const runner = slotRunners.get(slotId);
        if (runner) {
          return await runner.runDetection();
        }
      },
    });
    scheduler.start();

    // Store factory for slot-sync effect to call for newly added slots.
    registerSlotRunnerRef.current = makeSlotRunner;

    return () => {
      stopped = true;
      stoppedSessionRef.current = true;
      registerSlotRunnerRef.current = null;
      scheduler.stop();
      cleanupRunners.forEach((cleanup) => cleanup());
      slotRunners.clear();
      animCleanup.clear();
      flushScannerMetrics();
    };
  }, [
    collectDatasetSample,
    ensureSlotMetrics,
    flushScannerMetrics,
    getSlotRuntime,
    isCameraReady,
    isScanning,
    queueEnvironmentSample,
    runDatabaseMatch,
    scannerProcessingPaused,
  ]);

  // ── Dynamic slot runner registration ───────────────────────────────────────
  // Runs when the set of preview slots changes. Adds runners for newly active
  // slots and tears down runners for removed slots WITHOUT stopping the
  // CameraDetectionScheduler or interrupting other running slots.
  useEffect(() => {
    if (!isCameraReady || !isScanning || scannerProcessingPaused) return;

    const slotRunners = slotRunnersRegistryRef.current;
    const animCleanup = slotAnimCleanupRef.current;

    // Determine which slots currently need a runner.
    const activeSlotsNeedingRunner = cameraSlotsRef.current.filter(
      (slot) => previewSlotIdsRef.current.includes(slot.id) && videoRefs.current[slot.id]
    );
    const neededIds = new Set(activeSlotsNeedingRunner.map((s) => s.id));

    // Remove runners for slots that are no longer active.
    for (const [slotId, cleanup] of animCleanup.entries()) {
      if (!neededIds.has(slotId)) {
        cleanup();
      }
    }

    // Add runners for slots that are newly active.
    for (const slot of activeSlotsNeedingRunner) {
      if (slotRunners.has(slot.id)) continue; // already registered

      if (registerSlotRunnerRef.current) {
        registerSlotRunnerRef.current(slot.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraSlots, previewSlotIds, isCameraReady, isScanning, scannerProcessingPaused]);


  function drawOverlays(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    tracks: ActiveTrack[],
    showGuide: boolean,
    isMirrored = false
  ) {
    if (showGuide) {
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      const guideWidth = width * 0.6;
      const guideHeight = guideWidth / 4;
      ctx.strokeRect((width - guideWidth) / 2, (height - guideHeight) / 2, guideWidth, guideHeight);
      ctx.setLineDash([]);
    }

    // 1 physical plate = 1 visual box. Ensure no duplicate overlapping boxes are drawn on the same vehicle.
    const drawableTracks: ActiveTrack[] = [];
    tracks.forEach((track) => {
      const isDuplicate = drawableTracks.some((existing) => {
        const iou = calculateIoU(existing.bbox, track.bbox);
        return iou >= 0.35;
      });
      if (!isDuplicate) {
        drawableTracks.push(track);
      }
    });

    drawableTracks.forEach((track) => {
      // Use smoothBbox during vehicle motion (20km/h - 60km/h) to prevent hovering and late tracking,
      // and use predicted/smooth box during 1-2 frame detector dropouts.
      const overlayBox = (track.smoothBbox && (track.motionScore ?? 0) > 0.04)
        ? track.smoothBbox
        : (track.visibleThisFrame === false
          ? (track.predictedBbox || track.smoothBbox || track.bbox)
          : track.bbox);
      const { x, y, width: boxWidth, height: boxHeight } = overlayBox;
      const color = getTrackColor(track);
      const plateText = getTrackPlateText(track);
      const label = plateText || (track.matchType ? getTrackStatusLabel(track) : '');
      const angle = track.overlayAngle ?? 0;

      // Every valid detector candidate gets an outline immediately. OCR and
      // temporal confirmation only govern recognition/session results.
      const cx = x + boxWidth / 2;
      const cy = y + boxHeight / 2;
      const drawWidth = boxWidth * 1.02;
      const drawHeight = boxHeight * 1.08;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      drawRoundedRect(ctx, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight, 7);
      ctx.stroke();
      ctx.restore();

      if (!label) return;

      ctx.save();
      ctx.font = 'bold 14px sans-serif';
      const textWidth = ctx.measureText(label).width;
      const pillWidth = Math.max(56, textWidth + 18);
      const pillHeight = 26;
      const normalX = Math.sin(angle);
      const normalY = -Math.cos(angle);
      const pillCx = clampNumber(cx + normalX * (drawHeight / 2 + pillHeight / 2 + 6), pillWidth / 2 + 2, width - pillWidth / 2 - 2);
      const pillCy = clampNumber(cy + normalY * (drawHeight / 2 + pillHeight / 2 + 6), pillHeight / 2 + 2, height - pillHeight / 2 - 2);
      const pillX = pillCx - pillWidth / 2;
      const pillY = pillCy - pillHeight / 2;

      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      drawRoundedRect(ctx, pillX, pillY, pillWidth, pillHeight, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = track.matchType === 'EXACT' ? '#ffffff' : '#020617';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (isMirrored) {
        ctx.save();
        ctx.translate(pillCx, pillCy);
        ctx.scale(-1, 1);
        ctx.fillText(label, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(label, pillCx, pillCy);
      }
      ctx.restore();

      if (showGuide) {
        const debugLines = [
          `Q ${track.qualityClass ?? 'WAIT'} ${Math.round((track.qualityConfidence ?? 0) * 100)}% score ${Math.round((track.qualityScore ?? 0) * 100)}%`,
          `engine ${track.qualityBackend ?? getPlateQualityBackend()} ${track.qualityAcceptedForOcr ? 'ACCEPT' : 'WAIT'}`,
          `crop ${track.qualityCropSize ? `${track.qualityCropSize.width}x${track.qualityCropSize.height}` : '-'} sharp ${Math.round((track.qualitySharpness ?? 0) * 100)}%`,
          `prep ${(track.qualitySelectedPreprocessing ?? ['ORIGINAL']).join(',')} submitted ${track.qualitySubmittedToOcr ? 'YES' : 'NO'}`,
          track.qualityRejectionReasons?.length ? `reason ${track.qualityRejectionReasons.slice(0, 2).join(',')}` : '',
        ].filter(Boolean);
        const lineHeight = 13;
        const panelWidth = Math.min(width - 8, Math.max(180, ...debugLines.map((line) => ctx.measureText(line).width + 12)));
        const panelHeight = debugLines.length * lineHeight + 8;
        const panelX = clampNumber(x, 4, Math.max(4, width - panelWidth - 4));
        const panelY = clampNumber(y + boxHeight + 8, 4, Math.max(4, height - panelHeight - 4));

        ctx.save();
        ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        drawRoundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 5);
        ctx.fill();
        ctx.stroke();
        ctx.font = '10px monospace';
        ctx.fillStyle = '#cffafe';
        if (isMirrored) {
          ctx.save();
          ctx.translate(panelX + panelWidth, panelY);
          ctx.scale(-1, 1);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          debugLines.forEach((line, index) => {
            ctx.fillText(line, 6, 5 + index * lineHeight);
          });
          ctx.restore();
        } else {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          debugLines.forEach((line, index) => {
            ctx.fillText(line, panelX + 6, panelY + 5 + index * lineHeight);
          });
        }
        ctx.restore();
      }
    });
  }

  const markAlertActionReviewed = (args: {
    vehicle: Vehicle;
    detectionId?: string;
    cameraId: string;
    cameraName: string;
    source: 'ALERT' | 'LIST';
  }) => {
    if (args.detectionId) {
      if (reviewedAlertDetectionIdsRef.current.has(args.detectionId)) return;
      reviewedAlertDetectionIdsRef.current.add(args.detectionId);
    }

    const actionedAt = new Date().toISOString();
    const flaggedVehicle = { ...args.vehicle, status: 'FLAGGED' as const };
    updateVehicle(flaggedVehicle);
    addHistoryLog({
      type: 'ACTION',
      action:
        args.source === 'ALERT'
          ? `Tanda Tindakan (Disemak): ${args.vehicle.plate}`
          : `Tanda Tindakan (Pengimbas): ${args.vehicle.plate}`,
      plate: args.vehicle.plate,
      details:
        args.source === 'ALERT'
          ? `Alert Tanda Tindakan disahkan oleh ${role} pada ${args.cameraName}. Status ditukar: ${args.vehicle.status} → FLAGGED`
          : `Tanda Tindakan disahkan oleh ${role} dari senarai pada ${args.cameraName}. Status ditukar: ${args.vehicle.status} → FLAGGED`,
      note:
        args.source === 'ALERT'
          ? `Ditanda Tindakan oleh ${role} pada ${args.cameraName}`
          : `Ditanda Tindakan oleh ${role} dari ${args.cameraName}`,
      cameraId: args.cameraId,
      cameraName: args.cameraName,
      userRole: role,
      statusMatch: 'EXACT',
    });

    setLiveDetections((prevStream) => {
      let changed = false;
      const nextStream = prevStream.map((item) => {
        const isTarget =
          (args.detectionId && item.id === args.detectionId) ||
          (!args.detectionId && item.vehicleId === args.vehicle.id && item.actionStatus !== 'REVIEWED');

        if (!isTarget) return item;
        changed = true;
        return {
          ...item,
          matched: true,
          matchType: 'EXACT' as const,
          vehicleId: args.vehicle.id,
          actionStatus: 'REVIEWED' as const,
          actionedAt,
          actionedBy: role,
        };
      });

      if (changed) {
        localStorage.setItem(RECENT_DETECTIONS_STORAGE_KEY, JSON.stringify(nextStream));
        return nextStream;
      }

      return prevStream;
    });

    setActiveAlertMatchesBySlot((alerts) => {
      const nextAlerts = { ...alerts };
      Object.entries(alerts).forEach(([alertSlotId, alertMatch]) => {
        if (
          alertMatch.vehicle.id === args.vehicle.id ||
          (args.detectionId && alertMatch.detectionId === args.detectionId)
        ) {
          delete nextAlerts[alertSlotId];
        }
      });
      return nextAlerts;
    });
  };

  const handleMarkAsSeen = (slotId: string) => {
    const activeAlertMatch = activeAlertMatchesBySlot[slotId];
    if (!activeAlertMatch) return;

    markAlertActionReviewed({
      vehicle: activeAlertMatch.vehicle,
      detectionId: activeAlertMatch.detectionId,
      cameraId: activeAlertMatch.cameraId,
      cameraName: activeAlertMatch.cameraName,
      source: 'ALERT',
    });
  };

  const handleMarkDetectionAction = (detection: SessionDetection) => {
    if (!isUnreviewedAlertDetection(detection)) return;

    const vehicle = vehicles.find((item) => item.id === detection.vehicleId);
    if (!vehicle) return;

    markAlertActionReviewed({
      vehicle,
      detectionId: detection.id,
      cameraId: detection.cameraId,
      cameraName: detection.cameraName,
      source: 'LIST',
    });
  };

  const handleExportScannerMetrics = () => {
    if (!canUseDiagnostics) return;
    const snapshot = createMetricsSnapshot(runtimeMetricsRef.current, tracksList);
    const health = createSystemHealthSnapshot(snapshot, detFps, camFps);
    const payload = {
      exportedAt: new Date().toISOString(),
      device: typeof navigator !== 'undefined'
        ? {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
          }
        : null,
      benchmark: benchmarkResult,
      performanceTargets: SCANNER_PERFORMANCE_TARGETS,
      health,
      metrics: snapshot,
      environment: {
        current: snapshot.currentEnvironment,
        confidence: snapshot.currentEnvironmentConfidence,
        source: snapshot.currentEnvironmentSource,
        modelStatus: getEnvironmentModelStatus(),
        distributionPercent: serializeDistributionPercentages(snapshot.environmentDistribution),
        perEnvironmentStats: snapshot.environmentStats,
      },
      quality: {
        current: snapshot.currentQuality,
        confidence: snapshot.currentQualityConfidence,
        backend: snapshot.currentQualityBackend,
        engine: getPlateQualityEngineLabel(),
        modelStatus: getPlateQualityModelStatus(),
        latencyAvgMs: snapshot.qualityLatencyAvgMs,
        latencyP95Ms: snapshot.qualityLatencyP95Ms,
        acceptedCrops: snapshot.qualityAcceptedCropCount,
        rejectedCrops: snapshot.qualityRejectedCropCount,
        rejectionReasons: snapshot.qualityRejectionReasons,
        ocrAvoided: snapshot.qualityOcrAvoidedCount,
        correctableRecovered: snapshot.qualityCorrectableRecoveredCount,
        heuristicUsage: snapshot.heuristicQualityUsageCount,
        onnxUsage: snapshot.onnxQualityUsageCount,
        distributionPercent: serializeDistributionPercentages(snapshot.qualityDistribution),
      },
      camera: {
        selectedSlotId: activeCameraSlotIdRef.current,
        metadataBySlot: cameraMetadataBySlotRef.current,
        health: snapshot.cameraHealth,
      },
      runtimeConfig: {
        executionMode: snapshot.executionMode,
        cameraProfile: snapshot.cameraProfile,
        processingProfile: snapshot.processingProfile,
        ocrProfile: snapshot.ocrProfile,
        baseDeviceTier: snapshot.baseDeviceTier,
        activeDeviceTier: snapshot.deviceTier,
        adaptationLevel: snapshot.adaptationLevel,
        performanceMode: snapshot.performanceMode,
        performanceModeReason: snapshot.performanceModeReason,
        detectorTargetMs: getTierDetectorTargetMs(snapshot.deviceTier),
        detectorBusyIntervalMs: getTierDetectorBusyIntervalMs(snapshot.deviceTier),
        adaptiveConfig: adaptiveConfigRef.current,
        supportedDesktopBrowser: isSupportedDesktopScannerBrowser(),
      },
      detectorMetrics: {
        medianLatencyMs: snapshot.detectorLatencyMedianMs,
        p95LatencyMs: snapshot.detectorLatencyP95Ms,
        averageLatencyMs: snapshot.detectorLatencyAvgMs,
        fps: detFps,
        frames: snapshot.detectorLatencySamples,
      },
      ocrMetrics: {
        medianLatencyMs: snapshot.ocrLatencyMedianMs,
        p95LatencyMs: snapshot.ocrLatencyP95Ms,
        averageLatencyMs: snapshot.ocrLatencyAvgMs,
        attempts: snapshot.ocrAttemptCount,
        accepted: snapshot.ocrAcceptedCount,
        duplicateRate: snapshot.duplicateOcrRate,
        queuePressureSkips: snapshot.ocrSkippedQueuePressureCount,
      },
      databaseMetrics: {
        completedEvents: completedTrackEventsRef.current.length,
        falseExactMatches: snapshot.falseAlertCount,
        exactMatches: completedTrackEventsRef.current.filter((event) => event.matchType === 'EXACT').length,
        possibleMatches: completedTrackEventsRef.current.filter((event) => event.matchType === 'POSSIBLE').length,
        noMatches: completedTrackEventsRef.current.filter((event) => event.matchType === 'NONE').length,
      },
      completedTrackEvents: completedTrackEventsRef.current,
      activeTracks: tracksList.map((track) => ({
        trackId: track.trackId,
        state: track.trackState,
        pipelineState: track.pipelineState,
        framesSeen: track.framesSeen,
        missedFrames: track.missedFrames ?? 0,
        motionScore: track.motionScore ?? 0,
        trackConfidence: track.trackConfidence ?? 0,
        confidenceComponents: track.confidenceComponents,
        quality: {
          className: track.qualityClass,
          confidence: track.qualityConfidence,
          score: track.qualityScore,
          backend: track.qualityBackend,
          acceptedForOcr: track.qualityAcceptedForOcr,
          rejectionReasons: track.qualityRejectionReasons,
          cropSize: track.qualityCropSize,
          sharpness: track.qualitySharpness,
          selectedPreprocessing: track.qualitySelectedPreprocessing,
          submittedToOcr: track.qualitySubmittedToOcr,
        },
        stats: track.stats,
        currentPlate: getTrackPlateText(track),
      })),
    };

    downloadJson(`track_scanner_metrics_${Date.now()}.json`, payload);
  };

  const handleExportDataset = () => {
    if (!canUseDiagnostics) return;
    const samples = datasetSamplesRef.current;
    const yoloDataset = samples.map((sample) => ({
      imagePath: `${sample.folderPath}/original.jpg`,
      cropPath: `${sample.folderPath}/plate_crop.jpg`,
      label: 'license-plate',
      detectorConfidence: sample.detectorConfidence,
      environmentClass: sample.environmentClass,
      camera: sample.camera,
      timestamp: sample.timestamp,
    }));
    const ocrDataset = samples.map((sample) => ({
      imagePath: `${sample.folderPath}/plate_crop.jpg`,
      text: sample.ocrResult,
      confidence: sample.ocrConfidence,
      qualityClass: sample.qualityClass,
      qualityScore: sample.qualityScore,
      qualityBackend: sample.qualityBackend,
      selectedPreprocessing: sample.selectedPreprocessing,
      environmentClass: sample.environmentClass,
      timestamp: sample.timestamp,
    }));
    const classificationDataset = samples.flatMap((sample) => [
      {
        imagePath: `${sample.folderPath}/original.jpg`,
        task: 'environment',
        className: sample.environmentClass,
        confidence: sample.environmentConfidence,
      },
      {
        imagePath: `${sample.folderPath}/plate_crop.jpg`,
        task: 'plate_quality',
        className: sample.qualityClass,
        confidence: sample.qualityConfidence,
        qualityScore: sample.qualityScore,
        backend: sample.qualityBackend,
        rejectionReasons: sample.qualityRejectionReasons,
      },
    ]);

    downloadJson(`track_dataset_export_${Date.now()}.json`, {
      exportedAt: new Date().toISOString(),
      schemaVersion: 2,
      sampleCount: samples.length,
      qualityTask: createPlateQualityDatasetSchema(),
      folderStructure: samples.map((sample) => sample.folderPath),
      yoloDataset,
      ocrDataset,
      classificationDataset,
      samples,
    });
  };

  const runtimeReady = isRuntimeScanningReady(runtimeState);
  const scannerReloadActive = Boolean(scannerReloadNotice?.isReloading);
  const scannerReloadComplete = Boolean(scannerReloadNotice && !scannerReloadNotice.isReloading);
  const scannerNoticeMode = scannerReloadNotice?.mode ?? 'RELOADING';
  const scannerNoticeStarting = scannerReloadActive && scannerNoticeMode === 'STARTING';
  const scannerNoticeTitle = scannerNoticeStarting
    ? language === 'BM'
      ? 'Kamera dimulakan'
      : 'Camera initializing'
    : scannerReloadActive
    ? language === 'BM'
      ? 'Pengimbas dimuat semula'
      : 'Scanner reloading'
    : scannerNoticeMode === 'STARTING'
    ? language === 'BM'
      ? 'Kamera sedia'
      : 'Camera ready'
    : language === 'BM'
    ? 'Pengimbas disegar'
    : 'Scanner refreshed';
  const scannerNoticeBody = scannerReloadActive
    ? scannerNoticeMode === 'STARTING'
      ? language === 'BM'
        ? 'Kamera dibuka semula dan distabilkan sebelum imbasan bermula.'
        : 'Opening a fresh camera stream and letting it settle before scanning.'
      : language === 'BM'
      ? 'Kamera disambung semula kerana prestasi atau sambungan perlu disegar.'
      : 'Refreshing the camera because performance or stream health needed a reset.'
    : language === 'BM'
    ? 'Imbasan disambung semula.'
    : 'Scanning has resumed.';
  const scannerControlBusy = isScannerPreparing || scannerReloadActive || scannerProcessingPaused;
  const isMirroredCameraPreview = scannerSourceMode === 'CAMERA' && isCameraPreviewMirrored;
  const mirrorPreviewLabel = isCameraPreviewMirrored
    ? (language === 'BM' ? 'Nyah-cermin pratonton' : 'Unmirror preview')
    : (language === 'BM' ? 'Cerminkan pratonton' : 'Mirror preview');
  const visibleTracksWithPlates = tracksList.map((t) => getTrackPlateText(t) || getTrackBestObservedPlate(t)).filter(Boolean);
  const visiblePlatesSummary = Array.from(new Set(visibleTracksWithPlates)).join(', ');
  const activeScanTileCount = supportsMultiCameraScan
    ? cameraSlots.filter((slot) => previewSlotIds.includes(slot.id)).length
    : previewSlotIds.includes(activeCameraSlotId)
      ? 1
      : 0;
  const scannerStatusText = isFinishingSample
    ? (language === 'BM' ? 'Video tamat — memproses baki bacaan…' : 'Video ended — finishing plate readings…')
    : scannerReloadActive
    ? scannerNoticeMode === 'STARTING'
      ? 'Camera initializing - scanning starts after stream settles'
      : 'Scanner reloading - camera stream is being refreshed'
    : scannerReloadComplete
    ? scannerNoticeMode === 'STARTING'
      ? 'Camera ready and scanning started'
      : 'Scanner refreshed and scanning resumed'
    : cameraError
    ? 'Camera unavailable'
    : isScanning && runtimeReady && supportsMultiCameraScan
    ? `Scanning ${activeScanTileCount || 1} camera${(activeScanTileCount || 1) === 1 ? '' : 's'}${visiblePlatesSummary ? ` - ${visiblePlatesSummary}` : ''}`
    : isScanning && runtimeReady
    ? `Scanning selected camera${visiblePlatesSummary ? ` - ${visiblePlatesSummary}` : ''}`
    : isScanning
    ? 'AI models warming up'
    : previewSlotIds.length > 0
    ? 'Camera preview ready'
    : 'Choose camera in preview and start scanning';
  const latestDetection = liveDetections[0] || null;
  const latestExactVehicle =
    latestDetection?.vehicleId ? vehicles.find((vehicle) => vehicle.id === latestDetection.vehicleId) || null : null;
  const latestSearchHref = latestDetection ? `/search?plate=${encodeURIComponent(latestDetection.plate)}` : '/search';
  const latestResultTone =
    latestDetection?.matchType === 'EXACT' || latestDetection?.matched
      ? 'EXACT'
      : latestDetection?.matchType === 'POSSIBLE'
      ? 'POSSIBLE'
      : latestDetection
      ? 'NONE'
      : null;
  const latestActionPending = isUnreviewedAlertDetection(latestDetection);
  const selectableCameraDeviceCount = getSelectableCameraDeviceCount(availableCameras);
  const canAddCameraSlot =
    supportsMultiCameraScan &&
    cameraSlots.length < 4 &&
    (selectableCameraDeviceCount === 0 || selectableCameraDeviceCount > cameraSlots.length);

  const showDeveloperOverlay = effectiveDeveloperMode;
  const activeCameraMetadata = cameraMetadataBySlot[activeCameraSlotId];
  const environmentDistributionPercent = serializeDistributionPercentages(runtimeMetricsSnapshot.environmentDistribution);
  const qualityDistributionPercent = serializeDistributionPercentages(runtimeMetricsSnapshot.qualityDistribution);
  const activeCameraLabel = activeCameraMetadata?.label || getCameraSlotLabel(cameraSlots[0], 0);
  const simpleScannerStatus = cameraError
    ? language === 'BM'
      ? 'Kamera perlu disemak'
      : 'Camera needs attention'
    : scannerReloadActive
    ? scannerNoticeTitle
    : scannerReloadComplete
    ? scannerNoticeTitle
    : isScanning && runtimeReady
    ? language === 'BM'
      ? 'Sedang mengimbas'
      : 'Scanning'
    : isScanning
    ? language === 'BM'
      ? 'Memulakan pengimbas'
      : 'Starting scanner'
    : previewSlotIds.length > 0
    ? language === 'BM'
      ? 'Pratonton sedia'
      : 'Preview ready'
    : language === 'BM'
    ? 'Pilih kamera'
    : 'Choose camera';
  const simpleScannerHint = cameraError
    ? cameraError
    : scannerReloadActive
    ? scannerNoticeBody
    : scannerReloadComplete
    ? language === 'BM'
      ? `${scannerReloadNotice?.reason || 'Pengimbas disegar'}; imbasan disambung semula.`
      : `${scannerReloadNotice?.reason || 'Scanner refreshed'}; scanning has resumed.`
    : isScanning
    ? language === 'BM'
      ? 'Biarkan kamera aktif. Sistem akan terus mencari nombor plat.'
      : 'Keep the camera active. The scanner will continue looking for plates.'
    : previewSlotIds.length > 0
    ? language === 'BM'
      ? 'Tekan Mula Imbasan untuk mula.'
      : 'Press Start Scanning to begin.'
    : language === 'BM'
    ? 'Tekan Pratonton dan benarkan akses kamera.'
    : 'Press Preview and allow camera access.';
  const simpleLastResult = latestDetection
    ? latestResultTone === 'EXACT'
      ? language === 'BM'
        ? 'Padanan kes'
        : 'Match found'
      : latestResultTone === 'POSSIBLE'
      ? language === 'BM'
        ? 'Perlu semakan'
        : 'Needs review'
      : language === 'BM'
      ? 'Tiada padanan'
      : 'No match'
    : language === 'BM'
    ? 'Belum ada imbasan'
    : 'No scans yet';
  const simpleLastResultDetail = latestDetection
    ? `${latestDetection.plate} · ${latestDetection.confidence}%`
    : language === 'BM'
    ? 'Keputusan akan dipaparkan selepas plat dikesan.'
    : 'Results will appear after a plate is detected.';
  const recentDetectionByPlate = new Map<string, SessionDetection>();
  liveDetections.forEach((detection) => {
    const normalized = cleanPlateNumber(detection.plate);
    if (normalized && !recentDetectionByPlate.has(normalized)) {
      recentDetectionByPlate.set(normalized, detection);
    }
  });
  const activeSeenPlateItems: SeenPlateItem[] = tracksList
    .flatMap((track): SeenPlateItem[] => {
      const plate = cleanPlateNumber(getTrackBestObservedPlate(track));
      if (!plate) return [];

      const recentDetection = recentDetectionByPlate.get(plate);
      const tone = recentDetection ? getDetectionSeenPlateTone(recentDetection) : getTrackSeenPlateTone(track);
      const matchedVehicle =
        recentDetection?.vehicleId
          ? vehicles.find((vehicle) => vehicle.id === recentDetection.vehicleId) || null
          : track.matchedVehicle
            ? (track.matchedVehicle as Vehicle)
            : null;
      const detail =
        tone === 'EXACT' && matchedVehicle
          ? `${matchedVehicle.brand} ${matchedVehicle.model}`
          : tone === 'POSSIBLE'
            ? language === 'BM'
              ? 'Perlu semakan'
              : 'Needs review'
            : tone === 'NONE'
              ? language === 'BM'
                ? 'Tiada padanan'
                : 'No match'
              : getTrackStatusLabel(track);

      return [{
        id: `track-${track.trackId}`,
        plate,
        tone,
        confidence: recentDetection?.confidence ?? getTrackDisplayConfidencePercent(track),
        cameraName: recentDetection?.cameraName ?? activeCameraLabel,
        timestamp: recentDetection?.timestamp ?? new Date(track.lastSeenTimestamp || Date.now()).toLocaleTimeString('en-GB'),
        detail,
        searchHref: `/search?plate=${encodeURIComponent(plate)}`,
        active: true,
        detection: recentDetection,
        actionStatus: recentDetection?.actionStatus,
        snapshotDataUrl: recentDetection?.snapshotDataUrl,
        canMarkAction: isUnreviewedAlertDetection(recentDetection),
        timing: recentDetection ? getSampleDetectionTiming(recentDetection, language) : undefined,
      }];
    });
  const recentSeenPlateItems: SeenPlateItem[] = liveDetections
    .map((detection) => {
      const tone = getDetectionSeenPlateTone(detection);
      const matchedVehicle = detection.vehicleId
        ? vehicles.find((vehicle) => vehicle.id === detection.vehicleId) || null
        : null;
      return {
        id: `det-${detection.id}`,
        plate: cleanPlateNumber(detection.plate),
        tone,
        confidence: detection.confidence,
        cameraName: detection.cameraName,
        timestamp: detection.timestamp,
        detail:
          tone === 'EXACT' && matchedVehicle
            ? `${matchedVehicle.brand} ${matchedVehicle.model}`
            : tone === 'POSSIBLE'
              ? language === 'BM'
                ? 'Perlu semakan'
                : 'Needs review'
              : language === 'BM'
                ? 'Tiada padanan'
                : 'No match',
        searchHref: `/search?plate=${encodeURIComponent(detection.plate)}`,
        active: false,
        detection,
        actionStatus: detection.actionStatus,
        snapshotDataUrl: detection.snapshotDataUrl,
        canMarkAction: isUnreviewedAlertDetection(detection),
        timing: getSampleDetectionTiming(detection, language),
      };
    });
  // Cards represent committed session results and must not disappear when a
  // tracked vehicle leaves the frame. Tentative reads remain visible only in
  // the cyan overlay until consensus commits them to liveDetections.
  const seenPlateItems = recentSeenPlateItems.slice(0, 8);
  const scannerCameraStyle = {
    // Test clips must always show their full source frame. Camera pinch zoom is
    // intentionally limited to the live-camera path.
    '--scanner-camera-zoom': scannerSourceMode === 'SAMPLE_VIDEO' ? '1' : mobileCameraZoom.toFixed(2),
  } as React.CSSProperties;

  // Pinch-zoom refs — used by a non-passive native event listener so that
  // event.preventDefault() actually suppresses the browser's own zoom/scroll.
  const scannerCameraCardRef = useRef<HTMLDivElement | null>(null);
  const mobileCameraZoomRef = useRef(mobileCameraZoom);
  useEffect(() => {
    mobileCameraZoomRef.current = mobileCameraZoom;
  }, [mobileCameraZoom]);

  useEffect(() => {
    const el = scannerCameraCardRef.current;
    if (!el) return;

    const getTouchDist = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      mobilePinchZoomRef.current = {
        startDistance: getTouchDist(event.touches),
        startZoom: mobileCameraZoomRef.current,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !mobilePinchZoomRef.current) return;
      event.preventDefault(); // only works on a non-passive listener
      const { startDistance, startZoom } = mobilePinchZoomRef.current;
      if (startDistance <= 0) return;
      const ratio = getTouchDist(event.touches) / startDistance;
      setMobileCameraZoom(clampNumber(startZoom * ratio, 1, 3));
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) mobilePinchZoomRef.current = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false }); // non-passive to allow preventDefault
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []); // attach once — handlers read latest zoom via ref

  return (
    <div className="scanner-page max-w-6xl mx-auto space-y-3 sm:space-y-5">
      <div className="hidden bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-xl sm:flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Link
            href="/"
            className="p-2 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition-all shrink-0"
            title={language === 'BM' ? 'Kembali ke Papan Utama' : 'Back to Dashboard'}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-sm sm:text-base font-black text-white uppercase tracking-wider leading-tight">
              {t('liveScannerTitle')}
            </h1>
            <p className="text-[10px] text-slate-500 hidden sm:block">
              {scannerStatusText}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:justify-end">
          <button
            type="button"
            onClick={() => void refreshCameraList()}
            disabled={isRefreshingCameras}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 transition-all hover:border-cyan-700 hover:text-cyan-300 disabled:opacity-60"
            title={language === 'BM' ? 'Segarkan senarai kamera' : 'Refresh camera list'}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshingCameras ? 'animate-spin text-cyan-400' : ''}`} />
            <span>{language === 'BM' ? 'Segar' : 'Refresh'}</span>
          </button>
          {supportsMultiCameraScan && (
            <button
              type="button"
              onClick={() => void handleAddCamera()}
              disabled={!canAddCameraSlot}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 transition-all hover:border-cyan-700 hover:text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                canAddCameraSlot
                  ? language === 'BM'
                    ? 'Tambah pengimbas kamera'
                    : 'Add camera scanner'
                  : language === 'BM'
                    ? 'Tiada kamera tambahan tersedia'
                    : 'No additional camera available'
              }
            >
              <Plus className="w-4 h-4" />
              <span>{language === 'BM' ? 'Tambah Kamera' : 'Add Camera'}</span>
            </button>
          )}
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-2.5 sm:p-2 rounded-xl border text-xs font-bold transition-all shrink-0 ${
              soundEnabled
                ? 'bg-cyan-950 text-cyan-400 border-cyan-800'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
            title="Toggle sound"
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Input Source & Training Video Live Preview Banner */}


      {cameraError && (
        <div className="hidden sm:block rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-xs font-bold text-red-300">
          {cameraError}
        </div>
      )}

      {!cameraError && (
        <div className="hidden sm:block">
          <ModelStatusBanner
            runtimeState={runtimeState}
            detectorProvider={detectorProvider}
            ocrProvider={ocrProvider}
            benchmark={benchmarkResult}
            errorMessage={runtimeErrorMessage}
            debugMode={showDeveloperOverlay}
            onRetry={startRuntimeInit}
            onManualSearch={() => {
              window.location.href = '/search';
            }}
          />
        </div>
      )}

      {showUnsupportedBrowserWarning && (
        <div className="hidden sm:flex items-start gap-2 rounded-xl border border-amber-700 bg-amber-950/35 px-3 py-2 text-[11px] font-bold text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {language === 'BM'
              ? 'Pengimbas produksi ini disokong untuk Chrome atau Edge terkini pada komputer riba Windows/macOS.'
              : 'This production scanner is supported on the latest Chrome or Edge on Windows/macOS laptops.'}
          </span>
        </div>
      )}


      <div
        ref={scannerCameraCardRef}
        data-slot-count={cameraSlots.length}
        className="scanner-camera-card relative w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-xl"
        style={scannerCameraStyle}
        aria-busy={scannerControlBusy}
      >
        {isFinishingSample && (
          <div role="status" aria-live="polite" className="absolute inset-x-2 top-2 z-30 rounded-lg bg-slate-950/90 p-3 text-center text-sm text-cyan-200">
            {language === 'BM' ? 'Video tamat. Memproses baki bacaan — senarai akan dikemas kini.' : 'Video ended. Finishing saved plate crops — results will update.'}
          </div>
        )}
        {isScannerPreparing && (
          <div role="status" aria-live="polite" className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-slate-950/90 px-6 text-center text-white">
            <RefreshCw className="h-8 w-8 animate-spin text-cyan-400" />
            <p className="text-lg font-bold">{language === 'BM' ? 'Menyediakan imbasan…' : 'Preparing scanner…'}</p>
            <p className="max-w-md text-sm text-slate-300">{language === 'BM'
              ? (runtimeState === 'BENCHMARKING_DEVICE' ? 'Memanaskan enjin pengesanan dan OCR. Sila tunggu; imbasan akan bermula secara automatik.' : 'Menyediakan model AI, sumber video dan penjejak. Imbasan akan bermula secara automatik.')
              : 'Preparing AI models, tracker and the first frame. Scanning will start automatically.'}</p>
            <button onClick={handleStopScanning} className="rounded-lg border border-slate-600 px-4 py-2 text-sm">{language === 'BM' ? 'Batal' : 'Cancel'}</button>
          </div>
        )}
        <div
          className={`grid absolute inset-0 ${
            cameraSlots.length === 1
              ? 'gap-0 p-0 grid-cols-1 grid-rows-1'
              : cameraSlots.length === 2
              ? 'gap-1.5 p-1.5 grid-cols-2 grid-rows-1'
              : cameraSlots.length === 3
              ? 'gap-1.5 p-1.5 grid-cols-2 grid-rows-2'
              : 'gap-1.5 p-1.5 grid-cols-2 grid-rows-2'
          }`}
        >
          {cameraSlots.map((slot, index) => {
            const slotLabel = getCameraSlotLabel(slot, index);
            const activeSlotAlert = activeAlertMatchesBySlot[slot.id];
            const isAlertSlot = Boolean(activeSlotAlert);
            const slotSeenItems = cameraSlots.length === 1
              ? recentSeenPlateItems
              : recentSeenPlateItems.filter(
                  (item) => item.detection?.cameraId === slot.id || item.cameraName === slotLabel
                );

            return (
              <div
                key={slot.id}
                onClick={() => handleSelectActiveSlot(slot.id)}
                className={`relative min-h-0 overflow-hidden bg-slate-950 text-left transition-all ${
                  cameraSlots.length === 1 ? '' : 'rounded-xl border'
                } ${
                  isAlertSlot
                    ? 'border-red-500 ring-2 ring-red-500/40'
                    : 'border-slate-800'
                } ${
                  cameraSlots.length === 3 && index === 2 ? 'col-span-2' : ''
                }`}
              >
                {/* Inline transform composes the preview flip with pinch zoom. */}
                <video
                  ref={(node) => {
                    videoRefs.current[slot.id] = node;
                  }}
                  className="scanner-camera-media absolute inset-0 h-full w-full object-contain"
                  style={{
                    transform: isMirroredCameraPreview
                      ? 'scaleX(-1) scale(var(--scanner-camera-zoom, 1))'
                      : 'scale(var(--scanner-camera-zoom, 1))',
                  }}
                  muted
                  playsInline
                  autoPlay={scannerSourceMode !== 'SAMPLE_VIDEO'}
                  onEnded={() => {
                    if (scannerSourceModeRef.current === 'SAMPLE_VIDEO') {
                      handleSampleVideoEnded(slot.id);
                    }
                  }}
                />

                {!previewSlotIds.includes(slot.id) && (
                  <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center gap-3 text-center p-6">
                    <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                      <Video className="w-6 h-6 text-cyan-400" />
                    </div>
                    <div>
                      <div className="text-xs font-black text-white uppercase tracking-wider">{slotLabel}</div>
                      <div className="text-[10px] text-slate-500 mt-1">
                        <span className="sm:hidden">
                          {language === 'BM' ? 'Tekan Mula Imbasan untuk buka kamera.' : 'Tap Start Scan to open camera.'}
                        </span>
                        <span className="hidden sm:inline">
                          {language === 'BM'
                            ? 'Pilih kamera dan guna pratonton sebelum mengimbas.'
                            : 'Choose camera and use preview before scanning.'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* The overlay uses the identical display transform, while its
                    detector/OCR source remains in native orientation. */}
                <canvas
                  ref={(node) => {
                    canvasRefs.current[slot.id] = node;
                  }}
                  className="scanner-camera-media absolute inset-0 z-10 h-full w-full object-contain pointer-events-none"
                  style={{
                    transform: isMirroredCameraPreview
                      ? 'scaleX(-1) scale(var(--scanner-camera-zoom, 1))'
                      : 'scale(var(--scanner-camera-zoom, 1))',
                  }}
                />

                {scannerReloadActive && (
                  <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/75 px-6 text-center backdrop-blur-sm">
                    <div className="rounded-xl border border-cyan-800 bg-slate-950/90 px-4 py-3 shadow-xl">
                      <RefreshCw className="mx-auto h-5 w-5 animate-spin text-cyan-300" />
                      <div className="mt-2 text-xs font-black uppercase tracking-wider text-white">
                        {scannerNoticeTitle}
                      </div>
                      <div className="mt-1 max-w-[220px] text-[10px] font-semibold text-slate-400">
                        {scannerNoticeBody}
                      </div>
                    </div>
                  </div>
                )}

                {scannerReloadComplete && (
                  <div className="absolute inset-x-3 top-14 z-30 flex justify-center sm:top-12">
                    <div className="rounded-xl border border-emerald-800 bg-emerald-950/90 px-3 py-2 text-center shadow-xl backdrop-blur-md">
                      <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-300" />
                      <div className="mt-1 text-[10px] font-black uppercase tracking-wider text-emerald-100">
                        {scannerNoticeTitle}
                      </div>
                      <div className="mt-0.5 max-w-[220px] text-[9px] font-semibold text-emerald-200/80">
                        {scannerNoticeBody}
                      </div>
                    </div>
                  </div>
                )}

                {/* ONE-LINE CAMERA TOOLBAR */}
                <div className="absolute inset-x-0 top-0 z-30 flex h-11 items-center justify-between gap-1.5 border-b border-slate-800/80 bg-slate-950/85 px-2.5 backdrop-blur-md">
                  {/* LEFT: Camera Selector + Action Controls */}
                  <div className="flex flex-1 items-center gap-1.5 min-w-0">
                    {/* Camera Selector Dropdown */}
                    <select
                      value={slot.deviceId}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => handleCameraSlotDeviceChange(slot.id, event.target.value)}
                      className="h-7 min-w-[90px] max-w-[140px] xs:max-w-[170px] sm:max-w-[210px] truncate rounded-lg border border-slate-700/80 bg-slate-900/90 px-2 text-[11px] font-bold text-slate-200 outline-none hover:border-cyan-700 focus:border-cyan-500 transition-colors"
                      title={
                        (availableCameras.find((c) => c.deviceId === slot.deviceId)?.label) || slotLabel
                      }
                    >
                      {(availableCameras.length > 0
                        ? availableCameras
                        : [{ deviceId: '', groupId: '', label: slotLabel, kind: 'UNKNOWN_CAMERA' as const }]
                      ).map((cameraDevice, cameraIndex) => (
                        <option
                          key={cameraDevice.deviceId || `camera-${cameraIndex}`}
                          value={cameraDevice.deviceId}
                          disabled={Boolean(
                            cameraDevice.deviceId &&
                              cameraSlots.some(
                                (cameraSlot) =>
                                  cameraSlot.id !== slot.id && cameraSlot.deviceId === cameraDevice.deviceId
                              )
                          )}
                        >
                          {cameraDevice.label || (cameraIndex === 0 ? slotLabel : `Camera ${cameraIndex + 1}`)}
                        </option>
                      ))}
                    </select>

                    {/* Mula / Henti Button */}
                    {(() => {
                      const slotStatus = cameraSlotStatuses[slot.id] || (isScanning ? 'RUNNING' : 'STOPPED');
                      const isSlotRunning = slotStatus === 'RUNNING';
                      const isSlotStarting = slotStatus === 'STARTING';
                      const isSlotStopping = slotStatus === 'STOPPING';

                      if (isSlotRunning) {
                        return (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleStopSlotCamera(slot.id);
                            }}
                            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-red-700/90 bg-red-950/90 px-2.5 text-[11px] font-bold text-red-200 hover:bg-red-900 transition-colors"
                            title={language === 'BM' ? 'Henti kamera ini' : 'Stop this camera'}
                          >
                            <span className="h-2 w-2 rounded-sm bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)] shrink-0" />
                            <span className="hidden sm:inline">
                              {isFinishingSample ? (language === 'BM' ? 'Batal' : 'Cancel') : (language === 'BM' ? 'Henti' : 'Stop')}
                            </span>
                          </button>
                        );
                      }

                      if (isSlotStarting || isSlotStopping) {
                        return (
                          <button
                            type="button"
                            disabled
                            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-amber-600/80 bg-amber-950/90 px-2.5 text-[11px] font-bold text-amber-200 opacity-75"
                          >
                            <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
                            <span className="hidden sm:inline">
                              {isSlotStarting
                                ? (language === 'BM' ? 'Mulakan…' : 'Starting…')
                                : (language === 'BM' ? 'Henti…' : 'Stopping…')}
                            </span>
                          </button>
                        );
                      }

                      return (
                        <button
                          type="button"
                          disabled={scannerControlBusy}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleStartSlotCamera(slot.id);
                          }}
                          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-emerald-600 bg-emerald-700/90 px-2.5 text-[11px] font-black uppercase text-white shadow-md shadow-emerald-950/50 hover:bg-emerald-600 transition-colors disabled:opacity-50"
                          title={language === 'BM' ? 'Mula kamera ini' : 'Start this camera'}
                        >
                          <Play className="h-3 w-3 fill-current" />
                          <span className="hidden sm:inline">{language === 'BM' ? 'Mula' : 'Start'}</span>
                        </button>
                      );
                    })()}

                    {/* Pratonton / Preview Button */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleUseCamera(slot, index);
                      }}
                      className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-cyan-800/90 bg-cyan-950/90 px-2.5 text-[11px] font-bold text-cyan-200 hover:bg-cyan-900 transition-colors"
                      title={language === 'BM' ? 'Tukar ke pratonton kamera ini' : 'Switch preview to this camera'}
                    >
                      <Eye className="h-3 w-3 text-cyan-400" />
                      <span className="hidden sm:inline">{language === 'BM' ? 'Pratonton' : 'Preview'}</span>
                    </button>

                    {/* Mirror Preview Toggle Button */}
                    {scannerSourceMode === 'CAMERA' && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setIsCameraPreviewMirrored((mirrored) => !mirrored);
                        }}
                        aria-pressed={isMirroredCameraPreview}
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-cyan-200 transition-colors ${
                          isMirroredCameraPreview
                            ? 'border-cyan-500 bg-cyan-900/90'
                            : 'border-slate-700 bg-slate-900/90 hover:border-cyan-700'
                        }`}
                        title={mirrorPreviewLabel}
                        aria-label={mirrorPreviewLabel}
                      >
                        <FlipHorizontal className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* RIGHT: Live Tracker Count + Slot Close Button */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Live Tracker Count Indicator */}
                    <div
                      className="flex h-7 items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-900/90 px-2 text-[11px] font-bold text-slate-200 shadow-sm"
                      title={language === 'BM' ? `${slotSeenItems.length} plat dikesan` : `${slotSeenItems.length} plates tracked`}
                    >
                      <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                      <span className="hidden sm:inline font-bold uppercase tracking-wider text-slate-400 text-[9px]">LIVE</span>
                      <span className="font-mono font-black text-cyan-300 text-[11px]">{slotSeenItems.length}</span>
                    </div>

                    {/* Far Right Red Close Button (×) */}
                    {cameraSlots.length > 1 && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRemoveCamera(slot.id);
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-800 bg-slate-900/90 text-slate-400 hover:border-red-600/80 hover:bg-red-950/90 hover:text-red-300 transition-colors"
                        title={language === 'BM' ? 'Tutup slot kamera ini' : 'Close this camera slot'}
                        aria-label={language === 'BM' ? 'Tutup slot kamera ini' : 'Close this camera slot'}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {supportsMultiCameraScan && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleAddCamera();
                    }}
                    disabled={!canAddCameraSlot}
                    className="hidden absolute bottom-2.5 right-2.5 z-20 items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/85 px-2.5 py-1 text-[10px] font-bold text-slate-300 disabled:opacity-40"
                    title={
                      canAddCameraSlot
                        ? language === 'BM'
                          ? 'Tambah pengimbas kamera'
                          : 'Add camera scanner'
                        : language === 'BM'
                          ? 'Tiada kamera tambahan tersedia'
                          : 'No additional camera available'
                    }
                  >
                    <Plus className="h-3 w-3" />
                    <span>{language === 'BM' ? 'Tambah' : 'Add'}</span>
                  </button>
                )}
                {isAlertSlot && activeSlotAlert && (
                  <div className="scanner-alert-card absolute inset-1.5 z-30 flex flex-col gap-2 overflow-hidden rounded-2xl border-2 border-red-300/80 bg-red-600/95 p-3 text-left shadow-2xl sm:p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <ShieldAlert className="h-5 w-5 shrink-0 text-white" />
                        <span className="text-sm font-black uppercase leading-tight tracking-wider text-white sm:text-lg">
                          {language === 'BM' ? 'AMARAN: KENDERAAN DEBTOR' : 'ALERT: DEBTOR VEHICLE'}
                        </span>
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveAlertMatchesBySlot((alerts) => {
                            const nextAlerts = { ...alerts };
                            delete nextAlerts[slot.id];
                            return nextAlerts;
                          });
                        }}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-800/70 text-white transition-all hover:bg-red-900"
                        title={t('closeBtn')}
                        aria-label={t('closeBtn')}
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>

                    <div
                      className="min-h-[74px] flex-1 overflow-hidden rounded-lg border border-red-200/70 bg-red-900/60 bg-cover bg-center shadow-inner sm:min-h-[92px]"
                      style={
                        activeSlotAlert.snapshotDataUrl
                          ? { backgroundImage: `url(${activeSlotAlert.snapshotDataUrl})` }
                          : undefined
                      }
                      aria-label={language === 'BM' ? 'Gambar nombor plat' : 'Plate number snapshot'}
                    >
                      {!activeSlotAlert.snapshotDataUrl && (
                        <div className="flex h-full min-h-[74px] items-center justify-center px-3 sm:min-h-[92px]">
                          <span className="plate-yellow font-mono text-3xl font-black tracking-wide sm:text-5xl">
                            {activeSlotAlert.vehicle.plate}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg border border-red-400/50 bg-red-700/80 p-2.5 text-left shadow-inner sm:p-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="text-[9px] text-red-100 font-bold uppercase block">{t('plateNumber')}</span>
                          <span className="plate-yellow text-xl font-mono font-black sm:text-2xl">
                            {activeSlotAlert.vehicle.plate}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-red-100 font-bold uppercase block">{t('outstandingAmount')}</span>
                          <span className="text-lg font-mono font-black text-white sm:text-2xl">
                            {formatMYR(activeSlotAlert.vehicle.outstandingAmount)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-center">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMarkAsSeen(slot.id);
                        }}
                        className="btn-mark-seen flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-xs font-black uppercase tracking-wider text-red-600 shadow-md transition-all hover:bg-slate-100 sm:text-sm"
                      >
                        <BookmarkCheck className="h-4 w-4 text-red-600" />
                        <span>{language === 'BM' ? 'Semak (Tanda Tindakan)' : 'Semak (Mark Action)'}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* RESTORE BUTTON ON THIS CAMERA SLOT (When closed) */}
                {isSlotOverlayClosed(slot.id) && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleSlotOverlayClosed(slot.id, false);
                    }}
                    className="absolute right-2.5 top-13 z-20 flex items-center gap-1.5 rounded-full border border-white/20 bg-black/50 px-2.5 py-1 text-[11px] font-bold text-white shadow-lg backdrop-blur-sm transition-all hover:bg-black/70"
                    title={language === 'BM' ? 'Buka Live Tracker' : 'Open Live Tracker'}
                    aria-label="Open Live Tracker"
                  >
                    <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                    <span>LIVE TRACKER</span>
                    {slotSeenItems.length > 0 && (
                      <span className="font-mono text-[10px] text-cyan-300 bg-black/60 px-1.5 py-0.5 rounded-full border border-cyan-500/40">
                        {slotSeenItems.length}
                      </span>
                    )}
                  </button>
                )}

                {/* YOUTUBE LIVE-STYLE FLOATING ANPR OVERLAY FOR THIS CAMERA */}
                {!isSlotOverlayClosed(slot.id) && (
                  <aside
                    aria-label={`${slotLabel} Live Tracker Feed`}
                    className={`absolute right-1.5 top-13 bottom-4 z-20 flex flex-col pointer-events-none transition-all duration-200 ${
                      isSlotOverlayCollapsed(slot.id)
                        ? 'w-auto'
                        : isSlotOverlayExpanded(slot.id)
                        ? cameraSlots.length >= 3 ? 'w-[160px] sm:w-[200px]' : 'w-[240px] sm:w-[280px] md:w-[320px]'
                        : cameraSlots.length >= 3 ? 'w-[120px] sm:w-[150px]' : 'w-[180px] sm:w-[210px] md:w-[240px]'
                    }`}
                  >
                    {/* COMPACT FLOATING HEADER PILL */}
                    <div className="pointer-events-auto flex items-center justify-between gap-1.5 rounded-full border border-white/20 bg-black/40 px-2.5 py-0.5 shadow-md backdrop-blur-sm mb-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                        <span className="text-[11px] font-black uppercase tracking-wider text-white [text-shadow:_0_1px_3px_rgb(0_0_0_/_90%)] truncate">
                          {isSlotOverlayCollapsed(slot.id) ? `LIVE ${slotSeenItems.length}` : 'LIVE TRACKER'}
                        </span>
                        {!isSlotOverlayCollapsed(slot.id) && (
                          <span className="font-mono text-[9px] font-bold text-cyan-300 bg-black/50 px-1.5 py-0.5 rounded-full border border-cyan-500/40 shrink-0">
                            {slotSeenItems.length}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {!isSlotOverlayCollapsed(slot.id) && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleSlotOverlayExpanded(slot.id);
                            }}
                            className="flex h-5 w-5 items-center justify-center rounded-full text-slate-300 hover:text-white hover:bg-white/20 transition-colors"
                            title={isSlotOverlayExpanded(slot.id) ? (language === 'BM' ? 'Kecilkan' : 'Normal width') : (language === 'BM' ? 'Lebarkan' : 'Expand width')}
                            aria-label="Toggle width"
                          >
                            {isSlotOverlayExpanded(slot.id) ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleSlotOverlayCollapsed(slot.id);
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded-full text-slate-300 hover:text-white hover:bg-white/20 transition-colors"
                          title={isSlotOverlayCollapsed(slot.id) ? (language === 'BM' ? 'Kembangkan' : 'Expand') : (language === 'BM' ? 'Kuncup' : 'Collapse')}
                          aria-label="Toggle collapse"
                        >
                          {isSlotOverlayCollapsed(slot.id) ? <Plus className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleSlotOverlayClosed(slot.id, true);
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded-full text-slate-300 hover:text-rose-400 hover:bg-white/20 transition-colors"
                          title={language === 'BM' ? 'Tutup' : 'Close'}
                          aria-label="Close overlay"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    {/* FLOATING COMMITTED RECOGNITIONS (LIVESTREAM COMMENTS STYLE — NO CARDS) */}
                    {!isSlotOverlayCollapsed(slot.id) && (
                      <div className="pointer-events-auto flex-1 overflow-y-auto space-y-2 pr-0.5 custom-scrollbar min-h-0">
                        {slotSeenItems.slice(0, 10).map((item) => (
                          <div
                            key={item.id}
                            className="flex items-start gap-2 py-0.5 px-1 transition-all hover:translate-x-0.5"
                          >
                            {/* Plate Crop Thumbnail */}
                            <div className="h-8 w-16 sm:h-9 sm:w-20 shrink-0 rounded-md overflow-hidden border border-white/25 bg-black/60 shadow-[0_2px_6px_rgba(0,0,0,0.85)] flex items-center justify-center">
                              {item.snapshotDataUrl ? (
                                <img
                                  src={item.snapshotDataUrl}
                                  alt={item.plate}
                                  className="h-full w-full object-contain"
                                />
                              ) : (
                                <span className="text-[9px] font-mono text-slate-400 font-bold">PLAT</span>
                              )}
                            </div>

                            {/* Recognition Text Floating directly with strong text-shadow */}
                            <div className="min-w-0 flex-1 leading-tight [text-shadow:_0_1px_2px_rgba(0,0,0,1),_0_2px_4px_rgba(0,0,0,0.95),_0_0_8px_rgba(0,0,0,0.8)]">
                              <div className="flex items-baseline justify-between gap-1.5">
                                <span className="font-mono text-sm sm:text-base font-black text-white tracking-wider truncate">
                                  {item.plate}
                                </span>
                                {typeof item.confidence === 'number' && (
                                  <span className="font-mono text-xs font-bold text-emerald-400 shrink-0">
                                    {item.confidence.toFixed(1)}%
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center justify-between text-[11px] text-slate-200 mt-0.5 gap-1">
                                <span
                                  className={`font-semibold truncate ${
                                    item.tone === 'EXACT'
                                      ? 'text-red-400 font-black'
                                      : item.tone === 'POSSIBLE'
                                      ? 'text-amber-300 font-bold'
                                      : 'text-slate-200'
                                  }`}
                                >
                                  {item.detail}
                                </span>
                                <span className="font-mono text-[10px] text-slate-300 shrink-0">
                                  {item.timestamp}
                                </span>
                              </div>
                              {isSlotOverlayExpanded(slot.id) && item.timing && (
                                <div className="text-[10px] text-cyan-300 font-mono mt-0.5 truncate opacity-90">
                                  {item.timing}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}

                        {slotSeenItems.length === 0 && (
                          <div className="py-3 text-center text-xs font-semibold text-white [text-shadow:_0_1px_3px_rgba(0,0,0,0.95)]">
                            {language === 'BM' ? 'Menunggu pengesanan plat…' : 'Waiting for recognized plates…'}
                          </div>
                        )}
                      </div>
                    )}
                  </aside>
                )}
              </div>
            );
          })}
        </div>

        <div className="absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-2 sm:hidden">
          <div className="min-w-0 rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 backdrop-blur-md">
            <div className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300">
              {language === 'BM' ? 'Pengimbas' : 'Scanner'}
            </div>
            <div className="truncate text-[11px] font-bold text-slate-200">{simpleScannerStatus}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleMobileFacingModeChange(mobileFacingMode === 'environment' ? 'user' : 'environment');
              }}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-700/80 bg-slate-950/75 text-cyan-200 shadow-lg shadow-slate-950/35 backdrop-blur-md transition-all hover:border-cyan-700 hover:text-cyan-100"
              title={language === 'BM' ? 'Tukar kamera' : 'Flip camera'}
              aria-label={language === 'BM' ? 'Tukar kamera' : 'Flip camera'}
            >
              <SwitchCamera className="h-5 w-5" />
            </button>
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-xs font-bold shadow-lg shadow-slate-950/35 backdrop-blur-md transition-all ${
                soundEnabled
                  ? 'border-cyan-800/80 bg-slate-950/75 text-cyan-300'
                  : 'border-slate-700/80 bg-slate-950/75 text-slate-400'
              }`}
              title="Toggle sound"
              aria-label="Toggle sound"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="absolute inset-x-3 bottom-3 z-20 sm:hidden">
          {cameraError && (
            <div className="mb-2 rounded-xl border border-red-700 bg-red-950/80 px-3 py-2 text-[11px] font-bold text-red-200 backdrop-blur-md">
              {cameraError}
            </div>
          )}
          {isScanning ? (
            <button
              onClick={handleStopScanning}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-700/90 bg-slate-950/82 text-xs font-black uppercase tracking-wider text-slate-100 shadow-xl shadow-slate-950/35 backdrop-blur-md transition-all active:scale-[0.99]"
            >
              <span className="h-3 w-3 rounded-sm bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.55)]" />
              <span>{isFinishingSample ? (language === 'BM' ? 'Batal pemprosesan' : 'Cancel processing') : (language === 'BM' ? 'Henti Imbasan' : 'Stop Scan')}</span>
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsCameraPreviewMirrored((mirrored) => !mirrored)}
                disabled={scannerSourceMode !== 'CAMERA'}
                aria-pressed={isCameraPreviewMirrored}
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border text-cyan-200 shadow-xl shadow-slate-950/35 disabled:cursor-not-allowed disabled:opacity-40 ${
                  isCameraPreviewMirrored
                    ? 'border-cyan-500 bg-cyan-900/90'
                    : 'border-slate-700/90 bg-slate-950/82'
                }`}
                title={scannerSourceMode === 'CAMERA' ? mirrorPreviewLabel : (language === 'BM' ? 'Cermin hanya untuk kamera langsung' : 'Mirroring is available for live cameras only')}
                aria-label={mirrorPreviewLabel}
              >
                <FlipHorizontal className="h-5 w-5" />
              </button>
              <button
                disabled={scannerControlBusy}
                onClick={() => void handleStartScanning()}
                className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-600 text-xs font-black uppercase tracking-wider text-white shadow-xl shadow-cyan-500/20"
              >
                <Play className="h-4 w-4" />
                <span>{isScannerPreparing ? (language === 'BM' ? 'Menyediakan…' : 'Preparing…') : (language === 'BM' ? 'Mula Imbasan' : 'Start Scan')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        className="scanner-mobile-result sm:hidden rounded-2xl border border-slate-800 bg-slate-900/90 p-3 shadow-xl shadow-slate-950/30"
      >
        {seenPlateItems.length > 0 ? (
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300">
                  {language === 'BM' ? 'Plat Dilihat' : 'Seen Plates'}
                </div>
                <div className="truncate text-[11px] font-semibold text-slate-400">
                  {activeSeenPlateItems.length} {language === 'BM' ? 'aktif' : 'active'} · {liveDetections.length}{' '}
                  {language === 'BM' ? 'keputusan sesi' : 'session results'}
                </div>
              </div>
              <span className="shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] font-black text-slate-300">
                {tracksList.length}
              </span>
            </div>

            <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
              {seenPlateItems.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-xl border px-3 py-2.5 ${getSeenPlateBorderClass(item.tone)}`}
                >
                  {(item.snapshotDataUrl || item.detection?.snapshotDataUrl) && (
                    <div className="mb-2 h-12 w-full overflow-hidden rounded-lg border border-slate-800 bg-black/80 flex items-center justify-center p-0.5">
                      <img
                        src={item.snapshotDataUrl || item.detection?.snapshotDataUrl}
                        alt={item.plate}
                        className="h-full w-full object-contain rounded"
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-xl font-black leading-none text-cyan-300">
                          {item.plate}
                        </span>
                        <span
                          className={`shrink-0 rounded-md px-2 py-1 text-[9px] font-black uppercase ${getSeenPlateBadgeClass(item.tone)}`}
                        >
                          {getSeenPlateStatusLabel(item.tone, language)}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs font-semibold text-slate-300">{item.detail}</div>
                      <div className="mt-0.5 truncate text-[10px] font-mono text-slate-500">
                        {item.confidence}% · {item.timestamp}
                        {item.active ? ` · ${language === 'BM' ? 'aktif' : 'active'}` : ''}
                      </div>
                      {item.timing && (
                        <div className="mt-0.5 truncate text-[9px] font-mono text-cyan-400/80">{item.timing}</div>
                      )}
                    </div>
                    {item.canMarkAction && item.detection ? (
                      <button
                        type="button"
                        onClick={() => handleMarkDetectionAction(item.detection!)}
                        className="shrink-0 rounded-xl border border-red-500 bg-white px-3 py-2 text-[10px] font-black uppercase text-red-600 shadow-sm"
                      >
                        {language === 'BM' ? 'Semak' : 'Review'}
                      </button>
                    ) : item.actionStatus === 'REVIEWED' ? (
                      <span className="shrink-0 rounded-xl border border-emerald-700 bg-emerald-950/70 px-3 py-2 text-[10px] font-black uppercase text-emerald-300">
                        {language === 'BM' ? 'Disemak' : 'Reviewed'}
                      </span>
                    ) : (
                      <Link
                        href={item.searchHref}
                        className="shrink-0 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-[10px] font-black uppercase text-slate-300"
                      >
                        {language === 'BM' ? 'Semak' : 'View'}
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950">
              <Activity className="h-4 w-4 text-cyan-300" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-black text-white">{simpleLastResult}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] font-medium leading-snug text-slate-400">
                {simpleLastResultDetail}
              </div>
            </div>
          </div>
        )}
      </div>



      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-cyan-400" />
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider">
              {t('recentDetectionList')}
            </h2>
          </div>
          <span className="text-[10px] font-mono text-slate-500">
            {liveDetections.length} session scans
          </span>
        </div>

        {seenPlateItems.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {seenPlateItems.slice(0, 8).map((item) => (
              <div
                key={item.id}
                className={`rounded-xl border p-3 transition-all hover:border-cyan-700 ${getSeenPlateBorderClass(item.tone)}`}
              >
                {(item.snapshotDataUrl || item.detection?.snapshotDataUrl) && (
                  <div className="mb-2 h-14 sm:h-12 w-full overflow-hidden rounded-lg border border-slate-800 bg-black/80 flex items-center justify-center p-0.5">
                    <img
                      src={item.snapshotDataUrl || item.detection?.snapshotDataUrl}
                      alt={item.plate}
                      className="h-full w-full object-contain rounded"
                    />
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-base sm:text-lg font-black text-cyan-300">{item.plate}</span>
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-black uppercase ${getSeenPlateBadgeClass(item.tone)}`}>
                    {getSeenPlateStatusLabel(item.tone, language)}
                  </span>
                </div>
                <div className="mt-1 truncate text-[10px] font-semibold text-slate-300">{item.detail}</div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="truncate font-mono text-[10px] text-slate-500">
                    {item.confidence}% · {item.timestamp}
                  </div>
                  {item.canMarkAction && item.detection ? (
                    <button
                      type="button"
                      onClick={() => handleMarkDetectionAction(item.detection!)}
                      className="shrink-0 rounded-md border border-red-500 bg-white px-2 py-1 text-[9px] font-black uppercase text-red-600 shadow-sm hover:bg-red-50"
                    >
                      {language === 'BM' ? 'Semak' : 'Review'}
                    </button>
                  ) : item.actionStatus === 'REVIEWED' ? (
                    <span className="shrink-0 rounded-md border border-emerald-700 bg-emerald-950/70 px-2 py-1 text-[9px] font-black uppercase text-emerald-300">
                      {language === 'BM' ? 'Disemak' : 'Reviewed'}
                    </span>
                  ) : (
                    <Link
                      href={item.searchHref}
                      className="shrink-0 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[9px] font-black uppercase text-slate-300 hover:border-cyan-800 hover:text-cyan-200"
                    >
                      {language === 'BM' ? 'Semak' : 'View'}
                    </Link>
                  )}
                </div>
                {item.timing && (
                  <div className="mt-1 truncate font-mono text-[9px] text-cyan-400/80">{item.timing}</div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="sm:hidden space-y-2.5">
          {liveDetections.length > 0 ? (
            liveDetections.map((det) => (
              <button
                key={det.id}
                type="button"
                onClick={() => setExpandedDetectionId((current) => (current === det.id ? null : det.id))}
                className="w-full p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-left space-y-2.5 hover:border-cyan-900/70 transition-all"
              >
                {det.snapshotDataUrl && (
                  <div className="h-12 w-full overflow-hidden rounded-lg border border-slate-800 bg-black/80 flex items-center justify-center p-0.5">
                    <img src={det.snapshotDataUrl} alt={det.plate} className="h-full w-full object-contain rounded" />
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-black text-cyan-300 text-sm">{det.plate}</span>
                      <span className="text-[10px] text-slate-400 truncate">{det.cameraName}</span>
                    </div>
                    {det.matchType === 'EXACT' || det.matched ? (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-red-950 text-red-400 border border-red-700 inline-flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        <span>TANDA TINDAKAN</span>
                      </span>
                    ) : det.matchType === 'POSSIBLE' ? (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-amber-950 text-amber-300 border border-amber-700 inline-flex items-center gap-1">
                        <AlertTriangle className="w-2.5 h-2.5" />
                        <span>POSSIBLE</span>
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-900 text-slate-400 border border-slate-800 inline-flex items-center gap-1">
                        <XCircle className="w-2.5 h-2.5" />
                        <span>{language === 'BM' ? 'TIADA PADANAN' : 'NOT MATCH'}</span>
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">{det.timestamp}</span>
                </div>
                {expandedDetectionId === det.id && (
                  <div className="grid grid-cols-1 gap-1 border-t border-slate-800 pt-2 text-[10px] text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 text-cyan-400" />
                      <span>{det.name}</span>
                    </div>
                    <div className="font-mono">GPS: {det.gps}</div>
                  </div>
                )}
              </button>
            ))
          ) : (
            <div className="py-5 text-center text-xs text-slate-500">No scans in this session yet.</div>
          )}
        </div>

        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[560px]">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono text-[9px] sm:text-[10px] border-b border-slate-800 whitespace-nowrap">
              <tr>
                <th className="py-2 px-3">{language === 'BM' ? 'Nombor Plat' : 'Plate Number'}</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Confidence</th>
                <th className="py-2 px-3">{language === 'BM' ? 'Kamera' : 'Camera'}</th>
                <th className="py-2 px-3">{language === 'BM' ? 'Tindakan' : 'Action'}</th>
                <th className="py-2 px-3 text-right">{language === 'BM' ? 'Masa' : 'Time'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono whitespace-nowrap">
              {liveDetections.length > 0 ? (
                liveDetections.map((det) => (
                  <React.Fragment key={det.id}>
                    <tr
                      onClick={() => setExpandedDetectionId((current) => (current === det.id ? null : det.id))}
                      className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                    >
                      <td className="py-2 px-3 font-black text-cyan-300 text-xs sm:text-sm">{det.plate}</td>
                      <td className="py-2 px-3">
                        {det.matchType === 'EXACT' || det.matched ? (
                          <span className="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase bg-red-950 text-red-400 border border-red-700 inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>TANDA TINDAKAN</span>
                          </span>
                        ) : det.matchType === 'POSSIBLE' ? (
                          <span className="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase bg-amber-950 text-amber-300 border border-amber-700 inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            <span>POSSIBLE</span>
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase bg-slate-950 text-slate-400 border border-slate-800 inline-flex items-center gap-1">
                            <XCircle className="w-3 h-3" />
                            <span>{language === 'BM' ? 'TIADA PADANAN' : 'NOT MATCH'}</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-slate-300 text-[11px]">{det.confidence}%</td>
                      <td className="py-2 px-3 text-slate-300 text-[11px]">{det.cameraName}</td>
                      <td className="py-2 px-3">
                        {isUnreviewedAlertDetection(det) ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleMarkDetectionAction(det);
                            }}
                            className="rounded-md border border-red-500 bg-white px-2 py-1 text-[9px] font-black uppercase text-red-600 shadow-sm hover:bg-red-50"
                          >
                            {language === 'BM' ? 'Semak' : 'Review'}
                          </button>
                        ) : det.actionStatus === 'REVIEWED' ? (
                          <span className="rounded-md border border-emerald-700 bg-emerald-950/70 px-2 py-1 text-[9px] font-black uppercase text-emerald-300">
                            {language === 'BM' ? 'Disemak' : 'Reviewed'}
                          </span>
                        ) : (
                          <Link
                            href={`/search?plate=${encodeURIComponent(det.plate)}`}
                            onClick={(event) => event.stopPropagation()}
                            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[9px] font-black uppercase text-slate-300 hover:border-cyan-800 hover:text-cyan-200"
                          >
                            {language === 'BM' ? 'Semak' : 'View'}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-500 text-[10px] sm:text-[11px]">{det.timestamp}</td>
                    </tr>
                    {expandedDetectionId === det.id && (
                      <tr className="bg-slate-950/70">
                        <td colSpan={6} className="px-3 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-slate-400">
                            <div className="flex items-center gap-1.5 md:col-span-2">
                              <MapPin className="h-3.5 w-3.5 text-cyan-400" />
                              <span className="text-slate-500">{language === 'BM' ? 'Lokasi Dijumpai:' : 'Found Location:'}</span>
                              <span className="text-slate-300">{det.name}</span>
                            </div>
                            <div className="font-mono text-slate-300">GPS: {det.gps}</div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500 font-sans">
                    No scans in this session yet. Start scanning to populate dashboard and audit history.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
