// ─── NCAAB Config Overrides ───
// College basketball has wider line variation than NBA due to:
// - Larger number of teams/games → more pricing inefficiency
// - Less sharp market overall → bigger cross-book edges
// - More variance in team quality → spreads move more
//
// Includes statistical model parameters and NCAAB-specific confidence weights.

export const NCAAB_CONFIG = {
  // ─── Edge Thresholds ───
  minEdge: {
    ml: 0.008,      // 0.8% — slightly higher than NBA; college ML lines can be noisy
    pl: 0.006,      // 0.6% — spreads are where the value lives in NCAAB
    totals: 0.006,  // 0.6% — totals vary more across books in college
  },

  // ─── Statistical Model Parameters ───
  ncaabModel: {
    homeCourtAdvantage: 3.5,     // points — well-studied NCAAB HCA
    scoringMarginSigma: 11.0,    // std dev of scoring margin in NCAAB
    leagueAvgPtsPerPoss: 1.0,    // NCAA D1 average (~1.0 pts per possession)
    seasonGamesPlayed: 33,       // typical NCAAB regular season length
  },

  // ─── Confidence Weight Overrides for NCAAB ───
  confidence: {
    edgeWeight: 0.25,        // keep — edge magnitude matters
    agreementWeight: 0.20,   // NOW MEANINGFUL — model vs devig agreement
    depthWeight: 0.10,       // slightly lower — less data in NCAAB
    bookWeight: 0.12,        // keep — more books = better
    priceWeight: 0.08,       // keep — avoid extremes
    goalieWeight: 0.00,      // ZERO — no goalies in basketball
    sharpBookWeight: 0.10,   // keep — sportsbook intelligence
  },
};
