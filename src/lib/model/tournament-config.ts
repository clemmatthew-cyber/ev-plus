// ─── Tournament / March Madness Config ───
// All tunable constants for the tournament adjustment layer.

export const TOURNAMENT_CONFIG = {
  // Date threshold: games on or after this date are tournament games
  // Month is 0-indexed in JS (2 = March)
  tournamentStartMonth: 2,    // March
  tournamentStartDay: 14,     // March 14+

  // Conference tournament date range (before NCAA tournament)
  confTournamentStartDay: 4,  // March 4
  confTournamentEndDay: 15,   // March 15 (Selection Sunday)

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
  shortTurnaroundPenalty: 1.5,        // points deducted for back-to-back (<24h)

  // Sigma adjustment for tournament uncertainty
  tournamentSigmaMultiplier: 1.08,    // 8% wider scoring margin distribution
};

// Known conference tournament neutral-site venues
export const CONFERENCE_TOURNAMENT_VENUES: string[] = [
  'T-Mobile Center',       // Big 12
  'United Center',         // Big Ten
  'Greensboro',            // ACC
  'Bridgestone Arena',     // SEC
  'Madison Square Garden', // Big East
  'T-Mobile Arena',        // Pac-12/WCC
  'Orleans Arena',         // WAC/others
  'Boardwalk Hall',        // misc
];

// Actual NCAA tournament seeds — populated after Selection Sunday.
// Keys = Torvik team names. When empty, falls back to Barthag estimation.
export const ACTUAL_SEEDS: Record<string, number> = {
  // e.g. 'Houston': 1, 'Auburn': 1, 'Duke': 1, 'Florida': 1, ...
};
