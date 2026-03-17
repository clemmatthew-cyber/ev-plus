// ─── Dixon-Coles Rho Fitting (Fix 3) ───
// Fits the rho parameter to this season's actual results using grid search MLE.

import { poissonPmf } from './poisson';
import { dixonColesTau } from './dixon-coles';
import type { RecentGameResult } from './form';
import type { TeamStats, LeagueAverages } from '../stats';

interface GameResult {
  homeGoals: number;
  awayGoals: number;
  homeLam: number;
  awayLam: number;
}

/**
 * Fit Dixon-Coles rho to observed game results.
 * Uses grid search over [-0.15, 0.05] with step 0.005.
 * Returns the rho that maximizes log-likelihood.
 */
export function fitDixonColesRho(results: GameResult[]): number {
  if (results.length < 50) return -0.04; // not enough data, use default

  let bestRho = -0.04;
  let bestLL = -Infinity;

  for (let rho = -0.15; rho <= 0.05; rho += 0.005) {
    let ll = 0;
    for (const r of results) {
      const poisProb = poissonPmf(r.homeGoals, r.homeLam) * poissonPmf(r.awayGoals, r.awayLam);
      const tau = dixonColesTau(r.homeGoals, r.awayGoals, r.homeLam, r.awayLam, rho);
      const p = poisProb * tau;
      if (p > 0) ll += Math.log(p);
      else ll -= 20; // heavy penalty for zero probability
    }
    if (ll > bestLL) {
      bestLL = ll;
      bestRho = rho;
    }
  }

  return Math.round(bestRho * 1000) / 1000;
}

/**
 * Convert paired RecentGameResult entries into GameResult[] for rho fitting.
 * Groups by date+teams to pair home/away entries, then computes simple lambdas.
 */
export function buildGameResultsForFitting(
  recentResults: RecentGameResult[],
  stats: Map<string, TeamStats>,
  lg: LeagueAverages,
): GameResult[] {
  // Group results by game: pair home and away entries
  const gameMap = new Map<string, { home?: RecentGameResult; away?: RecentGameResult }>();

  for (const r of recentResults) {
    // Create a key from date + team to group paired entries
    const dateKey = r.date.slice(0, 10);
    // Find the matching pair by looking for same-date entries
    let foundPair = false;
    for (const [key, pair] of gameMap) {
      if (!key.startsWith(dateKey)) continue;
      if (r.isHome && !pair.home) {
        pair.home = r;
        foundPair = true;
        break;
      }
      if (!r.isHome && !pair.away) {
        pair.away = r;
        foundPair = true;
        break;
      }
    }
    if (!foundPair) {
      const key = `${dateKey}-${r.team}-${Math.random().toString(36).slice(2, 6)}`;
      gameMap.set(key, r.isHome ? { home: r } : { away: r });
    }
  }

  const results: GameResult[] = [];
  const lgPerTeam = (lg.goalsPerGame || 6) / 2;

  for (const pair of gameMap.values()) {
    if (!pair.home || !pair.away) continue;

    const hStats = stats.get(pair.home.team);
    const aStats = stats.get(pair.away.team);

    // Simple lambda estimate: team's season avgGF adjusted by opponent avgGA relative to league
    const hLam = hStats && aStats
      ? (hStats.avgGoalsFor * (aStats.avgGoalsAgainst / lgPerTeam))
      : lgPerTeam;
    const aLam = hStats && aStats
      ? (aStats.avgGoalsFor * (hStats.avgGoalsAgainst / lgPerTeam))
      : lgPerTeam;

    results.push({
      homeGoals: pair.home.goalsFor,
      awayGoals: pair.away.goalsFor,
      homeLam: Math.max(0.5, Math.min(5.5, hLam)),
      awayLam: Math.max(0.5, Math.min(5.5, aLam)),
    });
  }

  return results;
}
