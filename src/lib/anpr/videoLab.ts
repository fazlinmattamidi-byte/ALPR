export type VideoLabSplit = 'TRAIN' | 'VALIDATION' | 'TEST';
export type PlateLayoutLabel = 'SINGLE_LINE' | 'TWO_LINE' | 'SQUARE';
export type ViewingAngleLabel = 'FRONT' | 'SLIGHT' | 'SEVERE';
export type EnvironmentLabel = 'DAY' | 'NIGHT' | 'GLARE' | 'RAIN' | 'SHADOW' | 'INDOOR' | 'OTHER';

export interface VideoLabBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoLabAnnotation {
  id: string;
  sourceId: string;
  sourceName: string;
  timestampSeconds: number;
  plate: string;
  bbox: VideoLabBox;
  layout: PlateLayoutLabel;
  viewingAngle: ViewingAngleLabel;
  environment: EnvironmentLabel;
  split: VideoLabSplit;
  unreadable: boolean;
  partiallyOccluded: boolean;
  createdAt: string;
}

export interface VideoLabPrediction {
  id: string;
  runId: string;
  sourceId: string;
  sourceName: string;
  frameIndex: number;
  timestampSeconds: number;
  bbox: VideoLabBox;
  detectorConfidence: number;
  detectorLatencyMs: number;
  ocrText: string;
  ocrConfidence: number;
  ocrLatencyMs: number;
  totalLatencyMs: number;
  cropDataUrl?: string;
}

export interface VideoLabSourceResult {
  sourceId: string;
  sourceName: string;
  durationSeconds: number;
  frameIntervalSeconds: number;
  processedFrames: number;
  predictions: VideoLabPrediction[];
  startedAt: string;
  completedAt: string;
  modelCombination?: string;
  detectorModelPath?: string;
  ocrModelPath?: string;
}

export interface VideoLabEvaluationRow {
  annotation: VideoLabAnnotation;
  detected: boolean;
  recognized: boolean;
  prediction?: VideoLabPrediction;
  failureStage?: 'DETECTOR' | 'OCR';
}

export interface VideoLabMetrics {
  /** Formal accuracy/error metrics require at least one human annotation. */
  hasGroundTruth: boolean;
  /** Detector/OCR outputs from sources that have no human labels. */
  unlabelledPredictions: number;
  totalLabels: number;
  readableLabels: number;
  detected: number;
  correctlyRecognized: number;
  missed: number;
  incorrectReads: number;
  falsePositives: number;
  detectionRecall: number;
  ocrExactMatchAccuracy: number;
  endToEndRecall: number;
  latencyAverageMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  rows: VideoLabEvaluationRow[];
}

export function normalizeLabPlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function calculateBoxIou(left: VideoLabBox, right: VideoLabBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection <= 0) return 0;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index];
}

export function evaluateVideoLabRun(
  annotations: VideoLabAnnotation[],
  predictions: VideoLabPrediction[],
  options: { timestampToleranceSeconds?: number; minimumIou?: number } = {}
): VideoLabMetrics {
  const timestampTolerance = options.timestampToleranceSeconds ?? 0.12;
  const minimumIou = options.minimumIou ?? 0.5;
  const usedPredictionIds = new Set<string>();
  const annotatedSourceIds = new Set(annotations.map((annotation) => annotation.sourceId));
  const hasGroundTruth = annotations.length > 0;

  const rows = annotations.map((annotation): VideoLabEvaluationRow => {
    const candidates = predictions
      .filter(
        (prediction) =>
          prediction.sourceId === annotation.sourceId &&
          Math.abs(prediction.timestampSeconds - annotation.timestampSeconds) <= timestampTolerance &&
          !usedPredictionIds.has(prediction.id)
      )
      .map((prediction) => ({ prediction, iou: calculateBoxIou(annotation.bbox, prediction.bbox) }))
      .filter((candidate) => candidate.iou >= minimumIou)
      .sort((a, b) => b.iou - a.iou || b.prediction.detectorConfidence - a.prediction.detectorConfidence);

    const best = candidates[0]?.prediction;
    if (!best) return { annotation, detected: false, recognized: false, failureStage: 'DETECTOR' };

    usedPredictionIds.add(best.id);
    const recognized =
      annotation.unreadable || normalizeLabPlate(best.ocrText) === normalizeLabPlate(annotation.plate);
    return {
      annotation,
      detected: true,
      recognized,
      prediction: best,
      failureStage: recognized ? undefined : 'OCR',
    };
  });

  const readableRows = rows.filter((row) => !row.annotation.unreadable);
  const detected = rows.filter((row) => row.detected).length;
  const correctlyRecognized = readableRows.filter((row) => row.recognized).length;
  const detectedReadable = readableRows.filter((row) => row.detected).length;
  const latencies = readableRows
    .filter((row) => row.recognized && row.prediction)
    .map((row) => row.prediction!.totalLatencyMs);
  // A detector output from an unlabelled source is an observation, not a
  // false positive. It cannot be classified until a human provides a box and
  // identity for that source.
  const labelledPredictions = predictions.filter((prediction) => annotatedSourceIds.has(prediction.sourceId));
  const unlabelledPredictions = predictions.length - labelledPredictions.length;

  return {
    hasGroundTruth,
    unlabelledPredictions,
    totalLabels: rows.length,
    readableLabels: readableRows.length,
    detected,
    correctlyRecognized,
    missed: rows.filter((row) => !row.detected).length,
    incorrectReads: readableRows.filter((row) => row.detected && !row.recognized).length,
    falsePositives: hasGroundTruth
      ? labelledPredictions.filter((prediction) => !usedPredictionIds.has(prediction.id)).length
      : 0,
    detectionRecall: rows.length > 0 ? detected / rows.length : 0,
    ocrExactMatchAccuracy: detectedReadable > 0 ? correctlyRecognized / detectedReadable : 0,
    endToEndRecall: readableRows.length > 0 ? correctlyRecognized / readableRows.length : 0,
    latencyAverageMs: latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    rows,
  };
}

export function isSourceSplitConsistent(annotations: VideoLabAnnotation[]): boolean {
  const splitBySource = new Map<string, VideoLabSplit>();
  for (const annotation of annotations) {
    const existing = splitBySource.get(annotation.sourceId);
    if (existing && existing !== annotation.split) return false;
    splitBySource.set(annotation.sourceId, annotation.split);
  }
  return true;
}
