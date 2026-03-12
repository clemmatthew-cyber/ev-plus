// ─── NBA Config Overrides ───
// Devig-only model with limited book coverage (3-5 books).
// Cross-book edges are naturally smaller than model-vs-market edges,
// but they're real and reliable — they represent actual pricing
// discrepancies between books. We use lower thresholds and let
// the confidence grading filter for quality.

export const NBA_CONFIG = {
  minEdge: {
    ml: 0.005,      // 0.5% — small but real cross-book edges
    pl: 0.005,      // 0.5% — spreads often have more variation
    totals: 0.005,  // 0.5% — totals can diverge between books
  },
};
