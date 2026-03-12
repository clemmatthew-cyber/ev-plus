// ─── Poisson Probability Engine ───
// Pure functions — no side effects, no imports except config types.
// All probability grids are computed over [0..maxGoals] × [0..maxGoals].

/**
 * Poisson probability mass function.
 * P(X = k) where X ~ Poisson(λ)
 */
export function poissonPmf(k: number, lam: number): number {
  // Direct computation avoids factorial overflow for small k
  let r = Math.exp(-lam);
  for (let i = 1; i <= k; i++) r *= lam / i;
  return r;
}

/**
 * Precompute Poisson PMF vector for a given lambda.
 * Returns array of P(X=0), P(X=1), ..., P(X=max).
 */
export function poissonVector(lam: number, max: number): number[] {
  const v = new Array(max + 1);
  v[0] = Math.exp(-lam);
  for (let k = 1; k <= max; k++) v[k] = v[k - 1] * lam / k;
  return v;
}

/**
 * Build full 2D probability grid for (homeGoals, awayGoals).
 * grid[h][a] = P(home scores h) × P(away scores a)
 */
export function buildGrid(
  homeLam: number,
  awayLam: number,
  max: number,
): number[][] {
  const hv = poissonVector(homeLam, max);
  const av = poissonVector(awayLam, max);
  const grid: number[][] = [];
  for (let h = 0; h <= max; h++) {
    grid[h] = [];
    for (let a = 0; a <= max; a++) {
      grid[h][a] = hv[h] * av[a];
    }
  }
  return grid;
}

// ─── Grid-based probability functions (accept pre-built grid) ───
// All functions accept either (lambda, lambda, max) for convenience
// or a pre-built grid for efficiency when computing multiple markets.

/**
 * Moneyline probability for `team` side.
 * NHL: regulation ties go to OT/SO → ~50/50 split.
 */
export function mlProb(
  teamLam: number,
  oppLam: number,
  max: number,
  grid?: number[][],
): number {
  const g = grid ?? buildGrid(teamLam, oppLam, max);
  let win = 0;
  let draw = 0;
  for (let t = 0; t <= max; t++) {
    for (let o = 0; o <= max; o++) {
      if (t > o) win += g[t][o];
      else if (t === o) draw += g[t][o];
    }
  }
  return win + draw * 0.5; // OT/SO is coin flip
}

/**
 * Puckline (spread) probability.
 * @param spread from the team's perspective:
 *   -1.5 → team must win by 2+ (favorite side)
 *   +1.5 → team can lose by 1 and still cover (underdog side)
 */
export function plProb(
  teamLam: number,
  oppLam: number,
  spread: number,
  max: number,
  grid?: number[][],
): number {
  const g = grid ?? buildGrid(teamLam, oppLam, max);
  let cover = 0;
  for (let t = 0; t <= max; t++) {
    for (let o = 0; o <= max; o++) {
      const margin = t - o;
      if (spread < 0) {
        if (margin > Math.abs(spread)) cover += g[t][o];
      } else {
        if (margin >= -spread) cover += g[t][o];
      }
    }
  }
  return cover;
}

/**
 * Totals (over/under) probability.
 */
export function totalProb(
  homeLam: number,
  awayLam: number,
  line: number,
  over: boolean,
  max: number,
  grid?: number[][],
): number {
  const g = grid ?? buildGrid(homeLam, awayLam, max);
  let p = 0;
  for (let h = 0; h <= max; h++) {
    for (let a = 0; a <= max; a++) {
      const total = h + a;
      if (over && total > line) p += g[h][a];
      if (!over && total < line) p += g[h][a];
    }
  }
  return p;
}
