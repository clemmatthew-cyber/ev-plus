// ─── xG-Based Lambda Estimation ───
// Situation-split (EV + PP/PK overlay), goalie adjustment, recency regression.
// Pure function — takes stats/config in, returns lambdas out.

import type { ModelConfig } from "./config";
import type { TeamStats, GoalieStats, LeagueAverages } from "../stats";

export interface MatchupLambdas {
  homeLam: number;
  awayLam: number;
  hasGoalieData: boolean;
}

/**
 * Compute per-game xG rate from season totals, blending xG with actual goals.
 * Optionally credits high-danger finishing overperformance.
 */
function xgRate(
  xg: number,
  goals: number,
  hdXg: number,
  hdGoals: number,
  gp: number,
  xgWeight: number,
  hdCredit: number,
): number {
  const base = (xg * xgWeight + goals * (1 - xgWeight)) / gp;
  // High-danger finishing credit: if team converts HD chances above xG, credit a fraction
  const hdDelta = ((hdGoals - hdXg) / gp) * hdCredit;
  return base + hdDelta;
}

/**
 * Compute even-strength lambda component for one team.
 *
 * Uses Dixon-Coles style: λ_EV = lg_avg × (team_off / lg_off) × (opp_def / lg_def)
 *
 * But with xG-based rates instead of raw goals.
 */
function evComponent(
  teamOff: number,   // team's 5v5 xG for rate (per game)
  oppDef: number,    // opponent's 5v5 xG against rate (per game)
  lgOff: number,     // league avg 5v5 xGF per team per game
  lgDef: number,     // league avg 5v5 xGA per team per game
): number {
  if (lgOff <= 0 || lgDef <= 0) return 1.5; // safety fallback
  return lgOff * (teamOff / lgOff) * (oppDef / lgDef);
}

/**
 * Compute power play / penalty kill goal expectation component.
 *
 * For home PP goals:
 *   - Home's PP offense strength × Away's PK defense weakness
 *   - Scaled by expected PP opportunities (driven by away team's penalty rate)
 */
function ppComponent(
  teamPpXgF: number,   // team's PP xGF (season total)
  oppPkXgA: number,    // opponent's PK xGA (season total)
  teamGP: number,
  oppGP: number,
  oppPenRate: number,  // opponent's penalties taken per game (= team's PP opps)
  lgPpXgPerGame: number,
  lgPPPerGame: number,
  ppBlend: number,     // xG vs actual blend
  teamPpGoalsF: number,
  oppPkGoalsA: number,
): number {
  if (lgPpXgPerGame <= 0 || lgPPPerGame <= 0) return 0;

  // Team's PP offense rate: blend of xG and actual
  const teamPpRate = (teamPpXgF * ppBlend + teamPpGoalsF * (1 - ppBlend)) / teamGP;
  const oppPkRate = (oppPkXgA * ppBlend + oppPkGoalsA * (1 - ppBlend)) / oppGP;

  // Strength indices relative to league average
  const ppStrength = teamPpRate / lgPpXgPerGame;
  const pkWeakness = oppPkRate / lgPpXgPerGame;

  // Scale by expected PP opportunities
  const expectedPPs = oppPenRate / lgPPPerGame;

  return lgPpXgPerGame * ppStrength * pkWeakness * expectedPPs;
}

/**
 * Goalie adjustment multiplier.
 *
 * Uses GSAx/60 to shift opponent's expected goals.
 * Better goalies (positive GSAx) → multiplier < 1 → opponent scores less.
 * Worse goalies (negative GSAx) → multiplier > 1 → opponent scores more.
 */
function goalieMultiplier(
  goalie: GoalieStats | null,
  lgAvgGsaxPer60: number,
  cfg: ModelConfig,
): number {
  if (!goalie || goalie.gamesPlayed < cfg.goalieMinGP) return 1.0;

  // GSAx/60 relative to league average
  const delta = goalie.gsaxPer60 - lgAvgGsaxPer60;

  // Convert to multiplier: positive delta (good goalie) → reduce opponent lambda
  let mult = 1.0 - delta * cfg.goalieImpactScale;
  return Math.max(cfg.goalieFloor, Math.min(cfg.goalieCeiling, mult));
}

/**
 * Recency regression: pull extreme lambdas toward league average.
 *
 * With only season aggregates (no per-game xG logs), we approximate
 * recency by regressing teams with many GP slightly toward the mean.
 * This prevents the model from overweighting early-season noise for
 * teams deep into the season.
 */
function applyRecencyRegression(
  lam: number,
  gp: number,
  lgPerTeam: number,
  cfg: ModelConfig,
): number {
  if (gp < cfg.recencyMinGP) return lam;
  // Linear regression toward league avg
  return lam * (1 - cfg.recencyRegression) + lgPerTeam * cfg.recencyRegression;
}

/**
 * Main lambda estimation function.
 *
 * Takes home/away team stats, goalie stats, league averages, and config.
 * Returns adjusted per-game goal expectations for each team.
 */
export function estimateMatchupLambdas(
  home: TeamStats,
  away: TeamStats,
  homeGoalie: GoalieStats | null,
  awayGoalie: GoalieStats | null,
  lg: LeagueAverages,
  lgAvgGsaxPer60: number,
  cfg: ModelConfig,
): MatchupLambdas {
  const gpH = home.gamesPlayed || 1;
  const gpA = away.gamesPlayed || 1;

  // ── 1. Even-strength (5v5) component ──
  const hEvOff = xgRate(
    home.ev.xGoalsFor, home.ev.goalsFor,
    home.ev.highDangerXgFor, home.ev.highDangerGoalsFor,
    gpH, cfg.xgWeight, cfg.hdFinishingCredit,
  );
  const hEvDef = xgRate(
    home.ev.xGoalsAgainst, home.ev.goalsAgainst,
    home.ev.highDangerXgAgainst, home.ev.highDangerGoalsAgainst,
    gpH, cfg.xgWeight, cfg.hdFinishingCredit,
  );
  const aEvOff = xgRate(
    away.ev.xGoalsFor, away.ev.goalsFor,
    away.ev.highDangerXgFor, away.ev.highDangerGoalsFor,
    gpA, cfg.xgWeight, cfg.hdFinishingCredit,
  );
  const aEvDef = xgRate(
    away.ev.xGoalsAgainst, away.ev.goalsAgainst,
    away.ev.highDangerXgAgainst, away.ev.highDangerGoalsAgainst,
    gpA, cfg.xgWeight, cfg.hdFinishingCredit,
  );

  const lgEvF = lg.evXgForPerGame || 1.5;
  const lgEvA = lg.evXgAgainstPerGame || 1.5;

  const ev5v5_h = evComponent(hEvOff, aEvDef, lgEvF, lgEvA);
  const ev5v5_a = evComponent(aEvOff, hEvDef, lgEvF, lgEvA);

  // ── 2. PP/PK component ──
  const lgPP = lg.ppPerGame || cfg.lgAvgPPPerGame;
  const lgPpXg = lg.ppXgPerGame || 0.5;

  // Away team's penalty rate determines home PP opportunities (and vice versa)
  const awayPenRate = away.all.penaltiesAgainst / gpA || lgPP;
  const homePenRate = home.all.penaltiesAgainst / gpH || lgPP;

  const ppH = ppComponent(
    home.pp.xGoalsFor, away.pk.xGoalsAgainst,
    gpH, gpA, awayPenRate,
    lgPpXg, lgPP, cfg.ppXgBlend,
    home.pp.goalsFor, away.pk.goalsAgainst,
  );
  const ppA = ppComponent(
    away.pp.xGoalsFor, home.pk.xGoalsAgainst,
    gpA, gpH, homePenRate,
    lgPpXg, lgPP, cfg.ppXgBlend,
    away.pp.goalsFor, home.pk.goalsAgainst,
  );

  // ── 3. Combine: EV + PP + other situations + home/away adjustment ──
  // otherSituationsPerTeam covers 4v4, 3v3, empty-net, shorthanded goals
  let homeLam = ev5v5_h + ppH + cfg.otherSituationsPerTeam + cfg.homeIceAdvantage;
  let awayLam = ev5v5_a + ppA + cfg.otherSituationsPerTeam - cfg.awayPenalty;

  // ── 4. Goalie adjustment ──
  const hasGoalieData = !!(
    homeGoalie && homeGoalie.gamesPlayed >= cfg.goalieMinGP &&
    awayGoalie && awayGoalie.gamesPlayed >= cfg.goalieMinGP
  );

  // Home goalie affects away team's scoring
  const hGMult = goalieMultiplier(homeGoalie, lgAvgGsaxPer60, cfg);
  awayLam *= hGMult;

  // Away goalie affects home team's scoring
  const aGMult = goalieMultiplier(awayGoalie, lgAvgGsaxPer60, cfg);
  homeLam *= aGMult;

  // ── 5. Recency regression ──
  const lgPerTeam = (lg.goalsPerGame || 6) / 2;
  homeLam = applyRecencyRegression(homeLam, gpH, lgPerTeam, cfg);
  awayLam = applyRecencyRegression(awayLam, gpA, lgPerTeam, cfg);

  // ── 6. Clamp ──
  homeLam = Math.max(cfg.lambdaMin, Math.min(cfg.lambdaMax, homeLam));
  awayLam = Math.max(cfg.lambdaMin, Math.min(cfg.lambdaMax, awayLam));

  return { homeLam, awayLam, hasGoalieData };
}
