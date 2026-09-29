import { describe, expect, it } from 'vitest';
import {
  VideoLabAnnotation,
  VideoLabPrediction,
  evaluateVideoLabRun,
  isSourceSplitConsistent,
} from '../lib/anpr/videoLab';

function annotation(overrides: Partial<VideoLabAnnotation> = {}): VideoLabAnnotation {
  return {
    id: 'label-1',
    sourceId: 'video-a',
    sourceName: 'Video A',
    timestampSeconds: 1,
    plate: 'ABC1234',
    bbox: { x: 10, y: 20, width: 100, height: 30 },
    layout: 'SINGLE_LINE',
    viewingAngle: 'FRONT',
    environment: 'DAY',
    split: 'TEST',
    unreadable: false,
    partiallyOccluded: false,
    createdAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

function prediction(overrides: Partial<VideoLabPrediction> = {}): VideoLabPrediction {
  return {
    id: 'prediction-1',
    runId: 'run-1',
    sourceId: 'video-a',
    sourceName: 'Video A',
    frameIndex: 5,
    timestampSeconds: 1,
    bbox: { x: 11, y: 20, width: 99, height: 30 },
    detectorConfidence: 0.9,
    detectorLatencyMs: 40,
    ocrText: 'ABC1234',
    ocrConfidence: 0.9,
    ocrLatencyMs: 60,
    totalLatencyMs: 100,
    ...overrides,
  };
}

describe('video lab evaluation', () => {
  it('keeps predictions from unlabelled sources separate from formal metrics', () => {
    const metrics = evaluateVideoLabRun([], [prediction()]);
    expect(metrics.hasGroundTruth).toBe(false);
    expect(metrics.unlabelledPredictions).toBe(1);
    expect(metrics.falsePositives).toBe(0);
    expect(metrics.detectionRecall).toBe(0);
  });

  it('matches predictions by source, timestamp and IoU', () => {
    const metrics = evaluateVideoLabRun([annotation()], [prediction()]);
    expect(metrics.detected).toBe(1);
    expect(metrics.correctlyRecognized).toBe(1);
    expect(metrics.endToEndRecall).toBe(1);
    expect(metrics.falsePositives).toBe(0);
    expect(metrics.unlabelledPredictions).toBe(0);
    expect(metrics.latencyP95Ms).toBe(100);
  });

  it('separates detector misses, OCR errors and false positives', () => {
    const labels = [
      annotation(),
      annotation({ id: 'label-2', timestampSeconds: 2, plate: 'XYZ9' }),
      annotation({ id: 'label-3', timestampSeconds: 3, plate: 'VME7108' }),
    ];
    const predictions = [
      prediction(),
      prediction({ id: 'prediction-2', timestampSeconds: 2, ocrText: 'XYZ8' }),
      prediction({ id: 'prediction-false', timestampSeconds: 4, bbox: { x: 300, y: 300, width: 50, height: 20 } }),
    ];
    const metrics = evaluateVideoLabRun(labels, predictions);
    expect(metrics.detected).toBe(2);
    expect(metrics.correctlyRecognized).toBe(1);
    expect(metrics.missed).toBe(1);
    expect(metrics.incorrectReads).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.rows.map((row) => row.failureStage)).toEqual([undefined, 'OCR', 'DETECTOR']);
  });

  it('detects source-level dataset leakage', () => {
    expect(isSourceSplitConsistent([annotation(), annotation({ id: 'label-2', split: 'TRAIN' })])).toBe(false);
    expect(isSourceSplitConsistent([annotation(), annotation({ id: 'label-2', sourceId: 'video-b', split: 'TRAIN' })])).toBe(true);
  });
});
