// ─── Tournament / March Madness Config ───
// All tunable constants for the tournament adjustment layer.

export const TOURNAMENT_CONFIG = {
  // Date threshold: games on or after this date are tournament games
  // Month is 0-indexed in JS (2 = March)
  tournamentStartMonth: 2,    // March
  tournamentStartDay: 14,     // March 14+

  // Confidence multipliers
  baseConfidenceMultiplier: 0.85,      // reduce confidence by 15% for all tournament games
  crossConferencePenalty: 0.05,        // additional 5% reduction for cross-conference
  highMismatchPenalty: 0.05,           // additional 5% reduction for high style mismatch
  confidenceFloor: 0.70,              // never reduce by more than 30%

  // Public bias
  publicBiasEdgeBoost: 0.008,         // 0.8% edge boost when fading public team
  publicSeedThreshold: 4,             // seeds 1-4 get public bias flag (if brand name)

  // Tempo/style mismatch
  tempoMismatchThreshold: 0.08,       // |delta tempo| / avgTempo > 8% = significant
  highMismatchThreshold: 0.15,        // > 15% = high mismatch
  tempoMismatchTotalAdjustment: -1.5, // points off projected total when significant mismatch

  // Short turnaround
  shortTurnaroundSpreadPenalty: 1.0,  // points added to spread for fatigued team

  // Sigma adjustment for tournament uncertainty
  tournamentSigmaMultiplier: 1.08,    // 8% wider scoring margin distribution
};
