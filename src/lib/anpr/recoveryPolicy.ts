import type { EnvironmentClass, EnvironmentProfile, PlateQualityClass } from './adaptiveConfig';
import type { PreprocessVariant } from './imageProcessor';
import { getQualityPreprocessingPlan } from './plateQualityScoring';

export function environmentRecoveryVariants(environment: EnvironmentClass, stats?: EnvironmentProfile['stats']): PreprocessVariant[] {
  // Scene labels (PARKING/HIGHWAY) and exposure conditions are not exclusive.
  if (stats && stats.glareRatio >= 0.10) return ['HIGHLIGHT_REDUCED', 'CLAHE'];
  if (stats && stats.brightness <= 0.30) return ['GAMMA_BRIGHTEN', 'CLAHE'];
  switch (environment) {
    case 'NIGHT': case 'LOW_LIGHT': case 'TUNNEL': return ['GAMMA_BRIGHTEN', 'CLAHE'];
    case 'GLARE': case 'BACKLIGHT': return ['HIGHLIGHT_REDUCED', 'CLAHE'];
    case 'FOG': case 'RAIN': case 'HEAVY_RAIN': return ['CLAHE', 'CONTRAST_BOOST'];
    default: return [];
  }
}

/** Alternate exposure and tile recovery; a daytime scene can still contain
 * a locally shadowed plate, so an empty detection gets local contrast recovery.
 */
export function planDetectorRecovery(environment: EnvironmentClass, consecutiveMisses: number, stats?: EnvironmentProfile['stats']): PreprocessVariant | undefined {
  if (consecutiveMisses % 2 !== 0) return undefined;
  const configured = environmentRecoveryVariants(environment, stats);
  const variants: PreprocessVariant[] = configured.length ? configured : ['CLAHE'];
  return variants[Math.floor(consecutiveMisses / 2) % variants.length];
}

/** Spend the bounded retry budget on different class-specific corrections. */
export function planOcrRecovery(
  quality: PlateQualityClass,
  environment: EnvironmentClass,
  attempt: number,
  selected: readonly PreprocessVariant[] = [],
  stats?: EnvironmentProfile['stats']
): PreprocessVariant[] {
  const variants = [...new Set([
    ...getQualityPreprocessingPlan(quality),
    ...environmentRecoveryVariants(environment, stats),
    ...selected,
  ])].filter(variant => variant !== 'ORIGINAL');
  if (!variants.length) return ['ORIGINAL'];
  return ['ORIGINAL', variants[Math.max(0, attempt) % variants.length]];
}

/** Preserve raw pixels and guarantee the correction survives the crop cap. */
export function selectOcrRecoveryCandidates<T extends { variant?: PreprocessVariant }>(
  original: T, enhanced: T[], inner: T[], difficult: boolean, attempt: number, limit: number
): T[] {
  const correction = enhanced[0];
  const ordered = difficult && correction
    ? (attempt > 0
      ? [correction, ...(inner.length ? inner : [original])]
      : [original, correction])
    : [original, ...enhanced, ...inner];
  return ordered.slice(0, Math.max(1, limit));
}
