// ─── NCAAB Defensive Efficiency Upset Detection ───
// Detects games where a slow-paced defensive underdog has elevated upset
// probability against an offensively-strong favorite.
//
// Four conditions must all be met to fire the upset signal:
//   1. Underdog spread >= spreadThreshold (big enough dog)
//   2. Underdog AdjDE rank <= adjDERankThreshold (top-tier defense)
//   3. Underdog tempo rank >= tempoRankThreshold (slow pace)
//   4. Favorite AdjOE rank <= opponentAdjOERankThreshold (elite offense being slowed)

import type { TorvikStats } from "../stats/torvik";

// ─── Configuration ───

export const UPSET_CONFIG = {
  spreadThreshold: 6,                 // underdog spread must be >= +6
  adjDERankThreshold: 25,             // team AdjDE rank <= 25 (top 25 defense)
  tempoRankThreshold: 200,            // team tempo rank >= 200 (slow pace)
  opponentAdjOERankThreshold: 40,     // opponent AdjOE rank <= 40 (top 40 offense)
  winProbBoost: 0.02,                 // +2% to underdog win probability
  spreadCoverBoost: 0.015,            // +1.5% to underdog spread-cover probability
};

// ─── Types ───

export interface UpsetDetectionResult {
  defensiveMismatch: number;          // opponent_adjOE - team_adjDE (higher = more mismatch)
  upsetSignal: boolean;               // true when all 4 conditions met
  adjustedModelProb: number;          // win prob after upset adjustment
  // NC-24: adjustedSpreadCoverProb removed (always 0)
  upsetTeam: string | null;           // which team triggers the signal (null if no signal)
  upsetDetails: {
    adjDERank: number | null;
    tempoRank: number | null;
    opponentAdjOERank: number | null;
    spreadThresholdMet: boolean;
    allConditionsMet: boolean;
  } | null;
}

// ─── Ranking Computation ───

/**
 * Compute ranks from the full Torvik dataset.
 * Returns Maps of teamName → rank (1 = best).
 */
export function computeRankings(allStats: Map<string, TorvikStats>): {
  adjDERanks: Map<string, number>;   // rank 1 = lowest (best) AdjDE
  adjOERanks: Map<string, number>;   // rank 1 = highest (best) AdjOE
  tempoRanks: Map<string, number>;   // rank 1 = fastest, rank 365 = slowest
} {
  const teams = [...allStats.values()];

  // AdjDE: lower is better → sort ascending, rank 1 = best defense
  const byDE = [...teams].sort((a, b) => a.adjDE - b.adjDE);
  const adjDERanks = new Map<string, number>();
  byDE.forEach((t, i) => adjDERanks.set(t.team, i + 1));

  // AdjOE: higher is better → sort descending, rank 1 = best offense
  const byOE = [...teams].sort((a, b) => b.adjOE - a.adjOE);
  const adjOERanks = new Map<string, number>();
  byOE.forEach((t, i) => adjOERanks.set(t.team, i + 1));

  // Tempo: higher is faster → sort descending, rank 1 = fastest
  // We want slow teams (rank >= 200), so rank 200+ = slow
  const byTempo = [...teams].sort((a, b) => b.tempo - a.tempo);
  const tempoRanks = new Map<string, number>();
  byTempo.forEach((t, i) => tempoRanks.set(t.team, i + 1));

  return { adjDERanks, adjOERanks, tempoRanks };
}

// ─── Detection Function ───

/**
 * Detect defensive-efficiency upset signal for a game.
 *
 * @param homeStats - home team Torvik stats
 * @param awayStats - away team Torvik stats
 * @param projectedSpread - model's projected spread (negative = home favored)
 * @param homeWinProb - model's home win probability before adjustment
 * @param awayWinProb - model's away win probability before adjustment
 * @param rankings - precomputed rankings from computeRankings()
 * @returns UpsetDetectionResult for both teams evaluated
 */
export function detectDefensiveUpset(
  homeStats: TorvikStats,
  awayStats: TorvikStats,
  projectedSpread: number,
  homeWinProb: number,
  awayWinProb: number,
  rankings: ReturnType<typeof computeRankings>,
): UpsetDetectionResult {
  // projectedSpread is from home perspective: negative = home favored
  // positive spread = home is underdog, negative spread = away is underdog
  const homeIsUnderdog = projectedSpread > 0;
  const awayIsUnderdog = projectedSpread < 0;

  // Check home team as potential upset candidate
  if (homeIsUnderdog && projectedSpread >= UPSET_CONFIG.spreadThreshold) {
    const result = evaluateUpsetCandidate(
      homeStats, awayStats, projectedSpread, homeWinProb,
      rankings, "home",
    );
    if (result) return result;
  }

  // Check away team as potential upset candidate
  if (awayIsUnderdog && Math.abs(projectedSpread) >= UPSET_CONFIG.spreadThreshold) {
    const result = evaluateUpsetCandidate(
      awayStats, homeStats, Math.abs(projectedSpread), awayWinProb,
      rankings, "away",
    );
    if (result) return result;
  }

  // No upset signal — return baseline with defensive mismatch still computed
  const homeDefMismatch = awayStats.adjOE - homeStats.adjDE;
  const awayDefMismatch = homeStats.adjOE - awayStats.adjDE;
  const primaryMismatch = homeIsUnderdog ? homeDefMismatch : awayDefMismatch;

  return {
    defensiveMismatch: Math.round(primaryMismatch * 100) / 100,
    upsetSignal: false,
    adjustedModelProb: homeIsUnderdog ? homeWinProb : awayWinProb,
    upsetTeam: null,
    upsetDetails: null,
  };
}

// ─── Internal helper ───

function evaluateUpsetCandidate(
  underdogStats: TorvikStats,
  favoriteStats: TorvikStats,
  underdogSpread: number,
  underdogWinProb: number,
  rankings: ReturnType<typeof computeRankings>,
  _side: "home" | "away",
): UpsetDetectionResult | null {
  const { adjDERanks, adjOERanks, tempoRanks } = rankings;

  const defMismatch = favoriteStats.adjOE - underdogStats.adjDE;
  const adjDERank = adjDERanks.get(underdogStats.team) ?? 999;
  const tempoRank = tempoRanks.get(underdogStats.team) ?? 0;
  const oppAdjOERank = adjOERanks.get(favoriteStats.team) ?? 999;

  const spreadOk  = underdogSpread >= UPSET_CONFIG.spreadThreshold;
  const defenseOk = adjDERank <= UPSET_CONFIG.adjDERankThreshold;
  const tempoOk   = tempoRank >= UPSET_CONFIG.tempoRankThreshold;
  const offenseOk = oppAdjOERank <= UPSET_CONFIG.opponentAdjOERankThreshold;
  const allMet    = spreadOk && defenseOk && tempoOk && offenseOk;

  const adjustedWinProb = allMet
    ? Math.min(underdogWinProb + UPSET_CONFIG.winProbBoost, 0.50)
    : underdogWinProb;

  return {
    defensiveMismatch: Math.round(defMismatch * 100) / 100,
    upsetSignal: allMet,
    adjustedModelProb: Math.round(adjustedWinProb * 10000) / 10000,
    adjustedSpreadCoverProb: 0, // set in ncaab-engine when evaluating spread outcomes
    upsetTeam: allMet ? underdogStats.team : null,
    upsetDetails: {
      adjDERank,
      tempoRank,
      opponentAdjOERank: oppAdjOERank,
      spreadThresholdMet: spreadOk,
      allConditionsMet: allMet,
    },
  };
}
