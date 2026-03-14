// ─── MMA Elo Rating System ───
// Maintains and computes Elo ratings for UFC fighters.
//
// Bootstrap strategy: since we don't have historical fight results in this
// initial build, we initialize from win/loss record:
//   elo = DEFAULT_ELO + (wins - losses) * 12
//   clamped to [1200, 1900]
//
// Over time as we track results, the Elo will self-correct via K-factor updates.
// Storage is in-memory alongside fighter stats — no new DB tables needed.

import type { FighterStats } from "../stats/ufcstats";

const DEFAULT_ELO = 1500;
const K_FACTOR = 235;           // Research: optimal for MMA prediction
const FINISH_BONUS = 15;        // Extra Elo shift for KO/TKO/Sub finishes
const EXPERIENCE_FLOOR = 1350;  // New fighters start closer to underdog range
const ELO_MIN = 1200;
const ELO_MAX = 1900;

export interface EloRating {
  name: string;
  elo: number;
  fights: number;       // total fights tracked
  lastUpdated: string;  // ISO date
}

/**
 * Compute win probability for fighter A given both Elo ratings.
 * Standard Elo formula: 1 / (1 + 10^((ratingB - ratingA) / 400))
 */
export function eloWinProb(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Bootstrap Elo rating for a fighter from their win/loss/draw record.
 * Fighters with more wins get higher starting Elo.
 * New fighters (fewer fights) start at EXPERIENCE_FLOOR or below.
 */
export function bootstrapElo(stats: FighterStats): EloRating {
  const totalFights = stats.wins + stats.losses + stats.draws;

  let elo: number;
  if (totalFights === 0) {
    // No fight history — start at EXPERIENCE_FLOOR
    elo = EXPERIENCE_FLOOR;
  } else {
    // Record-based adjustment: each net win adds 12 Elo points
    const netAdjustment = (stats.wins - stats.losses) * 12;
    elo = DEFAULT_ELO + netAdjustment;
  }

  // Clamp to valid range
  elo = Math.max(ELO_MIN, Math.min(ELO_MAX, elo));

  return {
    name: stats.name,
    elo,
    fights: totalFights,
    lastUpdated: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Build an Elo rating map for all fighters in the stats map.
 * Keyed by lowercase fighter name for consistent lookup.
 */
export function buildEloMap(
  fighterStats: Map<string, FighterStats>,
): Map<string, EloRating> {
  const eloMap = new Map<string, EloRating>();

  for (const [key, stats] of fighterStats) {
    eloMap.set(key, bootstrapElo(stats));
  }

  return eloMap;
}

/**
 * Update Elo ratings after a fight result.
 * winnerElo and loserElo are the pre-fight ratings.
 * isFinish = true for KO/TKO/Submission — adds FINISH_BONUS to shift.
 * Returns [newWinnerElo, newLoserElo].
 */
export function updateElo(
  winnerElo: number,
  loserElo: number,
  isFinish = false,
): [number, number] {
  const expectedWinner = eloWinProb(winnerElo, loserElo);
  const baseShift = K_FACTOR * (1 - expectedWinner);
  const shift = isFinish ? baseShift + FINISH_BONUS : baseShift;

  const newWinner = Math.max(ELO_MIN, Math.min(ELO_MAX, winnerElo + shift));
  const newLoser = Math.max(ELO_MIN, Math.min(ELO_MAX, loserElo - shift));

  return [newWinner, newLoser];
}

// Re-export constants for use in engine
export { DEFAULT_ELO, K_FACTOR, FINISH_BONUS, EXPERIENCE_FLOOR };
