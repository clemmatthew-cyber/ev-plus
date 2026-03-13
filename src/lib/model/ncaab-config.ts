// ─── NCAAB Config Overrides ───
// College basketball has wider line variation than NBA due to:
// - Larger number of teams/games → more pricing inefficiency
// - Less sharp market overall → bigger cross-book edges
// - More variance in team quality → spreads move more
//
// Uses the same devig model as NBA but with tuned thresholds.

export const NCAAB_CONFIG = {
  minEdge: {
    ml: 0.008,      // 0.8% — slightly higher than NBA; college ML lines can be noisy
    pl: 0.006,      // 0.6% — spreads are where the value lives in NCAAB
    totals: 0.006,  // 0.6% — totals vary more across books in college
  },
};
