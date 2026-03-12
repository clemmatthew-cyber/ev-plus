// ─── EV Engine v4 — Sport-Aware Router ───
// NHL → full Poisson xG model (stats + goalies + situation splits)
// NBA → pure devig model (odds-only, consensus fair prob)
// MMA → pure devig model (same as NBA, 2-way markets)

import type { EvBet } from "./types";
import { fetchNhlOdds } from "./odds";
import { fetchTeamStats, fetchGoalieStats, leagueAverages, leagueAvg } from "./stats";
import { generateEvBets, DEFAULT_CONFIG, generateNbaEvBets, type ModelConfig } from "./model";

// Backend proxy base: replaced by deploy_website with proxy path to port 5000
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Upsert all games into SQLite so FK constraints on odds_history / model_results succeed.
 *  Returns a promise — callers should await before firing odds/model snapshots. */
async function saveGames(games: { id: string; commenceTime: string; homeTeam: string; awayTeam: string }[], sport: string): Promise<void> {
  if (games.length === 0) return;
  try {
    await fetch(`${API_BASE}/api/games/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        games: games.map(g => ({
          id: g.id,
          sport,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          commenceTime: g.commenceTime,
        })),
      }),
    });
  } catch {}
}

/** Fire-and-forget: persist model results snapshot to server */
function saveModelSnapshot(bets: EvBet[], sport: string): void {
  if (bets.length === 0) return;
  const snapshotAt = new Date().toISOString();
  const results = bets.map(b => ({
    gameId: b.gameId,
    sport,
    market: b.market,
    outcome: b.outcome,
    modelProb: b.modelProb,
    fairProb: b.fairProb,
    impliedProb: b.impliedProb,
    edge: b.edge,
    ev: b.ev,
    bestBook: b.bestBook,
    bestPrice: b.bestPrice,
    bestLine: b.bestLine,
    confidenceScore: b.confidenceScore,
    confidenceGrade: b.confidenceGrade,
    kellyFraction: b.kellyFraction,
    suggestedStake: b.suggestedStake,
    snapshotAt,
  }));
  fetch(`${API_BASE}/api/model-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  }).catch(() => {});
}

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

  // Upsert all games into SQLite (satisfies odds_history FK) — await to avoid race
  await saveGames(games, sport);

  // ── Route by sport ──
  let bets: EvBet[];
  if (sport === "nhl") {
    bets = await runNhlPipeline(games, config);
  } else {
    // NBA, MMA, and any future sport → devig model
    bets = generateNbaEvBets(games, config);
  }

  // Persist model results snapshot (fire-and-forget)
  saveModelSnapshot(bets, sport);

  return bets;
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
