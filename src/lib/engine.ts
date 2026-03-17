// ─── EV Engine v5 — Sport-Aware Router ───
// NHL  → full Poisson xG model (stats + goalies + situation splits)
// NCAAB → Torvik efficiency model + devig, with tournament adjustments
// NBA  → hybrid pace-projection + devig model

import type { EvBet } from "./types";
import { fetchOdds } from "./odds";
import { fetchTeamStats, fetchGoalieStats, leagueAverages, leagueAvg } from "./stats";
import { generateEvBets, DEFAULT_CONFIG, generateNbaEvBets, type ModelConfig } from "./model";
import { NCAAB_CONFIG } from "./model/ncaab-config";
import { generateNcaabEvBets } from "./model/ncaab-engine";
import { fetchTorvikStats } from "./stats/torvik";
import { clearTeamLastGameTime } from "./model/tournament";
import { fetchRecentSchedule, fetchNbaRecentSchedule } from "./schedule";
import { fetchNbaTeamRatings } from "./stats/nba-stats";
import { NBA_CONFIG } from "./model/nba-config";

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
  } catch (err) {
    console.error('[Engine] saveGames failed:', err);  // C-22
  }
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
  const games = await fetchOdds(sport);
  if (!games.length) return [];

  // Upsert all games into SQLite (satisfies odds_history FK) — await to avoid race
  await saveGames(games, sport);

  // ── Route by sport ──
  let bets: EvBet[];
  if (sport === "nhl") {
    bets = await runNhlPipeline(games, config);
  } else if (sport === "ncaab") {
    // NCAAB → Torvik statistical model + devig, with graceful fallback
    // NC-17: Clear per-team game time cache between pipeline runs
    clearTeamLastGameTime();
    let torvikStats: Map<string, import("./stats/torvik").TorvikStats> | null = null;
    try {
      torvikStats = await fetchTorvikStats();
    } catch {
      // Torvik fetch failed — fall back to devig-only
    }
    bets = generateNcaabEvBets(games, { ...config, ...NCAAB_CONFIG }, torvikStats);
  } else {
    // NBA → hybrid pace-projection + devig model
    bets = await runNbaPipeline(games, config);
  }

  // Persist model results snapshot (fire-and-forget)
  saveModelSnapshot(bets, sport);

  return bets;
}

/**
 * NHL-specific pipeline: fetch MoneyPuck stats + goalies, run Poisson model.
 */
async function runNhlPipeline(
  games: Awaited<ReturnType<typeof fetchOdds>>,
  config: ModelConfig,
): Promise<EvBet[]> {
  const [stats, goalies, recentGames] = await Promise.all([
    fetchTeamStats(),
    fetchGoalieStats(),
    fetchRecentSchedule(),
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
    recentGames,
  });
}

/**
 * NBA-specific pipeline: fetch team ratings + schedule, run hybrid model.
 * Falls back gracefully to pure devig if NBA stats fetch fails.
 */
async function runNbaPipeline(
  games: Awaited<ReturnType<typeof fetchOdds>>,
  config: ModelConfig,
): Promise<EvBet[]> {
  const cfg = { ...config, ...NBA_CONFIG };

  // Fetch NBA team ratings and schedule in parallel — graceful fallback on failure
  const [ratingsResult, scheduleResult] = await Promise.allSettled([
    fetchNbaTeamRatings(),
    fetchNbaRecentSchedule(),
  ]);

  const ratings = ratingsResult.status === "fulfilled" ? ratingsResult.value : null;
  const schedule = scheduleResult.status === "fulfilled" ? scheduleResult.value : [];

  if (ratingsResult.status === "rejected") {
    console.warn("[NBA] Stats fetch failed, falling back to pure devig:", ratingsResult.reason);
  }

  return generateNbaEvBets(games, cfg, ratings, schedule);
}
