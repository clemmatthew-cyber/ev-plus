// ─── NBA Score Projections ───
// Projects home/away scores from pace-adjusted offensive/defensive ratings.
// Blends full season + last 10 with recency weighting, uses home/away splits,
// and applies fatigue adjustments.

import type { NbaTeamRatings } from "../stats/nba-stats";
import type { FatigueAdjustment } from "./fatigue";

export interface NbaProjection {
  homeScore: number;
  awayScore: number;
  margin: number;       // homeScore - awayScore (positive = home favored)
  total: number;        // homeScore + awayScore
  // Probabilities
  homeWinProb: number;  // moneyline / spread at 0
  awayWinProb: number;
  overProb: number;     // for a given total line
  underProb: number;
}

export interface NbaProjectionConfig {
  recencyWeight: number;     // weight for last 10 games (e.g. 0.40)
  homeCourtAdj: number;      // fallback home court advantage in points
}

/**
 * Blend full-season and last-10 ratings.
 */
function blendRating(full: number, last10: number, recencyWeight: number): number {
  return full * (1 - recencyWeight) + last10 * recencyWeight;
}

/**
 * Project NBA game score from team ratings.
 * Uses the Four Factors matchup approach:
 *   homeScore = ((homeOff + awayDef) / 2) * (matchupPace / 100)
 *   awayScore = ((awayOff + homeDef) / 2) * (matchupPace / 100)
 *
 * With recency blending and home/away splits.
 */
export function projectNbaScore(
  home: NbaTeamRatings,
  away: NbaTeamRatings,
  cfg: NbaProjectionConfig,
  fatigue?: FatigueAdjustment,
): { homeScore: number; awayScore: number; margin: number; total: number } {
  const rW = cfg.recencyWeight;

  // Blend full season + last 10 for each rating dimension
  // Use home/away specific splits for the team's venue
  const homeOff = blendRating(home.homeOffRtg, home.offRtg10, rW);
  const homeDef = blendRating(home.homeDefRtg, home.defRtg10, rW);
  const homePace = blendRating(home.homePace, home.pace10, rW);

  const awayOff = blendRating(away.awayOffRtg, away.offRtg10, rW);
  const awayDef = blendRating(away.awayDefRtg, away.defRtg10, rW);
  const awayPace = blendRating(away.awayPace, away.pace10, rW);

  // Matchup pace: average of both teams' pace
  const matchupPace = (homePace + awayPace) / 2;

  // Projected scores using matchup pace
  let homeScore = ((homeOff + awayDef) / 2) * (matchupPace / 100);
  let awayScore = ((awayOff + homeDef) / 2) * (matchupPace / 100);

  // Home court advantage: +1.5 points to home, -1.5 to away (total ~3 pt swing)
  homeScore += cfg.homeCourtAdj / 2;
  awayScore -= cfg.homeCourtAdj / 2;

  // Fatigue adjustments
  if (fatigue) {
    homeScore *= fatigue.homeFactor;
    awayScore *= fatigue.awayFactor;
  }

  return {
    homeScore,
    awayScore,
    margin: homeScore - awayScore,
    total: homeScore + awayScore,
  };
}

/**
 * Convert projected margin to moneyline win probability using logistic function.
 * Based on research: ~0.15 logistic slope fits NBA spread-to-prob conversion well.
 */
export function spreadToWinProb(projectedMargin: number): number {
  return 1 / (1 + Math.exp(-0.15 * projectedMargin));
}

/**
 * Normal CDF approximation for totals probabilities.
 * Uses the Abramowitz & Stegun approximation.
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Convert projected total to over/under probability using normal distribution.
 * sigma ~10 for NBA games (typical standard deviation of total scores).
 */
export function totalToOverProb(projectedTotal: number, line: number, sigma = 10): number {
  // P(total > line) = 1 - CDF((line - projectedTotal) / sigma)
  const z = (line - projectedTotal) / sigma;
  return 1 - normalCDF(z);
}

/**
 * Full NBA projection: scores + all market probabilities.
 */
export function projectNbaGame(
  home: NbaTeamRatings,
  away: NbaTeamRatings,
  cfg: NbaProjectionConfig,
  fatigue?: FatigueAdjustment,
  totalLine?: number,
  spreadLine?: number,
): NbaProjection {
  const { homeScore, awayScore, margin, total } = projectNbaScore(home, away, cfg, fatigue);

  // Moneyline probabilities from projected margin
  const homeWinProb = spreadToWinProb(margin);
  const awayWinProb = 1 - homeWinProb;

  // Totals probabilities (default to projected total as line if not given)
  const tLine = totalLine ?? total;
  const overProb = totalToOverProb(total, tLine);
  const underProb = 1 - overProb;

  return {
    homeScore,
    awayScore,
    margin,
    total,
    homeWinProb,
    awayWinProb,
    overProb,
    underProb,
  };
}

/**
 * Compute spread probability: P(team covers spread line).
 * e.g., if home is -5.5 and projected margin is -7, P(cover) = P(margin > 5.5)
 */
export function spreadCoverProb(projectedMargin: number, spreadLine: number): number {
  // spreadLine is from the team's perspective (negative = favored)
  // Team covers if actual margin > -spreadLine (for the team with the spread)
  // Using logistic: P(cover) ≈ spreadToWinProb(projectedMargin + spreadLine)
  return spreadToWinProb(projectedMargin + spreadLine);
}
