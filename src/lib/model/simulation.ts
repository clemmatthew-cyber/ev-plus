// ─── Monte Carlo Simulation Engine ───
// Pure functions, no side effects. Simulates NHL games using Poisson sampling
// with Dixon-Coles importance weighting and OT/SO resolution.

import { dixonColesTau } from "./dixon-coles";

export interface SimConfig {
  simCount: number;         // number of iterations (default 50000)
  otHomeAdvantage: number;  // home team OT/SO win probability (default 0.53)
  dixonColesRho: number;    // Dixon-Coles rho parameter (default -0.04)
}

export interface SimulationResult {
  homeWinProb: number;
  awayWinProb: number;
  drawRegProb: number;
  spreadProbs: Map<number, { homeCovers: number; awayCovers: number }>;
  totalProbs: Map<number, { over: number; under: number }>;
  scoreDistribution: number[][];
  totalGoalsDist: number[];
}

/** Poisson random variate via inverse CDF method. */
function poissonSample(lam: number): number {
  if (lam <= 0) return 0;
  // N-1: Normal approximation for very large lambda (avoids exp(-lam) underflow)
  if (lam > 500) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lam + Math.sqrt(lam) * z));
  }
  const L = Math.exp(-lam);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

/**
 * Run Monte Carlo simulation for a single NHL game.
 * Uses importance weighting with Dixon-Coles tau factors.
 */
export function simulateGame(
  homeLam: number,
  awayLam: number,
  cfg: SimConfig,
): SimulationResult {
  // N-19: Validate simulation inputs
  if (cfg.simCount <= 0) throw new Error('simulateGame: simCount must be positive');
  if (cfg.otHomeAdvantage < 0 || cfg.otHomeAdvantage > 1) {
    throw new Error('simulateGame: otHomeAdvantage must be in [0,1]');
  }
  const { simCount, otHomeAdvantage, dixonColesRho: rho } = cfg;

  // Pre-allocate score distribution (N-24: configurable max score)
  const maxScore = cfg.simMaxScore ?? 15;
  const scoreDist: number[][] = [];
  for (let h = 0; h <= maxScore; h++) {
    scoreDist[h] = new Array(maxScore + 1).fill(0);
  }
  const totalGoalsDist: number[] = new Array(maxScore * 2 + 1).fill(0);

  let homeWinWeight = 0;
  let awayWinWeight = 0;
  let drawRegWeight = 0;
  let totalWeight = 0;

  // Spread tracking (N-18: configurable spread lines)
  const spreadLines = cfg.simSpreadLines ?? [-1.5, 1.5, -2.5, 2.5];
  const spreadCounts = new Map<number, { homeCovers: number; awayCovers: number }>();
  for (const s of spreadLines) {
    spreadCounts.set(s, { homeCovers: 0, awayCovers: 0 });
  }

  // Total tracking: common NHL totals
  const totalLines = [4.5, 5, 5.5, 6, 6.5, 7];
  const totalCounts = new Map<number, { over: number; under: number }>();
  for (const t of totalLines) {
    totalCounts.set(t, { over: 0, under: 0 });
  }

  for (let i = 0; i < simCount; i++) {
    const hGoals = poissonSample(homeLam);
    const aGoals = poissonSample(awayLam);

    // Dixon-Coles importance weight
    const tau = dixonColesTau(hGoals, aGoals, homeLam, awayLam, rho);
    totalWeight += tau;

    // Score distribution
    const hCapped = Math.min(hGoals, maxScore);
    const aCapped = Math.min(aGoals, maxScore);
    scoreDist[hCapped][aCapped] += tau;

    const totalGoals = hGoals + aGoals;
    if (totalGoals <= maxScore * 2) {
      totalGoalsDist[totalGoals] += tau;
    }

    // N-2: NHL moneyline includes OT — homeWinProb + awayWinProb intentionally sums > 1.0
    // Each represents the probability of that team ultimately winning (reg or OT)
    // drawRegProb tracks regulation draws separately for puckline/period markets
    if (hGoals > aGoals) {
      homeWinWeight += tau;
    } else if (aGoals > hGoals) {
      awayWinWeight += tau;
    } else {
      drawRegWeight += tau;
      // OT/SO resolution
      if (Math.random() < otHomeAdvantage) {
        homeWinWeight += tau;
      } else {
        awayWinWeight += tau;
      }
    }

    // Spread evaluation (regulation margin)
    const margin = hGoals - aGoals;
    for (const s of spreadLines) {
      const entry = spreadCounts.get(s)!;
      if (s < 0) {
        // Favorite side: home must win by more than |spread|
        if (margin > Math.abs(s)) entry.homeCovers += tau;
        if (-margin > Math.abs(s)) entry.awayCovers += tau;
      } else {
        // Underdog side: team can lose by less than spread
        if (margin >= -s) entry.homeCovers += tau;
        if (-margin >= -s) entry.awayCovers += tau;
      }
    }

    // Total evaluation
    for (const line of totalLines) {
      const entry = totalCounts.get(line)!;
      if (totalGoals > line) entry.over += tau;
      else if (totalGoals < line) entry.under += tau;
      // N-25: push on exact total tracked implicitly (neither over nor under incremented)
    }
  }

  // Normalize all weights
  const norm = totalWeight > 0 ? 1 / totalWeight : 0;

  // Normalize score distribution
  for (let h = 0; h <= maxScore; h++) {
    for (let a = 0; a <= maxScore; a++) {
      scoreDist[h][a] *= norm;
    }
  }
  for (let n = 0; n < totalGoalsDist.length; n++) {
    totalGoalsDist[n] *= norm;
  }

  // Normalize spread probs
  const spreadProbs = new Map<number, { homeCovers: number; awayCovers: number }>();
  for (const [s, counts] of spreadCounts) {
    spreadProbs.set(s, {
      homeCovers: counts.homeCovers * norm,
      awayCovers: counts.awayCovers * norm,
    });
  }

  // Normalize total probs
  const totalProbs = new Map<number, { over: number; under: number }>();
  for (const [t, counts] of totalCounts) {
    totalProbs.set(t, {
      over: counts.over * norm,
      under: counts.under * norm,
    });
  }

  return {
    homeWinProb: homeWinWeight * norm,
    awayWinProb: awayWinWeight * norm,
    drawRegProb: drawRegWeight * norm,
    spreadProbs,
    totalProbs,
    scoreDistribution: scoreDist,
    totalGoalsDist,
  };
}
