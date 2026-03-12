// ─── Dixon-Coles Low-Score Correlation Correction ───
// Adjusts independent Poisson probabilities for low-score outcomes
// where empirical NHL data shows dependence (draws more likely than independence predicts).

/**
 * Dixon-Coles tau factor for a given score.
 * rho < 0 means low-scoring draws are more likely than independence predicts.
 * NHL default: rho = -0.04 (based on published literature)
 */
export function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  homeLam: number,
  awayLam: number,
  rho: number,
): number {
  if (homeGoals === 0 && awayGoals === 0) return 1 - homeLam * awayLam * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + awayLam * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + homeLam * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1.0;
}

/**
 * Apply Dixon-Coles correction to a pre-built Poisson grid.
 * Modifies grid in-place and renormalizes so it sums to 1.
 */
export function applyDixonColesToGrid(
  grid: number[][],
  homeLam: number,
  awayLam: number,
  rho: number,
): void {
  const maxH = grid.length - 1;
  const maxA = grid[0].length - 1;

  // Apply tau to low-score cells
  for (let h = 0; h <= Math.min(1, maxH); h++) {
    for (let a = 0; a <= Math.min(1, maxA); a++) {
      grid[h][a] *= dixonColesTau(h, a, homeLam, awayLam, rho);
    }
  }

  // Renormalize so grid sums to 1
  let total = 0;
  for (let h = 0; h <= maxH; h++) {
    for (let a = 0; a <= maxA; a++) {
      total += grid[h][a];
    }
  }
  if (total > 0 && total !== 1) {
    const scale = 1 / total;
    for (let h = 0; h <= maxH; h++) {
      for (let a = 0; a <= maxA; a++) {
        grid[h][a] *= scale;
      }
    }
  }
}
