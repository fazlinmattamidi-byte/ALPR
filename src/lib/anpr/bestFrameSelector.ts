/**
 * PlateQ — Best Frame Selection Engine
 * 
 * Manages an sliding memory buffer of plate crops per track.
 * Automatically selects the crispest, highest-quality frame crop for OCR recognition.
 */

import { assessCropQuality, CropQualityReport } from './qualityAssessor';
import type { PlateQualityResult } from './plateQualityService';

export interface FrameCropEntry {
  id: string;
  canvas: HTMLCanvasElement;
  quality: CropQualityReport;
  qualityAssessment?: PlateQualityResult;
  timestamp: number;
  /** Capture time of the source frame, retained with the crop for OCR. */
  capturedAt: number;
  /** Source-media position when available (recorded video only). */
  mediaTimeSeconds?: number;
  cropKind: 'ORIGINAL' | 'DESKEWED' | 'TIGHT' | 'DETECTOR';
  bbox: { x: number; y: number; width: number; height: number };
  detectorConfidence: number;
  trackStability: number;
  perspectiveScore: number;
}

export class BestFrameSelector {
  private trackBuffers: Map<number, FrameCropEntry[]> = new Map();
  private maxBufferSize: number = 3;
  private maxEntryAgeMs: number = 2500;
  private maxTrackBuffers: number = 16;
  private retainUntil = 0;

  /** Keep already captured evidence alive while a finished clip drains. */
  public retainForDrain(until: number): void { this.retainUntil = until; }


  public configure(options: { maxBufferSize?: number; maxEntryAgeMs?: number; maxTrackBuffers?: number }): void {
    if (typeof options.maxBufferSize === 'number') {
      this.maxBufferSize = Math.max(1, Math.min(16, Math.round(options.maxBufferSize)));
    }
    if (typeof options.maxEntryAgeMs === 'number') {
      this.maxEntryAgeMs = Math.max(1000, Math.min(15000, Math.round(options.maxEntryAgeMs)));
    }
    if (typeof options.maxTrackBuffers === 'number') {
      this.maxTrackBuffers = Math.max(1, Math.min(32, Math.round(options.maxTrackBuffers)));
    }
  }

  private releaseEntry(entry: FrameCropEntry): void {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }

  private scoreEntry(entry: FrameCropEntry, now: number): number {
    const ageScore = Math.max(0, 1 - (now - entry.timestamp) / this.maxEntryAgeMs);
    const modelScore = entry.qualityAssessment?.qualityScore ?? entry.quality.overallScore;
    const isPartial = entry.qualityAssessment?.isPartialCrop || entry.quality.isPartialCrop;
    const completenessPenalty = isPartial ? 0.40 : 0.0;
    const sizeScore = Math.min(1, (entry.bbox.width * entry.bbox.height) / (180 * 48));
    const sharpness = entry.quality.sharpnessScore;
    const detectorConfidence = entry.detectorConfidence;
    const stability = entry.trackStability;
    const perspective = entry.perspectiveScore;
    const contrast = entry.quality.contrastScore;
    const motionBlur = 1.0 - entry.quality.motionBlurScore;

    return Math.max(0,
      modelScore * 0.35 +
      sharpness * 0.15 +
      detectorConfidence * 0.12 +
      sizeScore * 0.12 +
      contrast * 0.08 +
      motionBlur * 0.08 +
      stability * 0.05 +
      perspective * 0.05 -
      completenessPenalty
    );
  }

  private trimBuffer(buffer: FrameCropEntry[], now: number): void {
    buffer.sort((a, b) => this.scoreEntry(b, now) - this.scoreEntry(a, now));
    // Keep the newest source observation, even when padding/edges make an
    // older crop look sharper. Otherwise the final readable frame is evicted
    // before the drain can ever try it.
    const newest = Math.max(...buffer.map(entry => entry.capturedAt));
    while (buffer.length > this.maxBufferSize) {
      let index = buffer.length - 1;
      while (index >= 0 && buffer[index].capturedAt === newest) index--;
      if (index < 0) index = buffer.length - 1;
      this.releaseEntry(buffer.splice(index, 1)[0]);
    }
  }

  private pruneTrackBuffer(trackId: number, now: number): void {
    const buffer = this.trackBuffers.get(trackId);
    if (!buffer) return;

    const fresh = buffer.filter(entry => (now <= this.retainUntil || now - entry.timestamp <= this.maxEntryAgeMs));
    if (fresh.length !== buffer.length) {
      buffer
        .filter(entry => (now > this.retainUntil && now - entry.timestamp > this.maxEntryAgeMs))
        .forEach(entry => this.releaseEntry(entry));
    }

    if (fresh.length === 0) {
      this.trackBuffers.delete(trackId);
      return;
    }

    this.trimBuffer(fresh, now);
    this.trackBuffers.set(trackId, fresh);
  }

  private pruneOverflowTracks(): void {
    if (this.trackBuffers.size <= this.maxTrackBuffers) return;

    const ranked = Array.from(this.trackBuffers.entries()).sort((a, b) => {
      const newestA = Math.max(...a[1].map(entry => entry.timestamp));
      const newestB = Math.max(...b[1].map(entry => entry.timestamp));
      return newestB - newestA;
    });

    for (const [trackId] of ranked.slice(this.maxTrackBuffers)) {
      this.clearTrack(trackId);
    }
  }

  /**
   * Add a new frame crop candidate for a specific track ID.
   */
  public addCropCandidate(
    trackId: number,
    canvas: HTMLCanvasElement,
    bbox: { x: number; y: number; width: number; height: number; confidence?: number },
    options: {
      trackStability?: number;
      perspectiveScore?: number;
      capturedAt?: number;
      mediaTimeSeconds?: number;
      cropKind?: FrameCropEntry['cropKind'];
    } = {}
  ): CropQualityReport {
    const now = Date.now();
    this.pruneStale(this.maxEntryAgeMs, undefined, now);

    const quality = assessCropQuality(canvas);
    const entry: FrameCropEntry = {
      id: `${trackId}_${now}_${Math.random().toString(36).substring(2, 6)}`,
      canvas,
      quality,
      timestamp: now,
      capturedAt: options.capturedAt ?? now,
      mediaTimeSeconds: options.mediaTimeSeconds,
      cropKind: options.cropKind ?? 'ORIGINAL',
      bbox,
      detectorConfidence: Math.min(1, Math.max(0, bbox.confidence ?? 0.75)),
      trackStability: Math.min(1, Math.max(0, options.trackStability ?? 0.55)),
      perspectiveScore: Math.min(1, Math.max(0, options.perspectiveScore ?? quality.aspectRatioScore)),
    };

    if (!this.trackBuffers.has(trackId)) {
      this.trackBuffers.set(trackId, []);
    }

    const buffer = this.trackBuffers.get(trackId)!;
    buffer.push(entry);

    // Keep buffer size within max limit, prioritizing fresh high-quality crops.
    if (buffer.length > this.maxBufferSize) {
      this.trimBuffer(buffer, now);
    }

    this.pruneOverflowTracks();

    return quality;
  }

  /**
   * Get the absolute best frame crop for OCR processing for a given track ID.
   */
  public getBestCrop(trackId: number): FrameCropEntry | null {
    const now = Date.now();
    this.pruneTrackBuffer(trackId, now);

    const buffer = this.trackBuffers.get(trackId);
    if (!buffer || buffer.length === 0) return null;

    // Return the entry with highest blended quality/recency score.
    let best = buffer[0];
    for (let i = 1; i < buffer.length; i++) {
      if (this.scoreEntry(buffer[i], now) > this.scoreEntry(best, now)) {
        best = buffer[i];
      }
    }
    return best;
  }

  public getTopCrops(trackId: number, limit = 3): FrameCropEntry[] {
    const now = Date.now();
    this.pruneTrackBuffer(trackId, now);

    const buffer = this.trackBuffers.get(trackId);
    if (!buffer || buffer.length === 0) return [];

    return [...buffer]
      .sort((a, b) => this.scoreEntry(b, now) - this.scoreEntry(a, now))
      .slice(0, Math.max(1, Math.min(16, Math.round(limit))));
  }

  public updateCropAssessment(trackId: number, entryId: string, assessment: PlateQualityResult): void {
    const buffer = this.trackBuffers.get(trackId);
    if (!buffer) return;

    const entry = buffer.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    entry.qualityAssessment = assessment;
  }

  /** Transfer ownership to OCR before awaiting. Pruning must not clear an in-flight canvas. */
  public takeCrop(trackId: number, entryId: string): FrameCropEntry | null {
    const buffer = this.trackBuffers.get(trackId);
    if (!buffer) return null;
    const index = buffer.findIndex((entry) => entry.id === entryId);
    if (index < 0) return null;
    const [entry] = buffer.splice(index, 1);
    if (buffer.length === 0) this.trackBuffers.delete(trackId);
    return entry;
  }

  /**
   * Return the number of fresh crop candidates currently buffered for a track.
   */
  public getCropCount(trackId: number): number {
    const now = Date.now();
    this.pruneTrackBuffer(trackId, now);
    return this.trackBuffers.get(trackId)?.length ?? 0;
  }

  /**
   * Clear frame candidates for a specific track ID.
   */
  public clearTrack(trackId: number): void {
    const buffer = this.trackBuffers.get(trackId);
    if (buffer) {
      buffer.forEach(entry => this.releaseEntry(entry));
    }
    this.trackBuffers.delete(trackId);
  }

  /**
   * Clear all buffers that no longer belong to active tracker IDs.
   */
  public clearExcept(activeTrackIds: Set<number>): void {
    for (const trackId of Array.from(this.trackBuffers.keys())) {
      if (!activeTrackIds.has(trackId)) {
        this.clearTrack(trackId);
      }
    }
  }

  /**
   * Remove old frame candidates so long-running desktop scans stay memory-stable.
   */
  public pruneStale(
    maxAgeMs: number = this.maxEntryAgeMs,
    activeTrackIds?: Set<number>,
    now: number = Date.now()
  ): void {
    for (const trackId of Array.from(this.trackBuffers.keys())) {
      if (activeTrackIds && !activeTrackIds.has(trackId)) {
        this.clearTrack(trackId);
        continue;
      }

      const buffer = this.trackBuffers.get(trackId);
      if (!buffer) continue;
      const fresh = buffer.filter(entry => (now <= this.retainUntil || now - entry.timestamp <= maxAgeMs));
      if (fresh.length !== buffer.length) {
        buffer
          .filter(entry => (now > this.retainUntil && now - entry.timestamp > maxAgeMs))
          .forEach(entry => this.releaseEntry(entry));
      }
      if (fresh.length === 0) {
        this.trackBuffers.delete(trackId);
      } else {
        this.trackBuffers.set(trackId, fresh);
      }
    }

    this.pruneOverflowTracks();
  }

  /**
   * Reset all track frame buffers.
   */
  public resetAll(): void {
    this.retainUntil = 0;
    for (const buffer of this.trackBuffers.values()) {
      buffer.forEach(entry => this.releaseEntry(entry));
    }
    this.trackBuffers.clear();
  }
}

export const globalBestFrameSelector = new BestFrameSelector();
