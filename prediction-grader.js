// @ts-check
// ─── Prediction Grader — Grade ALL predictions against game results ───
// Resolves game scores independently of bets, then grades every model prediction.

import * as db from "./db.js";

// ─── Resolve Game Scores ───
// Fetches final scores for games that have started but aren't marked final.
// Updates the games table — this is INDEPENDENT of bet resolution.

export async function resolveGameScores() {
  const games = db.getGamesNeedingScores();
  if (games.length === 0) return { resolved: 0 };

  let resolved = 0;

  // Group games by sport
  const nhlGames = games.filter(g => g.sport === "nhl");
  const nbaGames = games.filter(g => g.sport === "nba");
  const ncaabGames = games.filter(g => g.sport === "ncaab");

  // ── NHL: Fetch from NHL API ──
  if (nhlGames.length > 0) {
    const dates = new Set();
    for (const g of nhlGames) {
      const d = g.commence_time.split("T")[0];
      dates.add(d);
      // Check day before too (late games)
      const prev = new Date(d);
      prev.setDate(prev.getDate() - 1);
      dates.add(prev.toISOString().split("T")[0]);
    }

    for (const date of dates) {
      try {
        const res = await fetch(`https://api-web.nhle.com/v1/score/${date}`);
        if (!res.ok) continue;
        const data = await res.json();
        const apiGames = data.games ?? [];

        for (const ag of apiGames) {
          const state = ag.gameState || "";
          if (state !== "FINAL" && state !== "OFF") continue;

          const homeAbbrev = ag.homeTeam?.abbrev;
          const awayAbbrev = ag.awayTeam?.abbrev;
          const homeScore = ag.homeTeam?.score;
          const awayScore = ag.awayTeam?.score;
          if (!homeAbbrev || !awayAbbrev || homeScore == null || awayScore == null) continue;

          // Match to our games table
          const match = nhlGames.find(g =>
            g.home_team === homeAbbrev && g.away_team === awayAbbrev &&
            g.commence_time.startsWith(date)
          );
          if (!match) continue;

          const periodType = ag.periodDescriptor?.periodType ?? "REG";
          db.updateGame({
            id: match.id,
            home_score: homeScore,
            away_score: awayScore,
            period_type: periodType,
            game_state: "final",
          });
          resolved++;
        }
      } catch (err) {
        console.error(`[PredGrader] NHL score fetch failed for ${date}:`, err.message);
      }
    }
  }

  // ── NBA: Fetch from NBA API ──
  if (nbaGames.length > 0) {
    const dates = new Set();
    for (const g of nbaGames) {
      dates.add(g.commence_time.split("T")[0]);
    }

    for (const date of dates) {
      try {
        const res = await fetch(
          `https://stats.nba.com/stats/scoreboardv3?GameDate=${date}&LeagueID=00`,
          {
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Referer": "https://www.nba.com/",
              "Accept": "application/json",
            },
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const scoreboard = data?.scoreboard?.games ?? [];

        for (const sg of scoreboard) {
          if (sg.gameStatus !== 3) continue; // 3 = final

          const homeTeam = sg.homeTeam?.teamTricode;
          const awayTeam = sg.awayTeam?.teamTricode;
          const homeScore = sg.homeTeam?.score;
          const awayScore = sg.awayTeam?.score;
          if (!homeTeam || !awayTeam || homeScore == null || awayScore == null) continue;

          const match = nbaGames.find(g =>
            g.home_team === homeTeam && g.away_team === awayTeam &&
            g.commence_time.startsWith(date)
          );
          if (!match) continue;

          db.updateGame({
            id: match.id,
            home_score: homeScore,
            away_score: awayScore,
            period_type: null,
            game_state: "final",
          });
          resolved++;
        }
      } catch (err) {
        console.error(`[PredGrader] NBA score fetch failed for ${date}:`, err.message);
      }
    }
  }

  // ── NCAAB: Similar approach (scores from ESPN or NCAA API) ──
  // NCAAB games are graded the same way if scores are available in games table
  // For now we rely on games being updated through other means

  // ── Backfill: populate prediction_outcomes from model_results ──
  backfillFromModelResults();

  console.log(`[PredGrader] Resolved ${resolved} game scores`);
  return { resolved };
}

// ─── Backfill prediction_outcomes from model_results ───
// One-time + ongoing: for any model_results rows without a matching prediction_outcome, insert them.

function backfillFromModelResults() {
  const existingGameIds = new Set(db.getExistingPredictionOutcomeGameIds());
  const allResults = db.getAllModelResults();

  // De-dup model_results by (game_id, market, outcome) — keep latest snapshot
  const latest = new Map();
  for (const r of allResults) {
    const key = `${r.game_id}|${r.market}|${r.outcome}`;
    const existing = latest.get(key);
    if (!existing || r.snapshot_at > existing.snapshot_at) {
      latest.set(key, r);
    }
  }

  const toInsert = [];
  for (const r of latest.values()) {
    toInsert.push({
      game_id: r.game_id,
      sport: r.sport,
      market: r.market,
      outcome: r.outcome,
      model_prob: r.model_prob,
      fair_prob: r.fair_prob,
      implied_prob: r.implied_prob,
      edge: r.edge,
      best_price: r.best_price,
      best_line: r.best_line ?? null,
      confidence_score: r.confidence_score,
      confidence_grade: r.confidence_grade,
      predicted_at: r.snapshot_at,
    });
  }

  if (toInsert.length > 0) {
    db.upsertManyPredictionOutcomes(toInsert);
    console.log(`[PredGrader] Backfilled/updated ${toInsert.length} prediction outcomes from model_results`);
  }
}

// ─── Grade All Unresolved Predictions ───
// For each unresolved prediction where the game is now final, determine actual_outcome.

export function gradeAllPredictions() {
  const unresolved = db.getUnresolvedPredictionOutcomes();
  if (unresolved.length === 0) return { graded: 0 };

  let graded = 0;

  for (const pred of unresolved) {
    const homeScore = pred.g_home_score;
    const awayScore = pred.g_away_score;
    if (homeScore == null || awayScore == null) continue;

    const actualOutcome = resolveOutcome(
      pred.market,
      pred.outcome,
      pred.home_team,
      pred.away_team,
      homeScore,
      awayScore,
      pred.best_line
    );

    db.updatePredictionOutcomeResult({
      id: pred.id,
      actual_outcome: actualOutcome,
      home_score: homeScore,
      away_score: awayScore,
      period_type: pred.g_period_type ?? null,
      resolved_at: new Date().toISOString(),
    });
    graded++;
  }

  // Cross-reference with bets to set was_bet flag
  markBookedBets();

  console.log(`[PredGrader] Graded ${graded} predictions`);
  return { graded };
}

// ─── Resolve a prediction outcome ───
// Returns: 1 (correct), 0 (incorrect), -1 (push)

function resolveOutcome(market, outcome, homeTeam, awayTeam, homeScore, awayScore, bestLine) {
  if (market === "ml") {
    // outcome like "STL ML" → extract team abbrev
    const team = outcome.replace(" ML", "");
    const teamIsHome = team === homeTeam;
    const teamScore = teamIsHome ? homeScore : awayScore;
    const oppScore = teamIsHome ? awayScore : homeScore;
    if (teamScore > oppScore) return 1;
    if (teamScore < oppScore) return 0;
    return -1; // push (rare in hockey — OT/SO decides)
  }

  if (market === "pl") {
    // outcome like "PL DET +1.5" or "PL CAR -1.5"
    const parts = outcome.split(" ");
    const team = parts[1];
    const spread = parseFloat(parts[2]);
    if (isNaN(spread)) return 0;
    const teamIsHome = team === homeTeam;
    const teamScore = teamIsHome ? homeScore : awayScore;
    const oppScore = teamIsHome ? awayScore : homeScore;
    const margin = teamScore - oppScore + spread;
    if (margin > 0) return 1;
    if (margin < 0) return 0;
    return -1; // push
  }

  if (market === "totals") {
    // outcome like "Over 6.5" or "Under 5.5"
    const isOver = outcome.startsWith("Over");
    const line = bestLine ?? parseFloat(outcome.split(" ")[1]);
    if (isNaN(line)) return 0;
    const total = homeScore + awayScore;
    if (isOver) {
      if (total > line) return 1;
      if (total < line) return 0;
      return -1;
    } else {
      if (total < line) return 1;
      if (total > line) return 0;
      return -1;
    }
  }

  return 0; // unknown market — treat as incorrect
}

// ─── Mark predictions that were actually bet on ───

function markBookedBets() {
  try {
    const bets = db.getAllBets();
    for (const bet of bets) {
      db.markPredictionAsBet(bet.game_id, bet.market, bet.outcome);
    }
  } catch {
    // Silently fail — not critical
  }
}
