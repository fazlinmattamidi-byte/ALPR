import { TrackOcrState } from '../db/types';
import { arePlatesSameVehicleFamily, addOcrCandidateEvidence, addOcrVoteToTrack } from './consensus';
import { isSamePlateAppearance } from './plateAppearance';

export interface BoundingBox {
  appearance?: number[];
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export type TrackLifecycleState = 'VISIBLE' | 'LOST' | 'REMOVED';
export type PlatePipelineState =
  | 'DETECTED'
  | 'TRACKING'
  | 'COLLECTING'
  | 'READY_FOR_OCR'
  | 'READING'
  | 'CONSENSUS'
  | 'MATCHED'
  | 'COOLDOWN'
  | 'FINISHED';

export interface TrackConfidenceComponents {
  detection: number;
  age: number;
  motion: number;
  iou: number;
  ocr: number;
}

export interface TrackRuntimeStats {
  startedAt: number;
  lastUpdatedAt: number;
  framesVisible: number;
  framesLost: number;
  ocrAttempts: number;
  ocrAccepted: number;
  consensusAttempts: number;
  finalConfidence?: number;
  finishedAt?: number;
  lastDetectorLatencyMs?: number;
  lastOcrLatencyMs?: number;
  bestCropQuality?: number;
  lastQualityLatencyMs?: number;
  bestFrameReplacementCount?: number;
  /** Wall-clock ms between job being enqueued and OCR inference starting. */
  queueWaitMs?: number;
  /** Wall-clock ms for the first-crop OCR inference only (fast-path timing). */
  firstOcrMs?: number;
  /** Preprocessing variant that produced the winning OCR recognition. */
  winnerVariant?: string;
}

export interface TrackerRuntimeTuning {
  maxPredictionFrames?: number;
  lostTrackTimeoutMs?: number;
  unconfirmedTrackTimeoutMs?: number;
}

export interface TrackTelemetry {
  trackId: string;
  detectedAt: number;
  cropSavedAt?: number;
  cropWidth?: number;
  cropHeight?: number;
  cropComplete?: boolean;
  ocrQueuedAt?: number;
  ocrStartedAt?: number;
  ocrFinishedAt?: number;
  committedAt?: number;
  dropReason?: string;
  winnerVariant?: string;
}

export interface TrackCropSample {
  dataUrl?: string;
  qualityScore: number;
  timestamp: number;
  ocrText?: string;
  ocrConfidence?: number;
}

export interface ActiveTrack {
  trackId: string;
  observationId?: string;
  firstDetectedMonotonicMs?: number;
  trackNumber: number;
  bbox: BoundingBox;          // Raw detection bbox (used for IoU / matching / cropping)
  smoothBbox: BoundingBox;    // EMA-smoothed bbox (used strictly for UI overlay rendering)
  predictedBbox?: BoundingBox;
  overlayAngle?: number;
  lastOverlayAngleAt?: number;
  vx: number; // velocity x (pixels per frame)
  vy: number; // velocity y (pixels per frame)
  cropSamples: TrackCropSample[];
  lastSeenFrame: number;
  firstSeenFrame: number;
  lastSeenTimestamp: number;
  firstSeenTimestamp: number;
  /** High-precision timestamp of the last verified visual detector box. */
  lastRealDetectionTimestamp?: number;
  /** Milliseconds since the last verified visual detector observation on this plate. */
  overlayAgeMs?: number;
  /** Wall-clock capture time of the source frame for the current detection. */
  lastSeenFrameCapturedAt?: number;
  firstSeenFrameCapturedAt?: number;
  /** Media timeline position where this track first appeared in a sample video. */
  firstSeenMediaTimeSeconds?: number;
  /** Media timeline position of the frame that produced the current box. */
  lastSeenMediaTimeSeconds?: number;
  framesSeen: number;
  visibleThisFrame?: boolean;
  missedFrames?: number;
  motionScore?: number;
  trackConfidence?: number;
  confidenceComponents?: TrackConfidenceComponents;
  qualityClass?: string;
  qualityConfidence?: number;
  qualityScore?: number;
  qualityBackend?: string;
  qualityAcceptedForOcr?: boolean;
  qualityRejectionReasons?: string[];
  qualityCropSize?: { width: number; height: number };
  qualitySharpness?: number;
  qualitySelectedPreprocessing?: string[];
  qualitySubmittedToOcr?: boolean;
  trackState?: TrackLifecycleState;
  pipelineState?: PlatePipelineState;
  stats?: TrackRuntimeStats;

  ocrState: TrackOcrState;
  ocrRunning: boolean;
  ocrJobQueued: boolean;
  /** A captured crop awaits its first OCR attempt; visual loss must not erase it. */
  ocrEvidencePending?: boolean;
  lastCropSampledAt?: number;
  /** Independent source frames already counted toward OCR consensus. */
  ocrVotedCaptureTimes?: Set<number>;
  ocrFrameObservations?: Map<number, { plate: string; confidence: number }>;
  ocrFrameCandidates?: Map<number, Map<string, number>>;
  lastOcrAttemptAt?: number;
  lastOcrSourceCapturedAt?: number;
  ocrAttemptedCaptureTimes?: Set<number>;
  /** Different crops of one frame may be retried, but share one consensus vote. */
  ocrAttemptedCropIds?: Set<string>;
  lastOcrCompletedAt?: number;
  /** performance.now() timestamp when this track's OCR job was enqueued. */
  ocrEnqueuedAt?: number;
  /** performance.now() timestamp when this track's first OCR inference pass began. */
  firstOcrStartedAt?: number;

  votes: Map<string, { count: number; totalConfidence: number }>;
  stabilizedPlate?: string;
  stabilizedConfidence?: number;
  committedPlate?: string;
  labelShown?: boolean;
  labelLocked?: boolean;

  provisionalPlate?: string;
  provisionalConfidence?: number;
  provisionalMatchState?: 'EXACT' | 'POSSIBLE' | 'NONE';

  matchType?: 'EXACT' | 'POSSIBLE' | 'NONE';
  matchedVehicle?: any;
  possibleMatchVehicles?: any[];

  possibleVerificationPlate?: string;
  possibleVerificationCount?: number;
  possibleVerificationStartedAt?: number;

  cooldownActive: boolean;
  cooldownStartedAt?: number;
  lastSearchedAt?: number;
  scanEventId?: string;

  isConfirmed?: boolean;
  candidateState?: 'PLATE_CANDIDATE' | 'CONFIRMED_PLATE' | 'REJECTED_NON_PLATE' | 'UNRESOLVED_EXPIRED';
  visualCandidateScore?: number;
  malaysianColourProfile?: string;
  telemetry?: TrackTelemetry;

  // Real-scanner context & kinematic evidence
  cameraId?: string;
  initialBbox?: BoundingBox;
  maxBboxArea?: number;
  minBboxArea?: number;
  totalDisplacement?: number;
  scaleEvolutionRatio?: number;
}

export function addQualityCropSample(track: ActiveTrack, sample: TrackCropSample, maxSamples = 5): void {
  if (!track.cropSamples) {
    track.cropSamples = [];
  }
  // Check if sample is significantly higher quality than existing samples
  const existingIdx = track.cropSamples.findIndex(s => s.dataUrl === sample.dataUrl);
  if (existingIdx >= 0) {
    track.cropSamples[existingIdx] = sample;
  } else {
    track.cropSamples.push(sample);
  }
  // Sort descending by quality score so best quality crop is at index 0
  track.cropSamples.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
  if (track.cropSamples.length > maxSamples) {
    track.cropSamples = track.cropSamples.slice(0, maxSamples);
  }
}

export function calculateIoU(boxA: BoundingBox, boxB: BoundingBox): number {
  const xA = Math.max(boxA.x, boxB.x);
  const yA = Math.max(boxA.y, boxB.y);
  const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const interWidth = Math.max(0, xB - xA);
  const interHeight = Math.max(0, yB - yA);
  const interArea = interWidth * interHeight;

  if (interArea === 0) return 0;

  const boxAArea = boxA.width * boxA.height;
  const boxBArea = boxB.width * boxB.height;

  return interArea / (boxAArea + boxBArea - interArea);
}

export function calculateCentroidDistance(boxA: BoundingBox, boxB: BoundingBox): number {
  const cxA = boxA.x + boxA.width / 2;
  const cyA = boxA.y + boxA.height / 2;
  const cxB = boxB.x + boxB.width / 2;
  const cyB = boxB.y + boxB.height / 2;
  return Math.sqrt(Math.pow(cxA - cxB, 2) + Math.pow(cyA - cyB, 2));
}

/**
 * ByteTrack-inspired Multi-Object Tracker for Real-Time License Plate Tracking.
 * 
 * Key Features:
 * - High-confidence & low-confidence two-stage association.
 * - Velocity prediction (dx, dy) for moving vehicles & moving cameras.
 * - Max active tracks pool (default 8).
 * - Independent track memory buffer & state machine.
 */
export class PlateTracker {
  private activeTracks: Map<string, ActiveTrack> = new Map();
  private recentlyExpiredTracks: Map<string, ActiveTrack> = new Map();
  private trackCounter: number = 1;
  private frameIndex: number = 0;
  private iouThreshold: number = 0.30;
  private lostTrackTimeout: number = 12; // Frames before a confirmed track is pruned (~600-800ms)
  private lostTrackTimeoutMs: number = 750; // Time-based expiration in milliseconds (invariant to FPS drops)
  private completedTrackLostTimeoutMs: number = 450;
  private unconfirmedTrackTimeoutMs: number = 450;
  private maxPredictionFrames: number = 2;
  private maxActiveTracks: number = 8;
  private minConfirmationFrames: number = 1;

  private isScaleCompatible(reference: BoundingBox, candidate: BoundingBox): boolean {
    const widthRatio = candidate.width / Math.max(1, reference.width);
    const heightRatio = candidate.height / Math.max(1, reference.height);
    const referenceAspect = reference.width / Math.max(1, reference.height);
    const candidateAspect = candidate.width / Math.max(1, candidate.height);
    const aspectSimilarity = candidateAspect / Math.max(0.1, referenceAspect);

    // Aspect ratio (width-to-height proportion) remains stable as a car approaches or recedes.
    const aspectMatches = aspectSimilarity >= 0.45 && aspectSimilarity <= 2.20;

    // As a vehicle approaches or recedes, physical bounding box scale changes rapidly (0.30x to 3.50x).
    // Do not reject association merely because the plate became substantially larger as the vehicle approached.
    const scaleMatches =
      widthRatio >= 0.30 &&
      widthRatio <= 3.50 &&
      heightRatio >= 0.30 &&
      heightRatio <= 3.50;

    return aspectMatches && scaleMatches;
  }

  private getAssociationDistanceLimit(track: ActiveTrack, targetBox: BoundingBox, confidence: number): number {
    const baseSize = Math.max(targetBox.width, targetBox.height, track.bbox.width, track.bbox.height, 1);
    const framesMissing = Math.max(0, this.frameIndex - track.lastSeenFrame - 1);
    const velocityBoost = Math.min(baseSize * 0.60, Math.hypot(track.vx, track.vy) * Math.max(1, framesMissing + 1));
    const missedFrameBoost = Math.min(baseSize * 0.25, framesMissing * baseSize * 0.12);
    const confidenceBoost = confidence >= 0.70 ? baseSize * 0.15 : 0;

    return baseSize * 1.10 + velocityBoost + missedFrameBoost + confidenceBoost;
  }

  private shouldPredictTrack(track: ActiveTrack): boolean {
    const dt = this.frameIndex - track.lastSeenFrame;
    if (dt <= 0) return true;
    if (track.cooldownActive) return false;
    return dt <= this.maxPredictionFrames;
  }

  private getAdaptiveSmoothAlpha(
    motionScore: number,
    _associationIoU: number,
    detectorConfidence: number,
    baseAlpha: number
  ): number {
    // Keep enough inertia to suppress detector jitter while still following a
    // moving vehicle within one or two frames. Values close to 1 effectively
    // render the raw detector box and caused the visible hovering/ghosting.
    if (motionScore >= 0.16) return 0.78;
    if (motionScore >= 0.07) return 0.68;
    if (detectorConfidence >= 0.78) return 0.58;
    return Math.max(baseAlpha, 0.48);
  }

  private shouldSkipAssociationAfterGap(track: ActiveTrack): boolean {
    const frameGap = this.frameIndex - track.lastSeenFrame;

    if (track.cooldownActive) return true;
    if (track.stabilizedPlate && frameGap > 1) return true;
    if (track.votes.size > 0 && frameGap > Math.max(4, Math.floor(this.lostTrackTimeout * 0.35))) return true;

    return false;
  }

  private getOcrStabilityScore(track: ActiveTrack): number {
    let totalVotes = 0;
    let topVotes = 0;

    track.votes.forEach((vote) => {
      totalVotes += vote.count;
      topVotes = Math.max(topVotes, vote.count);
    });

    if (totalVotes === 0) return 0.55;
    return topVotes / totalVotes;
  }

  private calculateTrackConfidence(
    track: ActiveTrack,
    detectorConfidence: number,
    associationIoU: number
  ): number {
    const components: TrackConfidenceComponents = {
      detection: detectorConfidence,
      age: Math.min(1, track.framesSeen / 4),
      motion: 1 - Math.min(1, (track.motionScore ?? 0) / 0.50),
      iou: associationIoU > 0 ? Math.min(1, associationIoU / 0.50) : 0.55,
      ocr: this.getOcrStabilityScore(track),
    };

    const confidence =
      components.detection * 0.38 +
      components.age * 0.18 +
      components.motion * 0.16 +
      components.iou * 0.16 +
      components.ocr * 0.12;

    track.confidenceComponents = components;
    return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
  }

  private calculateInitialTrackConfidence(detectorConfidence: number): number {
    const components: TrackConfidenceComponents = {
      detection: detectorConfidence,
      age: 0.25,
      motion: 1.0,
      iou: 0.55,
      ocr: 0.55,
    };

    const confidence =
      components.detection * 0.38 +
      components.age * 0.18 +
      components.motion * 0.16 +
      components.iou * 0.16 +
      components.ocr * 0.12;

    return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
  }

  private createInitialConfidenceComponents(detectorConfidence: number): TrackConfidenceComponents {
    return {
      detection: detectorConfidence,
      age: 0.25,
      motion: 1,
      iou: 0.55,
      ocr: 0.55,
    };
  }

  private markMatchedTrack(
    track: ActiveTrack,
    matchedBox: BoundingBox,
    velocityAlpha: number,
    smoothAlpha: number,
    associationIoU: number
  ): void {
    const now = this.currentFrameCapturedAt;
    const prevSeen = track.lastRealDetectionTimestamp || track.lastSeenTimestamp || now;
    const deltaMs = Math.max(16, now - prevSeen);
    const timeScale = Math.min(2.5, Math.max(0.2, 33.33 / deltaMs));

    const dx = matchedBox.x - track.bbox.x;
    const dy = matchedBox.y - track.bbox.y;
    const motionDenominator = Math.max(1, matchedBox.width, matchedBox.height);

    track.vx = track.vx * (1 - velocityAlpha) + (dx * timeScale) * velocityAlpha;
    track.vy = track.vy * (1 - velocityAlpha) + (dy * timeScale) * velocityAlpha;
    const motionScore = Math.min(2, Math.hypot(dx, dy) / motionDenominator);
    track.motionScore = motionScore;

    track.bbox = matchedBox;
    track.lastRealDetectionTimestamp = now;
    track.overlayAgeMs = 0;

    // Maintain scale change and total displacement context
    const currentArea = matchedBox.width * matchedBox.height;
    if (!track.initialBbox) {
      track.initialBbox = { ...matchedBox };
      track.maxBboxArea = currentArea;
      track.minBboxArea = currentArea;
      track.totalDisplacement = 0;
      track.scaleEvolutionRatio = 1.0;
    } else {
      track.maxBboxArea = Math.max(track.maxBboxArea ?? currentArea, currentArea);
      track.minBboxArea = Math.min(track.minBboxArea ?? currentArea, currentArea);
      track.scaleEvolutionRatio = (track.maxBboxArea || 1) / Math.max(1, track.minBboxArea || 1);
      const initialCentroidX = track.initialBbox.x + track.initialBbox.width / 2;
      const initialCentroidY = track.initialBbox.y + track.initialBbox.height / 2;
      const currentCentroidX = matchedBox.x + matchedBox.width / 2;
      const currentCentroidY = matchedBox.y + matchedBox.height / 2;
      track.totalDisplacement = Math.hypot(currentCentroidX - initialCentroidX, currentCentroidY - initialCentroidY);
    }

    // EMA smoothing is only for UI display, so raw crops still use the detector bbox.
    const adaptiveSmoothAlpha = this.getAdaptiveSmoothAlpha(
      motionScore,
      associationIoU,
      matchedBox.confidence,
      smoothAlpha
    );
    track.smoothBbox = {
      x: track.smoothBbox.x * (1 - adaptiveSmoothAlpha) + matchedBox.x * adaptiveSmoothAlpha,
      y: track.smoothBbox.y * (1 - adaptiveSmoothAlpha) + matchedBox.y * adaptiveSmoothAlpha,
      width: track.smoothBbox.width * (1 - adaptiveSmoothAlpha) + matchedBox.width * adaptiveSmoothAlpha,
      height: track.smoothBbox.height * (1 - adaptiveSmoothAlpha) + matchedBox.height * adaptiveSmoothAlpha,
      confidence: matchedBox.confidence,
    };

    track.lastSeenFrame = this.frameIndex;
    track.lastSeenTimestamp = now;
    track.lastSeenFrameCapturedAt = now;
    track.lastSeenMediaTimeSeconds = this.currentFrameMediaTimeSeconds;
    track.framesSeen++;
    track.visibleThisFrame = true;
    track.missedFrames = 0;
    track.trackState = 'VISIBLE';
    if (track.pipelineState === 'DETECTED') track.pipelineState = 'TRACKING';
    track.trackConfidence = this.calculateTrackConfidence(track, matchedBox.confidence, associationIoU);
    if (track.stats) {
      track.stats.framesVisible++;
      track.stats.lastUpdatedAt = now;
    }
    if (track.framesSeen >= this.minConfirmationFrames || track.bbox.confidence >= 0.70) track.isConfirmed = true;
  }

  constructor(lostTrackTimeout?: number, maxActiveTracks?: number, minConfirmationFrames?: number) {
    if (lostTrackTimeout !== undefined) {
      this.lostTrackTimeout = lostTrackTimeout;
      this.lostTrackTimeoutMs = lostTrackTimeout * 100;
      this.completedTrackLostTimeoutMs = Math.min(800, this.lostTrackTimeoutMs);
    }
    if (maxActiveTracks !== undefined) this.maxActiveTracks = maxActiveTracks;
    if (minConfirmationFrames !== undefined) this.minConfirmationFrames = minConfirmationFrames;
  }

  private currentFrameCapturedAt = Date.now();
  private currentFrameMediaTimeSeconds?: number;

  public updateTracks(
    detectedBoxes: BoundingBox[],
    frame: { capturedAt?: number; mediaTimeSeconds?: number } = {}
  ): ActiveTrack[] {
    this.currentFrameCapturedAt = Number.isFinite(frame.capturedAt) ? frame.capturedAt! : Date.now();
    this.currentFrameMediaTimeSeconds = Number.isFinite(frame.mediaTimeSeconds)
      ? frame.mediaTimeSeconds
      : undefined;
    this.frameIndex++;

    this.activeTracks.forEach((track) => {
      track.visibleThisFrame = false;
      track.missedFrames = Math.max(0, this.frameIndex - track.lastSeenFrame);
      track.trackState = 'LOST';
    });

    // 1. Separate detections into High Confidence and Low Confidence
    const highConfDets: { box: BoundingBox; idx: number }[] = [];
    const lowConfDets: { box: BoundingBox; idx: number }[] = [];

    detectedBoxes.forEach((box, idx) => {
      // The detector threshold is intentionally configurable. Do not impose a
      // hidden 0.40 floor here or valid distant detections can never start a
      // track. These lower-confidence tracks still need two frames to confirm.
      if (box.confidence >= 0.28) {
        highConfDets.push({ box, idx });
      } else {
        lowConfDets.push({ box, idx });
      }
    });

    const unassignedHigh = new Set<number>(highConfDets.map(d => d.idx));
    const unassignedLow = new Set<number>(lowConfDets.map(d => d.idx));

    // A completed plate that is still visible must not create a fresh OCR
    // track every frame. Require both consecutive geometry and matching image
    // evidence; a different car in the same location must remain eligible.
    this.activeTracks.forEach(track => {
      if (!track.cooldownActive || this.frameIndex - track.lastSeenFrame !== 1) return;
      const match = detectedBoxes.map((box, idx) => ({ box, idx, iou: calculateIoU(track.bbox, box) }))
        .filter(({ box, idx, iou }) => (unassignedHigh.has(idx) || unassignedLow.has(idx)) &&
          iou >= 0.30 && this.isScaleCompatible(track.bbox, box) &&
          isSamePlateAppearance(track.bbox.appearance, box.appearance))
        .sort((a, b) => b.iou - a.iou)[0];
      if (!match) return;
      this.markMatchedTrack(track, match.box, 0.62, 0.45, match.iou);
      unassignedHigh.delete(match.idx); unassignedLow.delete(match.idx);
    });

    // 2. Predict next position for active tracks using velocity (Kalman/Constant Velocity model)
    this.activeTracks.forEach((track) => {
      const dt = this.frameIndex - track.lastSeenFrame;
      if (this.shouldPredictTrack(track)) {
        track.predictedBbox = {
          x: track.bbox.x + track.vx * Math.min(dt, this.maxPredictionFrames),
          y: track.bbox.y + track.vy * Math.min(dt, this.maxPredictionFrames),
          width: track.bbox.width,
          height: track.bbox.height,
          confidence: track.bbox.confidence,
        };
      } else {
        track.predictedBbox = undefined;
      }
    });

    // 3. First Stage Association: Match Active Tracks with High Confidence Detections
    this.activeTracks.forEach((track) => {
      if (track.cooldownActive) return;
      if (this.shouldSkipAssociationAfterGap(track)) return;

      const hasPlateEvidence = (track.votes && track.votes.size > 0) || Boolean(track.stabilizedPlate);
      let bestMatchScore = 0;
      let bestIdx = -1;
      let bestIoU = 0;

      highConfDets.forEach(({ box, idx }) => {
        if (!unassignedHigh.has(idx)) return;
        const targetBox = track.predictedBbox || track.bbox;
        const iouPredicted = track.predictedBbox ? calculateIoU(track.predictedBbox, box) : 0;
        const iouCurrent = calculateIoU(track.bbox, box);
        const maxIoU = Math.max(iouPredicted, iouCurrent);
        // After a gap, another car can occupy the old coordinates during a
        // pan. Preserve the original saved evidence instead of mixing plates.
        if (hasPlateEvidence && this.frameIndex - track.lastSeenFrame > 1 &&
            track.bbox.appearance && box.appearance &&
            !isSamePlateAppearance(track.bbox.appearance, box.appearance)) return;

        // Crucial: A track with plate evidence MUST have physical spatial overlap.
        // It must NEVER be hijacked by an unrelated detection across empty space!
        if (hasPlateEvidence && maxIoU < 0.08) return;
        if (!this.shouldPredictTrack(track) && maxIoU <= this.iouThreshold) return;
        if (!this.isScaleCompatible(targetBox, box)) return;

        const dist = calculateCentroidDistance(targetBox, box);
        const maxDist = this.getAssociationDistanceLimit(track, targetBox, box.confidence);

        let score = 0;
        if (maxIoU > this.iouThreshold) {
          score = 1.0 + maxIoU; // prioritize IoU
        } else if (maxIoU >= 0.08) {
          score = 0.6 + maxIoU; // partial overlap with prediction/current
        } else if (!hasPlateEvidence && dist <= maxDist) {
          score = (1.0 - (dist / Math.max(1, maxDist))) * 0.5; // fallback to distance only for unverified tracks
        }

        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestIdx = idx;
          bestIoU = maxIoU;
        }
      });

      if (bestIdx !== -1) {
        const matchedBox = detectedBoxes[bestIdx];
        this.markMatchedTrack(track, matchedBox, 0.62, 0.45, bestIoU);
        unassignedHigh.delete(bestIdx);
      }
    });

    // 4. Second Stage Association: Match Unassigned Tracks with Low Confidence Detections
    this.activeTracks.forEach((track) => {
      if (track.lastSeenFrame === this.frameIndex) return; // Already updated in Stage 1
      if (track.cooldownActive) return;
      if (this.shouldSkipAssociationAfterGap(track)) return;

      const hasPlateEvidence = (track.votes && track.votes.size > 0) || Boolean(track.stabilizedPlate);
      let bestMatchScore = 0;
      let bestIdx = -1;
      let bestIoU = 0;

      lowConfDets.forEach(({ box, idx }) => {
        if (!unassignedLow.has(idx)) return;
        const targetBox = track.predictedBbox || track.bbox;
        const iouPredicted = track.predictedBbox ? calculateIoU(track.predictedBbox, box) : 0;
        const iouCurrent = calculateIoU(track.bbox, box);
        const maxIoU = Math.max(iouPredicted, iouCurrent);
        // After a gap, another car can occupy the old coordinates during a
        // pan. Preserve the original saved evidence instead of mixing plates.
        if (hasPlateEvidence && this.frameIndex - track.lastSeenFrame > 1 &&
            track.bbox.appearance && box.appearance &&
            !isSamePlateAppearance(track.bbox.appearance, box.appearance)) return;

        if (hasPlateEvidence && maxIoU < 0.10) return;
        if (!this.shouldPredictTrack(track) && maxIoU <= this.iouThreshold) return;
        if (!this.isScaleCompatible(targetBox, box)) return;

        const dist = calculateCentroidDistance(targetBox, box);
        const maxDist = this.getAssociationDistanceLimit(track, targetBox, box.confidence) * 0.80;

        let score = 0;
        if (maxIoU > this.iouThreshold * 0.8) {
          score = 1.0 + maxIoU;
        } else if (maxIoU >= 0.08) {
          score = 0.5 + maxIoU;
        } else if (!hasPlateEvidence && dist <= maxDist) {
          score = (1.0 - (dist / Math.max(1, maxDist))) * 0.4;
        }

        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestIdx = idx;
          bestIoU = maxIoU;
        }
      });

      if (bestIdx !== -1) {
        const matchedBox = detectedBoxes[bestIdx];
        this.markMatchedTrack(track, matchedBox, 0.48, 0.36, bestIoU);
        unassignedLow.delete(bestIdx);
      }
    });

    // 5. Create New Tracks for Unassigned High Confidence Detections (with corridor re-association)
    unassignedHigh.forEach((idx) => {
      const box = detectedBoxes[idx];
      if (box.width < 24 || box.height < 7) return;

      // Before creating a new track: check whether an existing unassigned track represents the same physical plate.
      // Approaching vehicles expand rapidly and can move along a trajectory corridor.
      let bestCorridorTrack: ActiveTrack | null = null;
      let bestCorridorIoU = 0;
      let minCorridorDist = Infinity;

      for (const track of this.activeTracks.values()) {
        if (track.lastSeenFrame === this.frameIndex) continue; // Already updated this frame
        if (track.cooldownActive || track.stabilizedPlate || this.shouldSkipAssociationAfterGap(track)) continue;
        if (track.votes.size && this.frameIndex - track.lastSeenFrame > 1) continue;

        const targetBox = track.predictedBbox || track.bbox;
        const iouPred = track.predictedBbox ? calculateIoU(track.predictedBbox, box) : 0;
        const iouCurr = calculateIoU(track.bbox, box);
        const maxIoU = Math.max(iouPred, iouCurr);
        const dist = calculateCentroidDistance(targetBox, box);
        const maxDist = this.getAssociationDistanceLimit(track, targetBox, box.confidence);

        if (track.votes.size > 0 && maxIoU < 0.08) continue;
        if ((maxIoU >= 0.08 || dist <= maxDist) && this.isScaleCompatible(track.bbox, box)) {
          if (dist < minCorridorDist) {
            minCorridorDist = dist;
            bestCorridorTrack = track;
            bestCorridorIoU = maxIoU;
          }
        }
      }

      if (bestCorridorTrack) {
        // Associate with the existing track instead of spawning a duplicate
        this.markMatchedTrack(bestCorridorTrack, box, 0.62, 0.45, bestCorridorIoU);
        return;
      }

      // Do not let finished/lost work occupy every slot while a new vehicle
      // enters the frame. In-flight OCR tracks remain protected, but stale or
      // completed tracks are evicted before rejecting a new detection.
      if (this.activeTracks.size >= this.maxActiveTracks) {
        const evictable = Array.from(this.activeTracks.entries())
          .filter(([, track]) => !track.ocrRunning && !track.ocrJobQueued)
          .sort(([, left], [, right]) => {
            const evictionScore = (track: ActiveTrack) => {
              if (track.cooldownActive || track.ocrState === 'MATCHED' || track.ocrState === 'COOLDOWN') return 0;
              if (track.trackState !== 'VISIBLE' && !track.ocrEvidencePending) return 1;
              if (track.votes.size === 0) return 2;
              return track.trackState !== 'VISIBLE' ? 3 : 4;
            };
            const leftStateScore = evictionScore(left);
            const rightStateScore = evictionScore(right);
            if (leftStateScore !== rightStateScore) return leftStateScore - rightStateScore;
            return left.lastSeenTimestamp - right.lastSeenTimestamp;
          })[0];
        if (evictable) this.activeTracks.delete(evictable[0]);
      }
      if (this.activeTracks.size >= this.maxActiveTracks) return;

      const num = this.trackCounter++;
      const now = this.currentFrameCapturedAt;

      // Check recently expired tracks for spatial reassociation (track fragmentation recovery)
      let inheritedObservationId: string | null = null;
      let matchedExpiredTrack: ActiveTrack | null = null;

      for (const expired of this.recentlyExpiredTracks.values()) {
        if (expired.cooldownActive || expired.stabilizedPlate) continue;
        const timeSinceLost = now - expired.lastSeenTimestamp;
        if (timeSinceLost <= 3500) {
          const dt = (now - expired.lastSeenTimestamp) / 1000.0;
          const predX = expired.bbox.x + expired.vx * dt * 30.0;
          const predY = expired.bbox.y + expired.vy * dt * 30.0;
          const predBox: BoundingBox = { ...expired.bbox, x: predX, y: predY };
          const dist = calculateCentroidDistance(predBox, box);
          const maxAllowedDist = Math.max(box.width, box.height) * 2.2;

          if (dist <= maxAllowedDist && this.isScaleCompatible(expired.bbox, box)) {
            inheritedObservationId = expired.observationId ?? null;
            matchedExpiredTrack = expired;
            break;
          }
        }
      }

      const initialArea = box.width * box.height;
      const newTrack: ActiveTrack = {
        trackId: `TRK-${num}`,
        observationId: inheritedObservationId || `obs-TRK-${num}`,
        firstDetectedMonotonicMs: typeof performance !== 'undefined' ? performance.now() : now,
        trackNumber: num,
        bbox: { ...box },
        smoothBbox: { ...box },
        initialBbox: { ...box },
        maxBboxArea: initialArea,
        minBboxArea: initialArea,
        totalDisplacement: 0,
        scaleEvolutionRatio: 1.0,
        vx: matchedExpiredTrack ? matchedExpiredTrack.vx : 0,
        vy: matchedExpiredTrack ? matchedExpiredTrack.vy : 0,
        cropSamples: [],
        lastSeenFrame: this.frameIndex,
        firstSeenFrame: this.frameIndex,
        lastSeenTimestamp: now,
        firstSeenTimestamp: now,
        lastRealDetectionTimestamp: now,
        overlayAgeMs: 0,
        lastSeenFrameCapturedAt: now,
        firstSeenFrameCapturedAt: now,
        firstSeenMediaTimeSeconds: this.currentFrameMediaTimeSeconds,
        lastSeenMediaTimeSeconds: this.currentFrameMediaTimeSeconds,
        framesSeen: 1,
        visibleThisFrame: true,
        missedFrames: 0,
        motionScore: 0,
        trackConfidence: this.calculateInitialTrackConfidence(box.confidence),
        confidenceComponents: this.createInitialConfidenceComponents(box.confidence),
        trackState: 'VISIBLE',
        pipelineState: 'DETECTED',
        telemetry: {
          trackId: `TRK-${num}`,
          detectedAt: now,
        },
        stats: {
          startedAt: now,
          lastUpdatedAt: now,
          framesVisible: 1,
          framesLost: 0,
          ocrAttempts: 0,
          ocrAccepted: 0,
          consensusAttempts: 0,
        },
        ocrState: 'DETECTED',
        ocrRunning: false,
        ocrJobQueued: false,
        ocrEvidencePending: false,
        votes: new Map(),
        cooldownActive: false,
        isConfirmed: box.confidence >= 0.55,
        candidateState: 'PLATE_CANDIDATE',
      };

      // Inherit votes and consensus if reassociated to an existing observationId
      if (matchedExpiredTrack) {
        if (matchedExpiredTrack.votes) {
          matchedExpiredTrack.votes.forEach((vData, vText) => {
            newTrack.votes.set(vText, { ...vData });
          });
        }
        if (matchedExpiredTrack.stabilizedPlate) {
          newTrack.stabilizedPlate = matchedExpiredTrack.stabilizedPlate;
          newTrack.stabilizedConfidence = matchedExpiredTrack.stabilizedConfidence;
          newTrack.isConfirmed = true;
        }
      }

      this.activeTracks.set(newTrack.trackId, newTrack);
    });

    // 6. Remove Stale Tracks & Buffer in Recently Expired Map
    const now = this.currentFrameCapturedAt;
    this.activeTracks.forEach((track, id) => {
      const timeLostMs = now - (track.lastSeenTimestamp || 0);
      const isPersistentFalsePositive =
        track.framesSeen >= 5 &&
        (!track.votes || track.votes.size === 0) &&
        !track.stabilizedPlate &&
        (track.bbox.confidence < 0.65 || (track.stats?.ocrAttempts ?? 0) >= 2);

      const effectiveTimeoutMs = isPersistentFalsePositive
        ? 150
        : track.isConfirmed
        ? track.cooldownActive
          ? this.completedTrackLostTimeoutMs
          : this.lostTrackTimeoutMs
        : this.unconfirmedTrackTimeoutMs;

      const pendingRead =
        ((track.ocrRunning || track.ocrJobQueued) && timeLostMs <= 5000) ||
        (track.ocrEvidencePending === true && !track.cooldownActive && timeLostMs <= 5000);
      if (!pendingRead && (timeLostMs > effectiveTimeoutMs || (isPersistentFalsePositive && !track.visibleThisFrame))) {
        track.trackState = 'REMOVED';
        track.pipelineState = track.cooldownActive ? 'FINISHED' : track.pipelineState;
        if (track.stats) {
          track.stats.finishedAt = now;
          track.stats.finalConfidence = track.stabilizedConfidence ?? track.trackConfidence;
          track.stats.lastUpdatedAt = now;
        }
        if (track.telemetry && !track.telemetry.committedAt && !track.telemetry.dropReason) {
          track.telemetry.dropReason = isPersistentFalsePositive
            ? 'PERSISTENT_UNREADABLE'
            : track.votes && track.votes.size > 0
            ? 'INSUFFICIENT_VOTES'
            : 'STALE_EXPIRED';
          console.debug(`[Telemetry] Track ${track.trackId} dropped:`, track.telemetry);
        }
        if (
          track.candidateState === 'PLATE_CANDIDATE' &&
          !track.isConfirmed &&
          !track.ocrEvidencePending &&
          !track.ocrRunning &&
          !track.ocrJobQueued
        ) {
          track.candidateState = 'UNRESOLVED_EXPIRED';
        }
        this.recentlyExpiredTracks.set(track.trackId, track);
        this.activeTracks.delete(id);
      } else if (!track.visibleThisFrame) {
        track.missedFrames = Math.max(1, this.frameIndex - track.lastSeenFrame);
        track.trackState = 'LOST';
        const overlayAgeMs = now - (track.lastRealDetectionTimestamp || track.lastSeenTimestamp || now);
        track.overlayAgeMs = overlayAgeMs;
        if (this.shouldPredictTrack(track) && overlayAgeMs <= 220) {
          const dt = Math.min(track.missedFrames, this.maxPredictionFrames);
          track.predictedBbox = {
            x: track.bbox.x + track.vx * dt,
            y: track.bbox.y + track.vy * dt,
            width: track.bbox.width,
            height: track.bbox.height,
            confidence: track.bbox.confidence,
          };
          track.smoothBbox = {
            x: track.smoothBbox.x + track.vx * dt,
            y: track.smoothBbox.y + track.vy * dt,
            width: track.smoothBbox.width,
            height: track.smoothBbox.height,
            confidence: track.smoothBbox.confidence,
          };
        } else {
          track.predictedBbox = undefined;
        }
        track.trackConfidence = Math.round(Math.max(0, (track.trackConfidence ?? 0) * 0.65) * 100) / 100;
        if (track.stats) {
          track.stats.framesLost++;
          track.stats.lastUpdatedAt = now;
        }
      }
    });

    // 7. Reconcile Duplicate Tracks (Merge overlapping tracks for same physical plate)
    this.reconcileDuplicateTracks();

    // Prune expired tracks older than 4,000ms & clean memory references
    this.recentlyExpiredTracks.forEach((expired, expId) => {
      if (now - expired.lastSeenTimestamp > 4000) {
        expired.cropSamples = [];
        expired.votes.clear();
        this.recentlyExpiredTracks.delete(expId);
      }
    });

    return Array.from(this.activeTracks.values());
  }

  private reconcileDuplicateTracks(): void {
    const tracks = Array.from(this.activeTracks.values());
    if (tracks.length < 2) return;

    for (let i = 0; i < tracks.length; i++) {
      const trackA = tracks[i];
      if (trackA.trackState === 'REMOVED' || !this.activeTracks.has(trackA.trackId)) continue;

      for (let j = i + 1; j < tracks.length; j++) {
        const trackB = tracks[j];
        if (trackB.trackState === 'REMOVED' || !this.activeTracks.has(trackB.trackId)) continue;
        if (trackA.cooldownActive || trackB.cooldownActive) continue;

        const iou = calculateIoU(trackA.bbox, trackB.bbox);
        const dist = calculateCentroidDistance(trackA.bbox, trackB.bbox);
        const maxDimension = Math.max(trackA.bbox.width, trackA.bbox.height, trackB.bbox.width, trackB.bbox.height, 1);

        const shareObservation = Boolean(trackA.observationId && trackB.observationId && trackA.observationId === trackB.observationId);
        const shareSamePlate = Boolean(
          trackA.stabilizedPlate && trackB.stabilizedPlate &&
          (trackA.stabilizedPlate === trackB.stabilizedPlate ||
           arePlatesSameVehicleFamily(trackA.stabilizedPlate, trackB.stabilizedPlate))
        );

        // If either track already locked in a stabilized plate, only merge if they share the same plate family
        if ((trackA.stabilizedPlate || trackB.stabilizedPlate) && !shareSamePlate) {
          continue;
        }

        if (trackA.votes.size && trackB.votes.size &&
            ![...trackA.votes.keys()].some(a => [...trackB.votes.keys()].some(b => arePlatesSameVehicleFamily(a, b)))) continue;

        if ((trackA.votes.size || trackB.votes.size) &&
            trackA.bbox.appearance && trackB.bbox.appearance &&
            !isSamePlateAppearance(trackA.bbox.appearance, trackB.bbox.appearance)) continue;

        const stronglyOverlapping = iou >= 0.30 || (iou >= 0.12 && shareSamePlate) || (shareObservation && dist <= maxDimension * 0.75);

        if (stronglyOverlapping || (shareSamePlate && iou >= 0.08)) {
          // Select canonical track based on visibility, evidence, and frames seen
          const scoreA =
            (trackA.visibleThisFrame ? 50 : 0) +
            (trackA.stabilizedPlate ? 30 : 0) +
            (trackA.votes ? trackA.votes.size * 5 : 0) +
            (trackA.framesSeen || 1) * 2 +
            (trackA.bbox.confidence ?? 0) * 10;

          const scoreB =
            (trackB.visibleThisFrame ? 50 : 0) +
            (trackB.stabilizedPlate ? 30 : 0) +
            (trackB.votes ? trackB.votes.size * 5 : 0) +
            (trackB.framesSeen || 1) * 2 +
            (trackB.bbox.confidence ?? 0) * 10;

          const canonical = scoreA >= scoreB ? trackA : trackB;
          const duplicate = scoreA >= scoreB ? trackB : trackA;

          // Preserve source identities across a geometric duplicate merge.
          // Aggregate addition alone loses alternative readings and can count
          // the same captured frame twice.
          if (duplicate.ocrFrameObservations?.size) {
            for (const [capturedAt, observation] of duplicate.ocrFrameObservations) {
              addOcrVoteToTrack(canonical, observation.plate, observation.confidence, 1, capturedAt);
            }
          } else {
            duplicate.votes.forEach((value, plate) => {
              const existing = canonical.votes.get(plate) ?? { count: 0, totalConfidence: 0 };
              canonical.votes.set(plate, { count: existing.count + value.count, totalConfidence: existing.totalConfidence + value.totalConfidence });
            });
          }
          for (const [capturedAt, candidates] of duplicate.ocrFrameCandidates ?? []) {
            for (const [plate, confidence] of candidates) addOcrCandidateEvidence(canonical, plate, confidence, capturedAt);
          }

          // Transfer crop samples
          if (duplicate.cropSamples && duplicate.cropSamples.length > 0) {
            duplicate.cropSamples.forEach((sample) => {
              addQualityCropSample(canonical, sample);
            });
          }

          // Adopt fuller stabilized/committed plate if available
          if (duplicate.stabilizedPlate && (!canonical.stabilizedPlate || duplicate.stabilizedPlate.length > canonical.stabilizedPlate.length)) {
            canonical.stabilizedPlate = duplicate.stabilizedPlate;
            canonical.stabilizedConfidence = duplicate.stabilizedConfidence;
          }
          if (duplicate.committedPlate && (!canonical.committedPlate || duplicate.committedPlate.length > canonical.committedPlate.length)) {
            canonical.committedPlate = duplicate.committedPlate;
            canonical.labelShown = duplicate.labelShown;
            canonical.labelLocked = duplicate.labelLocked;
          }
          if (duplicate.firstOcrStartedAt && !canonical.firstOcrStartedAt) {
            canonical.firstOcrStartedAt = duplicate.firstOcrStartedAt;
          }
          if (duplicate.ocrEvidencePending) {
            canonical.ocrEvidencePending = true;
          }

          // If canonical was not visible on current frame but duplicate was, adopt position
          if (!canonical.visibleThisFrame && duplicate.visibleThisFrame) {
            canonical.bbox = duplicate.bbox;
            canonical.smoothBbox = duplicate.smoothBbox;
            canonical.visibleThisFrame = true;
            canonical.missedFrames = 0;
            canonical.lastSeenFrame = duplicate.lastSeenFrame;
            canonical.lastSeenTimestamp = duplicate.lastSeenTimestamp;
          }

          duplicate.trackState = 'REMOVED';
          this.activeTracks.delete(duplicate.trackId);
          this.recentlyExpiredTracks.set(duplicate.trackId, duplicate);
        }
      }
    }
  }

  public getActiveTracks(confirmedOnly: boolean = false): ActiveTrack[] {
    const all = Array.from(this.activeTracks.values());
    if (confirmedOnly) return all.filter(t => t.isConfirmed);
    return all;
  }

  public getTracksEligibleForOcr(confirmedOnly: boolean = false): ActiveTrack[] {
    const active = Array.from(this.activeTracks.values());
    const recentlyExpiredPending = Array.from(this.recentlyExpiredTracks.values()).filter(
      t => !t.cooldownActive && (t.ocrEvidencePending === true || t.ocrRunning || t.ocrJobQueued)
    );
    const map = new Map<string, ActiveTrack>();
    active.forEach(t => map.set(t.trackId, t));
    recentlyExpiredPending.forEach(t => map.set(t.trackId, t));
    const combined = Array.from(map.values());
    if (confirmedOnly) return combined.filter(t => t.isConfirmed);
    return combined;
  }

  public getTrack(trackId: string): ActiveTrack | undefined {
    return this.activeTracks.get(trackId);
  }

  public getRecentlyExpiredTrack(trackId: string): ActiveTrack | undefined {
    return this.recentlyExpiredTracks.get(trackId);
  }

  public setLostTrackTimeout(frames: number): void {
    this.lostTrackTimeout = frames;
    this.lostTrackTimeoutMs = Math.min(1000, Math.max(300, frames * 60));
    this.completedTrackLostTimeoutMs = Math.min(350, this.lostTrackTimeoutMs);
  }

  public configureRuntime(options: TrackerRuntimeTuning): void {
    if (typeof options.maxPredictionFrames === 'number') {
      this.maxPredictionFrames = Math.max(0, Math.min(4, Math.round(options.maxPredictionFrames)));
    }
    if (typeof options.lostTrackTimeoutMs === 'number') {
      this.lostTrackTimeoutMs = Math.max(120, Math.min(1000, Math.round(options.lostTrackTimeoutMs)));
      this.lostTrackTimeout = Math.max(1, Math.round(this.lostTrackTimeoutMs / 60));
      this.completedTrackLostTimeoutMs = Math.min(450, this.lostTrackTimeoutMs);
    }
    if (typeof options.unconfirmedTrackTimeoutMs === 'number') {
      this.unconfirmedTrackTimeoutMs = Math.max(80, Math.min(600, Math.round(options.unconfirmedTrackTimeoutMs)));
    }
  }

  public setMaxActiveTracks(maxTracks: number): void {
    if (Number.isFinite(maxTracks) && maxTracks > 0) {
      this.maxActiveTracks = Math.max(1, Math.floor(maxTracks));
    }
  }

  public clear(): void {
    this.activeTracks.clear();
    this.frameIndex = 0;
    this.trackCounter = 1;
  }
}

/**
 * Determines whether a track's bounding box overlay should be rendered on the video preview.
 * Strictly separates visual detection presence (overlayAgeMs <= 200ms) from background OCR lifetime.
 */
export function isTrackDrawable(
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
    return (track.trackState === 'VISIBLE' || track.trackState === 'LOST') && frameAgeMs <= 2500;
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

