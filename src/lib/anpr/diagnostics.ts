/**
 * Structured ANPR Pipeline Diagnostics & Tracing Service.
 * Tracks per-frame and per-track processing lifecycle:
 * Frame -> Detections -> Tracks -> OCR queued -> OCR completed -> Saved -> Rejected
 */

export interface FrameDiagnosticRecord {
  frameId: number;
  timestamp: number;
  slotId: string;
  rawCandidatesCount: number;
  survivingCandidatesCount: number;
  detections: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
  }>;
  tracksAssigned: Array<{
    trackId: string;
    isConfirmed: boolean;
    state: string;
  }>;
  rejectedCandidates: Array<{
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number;
    reason: 'MIN_SIZE' | 'ASPECT_RATIO' | 'STROKE_DENSITY' | 'NMS_SUPPRESSED';
  }>;
}

export interface TrackDiagnosticRecord {
  trackId: string;
  slotId: string;
  firstSeenMs: number;
  lastSeenMs: number;
  cropCaptured: boolean;
  cropCount: number;
  ocrQueued: boolean;
  ocrStarted: boolean;
  ocrCompleted: boolean;
  ocrAttempts: number;
  ocrResultText?: string;
  ocrConfidence?: number;
  consensusVoteCount: number;
  committedStatus: 'SAVED' | 'REJECTED' | 'PENDING' | 'INSUFFICIENT_EVIDENCE';
  rejectionReason?: string;
}

class PipelineDiagnosticTracer {
  private frameHistory: FrameDiagnosticRecord[] = [];
  private trackRecords: Map<string, TrackDiagnosticRecord> = new Map();
  private maxFrameHistory = 100;
  private developerMode = false;

  public setDeveloperMode(enabled: boolean): void {
    this.developerMode = enabled;
  }

  public isDeveloperMode(): boolean {
    return this.developerMode;
  }

  public logFrame(record: FrameDiagnosticRecord): void {
    this.frameHistory.push(record);
    if (this.frameHistory.length > this.maxFrameHistory) {
      this.frameHistory.shift();
    }
  }

  public ensureTrackRecord(trackId: string, slotId: string): TrackDiagnosticRecord {
    let record = this.trackRecords.get(trackId);
    if (!record) {
      record = {
        trackId,
        slotId,
        firstSeenMs: Date.now(),
        lastSeenMs: Date.now(),
        cropCaptured: false,
        cropCount: 0,
        ocrQueued: false,
        ocrStarted: false,
        ocrCompleted: false,
        ocrAttempts: 0,
        consensusVoteCount: 0,
        committedStatus: 'PENDING',
      };
      this.trackRecords.set(trackId, record);
    }
    record.lastSeenMs = Date.now();
    return record;
  }

  public updateTrack(trackId: string, patch: Partial<TrackDiagnosticRecord>): void {
    const record = this.trackRecords.get(trackId);
    if (record) {
      Object.assign(record, patch);
    }
  }

  public getTrackRecord(trackId: string): TrackDiagnosticRecord | undefined {
    return this.trackRecords.get(trackId);
  }

  public getAllTrackRecords(): TrackDiagnosticRecord[] {
    return Array.from(this.trackRecords.values());
  }

  public getRecentFrames(limit = 10): FrameDiagnosticRecord[] {
    return this.frameHistory.slice(-limit);
  }

  public clear(): void {
    this.frameHistory = [];
    this.trackRecords.clear();
  }
}

export const pipelineDiagnostics = new PipelineDiagnosticTracer();
