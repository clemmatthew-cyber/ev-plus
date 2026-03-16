// ─── MMA Config Overrides ───
// MMA lines are less efficient than major sports due to:
// - Smaller fighter pool + less betting volume → more pricing inefficiency
// - Moneyline-only markets (no spreads/totals)
// - High variance sport with finish outcomes
//
// Only h2h (moneyline) market is available for MMA.
// pl/totals thresholds are included to satisfy the ModelConfig type but won't fire.

export const MMA_CONFIG = {
  // ─── Edge Thresholds ───
  minEdge: {
    ml: 0.025,      // 2.5% — MMA lines are less efficient than major sports
    pl: 0.04,       // won't be used (no spreads in MMA) but required by type
    totals: 0.045,  // won't be used (no totals in MMA) but required by type
  },

  // ─── Confidence Weight Overrides for MMA ───
  confidence: {
    edgeWeight: 0.30,        // Edge matters most in MMA
    agreementWeight: 0.25,   // Model vs devig agreement — very important
    depthWeight: 0.00,       // No "games played" concept
    bookWeight: 0.15,        // More books = better
    priceWeight: 0.10,       // Avoid extreme favorites
    goalieWeight: 0.00,      // No goalies
    sharpBookWeight: 0.10,   // Sportsbook intelligence
  },
};
