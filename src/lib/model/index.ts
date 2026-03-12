// ─── Model Barrel Export ───
// Re-exports everything for clean imports.

export { DEFAULT_CONFIG, type ModelConfig } from "./config";
export { poissonPmf, poissonVector, buildGrid, mlProb, plProb, totalProb } from "./poisson";  // buildGrid already exported
export { americanToImplied, americanToDecimal, shinDevig, multiplicativeDevig, fairProbForOutcome } from "./devig";
export { estimateMatchupLambdas, type MatchupLambdas } from "./lambdas";
export { adjustedKellyFraction, rawKelly, computeStake } from "./kelly";
export { computeConfidence, type ConfidenceResult } from "./confidence";
export { generateEvBets, type GenerateInput } from "./generate";
export { generateNbaEvBets } from "./nba";
export { NBA_CONFIG } from "./nba-config";
