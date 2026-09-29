/**
 * PlateQ — Lifecycle-Safe Per-Camera Health Monitor & In-Place Component Recovery
 * ================================================================================
 * Provides lightweight, lifecycle-safe health monitoring for individual camera slots:
 * - Tracks camera video stream readiness and frame advancement.
 * - Monitors YOLO detector inference latency and consecutive failure counts.
 * - Monitors OCR queue depth and job completion rates.
 * - Distinguishes between normal operation, sample video pauses, empty scenes,
 *   slow-but-progressing inference, genuine component stalls, and camera disconnections.
 * - Executes bounded in-place component recovery with exponential backoff (max 3 retries)
 *   without reloading the browser or losing captured session evidence.
 */

export type ScannerOperationalState =
  | 'AKTIF'       // Camera stream & AI pipeline healthy
  | 'MEMULIHKAN'  // Component failure detected, in-place recovery in progress
  | 'TERGANGGU';  // Unrecoverable hardware/stream failure or retry limit reached

export type DetailedStallReason =
  | 'NONE'
  | 'SAMPLE_VIDEO_PAUSED'
  | 'EMPTY_SCENE'
  | 'SLOW_PROGRESS'
  | 'GENUINE_STALL_YOLO'
  | 'GENUINE_STALL_OCR'
  | 'CAMERA_DISCONNECTED'
  | 'RECOVERY_LIMIT_EXCEEDED';

export interface HealthSnapshot {
  slotId: string;
  state: ScannerOperationalState;
  detailedReason: DetailedStallReason;
  statusMessage: string;
  lastFrameTimeMs: number;
  lastYoloSuccessMs: number;
  lastOcrSuccessMs: number;
  yoloConsecutiveFailures: number;
  ocrConsecutiveFailures: number;
  ocrQueueDepth: number;
  avgYoloLatencyMs: number;
  avgOcrLatencyMs: number;
  recoveryAttempts: number;
  canManualRetry: boolean;
}

export interface HealthMonitorOptions {
  slotId: string;
  maxConsecutiveFailures?: number;
  maxRecoveryAttempts?: number;
  yoloWatchdogTimeoutMs?: number;
  ocrWatchdogTimeoutMs?: number;
  onStateChange?: (snapshot: HealthSnapshot) => void;
  onTriggerRecovery?: (component: 'YOLO' | 'OCR' | 'CAMERA', attempt: number) => Promise<boolean>;
}

export class CameraHealthMonitor {
  private slotId: string;
  private maxConsecutiveFailures: number;
  private maxRecoveryAttempts: number;
  private yoloWatchdogTimeoutMs: number;
  private ocrWatchdogTimeoutMs: number;
  private onStateChange?: (snapshot: HealthSnapshot) => void;
  private onTriggerRecovery?: (component: 'YOLO' | 'OCR' | 'CAMERA', attempt: number) => Promise<boolean>;

  private state: ScannerOperationalState = 'AKTIF';
  private detailedReason: DetailedStallReason = 'NONE';
  private statusMessage: string = 'Sistem Berfungsi';

  private lastFrameTimeMs: number = Date.now();
  private lastYoloSuccessMs: number = Date.now();
  private lastOcrSuccessMs: number = Date.now();

  private yoloConsecutiveFailures: number = 0;
  private ocrConsecutiveFailures: number = 0;
  private ocrQueueDepth: number = 0;

  private yoloLatencies: number[] = [];
  private ocrLatencies: number[] = [];

  private recoveryAttempts: number = 0;
  private isRecovering: boolean = false;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private isDisposed: boolean = false;

  constructor(options: HealthMonitorOptions) {
    this.slotId = options.slotId;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3;
    this.yoloWatchdogTimeoutMs = options.yoloWatchdogTimeoutMs ?? 8000;
    this.ocrWatchdogTimeoutMs = options.ocrWatchdogTimeoutMs ?? 10000;
    this.onStateChange = options.onStateChange;
    this.onTriggerRecovery = options.onTriggerRecovery;
  }

  public start(): void {
    if (this.timerId || this.isDisposed) return;
    this.lastFrameTimeMs = Date.now();
    this.lastYoloSuccessMs = Date.now();
    this.lastOcrSuccessMs = Date.now();
    this.timerId = setInterval(() => this.evaluateHealth(), 1000);
  }

  public stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  public dispose(): void {
    this.stop();
    this.isDisposed = true;
    this.onStateChange = undefined;
    this.onTriggerRecovery = undefined;
  }

  public recordFrameAdvance(): void {
    if (this.isDisposed) return;
    this.lastFrameTimeMs = Date.now();
  }

  public recordYoloSuccess(latencyMs: number): void {
    if (this.isDisposed) return;
    this.lastYoloSuccessMs = Date.now();
    this.yoloConsecutiveFailures = 0;
    this.yoloLatencies.push(latencyMs);
    if (this.yoloLatencies.length > 20) this.yoloLatencies.shift();
  }

  public recordYoloFailure(): void {
    if (this.isDisposed) return;
    this.yoloConsecutiveFailures++;
  }

  public recordOcrSuccess(latencyMs: number): void {
    if (this.isDisposed) return;
    this.lastOcrSuccessMs = Date.now();
    this.ocrConsecutiveFailures = 0;
    this.ocrLatencies.push(latencyMs);
    if (this.ocrLatencies.length > 20) this.ocrLatencies.shift();
  }

  public recordOcrFailure(): void {
    if (this.isDisposed) return;
    this.ocrConsecutiveFailures++;
  }

  public updateOcrQueueDepth(depth: number): void {
    if (this.isDisposed) return;
    this.ocrQueueDepth = depth;
  }

  public getSnapshot(): HealthSnapshot {
    const avgYoloMs = this.yoloLatencies.length
      ? this.yoloLatencies.reduce((a, b) => a + b, 0) / this.yoloLatencies.length
      : 0;
    const avgOcrMs = this.ocrLatencies.length
      ? this.ocrLatencies.reduce((a, b) => a + b, 0) / this.ocrLatencies.length
      : 0;

    return {
      slotId: this.slotId,
      state: this.state,
      detailedReason: this.detailedReason,
      statusMessage: this.statusMessage,
      lastFrameTimeMs: this.lastFrameTimeMs,
      lastYoloSuccessMs: this.lastYoloSuccessMs,
      lastOcrSuccessMs: this.lastOcrSuccessMs,
      yoloConsecutiveFailures: this.yoloConsecutiveFailures,
      ocrConsecutiveFailures: this.ocrConsecutiveFailures,
      ocrQueueDepth: this.ocrQueueDepth,
      avgYoloLatencyMs: Math.round(avgYoloMs),
      avgOcrLatencyMs: Math.round(avgOcrMs),
      recoveryAttempts: this.recoveryAttempts,
      canManualRetry: this.state === 'TERGANGGU',
    };
  }

  public async manualRetry(): Promise<boolean> {
    if (this.isDisposed) return false;
    this.recoveryAttempts = 0;
    this.state = 'MEMULIHKAN';
    this.statusMessage = 'Memulihkan pengimbas secara manual...';
    this.notifyStateChange();

    return this.executeRecovery('YOLO');
  }

  private evaluateHealth(): void {
    if (this.isDisposed || this.isRecovering) return;
    const now = Date.now();

    // 1. Check camera video stream advancement (stream disconnect)
    if (now - this.lastFrameTimeMs > 6000) {
      if (this.recoveryAttempts < this.maxRecoveryAttempts) {
        this.executeRecovery('CAMERA');
      } else {
        this.transitionState(
          'TERGANGGU',
          'CAMERA_DISCONNECTED',
          'Pratonton kamera terputus atau terhenti'
        );
      }
      return;
    }

    // Check YOLO detector stalls
    const yoloStalled =
      this.yoloConsecutiveFailures >= this.maxConsecutiveFailures ||
      now - this.lastYoloSuccessMs > this.yoloWatchdogTimeoutMs;

    if (yoloStalled) {
      if (this.recoveryAttempts < this.maxRecoveryAttempts) {
        this.executeRecovery('YOLO');
      } else {
        this.transitionState(
          'TERGANGGU',
          'RECOVERY_LIMIT_EXCEEDED',
          'Had pemulihan automatik dicapai. Sila semak kamera atau tekan Muat Semula'
        );
      }
      return;
    }

    // Check OCR queue stalls (jobs queued but OCR not completing)
    const ocrStalled =
      this.ocrQueueDepth > 0 &&
      (this.ocrConsecutiveFailures >= this.maxConsecutiveFailures ||
        now - this.lastOcrSuccessMs > this.ocrWatchdogTimeoutMs);

    if (ocrStalled) {
      if (this.recoveryAttempts < this.maxRecoveryAttempts) {
        this.executeRecovery('OCR');
      } else {
        this.transitionState(
          'TERGANGGU',
          'RECOVERY_LIMIT_EXCEEDED',
          'Enjin OCR terhenti. Sila muat semula pengimbas'
        );
      }
      return;
    }

    // Normal operational state
    if (this.state !== 'AKTIF') {
      this.transitionState('AKTIF', 'NONE', 'Pengimbas & AI Berfungsi');
    }
  }

  private async executeRecovery(component: 'YOLO' | 'OCR' | 'CAMERA'): Promise<boolean> {
    if (this.isRecovering || this.isDisposed) return false;
    this.isRecovering = true;
    this.recoveryAttempts++;
    this.lastYoloSuccessMs = Date.now();
    this.lastOcrSuccessMs = Date.now();

    const backoffMs = Math.pow(2, this.recoveryAttempts - 1) * 1000;
    const reason: DetailedStallReason =
      component === 'CAMERA'
        ? 'CAMERA_DISCONNECTED'
        : component === 'YOLO'
        ? 'GENUINE_STALL_YOLO'
        : 'GENUINE_STALL_OCR';

    this.transitionState(
      'MEMULIHKAN',
      reason,
      `Memulihkan komponen ${component} (percubaan ${this.recoveryAttempts}/${this.maxRecoveryAttempts})...`
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      let success = true;

      if (this.onTriggerRecovery) {
        success = await this.onTriggerRecovery(component, this.recoveryAttempts);
      }

      if (success) {
        this.lastYoloSuccessMs = Date.now();
        this.lastOcrSuccessMs = Date.now();
        this.yoloConsecutiveFailures = 0;
        this.ocrConsecutiveFailures = 0;
        this.transitionState('AKTIF', 'NONE', `Komponen ${component} berjaya dipulihkan`);
        return true;
      } else {
        if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
          this.transitionState(
            'TERGANGGU',
            'RECOVERY_LIMIT_EXCEEDED',
            `Pemulihan ${component} gagal. Tekan Muat Semula.`
          );
        }
        return false;
      }
    } catch (err) {
      this.transitionState('TERGANGGU', 'RECOVERY_LIMIT_EXCEEDED', `Ralat pemulihan: ${String(err)}`);
      return false;
    } finally {
      this.isRecovering = false;
    }
  }

  private transitionState(
    newState: ScannerOperationalState,
    reason: DetailedStallReason,
    msg: string
  ): void {
    this.state = newState;
    this.detailedReason = reason;
    this.statusMessage = msg;
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    if (this.onStateChange && !this.isDisposed) {
      this.onStateChange(this.getSnapshot());
    }
  }
}
