/** Reserve capacity before any asynchronous crop preparation or inference. */
export class OcrWorkPool {
  private readonly jobs = new Set<string>();

  get activeCount(): number {
    return this.jobs.size;
  }

  acquire(key: string, limit: number): (() => void) | null {
    if (this.jobs.has(key) || this.jobs.size >= Math.max(1, limit)) return null;
    this.jobs.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.jobs.delete(key);
    };
  }
}

/** A stalled/paused video frame cannot count as another independent observation. */
export class VideoFrameAdmission {
  private lastTime = -1;
  private lastDecodedFrame?: number;

  accept(mediaTime: number, decodedFrame?: number): boolean {
    if (!Number.isFinite(mediaTime)) return false;
    const hasFrameCounter = Number.isFinite(decodedFrame) && decodedFrame! > 0;
    const unchanged = hasFrameCounter ? decodedFrame === this.lastDecodedFrame : mediaTime === this.lastTime;
    if (unchanged && mediaTime >= this.lastTime) return false;
    this.lastTime = mediaTime;
    this.lastDecodedFrame = hasFrameCounter ? decodedFrame : undefined;
    return true;
  }
}

/** Exhausted tracks can resume on fresh evidence without restarting the source.
 * Frozen frames still have a bounded retry budget.
 */
export function canScheduleOcrEvidence(
  attempts: number, elapsedMs: number, newestCapturedAt: number,
  lastAttemptedCapturedAt: number | undefined, committed: boolean, hasUnreadCrop = false
): boolean {
  if (committed) return false;
  if (attempts < 3 && elapsedMs < 2500) return true;
  return hasUnreadCrop || (Number.isFinite(newestCapturedAt) && newestCapturedAt > (lastAttemptedCapturedAt ?? Infinity));
}

/** Playback end is not cancellation. Finish in-flight work even after the
 * admission deadline, but admit no additional jobs after that deadline. */
export function shouldContinueSampleDrain(
  activeJobs: number, finalFramePending: boolean, eligibleCrops: boolean,
  now: number, deadline: number
): boolean {
  return activeJobs > 0 || (now < deadline && (finalFramePending || eligibleCrops));
}

export function canDrainOcrCrop<T extends string | number>(attempts: number, cropKey: T, attempted?: ReadonlySet<T>): boolean {
  return attempts < 3 || !attempted?.has(cropKey);
}

export interface SchedulerTurnContext {
  slotId: string;
  slotIndex: number;
  totalSlots: number;
  isMultiCamera: boolean;
}

export interface SchedulerOptions {
  getSlotIds: () => string[];
  runTurn: (context: SchedulerTurnContext) => Promise<number | void>;
  onTick?: () => void;
}

/**
 * Fair round-robin cooperative scheduler for single and multi-camera ANPR scanning.
 * Ensures balanced access to shared ONNX inference pipelines without starvation or unbounded queueing.
 */
export class CameraDetectionScheduler {
  private running = false;
  private currentSlotIndex = 0;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private lastTurnDurationMs = 0;

  constructor(private readonly options: SchedulerOptions) {}

  public start(initialDelayMs = 0): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(initialDelayMs);
  }

  public stop(): void {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.inFlight = false;
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get lastDurationMs(): number {
    return this.lastTurnDurationMs;
  }

  public scheduleNext(delayMs: number): void {
    if (!this.running) return;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    this.timeoutId = setTimeout(() => void this.tick(), Math.max(0, delayMs));
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.timeoutId = null;

    const slotIds = this.options.getSlotIds();
    if (slotIds.length === 0) {
      this.scheduleNext(150);
      return;
    }

    if (this.currentSlotIndex >= slotIds.length) {
      this.currentSlotIndex = 0;
    }

    const slotIndex = this.currentSlotIndex;
    const slotId = slotIds[slotIndex];
    const totalSlots = slotIds.length;
    const isMultiCamera = totalSlots > 1;

    // Advance to next slot for fair round-robin
    this.currentSlotIndex = (this.currentSlotIndex + 1) % totalSlots;

    this.inFlight = true;
    const startedAt = performance.now();
    let customDelay: number | void = undefined;

    try {
      customDelay = await this.options.runTurn({
        slotId,
        slotIndex,
        totalSlots,
        isMultiCamera,
      });
    } catch (err) {
      console.warn(`[CameraScheduler] Turn failed for slot ${slotId}:`, err);
    } finally {
      this.inFlight = false;
      this.lastTurnDurationMs = performance.now() - startedAt;
    }

    if (!this.running) return;

    if (typeof customDelay === 'number') {
      this.scheduleNext(customDelay);
    } else if (isMultiCamera) {
      // In multi-camera mode, pace turns cooperatively based on actual inference latency
      const nextDelay = Math.max(4, Math.min(45, Math.round(this.lastTurnDurationMs * 0.15)));
      this.scheduleNext(nextDelay);
    } else {
      // Single-camera mode: immediate cooperative next frame
      this.scheduleNext(0);
    }
  }
}

