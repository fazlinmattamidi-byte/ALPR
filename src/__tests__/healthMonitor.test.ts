import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CameraHealthMonitor, HealthSnapshot } from '../lib/anpr/healthMonitor';

describe('CameraHealthMonitor & In-Place Component Recovery Tests', () => {
  let monitor: CameraHealthMonitor;
  let lastState: HealthSnapshot | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    lastState = null;
    monitor = new CameraHealthMonitor({
      slotId: 'test-slot-1',
      maxConsecutiveFailures: 3,
      maxRecoveryAttempts: 2,
      yoloWatchdogTimeoutMs: 3000,
      ocrWatchdogTimeoutMs: 4000,
      onStateChange: (snapshot) => {
        lastState = snapshot;
      },
    });
  });

  afterEach(() => {
    monitor.dispose();
    vi.useRealTimers();
  });

  it('starts in AKTIF state with system functioning message', () => {
    monitor.start();
    const snap = monitor.getSnapshot();
    expect(snap.state).toBe('AKTIF');
    expect(snap.detailedReason).toBe('NONE');
    expect(snap.slotId).toBe('test-slot-1');
  });

  it('detects camera stream disconnection and recovers successfully', async () => {
    let triggeredComponent: string | null = null;
    monitor = new CameraHealthMonitor({
      slotId: 'test-slot-stream',
      yoloWatchdogTimeoutMs: 15000,
      onTriggerRecovery: async (comp) => {
        triggeredComponent = comp;
        return true;
      },
    });

    monitor.start();
    monitor.recordYoloSuccess(45);
    await vi.advanceTimersByTimeAsync(8000);

    const snap = monitor.getSnapshot();
    expect(snap.state).toBe('AKTIF');
    expect(triggeredComponent).toBe('CAMERA');
  });

  it('resets watchdog timer when frames advance normally', () => {
    monitor.start();
    vi.advanceTimersByTime(2000);
    monitor.recordFrameAdvance();
    monitor.recordYoloSuccess(45);
    vi.advanceTimersByTime(2000);
    monitor.recordFrameAdvance();

    const snap = monitor.getSnapshot();
    expect(snap.state).toBe('AKTIF');
    expect(snap.avgYoloLatencyMs).toBe(45);
  });

  it('executes in-place recovery when consecutive YOLO failures exceed limit', async () => {
    const recoveryTriggered = vi.fn().mockResolvedValue(true);
    monitor = new CameraHealthMonitor({
      slotId: 'test-slot-2',
      maxConsecutiveFailures: 2,
      maxRecoveryAttempts: 2,
      onStateChange: (snapshot) => {
        lastState = snapshot;
      },
      onTriggerRecovery: recoveryTriggered,
    });

    monitor.start();
    monitor.recordFrameAdvance();
    monitor.recordYoloFailure();
    monitor.recordYoloFailure();

    // Health evaluation tick
    vi.advanceTimersByTime(1100);
    expect(lastState?.state).toBe('MEMULIHKAN');

    // Advance backoff time
    await vi.advanceTimersByTimeAsync(2000);
    expect(recoveryTriggered).toHaveBeenCalled();
  });

  it('transitions to TERGANGGU when max recovery retries are exceeded', async () => {
    const recoveryTriggered = vi.fn().mockResolvedValue(false);
    monitor = new CameraHealthMonitor({
      slotId: 'test-slot-3',
      maxConsecutiveFailures: 1,
      maxRecoveryAttempts: 1,
      yoloWatchdogTimeoutMs: 1000,
      onStateChange: (snapshot) => {
        lastState = snapshot;
      },
      onTriggerRecovery: recoveryTriggered,
    });

    monitor.start();
    monitor.recordFrameAdvance();
    monitor.recordYoloFailure();

    vi.advanceTimersByTime(1100);
    await vi.advanceTimersByTimeAsync(3000);

    const snap = monitor.getSnapshot();
    expect(snap.state).toBe('TERGANGGU');
    expect(snap.canManualRetry).toBe(true);
  });

  it('allows manual retry after entering TERGANGGU state', async () => {
    const recoveryTriggered = vi.fn().mockResolvedValue(true);
    monitor = new CameraHealthMonitor({
      slotId: 'test-slot-4',
      maxRecoveryAttempts: 1,
      onStateChange: (snapshot) => {
        lastState = snapshot;
      },
      onTriggerRecovery: recoveryTriggered,
    });

    monitor.start();
    monitor.recordFrameAdvance();
    monitor.recordYoloFailure();
    monitor.recordYoloFailure();
    monitor.recordYoloFailure();

    vi.advanceTimersByTime(1100);
    await vi.advanceTimersByTimeAsync(3000);

    const retryPromise = monitor.manualRetry();
    await vi.advanceTimersByTimeAsync(2000);
    const success = await retryPromise;

    expect(success).toBe(true);
    expect(monitor.getSnapshot().state).toBe('AKTIF');
  });

  it('cleans up timers and ignores callbacks when disposed', () => {
    monitor.start();
    monitor.dispose();
    monitor.recordYoloFailure();
    vi.advanceTimersByTime(5000);

    // Snapshot after disposal remains unchanged
    expect(lastState).toBeNull();
  });
});
