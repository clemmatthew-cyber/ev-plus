// ─── NCAAB Independent Probability Model ───
// Uses Bart Torvik team efficiency data to compute win probability,
// projected spread, and projected total independently of sportsbook odds.
//
// Model: efficiency-based expected points + normal CDF for win probability.

import type { TorvikStats } from "../stats/torvik";
import { leagueAvgEfficiency } from "../stats/torvik";
import { NCAAB_CONFIG } from "./ncaab-config";

/**
 * Normal CDF approximation (Abramowitz & Stegun, max error 1.5e-7).
 */
export function normalCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1 + sign * y);
}

export interface NcaabProjection {
  homeExpectedPts: number;
  awayExpectedPts: number;
  projectedSpread: number;  // negative = home favored
  projectedTotal: number;
  homeWinProb: number;
  awayWinProb: number;
}

/**
 * Compute expected points and probabilities for an NCAAB matchup
 * using Torvik efficiency data.
 *
 * Formula (standard KenPom/Torvik methodology):
 *   teamExpPts = teamAdjOE * oppAdjDE / leagueAvgEff * gameTempo / 100
 *
 * Home court advantage applied additively (+HCA/2 to home, -HCA/2 to away).
 * Win probability via normal CDF of point differential / sigma.
 */
export function computeNcaabProjection(
  homeStats: TorvikStats,
  awayStats: TorvikStats,
  isNeutralSite = false,
): NcaabProjection {
  const modelParams = NCAAB_CONFIG.ncaabModel;
  const avgEff = leagueAvgEfficiency;

  const gameTempo = (homeStats.tempo + awayStats.tempo) / 2;

  // Expected points: teamAdjOE * oppAdjDE / leagueAvg * gameTempo / 100
  // This normalizes the interaction term by the league average efficiency
  const homeExpNeutral = homeStats.adjOE * awayStats.adjDE / avgEff * gameTempo / 100;
  const awayExpNeutral = awayStats.adjOE * homeStats.adjDE / avgEff * gameTempo / 100;

  // Additive home court advantage: split between home boost and away penalty
  const hca = isNeutralSite ? 0 : modelParams.homeCourtAdvantage;
  const homeExpectedPts = homeExpNeutral + hca / 2;
  const awayExpectedPts = awayExpNeutral - hca / 2;

  const expectedDiff = homeExpectedPts - awayExpectedPts;
  const sigma = modelParams.scoringMarginSigma;

  const homeWinProb = normalCDF(expectedDiff / sigma);
  const awayWinProb = 1 - homeWinProb;

  const projectedSpread = -expectedDiff; // Negative = home favored (convention)
  const projectedTotal = homeExpectedPts + awayExpectedPts;

  return {
    homeExpectedPts,
    awayExpectedPts,
    projectedSpread,
    projectedTotal,
    homeWinProb,
    awayWinProb,
  };
}

/**
 * Get the model win probability for a specific team in a matchup.
 * Returns the probability that `teamName` wins.
 */
export function getTeamWinProb(
  teamName: string,
  homeTeam: string,
  homeStats: TorvikStats,
  awayStats: TorvikStats,
  isNeutralSite = false,
): number {
  const proj = computeNcaabProjection(homeStats, awayStats, isNeutralSite);
  return teamName === homeTeam ? proj.homeWinProb : proj.awayWinProb;
}
