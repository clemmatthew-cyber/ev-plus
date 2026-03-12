// ─── EV Engine v4 — Sport-Aware Router ───
// NHL → full Poisson xG model (stats + goalies + situation splits)
// NBA → pure devig model (odds-only, consensus fair prob)
// MMA → pure devig model (same as NBA, 2-way markets)

import type { EvBet } from "./types";
import { fetchNhlOdds } from "./odds";
import { fetchTeamStats, fetchGoalieStats, leagueAverages, leagueAvg } from "./stats";
import { generateEvBets, DEFAULT_CONFIG, generateNbaEvBets, type ModelConfig } from "./model";

/**
 * Run the full EV pipeline: fetch data → model → scored bets.
 * Routes to the correct model based on sport.
 */
export async function runPipeline(
  sport = "nhl",
  configOverrides?: Partial<ModelConfig>,
): Promise<EvBet[]> {
  const config: ModelConfig = configOverrides
    ? { ...DEFAULT_CONFIG, ...configOverrides }
    : DEFAULT_CONFIG;

  // ── Fetch odds (works for all sports) ──
  const games = await fetchNhlOdds(sport);
  if (!games.length) return [];

  // ── Route by sport ──
  if (sport === "nhl") {
    return runNhlPipeline(games, config);
  } else {
    // NBA, MMA, and any future sport → devig model
    return generateNbaEvBets(games, config);
  }
}

/**
 * NHL-specific pipeline: fetch MoneyPuck stats + goalies, run Poisson model.
 */
async function runNhlPipeline(
  games: Awaited<ReturnType<typeof fetchNhlOdds>>,
  config: ModelConfig,
): Promise<EvBet[]> {
  const [stats, goalies] = await Promise.all([
    fetchTeamStats(),
    fetchGoalieStats(),
  ]);

  const hasStats = stats.size > 0;
  const lg = hasStats ? leagueAverages(stats) : {
    goalsPerGame: 6.0,
    evXgForPerGame: 1.5,
    evXgAgainstPerGame: 1.5,
    ppXgPerGame: 0.5,
    pkXgPerGame: 0.5,
    ppPerGame: 3.2,
  };
  const lgGoalsPerGame = hasStats ? leagueAvg(stats) : 6.0;

  return generateEvBets({
    games,
    stats,
    goalies,
    lg,
    lgGoalsPerGame,
    config,
  });
}
