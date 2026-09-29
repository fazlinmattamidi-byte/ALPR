import { createWorker, Worker } from 'tesseract.js';
import {
  normalizePlate,
  formatDisplayPlate,
  generateCandidatePlates,
  correctMalaysianTypographyOcr,
} from './normaliser';
import { validateMalaysianPattern } from './patterns';
import { CharacterConfidence, PlateCategory, PlateLayout } from '../db/types';
import { recognizeWithPpOcr } from './ppOcrEngine';
import { generateAdaptiveCrops, releaseCanvasMemory, PreprocessVariant } from './imageProcessor';
import {
  correctMalaysianPlateOcr,
  generateSpecialPlateCandidates,
  isPotentialSpecialSeriesCandidate,
} from './specialSeries';

let workerPromise: Promise<Worker> | null = null;

export async function getOCRWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const worker = await createWorker('eng', 1, {
      logger: () => {},
    });
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      tessedit_pageseg_mode: '7' as any,
    });
    return worker;
  })();

  return workerPromise;
}

export interface OcrRecognitionResult {
  text: string;
  normalizedPlate: string;
  displayPlate: string;
  confidence: number;
  characterConfidences: CharacterConfidence[];
  alternativeCandidates: string[];
  corroboratedRows?: boolean;
  layout: PlateLayout;
  category: PlateCategory;
  patternScore: number;
  hasTrailingSuffix: boolean;
  engineUsed: 'ONNX_MODEL' | 'PP_OCR' | 'TESSERACT';
}

/**
 * Primary OCR Router:
 * 1. Executes PP-OCR ONNX Model (Primary Production Engine via WebGPU/WASM)
 * 2. Optional Fallback to Tesseract.js (only when ONNX model is unavailable)
 */
export async function recognizePlateFromCanvas(
  cropCanvas: HTMLCanvasElement,
  isTwoLineHint?: boolean,
  options: { maxAdaptiveVariants?: number; quickMode?: boolean } = {}
): Promise<OcrRecognitionResult> {
  try {
    // Primary Engine: Local PP-OCR ONNX Model ONLY
    const ppOcrResult = await recognizeWithPpOcr(cropCanvas, isTwoLineHint, options.quickMode ?? false);
    if (ppOcrResult) {
      const candidates: OcrRecognitionResult[] = [{
        ...ppOcrResult,
        engineUsed: 'PP_OCR',
      }];

      const maxVariants = options.maxAdaptiveVariants ?? 0;
      const primaryPattern = validateMalaysianPattern(candidates[0].normalizedPlate);
      if (maxVariants > 0 && (!primaryPattern.isValid || candidates[0].confidence < 0.85)) {
        const specialVariants = getSpecialAdaptiveOcrVariants(cropCanvas, candidates[0])
          .slice(0, maxVariants);
        if (specialVariants.length > 0) {
          const adaptiveResults = await runSpecialAdaptiveOcrPass(cropCanvas, specialVariants, isTwoLineHint);
          candidates.push(...adaptiveResults);
        }
      }

      return chooseBestRecognitionResult(candidates);
    }

    return createEmptyResult();
  } catch (err) {
    console.warn('[ANPR OcrEngine] Error in PP-OCR recognition:', err);
    return createEmptyResult();
  }
}

const SPECIAL_OCR_PREPROCESSING: PreprocessVariant[] = [
  'CONTRAST_BOOST',
  'ADAPTIVE_THRESHOLD',
  'CLAHE',
  'BLACKHAT',
  'TOPHAT',
  'WIDE_CROP',
  'LARGE_TEXT',
  'HIGHLIGHT_REDUCED',
  'INVERTED',
];

export function getSpecialAdaptiveOcrVariants(
  cropCanvas: HTMLCanvasElement,
  result: Pick<OcrRecognitionResult, 'text' | 'confidence'> & Partial<OcrRecognitionResult>
): PreprocessVariant[] {
  const confidence = result.confidence;
  const plate = result.normalizedPlate || result.text;
  const pattern = validateMalaysianPattern(plate);
  const aspect = cropCanvas.width / Math.max(1, cropCanvas.height);
  const adaptiveCategory =
    pattern.category === 'SPECIAL_SERIES' ||
    pattern.category === 'PUTRAJAYA' ||
    pattern.category === 'EV_SPECIAL';
  const potentialSpecial = isPotentialSpecialSeriesCandidate(plate);
  const specialLikely =
    adaptiveCategory ||
    potentialSpecial ||
    plate.length >= 9 ||
    aspect >= 5.8;

  if (confidence >= 0.97 && pattern.isValid && pattern.score >= 0.70) return [];
  if (adaptiveCategory && confidence >= 0.94 && pattern.isValid && pattern.score >= 0.78) return [];

  // Standard Malaysian plates with confidence < 0.90: allow targeted contrast/sharpen/CLAHE
  if (!specialLikely) {
    if (confidence < 0.90) {
      return ['CONTRAST_BOOST', 'SHARPEN', 'CLAHE'];
    }
    return [];
  }

  if (confidence >= 0.90 && (adaptiveCategory || potentialSpecial)) {
    return ['CONTRAST_BOOST', 'WIDE_CROP', 'HIGHLIGHT_REDUCED'];
  }

  const inVotingBand = confidence >= 0.80 && confidence < 0.97;
  const weakButSpecific = confidence >= 0.45 && (adaptiveCategory || potentialSpecial) && pattern.score >= 0.50;

  if (inVotingBand) {
    return ['CONTRAST_BOOST', 'ADAPTIVE_THRESHOLD', 'CLAHE', 'WIDE_CROP'];
  }

  if (weakButSpecific) {
    return SPECIAL_OCR_PREPROCESSING.slice(0, 8);
  }

  return [];
}

async function runSpecialAdaptiveOcrPass(
  cropCanvas: HTMLCanvasElement,
  variants: PreprocessVariant[],
  isTwoLineHint?: boolean
): Promise<OcrRecognitionResult[]> {
  const adaptiveCrops = generateAdaptiveCrops(
    cropCanvas,
    { x: 0, y: 0, width: cropCanvas.width, height: cropCanvas.height, confidence: 1 },
    440,
    124,
    variants
  );

  const results: OcrRecognitionResult[] = [];

  try {
    for (const crop of adaptiveCrops) {
      const result = await recognizeWithPpOcr(crop.canvas, isTwoLineHint || crop.isTwoLine);
      if (!result) continue;
      results.push({
        ...result,
        engineUsed: 'PP_OCR',
      });
    }
  } finally {
    adaptiveCrops.forEach((crop) => {
      releaseCanvasMemory(crop.canvas);
      releaseCanvasMemory(crop.topLineCanvas);
      releaseCanvasMemory(crop.bottomLineCanvas);
    });
  }

  return results;
}

export function chooseBestRecognitionResult(candidates: OcrRecognitionResult[]): OcrRecognitionResult {
  const ranked = candidates
    .filter((candidate) => candidate.normalizedPlate.length >= 2)
    .map((candidate) => {
      const pattern = validateMalaysianPattern(candidate.normalizedPlate);
      const specialScore = isPotentialSpecialSeriesCandidate(candidate.normalizedPlate) ? 0.10 : 0;
      const score =
        candidate.confidence * 0.46 +
        pattern.score * 0.34 +
        (pattern.isValid ? 0.08 : 0) +
        specialScore;

      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.candidate ?? candidates[0] ?? createEmptyResult();
}

/**
 * Tesseract.js OCR engine execution (Fallback only)
 */
export async function recognizeWithTesseract(
  cropCanvas: HTMLCanvasElement,
  isTwoLineHint?: boolean
): Promise<OcrRecognitionResult> {
  const worker = await getOCRWorker();
  const ar = cropCanvas.width / (cropCanvas.height || 1);
  const isTwoLine = isTwoLineHint || ar < 2.3;

  if (isTwoLine) {
    const halfH = Math.round(cropCanvas.height * 0.52);

    const topCanvas = document.createElement('canvas');
    topCanvas.width = cropCanvas.width;
    topCanvas.height = halfH;
    const topCtx = topCanvas.getContext('2d');
    if (topCtx) topCtx.drawImage(cropCanvas, 0, 0, cropCanvas.width, halfH, 0, 0, topCanvas.width, halfH);

    const botCanvas = document.createElement('canvas');
    botCanvas.width = cropCanvas.width;
    botCanvas.height = cropCanvas.height - halfH;
    const botCtx = botCanvas.getContext('2d');
    if (botCtx) botCtx.drawImage(cropCanvas, 0, halfH, cropCanvas.width, cropCanvas.height - halfH, 0, 0, botCanvas.width, botCanvas.height);

    const [topRes, botRes] = await Promise.all([
      worker.recognize(topCanvas),
      worker.recognize(botCanvas),
    ]);

    const topText = normalizePlate(topRes.data.text || '');
    const botText = normalizePlate(botRes.data.text || '');
    const rawMerged = normalizePlate(`${topText}${botText}`);

    // Reject two-line candidates that exceed genuine plate length or contain duplicated whole-line text
    if (rawMerged && rawMerged.length >= 2 && rawMerged.length <= 8) {
      const topLetters = (topText.match(/[A-Z]/g) || []).length;
      const topDigits = (topText.match(/[0-9]/g) || []).length;
      const botLetters = (botText.match(/[A-Z]/g) || []).length;
      const botDigits = (botText.match(/[0-9]/g) || []).length;
      if (topLetters >= 2 && topDigits >= 2 && botLetters >= 2 && botDigits >= 2) {
        return createEmptyResult();
      }
      const topConf = (topRes.data.confidence || 0) / 100;
      const botConf = (botRes.data.confidence || 0) / 100;
      const avgConf = Math.min(1.0, (topConf + botConf) / 2);
      const specialCorrected = correctMalaysianPlateOcr(rawMerged, { ocrConfidence: avgConf }).normalized;
      const normMerged = correctMalaysianTypographyOcr(specialCorrected, { ocrConfidence: avgConf }).normalized;

      const patternVal = validateMalaysianPattern(normMerged);
      const charConfs: CharacterConfidence[] = normMerged.split('').map((char, i) => ({
        char,
        confidence: i < topText.length ? topConf : botConf,
        position: i,
      }));

      const alternatives = Array.from(new Set([
        ...generateSpecialPlateCandidates(rawMerged, 12, { ocrConfidence: avgConf }),
        ...generateCandidatePlates(normMerged),
      ])).filter((candidate) => candidate !== normMerged);

      return {
        text: normMerged,
        normalizedPlate: normMerged,
        displayPlate: formatDisplayPlate(normMerged, patternVal.category),
        confidence: avgConf,
        characterConfidences: charConfs,
        alternativeCandidates: alternatives,
        layout: ar < 1.6 ? 'SQUARE' : 'TWO_LINE',
        category: patternVal.category,
        patternScore: patternVal.score,
        hasTrailingSuffix: patternVal.hasTrailingSuffix,
        engineUsed: 'TESSERACT',
      };
    }
  }

  // Single-line OCR
  const result = await worker.recognize(cropCanvas);
  const rawText = result.data.text || '';
  const fullConf = Math.min(1.0, (result.data.confidence || 0) / 100);
  const specialCorrected = correctMalaysianPlateOcr(rawText, { ocrConfidence: fullConf }).normalized;
  const normText = correctMalaysianTypographyOcr(specialCorrected, { ocrConfidence: fullConf }).normalized;

  const patternVal = validateMalaysianPattern(normText);
  const charConfs: CharacterConfidence[] = [];

  if (result.data.symbols && result.data.symbols.length > 0) {
    let pos = 0;
    for (const sym of result.data.symbols) {
      const cleanSym = normalizePlate(sym.text);
      if (cleanSym) {
        charConfs.push({
          char: cleanSym,
          confidence: Math.min(1.0, (sym.confidence || 0) / 100),
          position: pos++,
        });
      }
    }
  } else {
    normText.split('').forEach((char, pos) => {
      charConfs.push({
        char,
        confidence: fullConf,
        position: pos,
      });
    });
  }

  const alternatives = Array.from(new Set([
    ...generateSpecialPlateCandidates(rawText, 12, { ocrConfidence: fullConf }),
    ...generateCandidatePlates(normText),
  ])).filter((candidate) => candidate !== normText);

  return {
    text: normText,
    normalizedPlate: normText,
    displayPlate: formatDisplayPlate(normText, patternVal.category),
    confidence: fullConf,
    characterConfidences: charConfs,
    alternativeCandidates: alternatives,
    layout: 'SINGLE_LINE',
    category: patternVal.category,
    patternScore: patternVal.score,
    hasTrailingSuffix: patternVal.hasTrailingSuffix,
    engineUsed: 'TESSERACT',
  };
}

function createEmptyResult(): OcrRecognitionResult {
  return {
    text: '',
    normalizedPlate: '',
    displayPlate: '',
    confidence: 0,
    characterConfidences: [],
    alternativeCandidates: [],
    layout: 'SINGLE_LINE',
    category: 'UNKNOWN_VALID_CANDIDATE',
    patternScore: 0,
    hasTrailingSuffix: false,
    engineUsed: 'TESSERACT',
  };
}
