// ─── NBA Config — Hybrid Pace-Projection + Devig Model ───
// Tighter edge thresholds now that we have an independent model signal.
// The model-market blend means edges are backed by basketball intelligence,
// not just cross-book pricing discrepancies.

export const NBA_CONFIG = {
  minEdge: {
    ml: 0.02,        // 2% — tighter now that we have model backing
    pl: 0.015,       // 1.5% — spreads are the sharpest market
    totals: 0.02,    // 2% — totals have more variance
  },
  // Projection weights
  recencyWeight: 0.40,        // 40% last 10, 60% full season
  modelWeight: 0.35,          // blend: 35% model, 65% sharp devig
  homeCourtAdj: 3.0,          // fallback home court points
  // Fatigue
  fatigueEnabled: true,
  b2bPenalty: 0.97,           // 3% scoring reduction for B2B
  restBonusPerDay: 0.008,     // slightly less than NHL
  maxRestBonus: 1.02,
  // Confidence
  depthDivisor: 60,           // 60 GP = full confidence (vs 82 game season)
};
