/** Blank warm-up output is legitimate, but an input-insensitive recognizer is
 * not ready. Compare probabilities, without requiring any particular text. */
export function haveDifferentNumericOutputs(first: ArrayLike<number>, second: ArrayLike<number>): boolean {
  if (!first.length || first.length !== second.length) return false;
  let different = false;
  for (let i = 0; i < first.length; i++) {
    if (!Number.isFinite(first[i]) || !Number.isFinite(second[i])) return false;
    if (Math.abs(first[i] - second[i]) > 1e-5) different = true;
  }
  return different;
}
