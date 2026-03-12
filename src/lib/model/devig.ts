// ─── De-vigging / Fair Probability Extraction ───
// Pure functions for removing bookmaker margins from odds.

/**
 * American odds → implied probability (no-vig not accounted for).
 */
export function americanToImplied(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

/**
 * American odds → decimal odds.
 */
export function americanToDecimal(odds: number): number {
  if (odds > 0) return odds / 100 + 1;
  return 100 / Math.abs(odds) + 1;
}

/**
 * Power de-vig (Shin-like).
 *
 * Given an array of raw implied probabilities that sum > 1 (due to vig),
 * find exponent k such that sum(p_i^k) = 1, then return p_i^k as fair probs.
 *
 * This method is considered more accurate than multiplicative or additive
 * removal because it accounts for the fact that bookmakers shade more
 * heavily on the favorite side.
 *
 * @param rawProbs - Array of implied probabilities from bookmaker odds
 * @returns Array of fair (de-vigged) probabilities summing to ~1.0
 */
export function shinDevig(rawProbs: number[]): number[] {
  if (rawProbs.length === 0) return [];
  if (rawProbs.length === 1) return [1.0];

  // Binary search for exponent k where sum(p^k) = 1
  let lo = 0.01;
  let hi = 5.0;
  for (let iter = 0; iter < 80; iter++) {
    const mid = (lo + hi) / 2;
    const sum = rawProbs.reduce((s, p) => s + Math.pow(Math.max(p, 0.001), mid), 0);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return rawProbs.map(p => Math.pow(Math.max(p, 0.001), k));
}

/**
 * Multiplicative de-vig (simpler alternative).
 * Just divides each implied prob by the sum to normalize to 1.
 * Less accurate than power method but useful as a sanity check.
 */
export function multiplicativeDevig(rawProbs: number[]): number[] {
  const sum = rawProbs.reduce((s, p) => s + p, 0);
  if (sum === 0) return rawProbs;
  return rawProbs.map(p => p / sum);
}

/**
 * Given a full book market (all outcomes with American odds),
 * extract the fair probability for one specific outcome using power de-vig.
 *
 * @param allOdds     - American odds for all outcomes in the market
 * @param targetIndex - Index of the outcome we want
 * @returns fair probability for the target outcome
 */
export function fairProbForOutcome(
  allOdds: number[],
  targetIndex: number,
): number {
  const rawProbs = allOdds.map(americanToImplied);
  const fair = shinDevig(rawProbs);
  return fair[targetIndex] ?? 0;
}
