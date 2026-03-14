// ─── MMA Elo Rating System ───
// Sequential Elo: replays each fighter's fight history chronologically,
// adjusting Elo after each bout based on opponent strength and finish method.
//
// Two-pass strategy:
// 1. Bootstrap: seed every fighter with record-based Elo (quick approximation)
// 2. Sequential replay: walk fight history oldest→newest for fighters in
//    active matchups, updating Elo fight-by-fight using opponent's
//    bootstrapped rating as a proxy for their strength at that time.
//
// This captures "quality of wins" — beating a 1800-rated champion shifts
// Elo far more than beating a 1300-rated debutant.

import type { FighterStats, FightRecord } from "../stats/ufcstats";

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
 * Used as the initial seed AND as a proxy for opponent strength when
 * the opponent isn't in the active matchup set (i.e., we don't have
 * their sequential Elo computed).
 */
export function bootstrapElo(stats: FighterStats): EloRating {
  const totalFights = stats.wins + stats.losses + stats.draws;

  let elo: number;
  if (totalFights === 0) {
    elo = EXPERIENCE_FLOOR;
  } else {
    const netAdjustment = (stats.wins - stats.losses) * 12;
    elo = DEFAULT_ELO + netAdjustment;
  }

  elo = Math.max(ELO_MIN, Math.min(ELO_MAX, elo));

  return {
    name: stats.name,
    elo,
    fights: totalFights,
    lastUpdated: new Date().toISOString().slice(0, 10),
  };
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

/**
 * Compute sequential Elo for a fighter by replaying their fight history
 * from oldest to newest.
 *
 * For each fight:
 * - Look up opponent in statsMap to get their bootstrapped Elo (proxy
 *   for opponent strength at that time)
 * - Apply updateElo() based on result + finish method
 *
 * Returns the final Elo after replaying all fights.
 * Falls back to bootstrapElo if fight history is empty.
 */
export function sequentialElo(
  stats: FighterStats,
  statsMap: Map<string, FighterStats>,
): EloRating {
  const history = stats.fightHistory;

  // No fight history available → fall back to bootstrap
  if (!history || history.length === 0) {
    return bootstrapElo(stats);
  }

  // Start at experience floor — let fight results build the rating
  let elo = EXPERIENCE_FLOOR;
  let fights = 0;

  // Fight history from UFCStats is most-recent-first → reverse to chronological
  const chronological = [...history].reverse();

  for (const fight of chronological) {
    // Skip no-contests and draws for Elo purposes (no clear winner)
    if (fight.result === 'nc') continue;
    if (fight.result === 'draw') {
      fights++;
      continue;
    }

    // Look up opponent's bootstrapped Elo as a strength proxy
    const oppKey = fight.opponent.toLowerCase().trim();
    const oppStats = statsMap.get(oppKey);
    const oppElo = oppStats ? bootstrapElo(oppStats).elo : DEFAULT_ELO;

    const isFinish = fight.method === 'KO/TKO' || fight.method === 'SUB';

    if (fight.result === 'win') {
      const [newElo] = updateElo(elo, oppElo, isFinish);
      elo = newElo;
    } else if (fight.result === 'loss') {
      const [, newElo] = updateElo(oppElo, elo, isFinish);
      elo = newElo;
    }

    fights++;
  }

  return {
    name: stats.name,
    elo: Math.max(ELO_MIN, Math.min(ELO_MAX, elo)),
    fights,
    lastUpdated: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Build an Elo rating map for all fighters in the stats map.
 * Uses bootstrap for the full map (needed as opponent-strength proxy).
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

// Re-export constants for use in engine
export { DEFAULT_ELO, K_FACTOR, FINISH_BONUS, EXPERIENCE_FLOOR };
