'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Car,
  CheckCircle2,
  Database,
  DollarSign,
  FileSearch,
  MapPin,
  Pause,
  Play,
  Plus,
  Search as SearchIcon,
  ShieldAlert,
  Video,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from 'lucide-react';
import { PlateTracker, ActiveTrack } from '@/lib/anpr/tracker';
import {
  detectMalaysianPlates,
  validateDetector,
  getActiveDetectorProvider,
  ActiveExecutionProvider,
} from '@/lib/anpr/yoloDetector';
import {
  generateAdaptiveCrops,
  createInnerPlateTextCrop,
  cropCanvasRegionFast,
  prioritiseTracks,
  releaseCanvasMemory,
} from '@/lib/anpr/imageProcessor';
import { BestFrameSelector } from '@/lib/anpr/bestFrameSelector';
import { recognizePlateFromCanvas } from '@/lib/anpr/ocrEngine';
import { addOcrVoteToTrack, evaluateConsensus } from '@/lib/anpr/consensus';
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
import { evaluateDatabaseMatch } from '@/lib/anpr/matchingEngine';
import { INITIAL_SETTINGS } from '@/lib/db/settingsDefaults';
import { ScannerSettings, VehicleCase } from '@/lib/db/types';
import { ModelStatusBanner } from '@/components/scanner/ModelStatusBanner';

type AlertMatch = {
  vehicle: Vehicle;
  cameraName: string;
  cameraId: string;
};

type CameraSlot = {
  id: string;
  deviceId: string;
};

type ScanLocation = {
  name: string;
  gps: string;
};

type SessionDetection = DetectionLog &
  ScanLocation & {
    matchType?: 'EXACT' | 'POSSIBLE' | 'NONE';
    possibleVehicleIds?: string[];
  };

type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

type SlotScannerRuntime = {
  tracker: PlateTracker;
  bestFrameSelector: BestFrameSelector;
  processingCanvas: HTMLCanvasElement | null;
  lastMaintenanceTs: number;
};

type SlotMetrics = {
  camFrames: number;
  detFrames: number;
  platesVisible: number;
  activeTracks: number;
  tracks: ActiveTrack[];
};

const SCAN_LOCATIONS: ScanLocation[] = [
  { name: 'Sungai Besi Toll Plaza', gps: '3.0602, 101.7047' },
  { name: 'Jalan Tun Razak, Kuala Lumpur', gps: '3.1618, 101.7165' },
  { name: 'Federal Highway KM12', gps: '3.0837, 101.6129' },
  { name: 'Shah Alam Section 13', gps: '3.0831, 101.5443' },
  { name: 'Penang Bridge Checkpoint', gps: '5.3674, 100.3422' },
];

const RECENT_DETECTIONS_STORAGE_KEY = 'track_recent_live_detections';
const DETECTION_TARGET_INTERVAL_MS = 90;
const DETECTION_BUSY_INTERVAL_MS = 125;
const DETECTION_MIN_DELAY_MS = 16;
const DETECTOR_VALIDATION_INTERVAL_MS = 2000;
const CROP_SAMPLE_FAST_MS = 90;
const CROP_SAMPLE_NORMAL_MS = 160;
const OCR_FIRST_READ_RETRY_MS = 80;
const OCR_REPEAT_READ_RETRY_MS = 180;
const OCR_MAX_CONCURRENCY = 4;
const OVERLAY_ANGLE_SAMPLE_MS = 140;
const MAX_OVERLAY_TILT_RAD = 0.35;
const SCANNER_MAINTENANCE_INTERVAL_MS = 1000;
const COOLDOWN_MAP_MAX_ENTRIES = 120;
const TRACK_RESULT_HOLD_MS = 900;

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

function getTrackPlateText(track: ActiveTrack): string {
  if (track.stabilizedPlate) return track.stabilizedPlate;
  if (!track.votes || track.votes.size === 0) return '';

  let topPlate = '';
  let topCount = 0;
  let topTotalConfidence = 0;
  track.votes.forEach((data, plateStr) => {
    if (data.count > topCount || (data.count === topCount && data.totalConfidence > topTotalConfidence)) {
      topPlate = plateStr;
      topCount = data.count;
      topTotalConfidence = data.totalConfidence;
    }
  });

  return topPlate;
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

function getExpectedMinPlateChars(crop: HTMLCanvasElement): number {
  const aspect = crop.width / Math.max(1, crop.height);
  if (aspect >= 3.0) return 5;
  if (aspect >= 2.3) return 4;
  return 3;
}

function countPlateChars(text: string): { letters: number; digits: number } {
  return {
    letters: (text.match(/[A-Z]/g) || []).length,
    digits: (text.match(/[0-9]/g) || []).length,
  };
}

function isPlausiblePlateCandidate(text: string, expectedMinChars: number, patternScore: number): boolean {
  if (!text || text.length < 3) return false;

  const { letters, digits } = countPlateChars(text);
  if (letters === 0 || digits === 0) return false;

  const hasEnoughLength = text.length >= expectedMinChars || (text.length >= 3 && patternScore >= 0.85);
  if (!hasEnoughLength) return false;

  if (text.length >= 5 && digits < 2) return false;
  if (/^([A-Z0-9]{2,4})\1$/.test(text)) return false;

  return true;
}

function canCommitFinalPlateOutcome(text: string): boolean {
  const pattern = validateMalaysianPattern(text);
  const { letters, digits } = countPlateChars(text);

  if (!pattern.isValid || pattern.score < 0.55) return false;
  if (letters === 0 || digits === 0) return false;
  if (text.length >= 5 && digits < 2) return false;

  return true;
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

function resetTrackForNextPlate(track: ActiveTrack): void {
  track.ocrState = 'COLLECTING';
  track.ocrRunning = false;
  track.ocrJobQueued = false;
  track.cooldownActive = false;
  track.votes.clear();
  track.cropSamples = [];

  delete track.cooldownStartedAt;
  delete track.lastCropSampledAt;
  delete track.lastOcrAttemptAt;
  delete track.lastOcrCompletedAt;
  delete track.lastSearchedAt;
  delete track.stabilizedPlate;
  delete track.stabilizedConfidence;
  delete track.matchType;
  delete track.matchedVehicle;
  delete track.possibleMatchVehicles;
  delete track.scanEventId;
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
    return 'This browser does not expose camera access. Try a current mobile browser and allow camera permission.';
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

function mapVehicleToCase(vehicle: Vehicle): VehicleCase {
  const normalizedPlate = cleanPlateNumber(vehicle.plate);

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
    status: vehicle.status === 'ACTIVE' ? 'ACTIVE' : 'CLOSED',
    notes: vehicle.remark,
    createdAt: vehicle.createdDate,
    updatedAt: vehicle.updatedDate,
  };
}

export default function ScannerPage() {
  const { t, language } = useLanguage();
  const { vehicles, addHistoryLog, updateVehicle, settings } = useStorage();
  const { role } = useAuth();

  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const slotRuntimesRef = useRef<Record<string, SlotScannerRuntime>>({});
  const slotMetricsRef = useRef<Record<string, SlotMetrics>>({});
  const activeStreamsRef = useRef<Record<string, MediaStream>>({});
  const activeCameraSlotIdRef = useRef('camera-slot-1');
  const cameraSlotsRef = useRef<CameraSlot[]>([{ id: 'camera-slot-1', deviceId: '' }]);
  const availableCamerasRef = useRef<MediaDeviceInfo[]>([]);
  const supportsMultiCameraScanRef = useRef(false);
  const runtimeStateRef = useRef<ANPRRuntimeState>('UNINITIALIZED');
  const vehiclesRef = useRef(vehicles);
  const addHistoryLogRef = useRef(addHistoryLog);
  const soundEnabledRef = useRef(true);
  const settingsRef = useRef<ScannerSettings>({ ...INITIAL_SETTINGS, debugMode: false });
  const cooldownMap = useRef<Map<string, number>>(new Map());
  const activeOcrCount = useRef(0);
  const lastMetricsFlushTs = useRef(Date.now());

  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraSlots, setCameraSlots] = useState<CameraSlot[]>([{ id: 'camera-slot-1', deviceId: '' }]);
  const [activeCameraSlotId, setActiveCameraSlotId] = useState('camera-slot-1');
  const [supportsMultiCameraScan, setSupportsMultiCameraScan] = useState(false);
  const [previewSlotIds, setPreviewSlotIds] = useState<string[]>([]);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [, setCurrentPlate] = useState('READY');
  const [, setLastDetectedSlotId] = useState('');
  const [activeAlertMatch, setActiveAlertMatch] = useState<AlertMatch | null>(null);
  const [liveDetections, setLiveDetections] = useState<SessionDetection[]>([]);
  const [expandedDetectionId, setExpandedDetectionId] = useState<string | null>(null);
  const [runtimeState, setRuntimeState] = useState<ANPRRuntimeState>('UNINITIALIZED');
  const [benchmarkResult, setBenchmarkResult] = useState<AdmissionBenchmarkResult | null>(null);
  const [runtimeErrorMessage, setRuntimeErrorMessage] = useState<string | null>(null);
  const [detectorProvider, setDetectorProvider] = useState<ActiveExecutionProvider>('NONE');
  const [ocrProvider, setOcrProvider] = useState<ActiveOcrProvider>('NONE');
  const [, setCamFps] = useState(0);
  const [, setDetFps] = useState(0);
  const [, setPlatesVisible] = useState(0);
  const [, setActiveTracksCount] = useState(0);
  const [tracksList, setTracksList] = useState<ActiveTrack[]>([]);

  const getSlotRuntime = useCallback((slotId: string): SlotScannerRuntime => {
    if (!slotRuntimesRef.current[slotId]) {
      slotRuntimesRef.current[slotId] = {
        tracker: new PlateTracker(20, 8),
        bestFrameSelector: new BestFrameSelector(),
        processingCanvas: null,
        lastMaintenanceTs: 0,
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

    Object.values(slotMetricsRef.current).forEach((item) => {
      item.camFrames = 0;
      item.detFrames = 0;
    });
  }, []);

  const resetLiveScanUi = useCallback(() => {
    Object.values(slotRuntimesRef.current).forEach((runtime) => {
      runtime.tracker.clear();
      runtime.bestFrameSelector.resetAll();
      runtime.processingCanvas = null;
      runtime.lastMaintenanceTs = 0;
    });
    slotMetricsRef.current = {};
    activeOcrCount.current = 0;
    lastMetricsFlushTs.current = Date.now();
    setTracksList([]);
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
    runtimeStateRef.current = nextState;
    setRuntimeState((prev) => (prev === nextState ? prev : nextState));
    setBenchmarkResult(getLatestBenchmarkResult());
    setRuntimeErrorMessage(getRuntimeErrorMessage());
    setDetectorProvider(getActiveDetectorProvider());
    setOcrProvider(getActivePpOcrProvider());
  }, []);

  const startRuntimeInit = useCallback(async () => {
    runtimeStateRef.current = 'LOADING_MODELS';
    setRuntimeState('LOADING_MODELS');
    setRuntimeErrorMessage(null);

    const progressTimer = window.setInterval(syncRuntimeStatus, 500);
    try {
      const res = await initializeANPRRuntime();
      runtimeStateRef.current = res.state;
      setRuntimeState(res.state);
      if (res.benchmark) setBenchmarkResult(res.benchmark);
    } finally {
      window.clearInterval(progressTimer);
      syncRuntimeStatus();
    }
  }, [syncRuntimeStatus]);

  useEffect(() => {
    vehiclesRef.current = vehicles;
  }, [vehicles]);

  useEffect(() => {
    cameraSlotsRef.current = cameraSlots;
  }, [cameraSlots]);

  useEffect(() => {
    availableCamerasRef.current = availableCameras;
  }, [availableCameras]);

  useEffect(() => {
    activeCameraSlotIdRef.current = activeCameraSlotId;
  }, [activeCameraSlotId]);

  useEffect(() => {
    supportsMultiCameraScanRef.current = supportsMultiCameraScan;
  }, [supportsMultiCameraScan]);

  useEffect(() => {
    const updateCapability = () => {
      const nextSupportsMultiCamera = canRunMultiCameraOnCurrentDevice();
      supportsMultiCameraScanRef.current = nextSupportsMultiCamera;
      setSupportsMultiCameraScan(nextSupportsMultiCamera);

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
  }, []);

  useEffect(() => {
    addHistoryLogRef.current = addHistoryLog;
  }, [addHistoryLog]);

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
    };
  }, [settings, soundEnabled]);

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
    const restoreTimer = window.setTimeout(() => {
      try {
        const storedDetections = localStorage.getItem(RECENT_DETECTIONS_STORAGE_KEY);
        if (storedDetections) {
          const parsedDetections = JSON.parse(storedDetections) as SessionDetection[];
          setLiveDetections(parsedDetections.slice(0, 8));
          if (parsedDetections[0]) {
            setCurrentPlate(parsedDetections[0].plate);
            setLastDetectedSlotId(parsedDetections[0].cameraId);
          }
        }
      } catch {
        localStorage.removeItem(RECENT_DETECTIONS_STORAGE_KEY);
      }

      void refreshCameraList();
    }, 0);

    return () => {
      window.clearTimeout(restoreTimer);
      stopCamera();
    };
  }, []);

  useEffect(() => {
    if (!isCameraReady) return;
    const resumeScanning = isScanning;
    window.setTimeout(() => {
      void startVisibleCameras({ resumeScanning });
    }, 0);
  }, [cameraSlots.length]);

  async function refreshCameraList() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraError('Camera devices are not available in this browser.');
      return [] as MediaDeviceInfo[];
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((device) => device.kind === 'videoinput');
      setAvailableCameras(videoDevices);
      setCameraSlots((slots) =>
        slots.map((slot, index) => ({
          ...slot,
          deviceId: slot.deviceId || videoDevices[index]?.deviceId || videoDevices[0]?.deviceId || '',
        }))
      );
      setCameraError('');
      return videoDevices;
    } catch {
      setCameraError('Unable to read camera list. Please allow camera access.');
      return [] as MediaDeviceInfo[];
    }
  }

  function getCameraSlotLabel(slot: CameraSlot | undefined, index: number) {
    if (!slot) return language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera';
    const device = availableCameras.find((cameraDevice) => cameraDevice.deviceId === slot.deviceId);
    return device?.label || (index === 0 ? (language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera') : `Camera ${index + 1}`);
  }

  function stopCamera(options: { preserveScanningState?: boolean } = {}) {
    Object.values(activeStreamsRef.current).forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    activeStreamsRef.current = {};
    setPreviewSlotIds([]);
    setIsCameraReady(false);
    if (!options.preserveScanningState) {
      setIsScanning(false);
    }
    resetLiveScanUi();
  }

  async function startCameraForSlot(slot: CameraSlot) {
    const preflightError = getCameraPreflightError();
    if (preflightError) {
      setCameraError(preflightError);
      return false;
    }

    try {
      const streamKey = slot.deviceId || 'default-camera';
      let stream = activeStreamsRef.current[streamKey];

      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: slot.deviceId
            ? { deviceId: { exact: slot.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        activeStreamsRef.current[streamKey] = stream;
      }

      const video = videoRefs.current[slot.id];
      if (video) {
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }

      setPreviewSlotIds((ids) => (ids.includes(slot.id) ? ids : [...ids, slot.id]));
      setCameraError('');
      return true;
    } catch {
      setCameraError('Unable to start camera. Please allow camera permission and try again.');
      return false;
    }
  }

  async function startVisibleCameras(options: { resumeScanning?: boolean } = {}) {
    const resumeScanning = options.resumeScanning ?? false;
    stopCamera({ preserveScanningState: resumeScanning });
    const devices = await refreshCameraList();
    const resolvedSlots =
      cameraSlots.length > 0
        ? cameraSlots.map((slot, index) => ({
            ...slot,
            deviceId: slot.deviceId || devices[index]?.deviceId || devices[0]?.deviceId || '',
          }))
        : [{ id: 'camera-slot-1', deviceId: devices[0]?.deviceId || '' }];
    const slots = supportsMultiCameraScanRef.current
      ? resolvedSlots
      : [resolvedSlots.find((slot) => slot.id === activeCameraSlotIdRef.current) || resolvedSlots[0]];

    setCameraSlots(slots);
    const startedResults = await Promise.all(slots.map((slot) => startCameraForSlot(slot)));
    const started = startedResults.some(Boolean);
    setIsCameraReady(started);
    if (started && resumeScanning) {
      setCurrentPlate('SCANNING');
      setIsScanning(true);
    }
    return started;
  }

  const handleUseCamera = async (slot: CameraSlot, index: number) => {
    const devices = await refreshCameraList();
    const resolvedSlot = {
      ...slot,
      deviceId: slot.deviceId || devices[index]?.deviceId || devices[0]?.deviceId || '',
    };
    setCameraSlots((slots) => slots.map((item) => (item.id === slot.id ? resolvedSlot : item)));
    handleSelectActiveSlot(slot.id);
    const started = await startCameraForSlot(resolvedSlot);
    if (started) setIsCameraReady(true);
  };

  const handleSelectActiveSlot = (slotId: string) => {
    setActiveCameraSlotId(slotId);
    if (isScanning) {
      setLastDetectedSlotId(slotId);
      setCurrentPlate((plate) => (plate === 'READY' || plate === 'PAUSED' ? 'SCANNING' : plate));
    }
  };

  const handleCameraSlotDeviceChange = (slotId: string, deviceId: string) => {
    setCameraSlots((slots) => slots.map((slot) => (slot.id === slotId ? { ...slot, deviceId } : slot)));
    setPreviewSlotIds((ids) => ids.filter((id) => id !== slotId));
    handleSelectActiveSlot(slotId);
    if (isScanning) {
      setIsScanning(false);
      resetLiveScanUi();
      setCurrentPlate('READY');
    }
  };

  const handleStartScanning = async () => {
    const started = await startVisibleCameras();
    if (started) {
      if (!isRuntimeScanningReady(runtimeStateRef.current)) {
        void startRuntimeInit();
      }
      resetLiveScanUi();
      setCurrentPlate('SCANNING');
      setIsScanning(true);
    }
  };

  const handlePauseScanning = () => {
    setIsScanning(false);
    resetLiveScanUi();
    setCurrentPlate('PAUSED');
  };

  const handleAddCamera = async () => {
    if (!supportsMultiCameraScanRef.current) return;

    const devices = await refreshCameraList();
    setCameraSlots((slots) => {
      if (slots.length >= 4) return slots;
      const nextIndex = slots.length;
      const nextDeviceId = devices[nextIndex]?.deviceId || devices[0]?.deviceId || slots[0]?.deviceId || '';
      return [...slots, { id: `camera-slot-${Date.now()}`, deviceId: nextDeviceId }];
    });
  };

  const handleRemoveCamera = (slotId: string) => {
    setCameraSlots((slots) => {
      if (slots.length <= 1) return slots;
      const nextSlots = slots.filter((slot) => slot.id !== slotId);
      if (activeCameraSlotId === slotId) {
        setActiveCameraSlotId(nextSlots[0]?.id || 'camera-slot-1');
      }
      setPreviewSlotIds((ids) => ids.filter((id) => id !== slotId));
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
      options: { commitNoCase?: boolean } = {}
    ) => {
      const commitNoCase = options.commitNoCase ?? true;
      const normalizedPlate = cleanPlateNumber(plate);
      const cooldownMs = settingsRef.current.duplicateCooldown * 1000;
      const now = Date.now();
      const lastSearch = cooldownMap.current.get(normalizedPlate) ?? 0;
      const trackSearchThrottleMs = commitNoCase ? 0 : 1000;

      if (commitNoCase && now - lastSearch < cooldownMs) {
        track.ocrState = 'COOLDOWN';
        track.cooldownActive = true;
        track.cooldownStartedAt = now;
        return;
      }

      if (trackSearchThrottleMs > 0 && track.lastSearchedAt && now - track.lastSearchedAt < trackSearchThrottleMs) {
        return;
      }

      track.lastSearchedAt = now;
      track.ocrState = 'DB_CHECKING';

      const vehicleCases = vehiclesRef.current.map(mapVehicleToCase);
      const evaluation = evaluateDatabaseMatch(
        normalizedPlate,
        confidence,
        vehicleCases,
        undefined,
        Math.min(settingsRef.current.recognitionThreshold, 0.6)
      );
      const matchedVehicle =
        evaluation.matchedVehicle ? vehiclesRef.current.find((vehicle) => vehicle.id === evaluation.matchedVehicle?.id) || null : null;
      const possibleVehicles = evaluation.possibleMatches
        .map((possibleVehicle) => vehiclesRef.current.find((vehicle) => vehicle.id === possibleVehicle.id) || null)
        .filter((vehicle): vehicle is Vehicle => Boolean(vehicle));
      const resolvedMatchType =
        evaluation.matchType === 'EXACT' && matchedVehicle
          ? 'EXACT'
          : evaluation.matchType === 'POSSIBLE' && possibleVehicles.length > 0
          ? 'POSSIBLE'
          : 'NONE';

      if (!commitNoCase && resolvedMatchType === 'NONE') {
        track.ocrState = 'CONSENSUS_BUILDING';
        return;
      }

      cooldownMap.current.set(normalizedPlate, now);

      const timestamp = new Date();
      const scanCameraName = getCameraSlotLabelFromRefs(slotId);
      const scanLocation = SCAN_LOCATIONS[Math.floor(Math.random() * SCAN_LOCATIONS.length)];
      const confidencePercent = Number((confidence * 100).toFixed(1));
      const detectionId = `det-${timestamp.getTime()}-${Math.floor(Math.random() * 1000)}`;
      const newDetection: SessionDetection = {
        id: detectionId,
        plate: normalizedPlate,
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
      };

      setCurrentPlate(normalizedPlate);
      setLastDetectedSlotId(slotId);
      setLiveDetections((prevStream) => {
        const nextStream = [newDetection, ...prevStream.slice(0, 7)];
        localStorage.setItem(RECENT_DETECTIONS_STORAGE_KEY, JSON.stringify(nextStream));
        return nextStream;
      });

      addHistoryLogRef.current({
        type: 'DETECTION',
        action:
          resolvedMatchType === 'EXACT'
            ? `Tanda Tindakan (Pengimbas): ${normalizedPlate}`
            : resolvedMatchType === 'POSSIBLE'
            ? `Possible Match (Pengimbas): ${normalizedPlate}`
            : `Live Scan: ${normalizedPlate}`,
        plate: normalizedPlate,
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
        userRole: role,
        statusMatch: resolvedMatchType,
      });

      track.matchType = resolvedMatchType;
      track.matchedVehicle = matchedVehicle ?? undefined;
      track.possibleMatchVehicles = possibleVehicles;
      track.ocrState =
        resolvedMatchType === 'EXACT' ? 'MATCHED' : resolvedMatchType === 'POSSIBLE' ? 'POSSIBLE MATCH' : 'NO CASE';
      track.scanEventId = detectionId;

      if (resolvedMatchType === 'EXACT' && matchedVehicle) {
        setActiveAlertMatch({ vehicle: matchedVehicle, cameraName: scanCameraName, cameraId: slotId });
        playAlertChime();
      }

      track.ocrState = 'COOLDOWN';
      track.cooldownActive = true;
      track.cooldownStartedAt = Date.now();
    },
    [getCameraSlotLabelFromRefs, role]
  );

  useEffect(() => {
    if (!isCameraReady || !isScanning) return;

    let stopped = false;
    const slotsToScan = (supportsMultiCameraScan
      ? cameraSlots
      : cameraSlots.filter((slot) => slot.id === activeCameraSlotIdRef.current)
    ).filter((slot) => previewSlotIds.includes(slot.id) && videoRefs.current[slot.id]);

    if (slotsToScan.length === 0) return;

    const flushInterval = window.setInterval(flushScannerMetrics, 1000);
    const cleanupRunners = slotsToScan.map((slot) => {
      const slotId = slot.id;
      const runtime = getSlotRuntime(slotId);
      const metrics = ensureSlotMetrics(slotId);
      let animId: number;
      let detectionTimeout: ReturnType<typeof setTimeout> | undefined;
      let lastVideoTime = -1;
      let lastDetectorValidationAt = 0;

      const scheduleDetection = (delay = 100) => {
        if (stopped) return;
        detectionTimeout = setTimeout(runDetection, delay);
      };

      const runDetection = async () => {
        if (stopped) return;

        const video = videoRefs.current[slotId];

        if (!video) {
          scheduleDetection(150);
          return;
        }

        if (!isRuntimeScanningReady(runtimeStateRef.current)) {
          scheduleDetection(250);
          return;
        }

        if (video.readyState < 2 || video.videoWidth === 0) {
          scheduleDetection(150);
          return;
        }

        if (!runtime.processingCanvas) {
          runtime.processingCanvas = document.createElement('canvas');
        }

        const processingCanvas = runtime.processingCanvas;
        if (processingCanvas.width !== video.videoWidth || processingCanvas.height !== video.videoHeight) {
          processingCanvas.width = video.videoWidth;
          processingCanvas.height = video.videoHeight;
        }

        const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });
        if (!processingCtx) {
          scheduleDetection(150);
          return;
        }

        const detectionStartedAt = performance.now();
        processingCtx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);

        const scannerSettings = settingsRef.current;
        let detectedPlates: Awaited<ReturnType<typeof detectMalaysianPlates>> = [];

        try {
          detectedPlates = await detectMalaysianPlates(processingCanvas, {
            minConfidence: scannerSettings.detectionThreshold,
            enginePreference: scannerSettings.detectorEngine,
            developerMode: scannerSettings.debugMode,
          });
        } catch (err) {
          console.warn(`[Scanner:${slotId}] Detector frame failed:`, err);
        }

        if (detectedPlates.length === 0) {
          const now = Date.now();
          if (now - lastDetectorValidationAt > DETECTOR_VALIDATION_INTERVAL_MS) {
            lastDetectorValidationAt = now;
            await validateDetector();
          }
        }

        const bboxList = detectedPlates.map((plateBox) => ({
          x: plateBox.bbox.x,
          y: plateBox.bbox.y,
          width: plateBox.bbox.width,
          height: plateBox.bbox.height,
          confidence: plateBox.confidence,
        }));

        const allTracks = runtime.tracker.updateTracks(bboxList);
        const confirmedTracks = runtime.tracker.getActiveTracks(true);
        const displayTracks = scannerSettings.debugMode ? allTracks : confirmedTracks;
        const loopNow = Date.now();

        confirmedTracks.forEach((track) => {
          if (track.cooldownActive && !track.cooldownStartedAt) {
            track.cooldownStartedAt = loopNow;
          }

          if (
            track.cooldownActive &&
            track.cooldownStartedAt &&
            loopNow - track.cooldownStartedAt >= TRACK_RESULT_HOLD_MS
          ) {
            resetTrackForNextPlate(track);
            runtime.bestFrameSelector.clearTrack(track.trackNumber);
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
        metrics.activeTracks = confirmedTracks.length;
        metrics.tracks = [...displayTracks];

        const cropSampleNow = loopNow;
        confirmedTracks.forEach((track) => {
          if (!track.lastOverlayAngleAt || cropSampleNow - track.lastOverlayAngleAt >= OVERLAY_ANGLE_SAMPLE_MS) {
            track.overlayAngle = estimatePlateOverlayAngle(processingCanvas, track.bbox, track.overlayAngle ?? 0);
            track.lastOverlayAngleAt = cropSampleNow;
          }

          if (track.ocrState === 'COOLDOWN' || track.ocrState === 'MATCHED') return;
          const existingCrop = runtime.bestFrameSelector.getBestCrop(track.trackNumber);
          const sampleInterval = track.bbox.confidence >= 0.7 ? CROP_SAMPLE_FAST_MS : CROP_SAMPLE_NORMAL_MS;
          if (existingCrop && track.lastCropSampledAt && cropSampleNow - track.lastCropSampledAt < sampleInterval) {
            return;
          }

          const cropCanvas = cropCanvasRegionFast(processingCanvas, track.bbox);
          runtime.bestFrameSelector.addCropCandidate(track.trackNumber, cropCanvas, track.bbox);
          track.lastCropSampledAt = cropSampleNow;
        });

        processOcrQueue(confirmedTracks, processingCanvas, scannerSettings, runtime, slotId);
        metrics.detFrames++;

        const targetInterval = activeOcrCount.current > 0 ? DETECTION_BUSY_INTERVAL_MS : DETECTION_TARGET_INTERVAL_MS;
        const nextDelay = Math.max(
          DETECTION_MIN_DELAY_MS,
          Math.round(targetInterval - (performance.now() - detectionStartedAt))
        );
        scheduleDetection(nextDelay);
      };

      const processOcrQueue = async (
        confirmedTracks: ActiveTrack[],
        canvas: HTMLCanvasElement,
        scannerSettings: ScannerSettings,
        slotRuntime: SlotScannerRuntime,
        sourceSlotId: string
      ) => {
        if (!isPpOcrReady()) {
          confirmedTracks.forEach((track) => {
            if (!track.cooldownActive && track.ocrState !== 'MATCHED') {
              track.ocrState = 'COLLECTING';
            }
          });
          return;
        }

        const maxOcrConcurrency = Math.min(
          OCR_MAX_CONCURRENCY,
          Math.max(1, scannerSettings.maxOcrConcurrency || INITIAL_SETTINGS.maxOcrConcurrency)
        );
        const priorityIds = prioritiseTracks(
          confirmedTracks.map((track) => ({
            trackId: track.trackId,
            bbox: track.bbox,
            framesSeen: track.framesSeen,
            ocrState: track.ocrState,
            lastOcrAttemptAt: track.lastOcrAttemptAt,
            voteCount: Array.from(track.votes.values()).reduce((sum, vote) => sum + vote.count, 0),
          })),
          canvas.width,
          canvas.height,
          maxOcrConcurrency
        );

        for (const trackId of priorityIds) {
          const track = slotRuntime.tracker.getTrack(trackId);
          if (!track || !track.isConfirmed || track.ocrRunning || track.cooldownActive) continue;
          if (activeOcrCount.current >= maxOcrConcurrency) break;

          const now = Date.now();
          const voteCount = Array.from(track.votes.values()).reduce((sum, vote) => sum + vote.count, 0);
          const retryDelay = voteCount === 0 ? OCR_FIRST_READ_RETRY_MS : OCR_REPEAT_READ_RETRY_MS;
          if (track.lastOcrAttemptAt && now - track.lastOcrAttemptAt < retryDelay) continue;

          const minReadableWidth = Math.max(40, scannerSettings.minCropWidth || INITIAL_SETTINGS.minCropWidth);
          const canReadFirstFrame = track.framesSeen >= 2 || track.bbox.confidence >= 0.6;
          if (!canReadFirstFrame || track.bbox.width < minReadableWidth) {
            track.ocrState = 'COLLECTING';
            continue;
          }

          const bestFrameEntry = slotRuntime.bestFrameSelector.getBestCrop(track.trackNumber);
          const targetCropFromBest = !!bestFrameEntry?.canvas;
          const targetCrop = bestFrameEntry?.canvas ?? cropCanvasRegionFast(canvas, track.bbox);
          const qualityReport = bestFrameEntry?.quality || { overallScore: 0.6, recommendation: 'MARGINAL' as const };
          if (qualityReport.recommendation === 'REJECT') {
            track.ocrState = 'LOW QUALITY';
            continue;
          }

          track.ocrRunning = true;
          track.ocrJobQueued = true;
          track.lastOcrAttemptAt = now;
          track.ocrState = 'OCR_RUNNING';
          activeOcrCount.current++;

          void (async () => {
            const transientCanvases: HTMLCanvasElement[] = [];
            const rememberTransientCanvas = (crop?: HTMLCanvasElement | null) => {
              if (crop && !transientCanvases.includes(crop)) {
                transientCanvases.push(crop);
              }
            };

            try {
              if (!targetCropFromBest) rememberTransientCanvas(targetCrop);

              const innerTextCrop = createInnerPlateTextCrop(targetCrop);
              rememberTransientCanvas(innerTextCrop);

              const innerCrops = generateAdaptiveCrops(
                innerTextCrop,
                { x: 0, y: 0, width: innerTextCrop.width, height: innerTextCrop.height, confidence: 1 },
                360,
                108,
                ['ORIGINAL', 'INVERTED']
              );
              innerCrops.forEach((crop) => {
                rememberTransientCanvas(crop.canvas);
                rememberTransientCanvas(crop.topLineCanvas);
                rememberTransientCanvas(crop.bottomLineCanvas);
              });

              const activeTrackLoad = Math.max(1, confirmedTracks.length);
              const fullCropVariants =
                activeTrackLoad >= 3
                  ? (['ORIGINAL', 'DARK_BG', 'INVERTED'] as const)
                  : (['ORIGINAL', 'SHARPEN', 'DARK_BG', 'INVERTED'] as const);
              const adaptiveCrops = generateAdaptiveCrops(
                targetCrop,
                { x: 0, y: 0, width: targetCrop.width, height: targetCrop.height, confidence: 1 },
                360,
                108,
                [...fullCropVariants]
              );
              adaptiveCrops.forEach((crop) => {
                rememberTransientCanvas(crop.canvas);
                rememberTransientCanvas(crop.topLineCanvas);
                rememberTransientCanvas(crop.bottomLineCanvas);
              });

              const maxCandidateCrops = activeTrackLoad >= 3 ? 4 : 6;
              const candidateCrops = [...innerCrops, ...adaptiveCrops].slice(0, maxCandidateCrops);
              const fallbackCrop = {
                canvas: targetCrop,
                isTwoLine: targetCrop.width / Math.max(1, targetCrop.height) < 2.3,
              };
              const expectedMinChars = getExpectedMinPlateChars(targetCrop);

              let text = '';
              let conf = 0;
              let bestScore = 0;
              let bestPatternValid = false;

              for (const crop of candidateCrops.length > 0 ? candidateCrops : [fallbackCrop]) {
                const result = await recognizePlateFromCanvas(crop.canvas, crop.isTwoLine);
                const resultText = result.normalizedPlate || result.text;
                const pattern = validateMalaysianPattern(resultText);
                const isPlausible = isPlausiblePlateCandidate(resultText, expectedMinChars, pattern.score);
                const lengthScore = Math.min(1, resultText.length / Math.max(expectedMinChars + 1, 6));
                const plausibilityPenalty = isPlausible ? 0 : 0.75;
                const score =
                  result.confidence * 0.45 +
                  pattern.score * 0.3 +
                  lengthScore * 0.2 +
                  (pattern.isValid ? 0.1 : 0) -
                  plausibilityPenalty;

                if (resultText && isPlausible && score >= bestScore) {
                  text = resultText;
                  conf = result.confidence;
                  bestScore = score;
                  bestPatternValid = pattern.isValid;
                }

                if (resultText && isPlausible && result.confidence >= 0.25 && pattern.score >= 0.55 && score >= 0.58) {
                  break;
                }
              }

              const updatedTrack = slotRuntime.tracker.getTrack(trackId);
              if (!updatedTrack || updatedTrack.cooldownActive) return;

              if (text && conf >= 0.25) {
                addOcrVoteToTrack(updatedTrack, text, conf, qualityReport.overallScore);
                updatedTrack.ocrState = 'CONSENSUS_BUILDING';

                const { digits } = countPlateChars(text);
                const canFastMatch = bestPatternValid && digits >= (text.length >= 5 ? 2 : 1);
                const veryStrongRead =
                  canFastMatch && conf >= Math.max(0.6, scannerSettings.recognitionThreshold) && bestScore >= 0.7;
                const strongRead = canFastMatch && conf >= 0.32 && bestScore >= 0.56;
                const requiredVotes = veryStrongRead
                  ? 1
                  : strongRead
                    ? Math.min(2, scannerSettings.consensusVotes)
                    : scannerSettings.consensusVotes;
                const confidenceGate = veryStrongRead
                  ? Math.min(scannerSettings.recognitionThreshold, 0.58)
                  : strongRead
                    ? Math.min(scannerSettings.recognitionThreshold, 0.45)
                    : scannerSettings.recognitionThreshold;
                const consensus = evaluateConsensus(updatedTrack, requiredVotes, confidenceGate);

                if (consensus.isStabilized) {
                  const matchConfidence = Math.max(consensus.confidence, Math.min(0.98, bestScore));
                  updatedTrack.stabilizedPlate = consensus.normalizedPlate;
                  updatedTrack.stabilizedConfidence = matchConfidence;
                  const finalOutcomeReady = canCommitFinalPlateOutcome(consensus.normalizedPlate);
                  await runDatabaseMatch(updatedTrack, consensus.normalizedPlate, matchConfidence, sourceSlotId, {
                    commitNoCase: finalOutcomeReady,
                  });
                }
              } else if (updatedTrack.votes.size === 0) {
                updatedTrack.ocrState = 'COLLECTING';
              }
            } catch (err) {
              console.warn(`[OCR:${sourceSlotId}] Error:`, err);
            } finally {
              transientCanvases.forEach(releaseCanvasMemory);
              const refreshedTrack = slotRuntime.tracker.getTrack(trackId);
              if (refreshedTrack) {
                refreshedTrack.ocrRunning = false;
                refreshedTrack.ocrJobQueued = false;
                refreshedTrack.lastOcrCompletedAt = Date.now();
              }
              activeOcrCount.current = Math.max(0, activeOcrCount.current - 1);
            }
          })();
        }
      };

      const renderLoop = () => {
        const video = videoRefs.current[slotId];
        const overlayCanvas = canvasRefs.current[slotId];

        if (video && overlayCanvas && video.readyState >= 2 && video.videoWidth > 0) {
          if (overlayCanvas.width !== video.videoWidth || overlayCanvas.height !== video.videoHeight) {
            overlayCanvas.width = video.videoWidth;
            overlayCanvas.height = video.videoHeight;
          }

          const overlayCtx = overlayCanvas.getContext('2d');
          if (overlayCtx) {
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            const scannerSettings = settingsRef.current;
            const displayTracks = scannerSettings.debugMode
              ? runtime.tracker.getActiveTracks(false)
              : runtime.tracker.getActiveTracks(true);
            drawOverlays(
              overlayCtx,
              overlayCanvas.width,
              overlayCanvas.height,
              displayTracks,
              scannerSettings.showCenterGuide
            );
          }

          if (video.currentTime !== lastVideoTime) {
            metrics.camFrames++;
            lastVideoTime = video.currentTime;
          }
        }

        const now = Date.now();
        if (now - lastMetricsFlushTs.current >= 1000) {
          lastMetricsFlushTs.current = now;
          flushScannerMetrics();
        }

        animId = requestAnimationFrame(renderLoop);
      };

      animId = requestAnimationFrame(renderLoop);
      scheduleDetection(100);

      return () => {
        cancelAnimationFrame(animId);
        if (detectionTimeout) clearTimeout(detectionTimeout);
        metrics.platesVisible = 0;
        metrics.activeTracks = 0;
        metrics.tracks = [];
      };
    });

    return () => {
      stopped = true;
      window.clearInterval(flushInterval);
      cleanupRunners.forEach((cleanup) => cleanup());
      flushScannerMetrics();
    };
  }, [
    cameraSlots,
    ensureSlotMetrics,
    flushScannerMetrics,
    getSlotRuntime,
    isCameraReady,
    isScanning,
    previewSlotIds,
    runDatabaseMatch,
    supportsMultiCameraScan,
  ]);

  function drawOverlays(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    tracks: ActiveTrack[],
    showGuide: boolean
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

    tracks.forEach((track) => {
      const { x, y, width: boxWidth, height: boxHeight } = track.smoothBbox;
      const color = getTrackColor(track);
      const label = getTrackPlateText(track) || getTrackStatusLabel(track);
      const angle = track.overlayAngle ?? 0;
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
      ctx.fillText(label, pillCx, pillCy);
      ctx.restore();
    });
  }

  const handleMarkAsSeen = () => {
    if (activeAlertMatch) {
      const flaggedObj = { ...activeAlertMatch.vehicle, status: 'FLAGGED' as const };
      updateVehicle(flaggedObj);
      addHistoryLog({
        type: 'DETECTION',
        action: `Tanda Tindakan (Disemak): ${activeAlertMatch.vehicle.plate}`,
        plate: activeAlertMatch.vehicle.plate,
        details: `Alert Tanda Tindakan disemak oleh ${role} pada ${activeAlertMatch.cameraName}`,
        note: `Ditanda Tindakan oleh ${role} pada ${activeAlertMatch.cameraName}`,
        userRole: role,
        statusMatch: 'EXACT',
      });
    }
    setActiveAlertMatch(null);
  };

  const handleMarkDetectionAction = (detection: SessionDetection) => {
    if (!detection.vehicleId) return;

    const vehicle = vehicles.find((item) => item.id === detection.vehicleId);
    if (!vehicle) return;

    const flaggedObj = { ...vehicle, status: 'FLAGGED' as const };
    updateVehicle(flaggedObj);
    addHistoryLog({
      type: 'DETECTION',
      action: `Tanda Tindakan (Pengimbas): ${vehicle.plate}`,
      plate: vehicle.plate,
      details: `Scanner action confirmed by ${role} from ${detection.cameraName}`,
      note: `Ditanda Tindakan oleh ${role} dari ${detection.cameraName}`,
      userRole: role,
      statusMatch: 'EXACT',
    });

    setLiveDetections((prevStream) => {
      const nextStream = prevStream.map((item) =>
        item.id === detection.id ? { ...item, matched: true, matchType: 'EXACT' as const, vehicleId: vehicle.id } : item
      );
      localStorage.setItem(RECENT_DETECTIONS_STORAGE_KEY, JSON.stringify(nextStream));
      return nextStream;
    });

    if (activeAlertMatch?.vehicle.id === vehicle.id) {
      setActiveAlertMatch(null);
    }
  };

  const runtimeReady = isRuntimeScanningReady(runtimeState);
  const visibleTrack = tracksList.find((track) => getTrackPlateText(track)) || tracksList[0] || null;
  const activeScanTileCount = supportsMultiCameraScan
    ? cameraSlots.filter((slot) => previewSlotIds.includes(slot.id)).length
    : previewSlotIds.includes(activeCameraSlotId)
      ? 1
      : 0;
  const scannerStatusText = cameraError
    ? 'Camera unavailable'
    : isScanning && runtimeReady && supportsMultiCameraScan
    ? `Scanning ${activeScanTileCount || 1} camera${(activeScanTileCount || 1) === 1 ? '' : 's'}${visibleTrack ? ` - ${getTrackStatusLabel(visibleTrack)}` : ''}`
    : isScanning && runtimeReady
    ? `Scanning selected camera${visibleTrack ? ` - ${getTrackStatusLabel(visibleTrack)}` : ''}`
    : isScanning
    ? 'AI models warming up'
    : previewSlotIds.length > 0
    ? 'Camera preview ready'
    : 'Choose camera in preview and start scanning';
  const latestDetection = liveDetections[0] || null;
  const latestExactVehicle =
    latestDetection?.vehicleId ? vehicles.find((vehicle) => vehicle.id === latestDetection.vehicleId) || null : null;
  const latestPossibleVehicles =
    latestDetection?.possibleVehicleIds
      ?.map((vehicleId) => vehicles.find((vehicle) => vehicle.id === vehicleId) || null)
      .filter((vehicle): vehicle is Vehicle => Boolean(vehicle)) || [];
  const latestSearchHref = latestDetection ? `/search?plate=${encodeURIComponent(latestDetection.plate)}` : '/search';
  const latestResultTone =
    latestDetection?.matchType === 'EXACT' || latestDetection?.matched
      ? 'EXACT'
      : latestDetection?.matchType === 'POSSIBLE'
      ? 'POSSIBLE'
      : latestDetection
      ? 'NONE'
      : null;

  return (
    <div className="space-y-4 max-w-6xl mx-auto px-1 sm:px-0">
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3 sm:p-4 shadow-xl flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Link
            href="/"
            className="p-1.5 sm:p-2 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition-all shrink-0"
            title={language === 'BM' ? 'Kembali ke Papan Utama' : 'Back to Dashboard'}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-xs sm:text-base font-black text-white uppercase tracking-wider">
              {t('liveScannerTitle')}
            </h1>
            <p className="text-[10px] text-slate-500 hidden sm:block">
              {scannerStatusText}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
            {supportsMultiCameraScan && (
              <button
                type="button"
                onClick={() => void handleAddCamera()}
                disabled={cameraSlots.length >= 4}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 transition-all hover:border-cyan-700 hover:text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
                <span>Add Camera</span>
              </button>
            )}
            {isScanning ? (
              <button
                onClick={handlePauseScanning}
                className="flex-1 sm:flex-initial px-4 py-2 rounded-xl bg-amber-950 text-amber-300 border border-amber-700 text-xs font-black uppercase flex items-center justify-center gap-2"
              >
                <Pause className="w-4 h-4" />
                <span>Pause Scan</span>
              </button>
            ) : (
              <button
                onClick={() => void handleStartScanning()}
                className="flex-1 sm:flex-initial px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-black uppercase flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20"
              >
                <Play className="w-4 h-4" />
                <span>Start Scanning</span>
              </button>
            )}
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`p-2 rounded-xl border text-xs font-bold transition-all shrink-0 ${
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

      {cameraError && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-xs font-bold text-red-300">
          {cameraError}
        </div>
      )}

      {!cameraError && (
        <ModelStatusBanner
          runtimeState={runtimeState}
          detectorProvider={detectorProvider}
          ocrProvider={ocrProvider}
          benchmark={benchmarkResult}
          errorMessage={runtimeErrorMessage}
          debugMode={false}
          onRetry={startRuntimeInit}
          onManualSearch={() => {
            window.location.href = '/search';
          }}
        />
      )}

      <div
        className="relative bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-xl sm:aspect-video"
      >
        <div
          className={`grid gap-1.5 p-1.5 sm:absolute sm:inset-0 ${
            cameraSlots.length === 1
              ? 'grid-cols-1'
              : cameraSlots.length === 2
              ? 'grid-cols-1 sm:grid-cols-2'
              : 'grid-cols-1 sm:grid-cols-2'
          }`}
        >
          {cameraSlots.map((slot, index) => {
            const slotLabel = getCameraSlotLabel(slot, index);
            const isAlertSlot = activeAlertMatch?.cameraId === slot.id;

            return (
              <div
                key={slot.id}
                onClick={() => handleSelectActiveSlot(slot.id)}
                className={`relative min-h-[420px] sm:min-h-0 rounded-xl overflow-hidden border bg-slate-950 text-left transition-all ${
                  isAlertSlot
                    ? 'border-red-500 ring-2 ring-red-500/40'
                    : 'border-slate-800'
                }`}
              >
                <video
                  ref={(node) => {
                    videoRefs.current[slot.id] = node;
                  }}
                  className="absolute inset-0 h-full w-full object-cover"
                  muted
                  playsInline
                  autoPlay
                />

                {!previewSlotIds.includes(slot.id) && (
                  <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center gap-3 text-center p-6">
                    <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                      <Video className="w-6 h-6 text-cyan-400" />
                    </div>
                    <div>
                      <div className="text-xs font-black text-white uppercase tracking-wider">{slotLabel}</div>
                      <div className="text-[10px] text-slate-500 mt-1">Choose camera and use preview before scanning.</div>
                    </div>
                  </div>
                )}

                <canvas
                  ref={(node) => {
                    canvasRefs.current[slot.id] = node;
                  }}
                  className="absolute inset-0 z-10 h-full w-full object-cover pointer-events-none"
                />

                <div className="absolute inset-x-2.5 top-2.5 z-20 flex items-center gap-1.5">
                  <select
                    value={slot.deviceId}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => handleCameraSlotDeviceChange(slot.id, event.target.value)}
                    className="h-7 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900/90 px-2 text-[10px] font-bold text-slate-200 outline-none hover:border-cyan-700 focus:border-cyan-500"
                    title={language === 'BM' ? 'Pilih kamera' : 'Choose camera'}
                  >
                    {(availableCameras.length > 0 ? availableCameras : [{ deviceId: '', label: slotLabel } as MediaDeviceInfo]).map(
                      (cameraDevice, cameraIndex) => (
                        <option key={cameraDevice.deviceId || `camera-${cameraIndex}`} value={cameraDevice.deviceId}>
                          {cameraDevice.label || (cameraIndex === 0 ? slotLabel : `Camera ${cameraIndex + 1}`)}
                        </option>
                      )
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUseCamera(slot, index);
                    }}
                    className="h-7 rounded-lg border border-cyan-700 bg-cyan-950/90 px-2 text-[10px] font-bold text-cyan-200 hover:bg-cyan-900"
                  >
                    Preview
                  </button>
                  {cameraSlots.length > 1 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRemoveCamera(slot.id);
                      }}
                      className="h-7 w-7 rounded-lg border border-slate-700 bg-slate-900/90 text-slate-300 hover:border-red-700 hover:text-red-300"
                      title={language === 'BM' ? 'Buang kamera' : 'Remove camera'}
                    >
                      <X className="mx-auto h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {supportsMultiCameraScan && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleAddCamera();
                    }}
                    disabled={cameraSlots.length >= 4}
                    className="sm:hidden absolute bottom-2.5 right-2.5 z-20 inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/85 px-2.5 py-1 text-[10px] font-bold text-slate-300 disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" />
                    <span>Add</span>
                  </button>
                )}
                {isAlertSlot && activeAlertMatch && (
                  <div className="scanner-alert-card absolute inset-1.5 z-30 bg-red-600 border-2 border-red-400 rounded-xl p-2.5 sm:p-4 shadow-2xl flex flex-col justify-between text-center overflow-hidden">
                    <div className="flex items-center justify-between border-b border-red-500/80 pb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <ShieldAlert className="w-4 h-4 text-white animate-bounce shrink-0" />
                        <span className="text-[10px] sm:text-xs font-black uppercase text-white tracking-wider truncate">
                          {language === 'BM' ? 'AMARAN: PADANAN DIKESAN' : 'ALERT: MATCH DETECTED'}
                        </span>
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveAlertMatch(null);
                        }}
                        className="p-1 rounded-lg bg-red-700 hover:bg-red-800 text-white transition-all"
                        title={t('closeBtn')}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="bg-red-700 border border-red-400/50 rounded-lg p-2.5 sm:p-3 space-y-2 text-left shadow-inner">
                      <div className="grid grid-cols-2 gap-2 border-b border-red-500/80 pb-2">
                        <div>
                          <span className="text-[9px] text-red-100 font-bold uppercase block">{t('plateNumber')}</span>
                          <span className="plate-yellow text-base sm:text-xl font-mono font-black">
                            {activeAlertMatch.vehicle.plate}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-red-100 font-bold uppercase block">{t('outstandingAmount')}</span>
                          <span className="text-base sm:text-lg font-mono font-black text-white">
                            {formatMYR(activeAlertMatch.vehicle.outstandingAmount)}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px] sm:text-xs">
                        <div>
                          <span className="text-red-100 block">{t('vehicleDetails')}</span>
                          <strong className="text-white truncate block">
                            {activeAlertMatch.vehicle.brand} {activeAlertMatch.vehicle.model}
                          </strong>
                        </div>
                        <div>
                          <span className="text-red-100 block">{language === 'BM' ? 'Kamera' : 'Camera'}</span>
                          <strong className="text-white truncate block">{activeAlertMatch.cameraName}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-1.5 pt-2 border-t border-red-500/80">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMarkAsSeen();
                        }}
                        className="btn-mark-seen px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-red-600 text-[10px] sm:text-xs font-black uppercase tracking-wider flex items-center justify-center gap-1 shadow-md transition-all"
                      >
                        <BookmarkCheck className="w-3.5 h-3.5 text-red-600" />
                        <span>{t('markAction')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {latestDetection && latestResultTone && (
        <div
          className={`rounded-2xl border p-3.5 sm:p-4 shadow-xl ${
            latestResultTone === 'EXACT'
              ? 'border-red-700 bg-red-950/35'
              : latestResultTone === 'POSSIBLE'
              ? 'border-amber-700 bg-amber-950/25'
              : 'border-slate-800 bg-slate-900/90'
          }`}
        >
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div
                className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                  latestResultTone === 'EXACT'
                    ? 'border-red-500 bg-red-600 text-white'
                    : latestResultTone === 'POSSIBLE'
                    ? 'border-amber-500 bg-amber-500 text-slate-950'
                    : 'border-cyan-900 bg-slate-950 text-cyan-300'
                }`}
              >
                {latestResultTone === 'EXACT' ? (
                  <ShieldAlert className="h-5 w-5" />
                ) : latestResultTone === 'POSSIBLE' ? (
                  <AlertTriangle className="h-5 w-5" />
                ) : (
                  <XCircle className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                  {language === 'BM' ? 'Keputusan Imbasan Terkini' : 'Latest Scanner Result'}
                </div>
                <h2 className="text-sm sm:text-base font-black text-white uppercase tracking-wide">
                  {latestResultTone === 'EXACT'
                    ? language === 'BM'
                      ? 'Padanan kes dijumpai'
                      : 'Case match found'
                    : latestResultTone === 'POSSIBLE'
                    ? language === 'BM'
                      ? 'Padanan berpotensi'
                      : 'Possible match'
                    : language === 'BM'
                    ? 'Tiada padanan aktif'
                    : 'No active match'}
                </h2>
                <p className="mt-1 text-[11px] sm:text-xs text-slate-400">
                  {latestResultTone === 'EXACT' && latestExactVehicle
                    ? `${latestExactVehicle.brand} ${latestExactVehicle.model} - ${latestExactVehicle.financeCompany}`
                    : latestResultTone === 'POSSIBLE' && latestPossibleVehicles.length > 0
                    ? `${language === 'BM' ? 'Semak calon:' : 'Review candidates:'} ${latestPossibleVehicles
                        .map((vehicle) => vehicle.plate)
                        .join(', ')}`
                    : language === 'BM'
                    ? 'Direkod untuk audit sahaja. Tiada amaran tindakan dikeluarkan.'
                    : 'Logged for audit only. No action alert was raised.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 lg:min-w-[520px]">
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase text-slate-500">
                  <FileSearch className="h-3 w-3 text-cyan-400" />
                  <span>{language === 'BM' ? 'Plat' : 'Plate'}</span>
                </div>
                <div className="mt-1 font-mono text-sm font-black text-cyan-300 truncate">{latestDetection.plate}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase text-slate-500">
                  <Activity className="h-3 w-3 text-cyan-400" />
                  <span>{language === 'BM' ? 'Keyakinan' : 'Confidence'}</span>
                </div>
                <div className="mt-1 font-mono text-sm font-black text-slate-200">{latestDetection.confidence}%</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase text-slate-500">
                  <Video className="h-3 w-3 text-cyan-400" />
                  <span>{language === 'BM' ? 'Kamera' : 'Camera'}</span>
                </div>
                <div className="mt-1 text-xs font-bold text-slate-200 truncate">{latestDetection.cameraName}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2">
                <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase text-slate-500">
                  {latestResultTone === 'EXACT' ? (
                    <DollarSign className="h-3 w-3 text-red-400" />
                  ) : (
                    <Car className="h-3 w-3 text-cyan-400" />
                  )}
                  <span>{latestResultTone === 'EXACT' ? t('outstandingAmount') : 'Status'}</span>
                </div>
                <div className="mt-1 text-xs font-black text-slate-200 truncate">
                  {latestResultTone === 'EXACT' && latestExactVehicle
                    ? formatMYR(latestExactVehicle.outstandingAmount)
                    : latestResultTone === 'POSSIBLE'
                    ? language === 'BM'
                      ? 'Semakan'
                      : 'Review'
                    : language === 'BM'
                    ? 'Jelas'
                    : 'Clear'}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-3">
            {latestResultTone === 'EXACT' && latestExactVehicle && (
              <button
                type="button"
                onClick={() => handleMarkDetectionAction(latestDetection)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-600 bg-red-600 px-4 py-2 text-xs font-black uppercase text-white shadow-lg shadow-red-950/30 transition-colors hover:bg-red-500"
              >
                <BookmarkCheck className="h-4 w-4" />
                <span>{t('markAction')}</span>
              </button>
            )}
            <Link
              href={latestSearchHref}
              className={`inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-xs font-black uppercase transition-colors ${
                latestResultTone === 'POSSIBLE'
                  ? 'border-amber-700 bg-amber-950/70 text-amber-200 hover:bg-amber-900'
                  : 'border-cyan-800 bg-cyan-950/70 text-cyan-200 hover:bg-cyan-900'
              }`}
            >
              <SearchIcon className="h-4 w-4" />
              <span>
                {latestResultTone === 'POSSIBLE'
                  ? language === 'BM'
                    ? 'Semak Padanan'
                    : 'Review Match'
                  : language === 'BM'
                  ? 'Carian Manual'
                  : 'Manual Search'}
              </span>
            </Link>
            {latestResultTone === 'NONE' && (
              <Link
                href="/vehicles"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-xs font-black uppercase text-slate-300 transition-colors hover:border-cyan-800 hover:text-cyan-200"
              >
                <Database className="h-4 w-4" />
                <span>{language === 'BM' ? 'Pangkalan Data' : 'Vehicle DB'}</span>
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 sm:p-5 shadow-xl space-y-3">
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

        <div className="sm:hidden space-y-2">
          {liveDetections.length > 0 ? (
            liveDetections.map((det) => (
              <button
                key={det.id}
                type="button"
                onClick={() => setExpandedDetectionId((current) => (current === det.id ? null : det.id))}
                className="w-full p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 text-left space-y-2 hover:border-cyan-900/70 transition-all"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-black text-cyan-300 text-xs">{det.plate}</span>
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
                        <span>{language === 'BM' ? 'TIADA' : 'NO MATCH'}</span>
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
                            <span>{language === 'BM' ? 'TIADA PADANAN' : 'UNMATCHED'}</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-slate-300 text-[11px]">{det.confidence}%</td>
                      <td className="py-2 px-3 text-slate-300 text-[11px]">{det.cameraName}</td>
                      <td className="py-2 px-3 text-right text-slate-500 text-[10px] sm:text-[11px]">{det.timestamp}</td>
                    </tr>
                    {expandedDetectionId === det.id && (
                      <tr className="bg-slate-950/70">
                        <td colSpan={5} className="px-3 py-3">
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
                  <td colSpan={5} className="py-8 text-center text-slate-500 font-sans">
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
