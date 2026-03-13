// ─── Model Barrel Export ───
// Re-exports everything for clean imports.

export { DEFAULT_CONFIG, type ModelConfig } from "./config";
export { poissonPmf, poissonVector, buildGrid, buildGridDC, mlProb, plProb, totalProb } from "./poisson";
export { simulateGame, type SimulationResult } from "./simulation";
export { dixonColesTau, applyDixonColesToGrid } from "./dixon-coles";
export { computeFatigueAdjustment, type FatigueAdjustment, type ScheduleEntry } from "./fatigue";
export { americanToImplied, americanToDecimal, shinDevig, multiplicativeDevig, fairProbForOutcome } from "./devig";
export { estimateMatchupLambdas, type MatchupLambdas } from "./lambdas";
export { adjustedKellyFraction, rawKelly, computeStake } from "./kelly";
export { computeConfidence, type ConfidenceResult } from "./confidence";
export { generateEvBets, type GenerateInput } from "./generate";
export { generateNbaEvBets } from "./nba";
export { NBA_CONFIG } from "./nba-config";
export { NCAAB_CONFIG } from "./ncaab-config";
export { generateNcaabEvBets } from "./ncaab-engine";
export { computeNcaabProjection, getTeamWinProb, type NcaabProjection } from "./ncaab-model";
export { detectTournamentContext, computeTournamentAdjustments, buildTournamentSnapshot, estimateSeed, detectPublicBias, type TournamentContext, type TournamentAdjustments, type TournamentSnapshot } from "./tournament";
export { TOURNAMENT_CONFIG } from "./tournament-config";
