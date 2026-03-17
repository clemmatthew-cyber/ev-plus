// ─── Recent Form Factor + Home/Away Splits ───
// Computes team-level adjustments from recent NHL game results.
// Fix 1: Recency weighting via form factor (hot/cold teams)
// Fix 2: Per-team home/away splits (replaces flat homeIceAdvantage partially)

export interface RecentGameResult {
  team: string;
  goalsFor: number;
  goalsAgainst: number;
  date: string;
  isHome: boolean;
}

export interface FormConfig {
  formEnabled: boolean;
  formLookbackGames: number;
  formWeight: number;
  formFloor: number;
  formCeiling: number;
}

/**
 * Compute form factor for a team based on recent game results.
 * Returns a multiplier: >1 if team is overperforming, <1 if underperforming.
 *
 * Method: Compare recent goals-per-game to season average.
 * Weight more recent games higher (linear decay).
 */
export function computeFormFactor(
  team: string,
  recentGames: RecentGameResult[],
  seasonAvgGF: number,
  seasonAvgGA: number,
  cfg: FormConfig,
): number {
  if (!cfg.formEnabled) return 1.0;

  const teamGames = recentGames
    .filter(g => g.team === team)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, cfg.formLookbackGames);

  if (teamGames.length < 5) return 1.0; // not enough data

  // Linear decay weights: most recent game gets weight N, oldest gets weight 1
  const n = teamGames.length;
  let weightedGF = 0, weightedGA = 0, totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const w = n - i; // most recent = highest weight
    weightedGF += teamGames[i].goalsFor * w;
    weightedGA += teamGames[i].goalsAgainst * w;
    totalWeight += w;
  }

  const recentGFRate = weightedGF / totalWeight;
  const recentGARate = weightedGA / totalWeight;

  // Offensive form: how much better/worse than season average
  const offForm = seasonAvgGF > 0 ? recentGFRate / seasonAvgGF : 1.0;
  // Defensive form: inverted (fewer GA = better)
  const defForm = seasonAvgGA > 0 ? seasonAvgGA / recentGARate : 1.0;

  // Combined form factor (geometric mean of off + def)
  const rawForm = Math.sqrt(offForm * defForm);

  // Blend toward 1.0 based on formWeight
  const blended = 1.0 + (rawForm - 1.0) * cfg.formWeight;

  return Math.max(cfg.formFloor, Math.min(cfg.formCeiling, blended));
}

// ─── Fix 2: Per-Team Home/Away Splits ───

export interface HomeAwaySplit {
  homeOffenseFactor: number;
  homeDefenseFactor: number;
}

/**
 * Compute team-specific home/away split from recent results.
 * Returns how much better/worse the team performs at home vs away.
 */
export function computeHomeAwaySplit(
  team: string,
  recentGames: RecentGameResult[],
  cfg: { homeAwaySplitEnabled: boolean; homeAwaySplitWeight: number },
): HomeAwaySplit {
  if (!cfg.homeAwaySplitEnabled) return { homeOffenseFactor: 1.0, homeDefenseFactor: 1.0 };

  const teamGames = recentGames.filter(g => g.team === team);
  const homeGames = teamGames.filter(g => g.isHome);
  const awayGames = teamGames.filter(g => !g.isHome);

  if (homeGames.length < 5 || awayGames.length < 5) {
    return { homeOffenseFactor: 1.0, homeDefenseFactor: 1.0 };
  }

  const homeGFAvg = homeGames.reduce((s, g) => s + g.goalsFor, 0) / homeGames.length;
  const homeGAAvg = homeGames.reduce((s, g) => s + g.goalsAgainst, 0) / homeGames.length;

  const overallGFAvg = teamGames.reduce((s, g) => s + g.goalsFor, 0) / teamGames.length;
  const overallGAAvg = teamGames.reduce((s, g) => s + g.goalsAgainst, 0) / teamGames.length;

  // How much better is offense at home vs overall
  const rawOffFactor = overallGFAvg > 0 ? homeGFAvg / overallGFAvg : 1.0;
  // How much better is defense at home vs overall (lower GA = better, so invert)
  const rawDefFactor = overallGAAvg > 0 ? overallGAAvg / homeGAAvg : 1.0;

  // Blend toward 1.0
  const w = cfg.homeAwaySplitWeight;
  return {
    homeOffenseFactor: 1.0 + (rawOffFactor - 1.0) * w,
    homeDefenseFactor: 1.0 + (rawDefFactor - 1.0) * w,
  };
}
