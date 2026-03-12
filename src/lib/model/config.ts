// ─── Model Configuration — All Tunable Constants ───
// Every magic number in the model lives here. Change these to tune behavior.

export interface ModelConfig {
  // ─── Bankroll & Staking ───
  bankroll: number;
  peakBankroll: number;           // for drawdown tracking
  minStake: number;
  maxStake: number;

  // ─── Edge Thresholds (per market) ───
  minEdge: {
    ml: number;
    pl: number;
    totals: number;
  };

  // ─── Kelly ───
  kellyFraction: number;          // base quarter-Kelly = 0.25
  kellyDrawdownFloor: number;     // min Kelly when at max drawdown = 0.15
  drawdownThresholds: {
    start: number;                // start scaling Kelly at this drawdown (0.10 = 10%)
    max: number;                  // full floor at this drawdown (0.20 = 20%)
  };

  // ─── Grade-based Stake Scaling ───
  gradeMultiplier: {
    A: number;
    B: number;
    C: number;
    D: number;
  };

  // ─── Lambda Estimation ───
  homeIceAdvantage: number;       // added to home lambda
  awayPenalty: number;            // subtracted from away lambda
  xgWeight: number;               // weight for xG vs actual goals (0-1, higher = more xG)
  hdFinishingCredit: number;      // fraction of high-danger overperformance to credit

  // ─── Goalie Adjustment ───
  goalieMinGP: number;            // min games played to use goalie data
  // Multiplier = 1 - (goalie_gsax_rate - lg_avg) * goalieImpactScale
  // If goalie is better than average: multiplier < 1 (reduces opponent lambda)
  // If worse: multiplier > 1 (increases opponent lambda)
  goalieImpactScale: number;      // how much GSAx moves the lambda
  goalieFloor: number;            // min goalie multiplier (don't let it go crazy)
  goalieCeiling: number;          // max goalie multiplier

  // ─── Recency Weighting ───
  // Since we only have season totals (not per-game logs) from MoneyPuck,
  // we approximate recency by regressing extreme rates toward league average
  // more aggressively for teams with many games played.
  recencyRegression: number;      // fraction to regress toward league avg (0.05 = 5%)
  recencyMinGP: number;           // don't apply regression until this many GP

  // ─── PP/PK Estimation ───
  lgAvgPPPerGame: number;         // fallback league avg power plays per team per game
  ppXgBlend: number;              // xG vs actual goals blend for special teams (0-1)

  // ─── Confidence Scoring ───
  confidence: {
    edgeWeight: number;           // weight for edge magnitude
    agreementWeight: number;      // weight for model-market agreement
    depthWeight: number;          // weight for games played depth
    bookWeight: number;           // weight for number of books
    priceWeight: number;          // weight for price efficiency (avoid extremes)
    goalieWeight: number;         // weight for goalie data availability
  };
  confidenceGradeCutoffs: {
    A: number;
    B: number;
    C: number;
  };

  // ─── Disagreement Penalty ───
  disagreementThreshold: number;  // |modelProb - fairProb| above this → penalty
  disagreementPenaltyMax: number; // max points subtracted from confidence
  disagreementBonus: number;      // points added when model ≈ fair

  // ─── Poisson Grid ───
  poissonMaxGoals: number;        // upper bound for summation grid (12 covers 99.9%+ of NHL games)

  // ─── Other Situations Scalar ───
  // 5v5 + PP/PK don't capture 4v4, 3v3, empty-net, shorthanded goals.
  // This additive term per team covers the ~0.5 goals/team/game gap.
  otherSituationsPerTeam: number;

  // ─── Lambda Clamping ───
  lambdaMin: number;
  lambdaMax: number;

  // ─── Monte Carlo Simulation ───
  simCount: number;              // number of simulation iterations (default 50000)
  otHomeAdvantage: number;       // home team OT/SO win probability (default 0.53)

  // ─── Dixon-Coles ───
  dixonColesRho: number;         // low-score correlation parameter (default -0.04)

  // ─── Fatigue ───
  fatigueEnabled: boolean;
  b2bPenalty: number;            // back-to-back multiplier (default 0.95)
  restBonusPerDay: number;       // per-day rest bonus (default 0.01)
  maxRestBonus: number;          // cap on rest bonus (default 1.03)
  travelPenaltyPerKm: number;   // per-km travel penalty (default 0, disabled)
  timezonePenaltyPerHour: number; // per-hour TZ penalty (default 0, disabled)
}

export const DEFAULT_CONFIG: ModelConfig = {
  bankroll: 3000,
  peakBankroll: 3000,
  minStake: 10,
  maxStake: Infinity,

  minEdge: {
    ml: 0.03,
    pl: 0.04,
    totals: 0.045,
  },

  kellyFraction: 0.25,
  kellyDrawdownFloor: 0.15,
  drawdownThresholds: {
    start: 0.10,
    max: 0.20,
  },

  gradeMultiplier: {
    A: 1.0,
    B: 0.5,
    C: 0.15,
    D: 0.0,
  },

  homeIceAdvantage: 0.12,
  awayPenalty: 0.04,
  xgWeight: 0.70,
  hdFinishingCredit: 0.15,

  goalieMinGP: 10,
  goalieImpactScale: 0.08,
  goalieFloor: 0.90,
  goalieCeiling: 1.10,

  recencyRegression: 0.06,
  recencyMinGP: 40,

  lgAvgPPPerGame: 3.2,
  ppXgBlend: 0.60,

  confidence: {
    edgeWeight: 0.28,
    agreementWeight: 0.22,
    depthWeight: 0.14,
    bookWeight: 0.14,
    priceWeight: 0.10,
    goalieWeight: 0.12,
  },
  confidenceGradeCutoffs: {
    A: 70,
    B: 50,
    C: 30,
  },

  disagreementThreshold: 0.08,
  disagreementPenaltyMax: 15,
  disagreementBonus: 5,

  poissonMaxGoals: 12,

  otherSituationsPerTeam: 0.55,

  lambdaMin: 0.8,
  lambdaMax: 5.5,

  // Monte Carlo
  simCount: 50000,
  otHomeAdvantage: 0.53,

  // Dixon-Coles
  dixonColesRho: -0.04,

  // Fatigue
  fatigueEnabled: true,
  b2bPenalty: 0.95,
  restBonusPerDay: 0.01,
  maxRestBonus: 1.03,
  travelPenaltyPerKm: 0,
  timezonePenaltyPerHour: 0,
};
