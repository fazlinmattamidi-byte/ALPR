/**
 * PlateQ — Best Frame Selection Engine
 * 
 * Manages an sliding memory buffer of plate crops per track.
 * Automatically selects the crispest, highest-quality frame crop for OCR recognition.
 */

import { assessCropQuality, CropQualityReport } from './qualityAssessor';

export interface FrameCropEntry {
  id: string;
  canvas: HTMLCanvasElement;
  quality: CropQualityReport;
  timestamp: number;
  bbox: { x: number; y: number; width: number; height: number };
}

export class BestFrameSelector {
  private trackBuffers: Map<number, FrameCropEntry[]> = new Map();
  private maxBufferSize: number = 6;
  private maxEntryAgeMs: number = 5000;
  private maxTrackBuffers: number = 16;

  private releaseEntry(entry: FrameCropEntry): void {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }

  private scoreEntry(entry: FrameCropEntry, now: number): number {
    const ageScore = Math.max(0, 1 - (now - entry.timestamp) / this.maxEntryAgeMs);
    return entry.quality.overallScore * 0.78 + ageScore * 0.22;
  }

  private pruneTrackBuffer(trackId: number, now: number): void {
    const buffer = this.trackBuffers.get(trackId);
    if (!buffer) return;

    const fresh = buffer.filter(entry => now - entry.timestamp <= this.maxEntryAgeMs);
    if (fresh.length !== buffer.length) {
      buffer
        .filter(entry => now - entry.timestamp > this.maxEntryAgeMs)
        .forEach(entry => this.releaseEntry(entry));
    }

    if (fresh.length === 0) {
      this.trackBuffers.delete(trackId);
      return;
    }

    fresh.sort((a, b) => this.scoreEntry(b, now) - this.scoreEntry(a, now));
    while (fresh.length > this.maxBufferSize) {
      const removed = fresh.pop();
      if (removed) this.releaseEntry(removed);
    }
    this.trackBuffers.set(trackId, fresh);
  }

  private pruneOverflowTracks(now: number): void {
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
    bbox: { x: number; y: number; width: number; height: number }
  ): CropQualityReport {
    const now = Date.now();
    this.pruneStale(this.maxEntryAgeMs, undefined, now);

    const quality = assessCropQuality(canvas);
    const entry: FrameCropEntry = {
      id: `${trackId}_${now}_${Math.random().toString(36).substring(2, 6)}`,
      canvas,
      quality,
      timestamp: now,
      bbox,
    };

    if (!this.trackBuffers.has(trackId)) {
      this.trackBuffers.set(trackId, []);
    }

    const buffer = this.trackBuffers.get(trackId)!;
    buffer.push(entry);

    // Keep buffer size within max limit, prioritizing fresh high-quality crops.
    if (buffer.length > this.maxBufferSize) {
      buffer.sort((a, b) => this.scoreEntry(b, now) - this.scoreEntry(a, now));
      const removed = buffer.pop();
      if (removed) this.releaseEntry(removed);
    }

    this.pruneOverflowTracks(now);

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
   * Remove old frame candidates so long-running scans stay stable on mobile browsers.
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
      const fresh = buffer.filter(entry => now - entry.timestamp <= maxAgeMs);
      if (fresh.length !== buffer.length) {
        buffer
          .filter(entry => now - entry.timestamp > maxAgeMs)
          .forEach(entry => this.releaseEntry(entry));
      }
      if (fresh.length === 0) {
        this.trackBuffers.delete(trackId);
      } else {
        this.trackBuffers.set(trackId, fresh);
      }
    }

    this.pruneOverflowTracks(now);
  }

  /**
   * Reset all track frame buffers.
   */
  public resetAll(): void {
    for (const buffer of this.trackBuffers.values()) {
      buffer.forEach(entry => this.releaseEntry(entry));
    }
    this.trackBuffers.clear();
  }
}

export const globalBestFrameSelector = new BestFrameSelector();
