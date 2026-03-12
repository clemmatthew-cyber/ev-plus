// ─── Confidence Scoring with Disagreement Penalty ───
// Computes a 0-100 score and A/B/C/D grade for each bet.

import type { ModelConfig } from "./config";
import type { GoalieStatus } from "../types";

export interface ConfidenceResult {
  score: number;
  grade: "A" | "B" | "C" | "D";
}

/**
 * Compute confidence score for a bet.
 *
 * Components (weights from config):
 * 1. Edge magnitude — how far above the market min edge
 * 2. Model-market agreement — how close modelProb is to Shin fairProb
 * 3. Data depth — min(homeGP, awayGP) relative to full season (~82)
 * 4. Book coverage — number of sportsbooks with odds for this game
 * 5. Price efficiency — penalize extreme probabilities (favorites/longshots)
 * 6. Goalie data quality — do we have starter GSAx data
 *
 * Then apply disagreement penalty/bonus:
 * - If |modelProb - fairProb| > threshold → subtract up to disagreementPenaltyMax
 * - If they agree closely → add disagreementBonus
 */
export function computeConfidence(
  edge: number,
  modelProb: number,
  fairProb: number,
  nBooks: number,
  homeGP: number,
  awayGP: number,
  hasGoalieData: boolean,
  market: "ml" | "pl" | "totals",
  cfg: ModelConfig,
  sharpBookScore?: number,
  homeGoalieStatus?: GoalieStatus,
  awayGoalieStatus?: GoalieStatus,
): ConfidenceResult {
  const minEdge = cfg.minEdge[market];
  const w = cfg.confidence;

  // 1. Edge magnitude: 0-100 scale, 100 at 10% above min edge
  const edgeScore = Math.min(((edge - minEdge) / 0.07) * 100, 100);

  // 2. Line sharpness: reward edges where multiple books cluster near the same price
  //    (moved from agreement to avoid penalizing the very edges we're looking for)
  //    When model agrees with Shin fair prob, it means the edge comes from a
  //    single book deviating from consensus — that's a BETTER signal.
  const sharpnessScore = Math.min(100, nBooks * 25);

  // 3. Data depth: 100 when both teams have 60+ games
  const depthScore = Math.min(100, (Math.min(homeGP, awayGP) / 60) * 100);

  // 4. Book coverage: 100 when 4+ books have odds
  const bookScore = Math.min(100, (nBooks / 4) * 100);

  // 5. Price efficiency: penalize extreme probabilities (very heavy favorites/dogs)
  const priceScore = Math.max(0, 100 - Math.abs(modelProb - 0.5) * 200);

  // 6. Goalie data quality — factor in confirmation status
  let goalieScore = hasGoalieData ? 100 : 35;
  if (cfg.goalieConfirmationEnabled) {
    const hStatus = homeGoalieStatus || 'unknown';
    const aStatus = awayGoalieStatus || 'unknown';

    if (hStatus === 'confirmed' && aStatus === 'confirmed') {
      goalieScore = Math.min(100, goalieScore + cfg.goalieConfirmedBoost);
    } else if (hStatus === 'expected' || aStatus === 'expected') {
      goalieScore = Math.max(0, goalieScore + cfg.goalieExpectedPenalty);
    }
    if (hStatus === 'unknown' || aStatus === 'unknown') {
      goalieScore = Math.max(0, goalieScore + cfg.goalieUnknownPenalty);
    }
  }

  // 7. Sharp book signal
  const sbScore = (cfg.sharpBookEnabled && sharpBookScore !== undefined) ? sharpBookScore : 50;

  // Weighted sum
  let score =
    edgeScore * w.edgeWeight +
    sharpnessScore * w.agreementWeight +
    depthScore * w.depthWeight +
    bookScore * w.bookWeight +
    priceScore * w.priceWeight +
    goalieScore * w.goalieWeight +
    sbScore * (w.sharpBookWeight ?? 0);

  // ── Disagreement penalty/bonus ──
  const disagreeAmt = Math.abs(modelProb - fairProb);
  if (disagreeAmt > cfg.disagreementThreshold) {
    // Penalty proportional to how much it exceeds threshold
    const excessFrac = Math.min(1, (disagreeAmt - cfg.disagreementThreshold) / 0.10);
    score -= excessFrac * cfg.disagreementPenaltyMax;
  } else if (disagreeAmt < cfg.disagreementThreshold * 0.5) {
    // Bonus when model and market largely agree
    score += cfg.disagreementBonus;
  }

  // Sharp book movement bonus: when sharp book score is high (>70), add bonus
  if (cfg.sharpBookEnabled && sharpBookScore !== undefined && sharpBookScore > 70) {
    score += cfg.sharpMovementBonus;
  }

  // Lineup adjustment: if lineup data is incomplete, apply penalty
  if (cfg.lineupAdjustmentEnabled) {
    const hStatus = homeGoalieStatus || 'unknown';
    const aStatus = awayGoalieStatus || 'unknown';
    if (hStatus === 'unknown' && aStatus === 'unknown') {
      score += cfg.lineupIncompleteConfidencePenalty;
    }
  }

  score = Math.max(0, Math.min(100, score));

  // Grade
  const cuts = cfg.confidenceGradeCutoffs;
  const grade: "A" | "B" | "C" | "D" =
    score >= cuts.A ? "A" :
    score >= cuts.B ? "B" :
    score >= cuts.C ? "C" : "D";

  return { score: Math.round(score * 10) / 10, grade };
}
