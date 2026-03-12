// ─── NHL EV+ Backend Proxy ───
// Keeps API key server-side, proxies MoneyPuck (CORS), caches both for 3 min.
// SQLite persistence via better-sqlite3 (db.js).

import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5000;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) {
  console.error("FATAL: ODDS_API_KEY not set in environment. Create a .env file.");
  process.exit(1);
}

// ─── JSON body parsing (must be before route handlers) ───

app.use(express.json());

// ─── Cache ───

const CACHE_TTL = 3 * 60_000; // 3 minutes

const cache = {
  odds: { data: null, ts: 0 },
  stats: { data: null, ts: 0 },
  goalies: { data: null, ts: 0 },
};

function isFresh(entry) {
  return entry.data !== null && Date.now() - entry.ts < CACHE_TTL;
}

// ─── Sport key map (Odds API sport slugs) ───

const SPORT_KEYS = {
  nhl: "icehockey_nhl",
  nba: "basketball_nba",
  mma: "mma_mixed_martial_arts",
};

// ─── /api/odds ───
// Proxies The Odds API — supports ?sport=nhl|nba|mma (default nhl)
// Per-sport cache so switching sports doesn't nuke the other cache.

const oddsCache = new Map(); // sportKey → { data, ts }

app.get("/api/odds", async (req, res) => {
  const sportParam = (req.query.sport || "nhl").toString().toLowerCase();
  const sportKey = SPORT_KEYS[sportParam] || SPORT_KEYS.nhl;

  try {
    const cached = oddsCache.get(sportKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached.data);
    }

    const url =
      `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/` +
      `?apiKey=${ODDS_API_KEY}` +
      `&regions=us` +
      `&markets=h2h,spreads,totals` +
      `&oddsFormat=american` +
      `&bookmakers=draftkings,fanduel,betmgm,caesars,pointsbetus`;

    const upstream = await fetch(url);
    if (!upstream.ok) {
      const body = await upstream.text();
      console.error(`[odds] upstream ${upstream.status}: ${body.slice(0, 200)}`);
      return res.status(upstream.status).json({ error: `Odds API ${upstream.status}` });
    }

    const remaining = upstream.headers.get("x-requests-remaining");
    const used = upstream.headers.get("x-requests-used");
    if (remaining) console.log(`[odds] ${sportParam} requests remaining: ${remaining}, used: ${used}`);

    const data = await upstream.json();

    oddsCache.set(sportKey, { data, ts: Date.now() });

    res.setHeader("X-Cache", "MISS");
    res.json(data);
  } catch (err) {
    console.error("[odds] error:", err.message);
    const cached = oddsCache.get(sportKey);
    if (cached) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cached.data);
    }
    res.status(502).json({ error: "Odds API unreachable" });
  }
});

// ─── /api/stats ───
// Proxies MoneyPuck team CSV to avoid CORS

app.get("/api/stats", async (_req, res) => {
  try {
    if (isFresh(cache.stats)) {
      res.setHeader("X-Cache", "HIT");
      return res.type("text/csv").send(cache.stats.data);
    }

    const url =
      "https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/teams.csv";

    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.error(`[stats] upstream ${upstream.status}`);
      return res.status(upstream.status).json({ error: `MoneyPuck ${upstream.status}` });
    }

    const csv = await upstream.text();

    cache.stats.data = csv;
    cache.stats.ts = Date.now();

    res.setHeader("X-Cache", "MISS");
    res.type("text/csv").send(csv);
  } catch (err) {
    console.error("[stats] error:", err.message);
    if (cache.stats.data) {
      res.setHeader("X-Cache", "STALE");
      return res.type("text/csv").send(cache.stats.data);
    }
    res.status(502).json({ error: "MoneyPuck unreachable" });
  }
});

// ─── /api/goalies ───
// Proxies MoneyPuck goalie CSV to avoid CORS

app.get("/api/goalies", async (_req, res) => {
  try {
    if (isFresh(cache.goalies)) {
      res.setHeader("X-Cache", "HIT");
      return res.type("text/csv").send(cache.goalies.data);
    }

    const url =
      "https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/goalies.csv";

    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.error(`[goalies] upstream ${upstream.status}`);
      return res.status(upstream.status).json({ error: `MoneyPuck ${upstream.status}` });
    }

    const csv = await upstream.text();

    cache.goalies.data = csv;
    cache.goalies.ts = Date.now();

    res.setHeader("X-Cache", "MISS");
    res.type("text/csv").send(csv);
  } catch (err) {
    console.error("[goalies] error:", err.message);
    if (cache.goalies.data) {
      res.setHeader("X-Cache", "STALE");
      return res.type("text/csv").send(cache.goalies.data);
    }
    res.status(502).json({ error: "MoneyPuck unreachable" });
  }
});

// ─── /api/scores/:date ───
// Proxies NHL API daily scores (avoids CORS from browser)

const scoresCache = new Map(); // date → { data, ts }

app.get("/api/scores/:date", async (req, res) => {
  const { date } = req.params;
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format, use YYYY-MM-DD" });
  }

  try {
    const cached = scoresCache.get(date);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached.data);
    }

    const url = `https://api-web.nhle.com/v1/score/${date}`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.error(`[scores] upstream ${upstream.status}`);
      return res.status(upstream.status).json({ error: `NHL API ${upstream.status}` });
    }

    const data = await upstream.json();
    scoresCache.set(date, { data, ts: Date.now() });

    // Evict old cache entries (keep last 7 days)
    if (scoresCache.size > 14) {
      const oldest = [...scoresCache.keys()].sort()[0];
      scoresCache.delete(oldest);
    }

    res.setHeader("X-Cache", "MISS");
    res.json(data);
  } catch (err) {
    console.error("[scores] error:", err.message);
    const cached = scoresCache.get(date);
    if (cached) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cached.data);
    }
    res.status(502).json({ error: "NHL API unreachable" });
  }
});

// ─── /api/bankroll ───
// Now backed by SQLite (persists across server restarts)

app.get("/api/bankroll", (_req, res) => {
  const row = db.getLatestBankroll();
  res.json({ balance: row.balance, peakBalance: row.peak_balance });
});

app.post("/api/bankroll", (req, res) => {
  const { balance } = req.body;
  if (typeof balance !== "number" || balance < 0 || balance > 1_000_000) {
    return res.status(400).json({ error: "Invalid balance" });
  }
  const rounded = Math.round(balance * 100) / 100;
  const current = db.getLatestBankroll();
  const peak = Math.max(rounded, current.peak_balance);
  db.insertBankrollEntry(rounded, peak, "manual");
  console.log(`[bankroll] updated to $${rounded}`);
  res.json({ balance: rounded, peakBalance: peak });
});

app.get("/api/bankroll/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const rows = db.getBankrollHistory(limit);
  res.json(rows);
});

// ─── /api/bets ───
// CRUD for tracked bets — backed by SQLite

// Helper: convert DB row (snake_case) to TrackedBet shape (camelCase)
function rowToBet(r) {
  return {
    id: r.id,
    gameId: r.game_id,
    gameTime: r.game_time,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    market: r.market,
    outcome: r.outcome,
    bestBook: r.best_book,
    oddsAtPick: r.odds_at_pick,
    lineAtPick: r.line_at_pick,
    modelProb: r.model_prob,
    impliedProb: r.implied_prob,
    fairProb: r.fair_prob,
    edge: r.edge,
    ev: r.ev,
    confidenceScore: r.confidence_score,
    confidenceGrade: r.confidence_grade,
    kellyFraction: r.kelly_fraction,
    stake: r.stake,
    placedAt: r.placed_at,
    result: r.result,
    resolvedAt: r.resolved_at,
    homeScore: r.home_score,
    awayScore: r.away_score,
    periodType: r.period_type,
    profitLoss: r.profit_loss,
    closingOdds: r.closing_odds,
    clv: r.clv,
  };
}

app.get("/api/bets", (_req, res) => {
  const rows = db.getAllBets();
  res.json(rows.map(rowToBet));
});

app.post("/api/bets", (req, res) => {
  const b = req.body;
  // Duplicate check
  const existing = db.getBetByKey(b.gameId, b.outcome, b.bestBook);
  if (existing) {
    return res.json(rowToBet(existing));
  }

  const id = b.id || `tb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.insertBet({
    id,
    game_id: b.gameId,
    game_time: b.gameTime,
    home_team: b.homeTeam,
    away_team: b.awayTeam,
    market: b.market,
    outcome: b.outcome,
    best_book: b.bestBook,
    odds_at_pick: b.oddsAtPick,
    line_at_pick: b.lineAtPick ?? null,
    model_prob: b.modelProb,
    implied_prob: b.impliedProb,
    fair_prob: b.fairProb,
    edge: b.edge,
    ev: b.ev,
    confidence_score: b.confidenceScore,
    confidence_grade: b.confidenceGrade,
    kelly_fraction: b.kellyFraction,
    stake: b.stake,
    placed_at: b.placedAt || new Date().toISOString(),
    result: b.result || "pending",
    resolved_at: b.resolvedAt ?? null,
    home_score: b.homeScore ?? null,
    away_score: b.awayScore ?? null,
    period_type: b.periodType ?? null,
    profit_loss: b.profitLoss ?? 0,
    closing_odds: b.closingOdds ?? null,
    clv: b.clv ?? null,
  });
  const inserted = db.getBetById(id);
  res.status(201).json(rowToBet(inserted));
});

app.delete("/api/bets/:id", (req, res) => {
  db.deleteBet(req.params.id);
  res.json({ ok: true });
});

app.post("/api/bets/:id/unplace", (req, res) => {
  // Unplace: delete a pending bet by its ID
  const bet = db.getBetById(req.params.id);
  if (bet && bet.result === "pending") {
    db.deleteBet(req.params.id);
  }
  res.json({ ok: true });
});

// Unplace by key (gameId + outcome + book) — used by store.ts unplaceBet
app.post("/api/bets/unplace-by-key", (req, res) => {
  const { gameId, outcome, book } = req.body;
  db.deletePendingBetByKey(gameId, outcome, book);
  res.json({ ok: true });
});

app.patch("/api/bets/:id", (req, res) => {
  const patch = req.body;
  db.updateBet({
    id: req.params.id,
    result: patch.result ?? null,
    resolved_at: patch.resolvedAt ?? null,
    home_score: patch.homeScore ?? null,
    away_score: patch.awayScore ?? null,
    period_type: patch.periodType ?? null,
    profit_loss: patch.profitLoss ?? null,
    closing_odds: patch.closingOdds ?? null,
    clv: patch.clv ?? null,
  });
  const updated = db.getBetById(req.params.id);
  if (!updated) return res.status(404).json({ error: "Bet not found" });
  res.json(rowToBet(updated));
});

app.post("/api/bets/resolve", (req, res) => {
  const { updates } = req.body; // [{ id, patch: { result, resolvedAt, ... } }]
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: "updates array required" });
  }
  const dbUpdates = updates.map((u) => ({
    id: u.id,
    result: u.patch.result ?? null,
    resolved_at: u.patch.resolvedAt ?? null,
    home_score: u.patch.homeScore ?? null,
    away_score: u.patch.awayScore ?? null,
    period_type: u.patch.periodType ?? null,
    profit_loss: u.patch.profitLoss ?? null,
    closing_odds: u.patch.closingOdds ?? null,
    clv: u.patch.clv ?? null,
  }));
  db.bulkUpdateBets(dbUpdates);
  res.json({ ok: true, count: updates.length });
});

// ─── /api/games ───

app.post("/api/games", (req, res) => {
  const g = req.body;
  db.upsertGame({
    id: g.id,
    sport: g.sport,
    home_team: g.homeTeam,
    away_team: g.awayTeam,
    commence_time: g.commenceTime,
  });
  res.json({ ok: true });
});

// Batch upsert games (called before odds-snapshot / model-snapshot to satisfy FK)
app.post("/api/games/batch", (req, res) => {
  const { games } = req.body;
  if (!Array.isArray(games)) {
    return res.status(400).json({ error: "games array required" });
  }
  db.upsertManyGames(
    games.map((g) => ({
      id: g.id,
      sport: g.sport,
      home_team: g.homeTeam,
      away_team: g.awayTeam,
      commence_time: g.commenceTime,
    }))
  );
  res.json({ ok: true, count: games.length });
});

app.patch("/api/games/:id", (req, res) => {
  const patch = req.body;
  db.updateGame({
    id: req.params.id,
    home_score: patch.homeScore ?? null,
    away_score: patch.awayScore ?? null,
    period_type: patch.periodType ?? null,
    game_state: patch.gameState ?? null,
  });
  const game = db.getGame(req.params.id);
  res.json(game || { ok: true });
});

// ─── /api/odds-snapshot ───

app.post("/api/odds-snapshot", (req, res) => {
  const { snapshots } = req.body; // array of odds snapshot rows
  if (!Array.isArray(snapshots)) {
    return res.status(400).json({ error: "snapshots array required" });
  }
  try {
    db.insertManyOddsSnapshots(
      snapshots.map((s) => ({
        game_id: s.gameId,
        sport: s.sport,
        book: s.book,
        market: s.market,
        outcome_name: s.outcomeName,
        outcome_point: s.outcomePoint ?? null,
        price: s.price,
        snapshot_at: s.snapshotAt,
      }))
    );
    res.json({ ok: true, count: snapshots.length });
  } catch (err) {
    console.error("[odds-snapshot] DB error:", err.message);
    res.status(500).json({ error: "Failed to insert odds snapshots", detail: err.message });
  }
});

app.get("/api/odds-history/:gameId", (req, res) => {
  const rows = db.getOddsHistory(req.params.gameId);
  res.json(rows);
});

// ─── /api/model-snapshot ───

app.post("/api/model-snapshot", (req, res) => {
  const { results } = req.body; // array of model result rows
  if (!Array.isArray(results)) {
    return res.status(400).json({ error: "results array required" });
  }
  try {
    db.insertManyModelResults(
      results.map((r) => ({
        game_id: r.gameId,
        sport: r.sport,
        market: r.market,
        outcome: r.outcome,
        model_prob: r.modelProb,
        fair_prob: r.fairProb,
        implied_prob: r.impliedProb,
        edge: r.edge,
        ev: r.ev,
        best_book: r.bestBook,
        best_price: r.bestPrice,
        best_line: r.bestLine ?? null,
        confidence_score: r.confidenceScore,
        confidence_grade: r.confidenceGrade,
        kelly_fraction: r.kellyFraction,
        suggested_stake: r.suggestedStake,
        snapshot_at: r.snapshotAt,
      }))
    );
    res.json({ ok: true, count: results.length });
  } catch (err) {
    console.error("[model-snapshot] DB error:", err.message);
    res.status(500).json({ error: "Failed to insert model results", detail: err.message });
  }
});

// ─── /api/health ───

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    cache: {
      odds: oddsCache.size > 0 ? "cached" : "empty",
      stats: isFresh(cache.stats) ? "fresh" : cache.stats.data ? "stale" : "empty",
      goalies: isFresh(cache.goalies) ? "fresh" : cache.goalies.data ? "stale" : "empty",
    },
    db: "sqlite",
    uptime: Math.round(process.uptime()),
  });
});

// ─── Static files (React dist) ───

app.use(express.static(join(__dirname, "dist")));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

// ─── Start ───

app.listen(PORT, () => {
  console.log(`[server] NHL EV+ running on http://localhost:${PORT} (SQLite persistence)`);
});
