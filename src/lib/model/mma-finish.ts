// ─── MMA Finish Probability Model ───
// Estimates KO/TKO, Submission, and Decision probabilities for a matchup.
// Also provides a finish type advantage feature for the weighted win-prob model.

import type { FighterStats } from "../stats/ufcstats";

export interface FinishProbabilities {
  koProb: number;      // P(fight ends by KO/TKO)
  subProb: number;     // P(fight ends by Submission)
  decProb: number;     // P(fight ends by Decision)
}

/**
 * Sigmoid helper — maps any real value to (0, 1), centered at 0.5.
 * Imported from mma-engine would cause a circular dep; duplicate locally.
 */
function sigmoid(x: number, scale: number): number {
  return 1 / (1 + Math.exp(-x * scale));
}

/**
 * Compute finish method probabilities for a fight between A and B.
 * Uses each fighter's historical finish rates and opponent's defensive vulnerabilities.
 */
export function computeFinishProbs(
  a: FighterStats,
  b: FighterStats,
): FinishProbabilities {
  // Raw KO probability: average of A's KO offense and B's KO vulnerability
  const aKoThreat = a.koRate * (1 - b.strDef);   // A's KO rate × B's defensive gap
  const bKoThreat = b.koRate * (1 - a.strDef);
  const rawKoProb = (aKoThreat + bKoThreat) / 2;

  // Raw Sub probability: average of A's Sub offense and B's Sub vulnerability
  const aSubThreat = a.subRate * (1 - b.tdDef);  // A's Sub rate × B's grappling gap
  const bSubThreat = b.subRate * (1 - a.tdDef);
  const rawSubProb = (aSubThreat + bSubThreat) / 2;

  // Decision is the complement (minimum 10%)
  const rawDecProb = Math.max(0.1, 1 - rawKoProb - rawSubProb);

  // Normalize so they sum to 1
  const total = rawKoProb + rawSubProb + rawDecProb;
  return {
    koProb: rawKoProb / total,
    subProb: rawSubProb / total,
    decProb: rawDecProb / total,
  };
}

/**
 * Finish type advantage feature for the weighted win-prob model.
 * Measures how well A's finish profile exploits B's vulnerability vs. vice versa.
 * Returns a [0, 1] value; 0.5 = neutral, >0.5 = favors A.
 */
export function finishTypeAdvantage(a: FighterStats, b: FighterStats): number {
  // KO exploit: A's KO offense vs B's KO vulnerability
  const koExploit = a.koRate * b.koLossRate;
  // Sub exploit: A's Sub offense vs B's Sub vulnerability
  const subExploit = a.subRate * b.subLossRate;
  // Reverse
  const bKoExploit = b.koRate * a.koLossRate;
  const bSubExploit = b.subRate * a.subLossRate;

  const aFinishThreat = koExploit + subExploit;
  const bFinishThreat = bKoExploit + bSubExploit;
  const diff = aFinishThreat - bFinishThreat;
  return sigmoid(diff, 4.0);
}
