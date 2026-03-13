// ─── NHL EV+ Backend Proxy ───
// Keeps API key server-side, proxies MoneyPuck (CORS), caches both for 3 min.
// SQLite persistence via better-sqlite3 (db.js).

import express from "express";
import cors from "cors";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import * as db from "./db.js";
import * as evaluation from "./evaluation.js";
import * as sportsbook from "./sportsbook-intelligence.js";
import { runAlertEngine } from "./alert-engine.js";
import { runRecalibration, getActiveModelConfig } from "./recalibration-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5000;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) {
  console.error("FATAL: ODDS_API_KEY not set in environment. Create a .env file.");
  process.exit(1);
}

// ─── CORS (allow external frontends) ───

app.use(cors());

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
  ncaab: "basketball_ncaab",
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
      `&bookmakers=draftkings,fanduel,betmgm,caesars,pointsbetus,fanatics`;

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
    // Lightweight consensus computation for just-inserted snapshots
    try {
      const snapshotRows = snapshots.map((s) => ({
        game_id: s.gameId,
        book: s.book,
        market: s.market,
        outcome_name: s.outcomeName,
        outcome_point: s.outcomePoint ?? null,
        price: s.price,
        snapshot_at: s.snapshotAt,
      }));
      const consensusCount = sportsbook.computeLiveConsensus(snapshotRows);

      // Run alert engine on fresh snapshot data
      let alertCount = 0;
      try {
        const bets = db.getAllBets().filter(b => b.result === "pending");
        const today = new Date().toISOString().slice(0, 10);
        const goalieConfs = db.getGoalieConfirmationsByDate(today);
        const alertResult = runAlertEngine(snapshotRows, bets, goalieConfs);
        alertCount = alertResult.newAlerts;
        if (alertCount > 0) console.log(`[ALERTS] ${alertCount} new alerts generated`);
      } catch (aErr) {
        console.error("[ALERTS] Engine error (non-fatal):", aErr.message);
      }

      res.json({ ok: true, count: snapshots.length, consensus: consensusCount, alerts: alertCount });
    } catch (cErr) {
      console.error("[odds-snapshot] Consensus error (non-fatal):", cErr.message);
      res.json({ ok: true, count: snapshots.length });
    }
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

// ─── /api/line-movement/:gameId ───
// Returns structured movement data: snapshots grouped by market/outcome/book

app.get("/api/line-movement/:gameId", (req, res) => {
  const { gameId } = req.params;
  const rows = db.getOddsMovement(gameId);

  if (rows.length === 0) {
    return res.json({ gameId, movements: [] });
  }

  // Group by market|outcomeName
  const grouped = new Map();
  for (const r of rows) {
    const key = `${r.market}|${r.outcome_name}|${r.outcome_point ?? ""}`;
    if (!grouped.has(key)) {
      grouped.set(key, { market: r.market, outcomeName: r.outcome_name, outcomePoint: r.outcome_point, books: new Map() });
    }
    const entry = grouped.get(key);
    if (!entry.books.has(r.book)) {
      entry.books.set(r.book, []);
    }
    entry.books.get(r.book).push({ price: r.price, at: r.snapshot_at });
  }

  const movements = [];
  for (const [, g] of grouped) {
    const books = {};
    let totalOpen = 0, totalCurrent = 0, bookCount = 0;

    for (const [book, snaps] of g.books) {
      const open = snaps[0].price;
      const current = snaps[snaps.length - 1].price;
      const magnitude = Math.abs(current - open);
      const direction = current > open + 2 ? "up" : current < open - 2 ? "down" : "flat";
      books[book] = { open, current, direction, magnitude, snapshots: snaps };
      totalOpen += open;
      totalCurrent += current;
      bookCount++;
    }

    const avgOpen = bookCount > 0 ? Math.round(totalOpen / bookCount) : 0;
    const avgCurrent = bookCount > 0 ? Math.round(totalCurrent / bookCount) : 0;
    const consensusDir = avgCurrent > avgOpen + 2 ? "up" : avgCurrent < avgOpen - 2 ? "down" : "flat";

    movements.push({
      market: g.market,
      outcomeName: g.outcomeName,
      outcomePoint: g.outcomePoint,
      books,
      consensus: { direction: consensusDir, avgOpen, avgCurrent },
    });
  }

  res.json({ gameId, movements });
});

// ─── /api/bets/capture-closing-lines ───
// Finds closing odds from odds_history for pending bets near game time, computes real CLV

app.post("/api/bets/capture-closing-lines", (_req, res) => {
  const pendingRows = db.getPendingBetsNeedingClosing();
  const now = Date.now();
  let captured = 0;

  for (const row of pendingRows) {
    const gameStart = new Date(row.game_time).getTime();
    // Only capture if game time has passed or is within 5 minutes
    if (now < gameStart - 5 * 60_000) continue;

    // Look for closing odds: last snapshot before game start for this bet's market/outcome/book
    let closing = db.getClosingOdds(row.game_id, row.market, row.outcome, row.best_book, row.game_time);

    // Fallback: any book for this market/outcome
    if (!closing) {
      closing = db.getClosingOddsAnyBook(row.game_id, row.market, row.outcome, row.game_time);
    }

    if (closing) {
      const closingPrice = closing.price;
      const clv = Math.round(
        (db.americanToImplied(closingPrice) - db.americanToImplied(row.odds_at_pick)) * 1000
      ) / 10;

      db.updateBet({
        id: row.id,
        result: null,
        resolved_at: null,
        home_score: null,
        away_score: null,
        period_type: null,
        profit_loss: null,
        closing_odds: closingPrice,
        clv,
      });
      captured++;
    }
  }

  res.json({ ok: true, captured });
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

// ─── /api/evaluation ───

app.post("/api/evaluation/run", (_req, res) => {
  try {
    const result = evaluation.runFullEvaluation();
    res.json(result);
  } catch (err) {
    console.error("[evaluation] run error:", err.message);
    res.status(500).json({ error: "Evaluation failed", detail: err.message });
  }
});

app.get("/api/evaluation/metrics", (_req, res) => {
  try {
    const evals = db.getAllPredictionEvals();
    const overall = evaluation.computeMetrics(evals);

    // By market
    const markets = new Map();
    for (const e of evals) {
      if (!markets.has(e.market)) markets.set(e.market, []);
      markets.get(e.market).push(e);
    }
    const byMarket = {};
    for (const [market, mEvals] of markets) {
      byMarket[market] = evaluation.computeMetrics(mEvals);
    }

    // By grade
    const grades = new Map();
    for (const e of evals) {
      if (!grades.has(e.confidence_grade)) grades.set(e.confidence_grade, []);
      grades.get(e.confidence_grade).push(e);
    }
    const byGrade = {};
    for (const [grade, gEvals] of grades) {
      byGrade[grade] = evaluation.computeMetrics(gEvals);
    }

    res.json({ overall, byMarket, byGrade });
  } catch (err) {
    console.error("[evaluation] metrics error:", err.message);
    res.status(500).json({ error: "Metrics computation failed" });
  }
});

app.get("/api/evaluation/calibration", (_req, res) => {
  const buckets = db.getAllCalibrationBuckets();
  res.json(buckets);
});

app.get("/api/evaluation/daily", (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  const rows = db.getDailyMetrics(limit);
  res.json(rows);
});

app.get("/api/evaluation/predictions", (req, res) => {
  let evals = db.getAllPredictionEvals();

  if (req.query.market) {
    evals = evals.filter(e => e.market === req.query.market);
  }
  if (req.query.grade) {
    evals = evals.filter(e => e.confidence_grade === req.query.grade);
  }

  const limit = parseInt(req.query.limit) || 50;
  res.json(evals.slice(0, limit));
});

app.get("/api/evaluation/edge-analysis", (_req, res) => {
  const evals = db.getAllPredictionEvals();
  const edgeBuckets = [
    { range: "0-2%", min: 0, max: 0.02 },
    { range: "2-5%", min: 0.02, max: 0.05 },
    { range: "5-10%", min: 0.05, max: 0.10 },
    { range: "10%+", min: 0.10, max: Infinity },
  ];

  const results = edgeBuckets.map(({ range, min, max }) => {
    const bucket = evals.filter(e => e.edge >= min && e.edge < max);
    if (bucket.length === 0) return { range, count: 0, winRate: 0, roi: 0, avgProfit: 0 };
    const wins = bucket.filter(e => e.actual_outcome === 1).length;
    const nonPush = bucket.filter(e => e.actual_outcome !== -1).length;
    const totalPL = bucket.reduce((a, e) => a + e.profit_loss, 0);
    const totalStake = bucket.reduce((a, e) => a + e.stake, 0);
    return {
      range,
      count: bucket.length,
      winRate: nonPush > 0 ? wins / nonPush : 0,
      roi: totalStake > 0 ? (totalPL / totalStake) * 100 : 0,
      avgProfit: totalPL / bucket.length,
    };
  });

  res.json(results);
});

app.get("/api/evaluation/confidence-analysis", (_req, res) => {
  const evals = db.getAllPredictionEvals();
  const gradeOrder = ["A", "B", "C", "D"];

  const results = gradeOrder.map(grade => {
    const bucket = evals.filter(e => e.confidence_grade === grade);
    if (bucket.length === 0) return { grade, count: 0, winRate: 0, roi: 0, avgEdge: 0, brierScore: null };
    const metrics = evaluation.computeMetrics(bucket);
    return {
      grade,
      count: bucket.length,
      winRate: metrics.winRate,
      roi: metrics.roiPct,
      avgEdge: metrics.avgEdge,
      brierScore: metrics.brierScore,
    };
  });

  res.json(results);
});

// ─── Sportsbook Intelligence Routes ───

app.get("/api/sportsbook/metrics", (_req, res) => {
  const metrics = db.getSportsbookMetrics();
  res.json({ metrics });
});

app.get("/api/sportsbook/daily", (req, res) => {
  const { book, limit } = req.query;
  if (book) {
    const daily = db.getSportsbookDailyByBook(book, Number(limit) || 14);
    res.json({ daily });
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const daily = db.getSportsbookDailyByDate(today);
    res.json({ daily });
  }
});

app.get("/api/sportsbook/consensus/:gameId", (req, res) => {
  const consensus = db.getMarketConsensusByGame(req.params.gameId);
  res.json({ consensus });
});

app.post("/api/sportsbook/analyze", (_req, res) => {
  try {
    const summary = sportsbook.runSportsbookAnalysis();
    res.json({ ok: true, summary });
  } catch (err) {
    console.error("[sportsbook/analyze] Error:", err.message);
    res.status(500).json({ error: "Sportsbook analysis failed", detail: err.message });
  }
});

// ─── Goalie Confirmation (DailyFaceoff) ───

const GOALIE_CACHE_TTL = 15 * 60_000; // 15 minutes
const goalieConfCache = { data: null, ts: 0, date: null };

// Team name normalization for DailyFaceoff → 3-letter abbreviation
const DF_TEAM_MAP = {
  "Anaheim Ducks": "ANA", "Ducks": "ANA",
  "Boston Bruins": "BOS", "Bruins": "BOS",
  "Buffalo Sabres": "BUF", "Sabres": "BUF",
  "Calgary Flames": "CGY", "Flames": "CGY",
  "Carolina Hurricanes": "CAR", "Hurricanes": "CAR",
  "Chicago Blackhawks": "CHI", "Blackhawks": "CHI",
  "Colorado Avalanche": "COL", "Avalanche": "COL",
  "Columbus Blue Jackets": "CBJ", "Blue Jackets": "CBJ",
  "Dallas Stars": "DAL", "Stars": "DAL",
  "Detroit Red Wings": "DET", "Red Wings": "DET",
  "Edmonton Oilers": "EDM", "Oilers": "EDM",
  "Florida Panthers": "FLA", "Panthers": "FLA",
  "Los Angeles Kings": "LAK", "Kings": "LAK",
  "Minnesota Wild": "MIN", "Wild": "MIN",
  "Montreal Canadiens": "MTL", "Montréal Canadiens": "MTL", "Canadiens": "MTL",
  "Nashville Predators": "NSH", "Predators": "NSH",
  "New Jersey Devils": "NJD", "Devils": "NJD",
  "New York Islanders": "NYI", "Islanders": "NYI",
  "New York Rangers": "NYR", "Rangers": "NYR",
  "Ottawa Senators": "OTT", "Senators": "OTT",
  "Philadelphia Flyers": "PHI", "Flyers": "PHI",
  "Pittsburgh Penguins": "PIT", "Penguins": "PIT",
  "San Jose Sharks": "SJS", "Sharks": "SJS",
  "Seattle Kraken": "SEA", "Kraken": "SEA",
  "St. Louis Blues": "STL", "St Louis Blues": "STL", "Blues": "STL",
  "Tampa Bay Lightning": "TBL", "Lightning": "TBL",
  "Toronto Maple Leafs": "TOR", "Maple Leafs": "TOR",
  "Utah Hockey Club": "UTA", "Utah Mammoth": "UTA",
  "Vancouver Canucks": "VAN", "Canucks": "VAN",
  "Vegas Golden Knights": "VGK", "Golden Knights": "VGK",
  "Washington Capitals": "WSH", "Capitals": "WSH",
  "Winnipeg Jets": "WPG", "Jets": "WPG",
};

function normalizeTeamName(name) {
  if (!name) return null;
  const trimmed = name.trim();
  return DF_TEAM_MAP[trimmed] || null;
}

function parseGoalieStatus(text) {
  if (!text) return "unknown";
  const lower = text.toLowerCase().trim();
  if (lower.includes("confirmed") || lower.includes("starter")) return "confirmed";
  if (lower.includes("expected") || lower.includes("likely") || lower.includes("probable")) return "expected";
  return "unknown";
}

async function fetchDailyFaceoffGoalies(dateStr) {
  const url = dateStr
    ? `https://www.dailyfaceoff.com/starting-goalies/${dateStr}`
    : "https://www.dailyfaceoff.com/starting-goalies";

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EVPlus/1.0)",
        "Accept": "text/html",
      },
    });
    if (!resp.ok) {
      console.warn(`[goalie-conf] DailyFaceoff returned ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    const $ = cheerio.load(html);
    const confirmations = [];

    // DailyFaceoff game cards — try multiple selectors for resilience
    const gameCards = $(".starting-goalies-card, .goalies-card, [class*='goalie']").toArray();

    if (gameCards.length === 0) {
      // Fallback: look for any container with two team names and goalie info
      $("table tr, .matchup, .game-card, .game").each((_, el) => {
        const text = $(el).text();
        // Try to extract team-goalie pairs from text content
        for (const [teamName, abbrev] of Object.entries(DF_TEAM_MAP)) {
          if (text.includes(teamName)) {
            // Found a team reference — try to find goalie name near it
            const links = $(el).find("a, .goalie-name, .player-name");
            links.each((__, link) => {
              const goalieName = $(link).text().trim();
              if (goalieName && goalieName.includes(" ") && goalieName.length > 3 && goalieName.length < 40) {
                const statusText = $(el).text();
                confirmations.push({
                  team: abbrev,
                  goalieName,
                  status: parseGoalieStatus(statusText),
                  source: "dailyfaceoff",
                });
              }
            });
          }
        }
      });
    } else {
      for (const card of gameCards) {
        const $card = $(card);
        // Look for team names and goalie names within each card
        const teams = [];
        $card.find(".team-name, .team, [class*='team']").each((_, el) => {
          const teamText = $(el).text().trim();
          const abbrev = normalizeTeamName(teamText);
          if (abbrev) teams.push(abbrev);
        });

        const goalieEls = $card.find(".goalie-name, .player-name, [class*='goalie'] a, [class*='player'] a").toArray();
        const statusEls = $card.find(".status, .confirmed, .expected, [class*='status']").toArray();

        for (let i = 0; i < Math.min(teams.length, goalieEls.length); i++) {
          const goalieName = $(goalieEls[i]).text().trim();
          const statusText = statusEls[i] ? $(statusEls[i]).text() : $card.text();
          if (goalieName && goalieName.length > 2) {
            confirmations.push({
              team: teams[i],
              goalieName,
              status: parseGoalieStatus(statusText),
              source: "dailyfaceoff",
            });
          }
        }
      }
    }

    return confirmations;
  } catch (err) {
    console.warn("[goalie-conf] DailyFaceoff fetch failed:", err.message);
    return [];
  }
}

async function getGoalieConfirmations(dateStr) {
  const targetDate = dateStr || new Date().toISOString().slice(0, 10);

  // Check cache
  if (goalieConfCache.data && goalieConfCache.date === targetDate &&
      Date.now() - goalieConfCache.ts < GOALIE_CACHE_TTL) {
    return { date: targetDate, confirmations: goalieConfCache.data, cached: true };
  }

  const confirmations = await fetchDailyFaceoffGoalies(dateStr);

  // Save to SQLite
  for (const c of confirmations) {
    try {
      db.upsertGoalieConfirmation({
        game_date: targetDate,
        team: c.team,
        goalie_name: c.goalieName,
        status: c.status,
        source: c.source,
      });
    } catch (err) {
      console.warn("[goalie-conf] DB upsert error:", err.message);
    }
  }

  // Update cache
  if (!dateStr || dateStr === new Date().toISOString().slice(0, 10)) {
    goalieConfCache.data = confirmations;
    goalieConfCache.ts = Date.now();
    goalieConfCache.date = targetDate;
  }

  return { date: targetDate, confirmations };
}

// Route: GET /api/goalie-confirmations
app.get("/api/goalie-confirmations", async (_req, res) => {
  try {
    const result = await getGoalieConfirmations();
    res.json(result);
  } catch (err) {
    console.error("[goalie-conf] route error:", err.message);
    res.json({ date: new Date().toISOString().slice(0, 10), confirmations: [], error: "source_unavailable" });
  }
});

// Route: GET /api/goalie-confirmations/:date
app.get("/api/goalie-confirmations/:date", async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format, use YYYY-MM-DD" });
  }
  try {
    const result = await getGoalieConfirmations(date);
    res.json(result);
  } catch (err) {
    console.error("[goalie-conf] route error:", err.message);
    res.json({ date, confirmations: [], error: "source_unavailable" });
  }
});

// Route: GET /api/lineup-adjustments
app.get("/api/lineup-adjustments", (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.getLineupAdjustmentsByDate(today);
  res.json({ date: today, adjustments: rows });
});

// Route: GET /api/lineup-adjustments/:date
app.get("/api/lineup-adjustments/:date", (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format, use YYYY-MM-DD" });
  }
  const rows = db.getLineupAdjustmentsByDate(date);
  res.json({ date, adjustments: rows });
});

// ─── Alert Routes ───

app.get("/api/alerts", (req, res) => {
  const type = req.query.type || null;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  let rows = db.getActiveAlerts(type);
  rows = rows.slice(0, limit);
  const alerts = rows.map(r => ({
    id: r.id,
    alertType: r.alert_type,
    severity: r.severity,
    gameId: r.game_id,
    market: r.market,
    outcome: r.outcome,
    book: r.book,
    headline: r.headline,
    detail: JSON.parse(r.detail || "{}"),
    modelEdge: r.model_edge,
    confidenceScore: r.confidence_score,
    isRead: !!r.is_read,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
  const unreadCount = db.getUnreadAlertCount();
  res.json({ ok: true, alerts, unreadCount });
});

app.get("/api/alerts/count", (_req, res) => {
  const unreadCount = db.getUnreadAlertCount();
  res.json({ ok: true, unreadCount });
});

app.post("/api/alerts/:id/read", (req, res) => {
  db.markAlertRead(Number(req.params.id));
  res.json({ ok: true });
});

app.post("/api/alerts/:id/dismiss", (req, res) => {
  db.markAlertDismissed(Number(req.params.id));
  res.json({ ok: true });
});

app.post("/api/alerts/run", (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Get latest odds snapshots from today
    const allOdds = db.getAllOddsHistory().filter(r => r.snapshot_at.startsWith(today));
    const bets = db.getAllBets().filter(b => b.result === "pending");
    const goalieConfs = db.getGoalieConfirmationsByDate(today);
    const result = runAlertEngine(allOdds, bets, goalieConfs);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[alerts/run] Error:", err.message);
    res.status(500).json({ error: "Alert engine failed", detail: err.message });
  }
});

// ─── Recalibration API ───

app.get("/api/recalibration/parameters", (_req, res) => {
  try {
    const parameters = db.getAllModelParams();
    const lastRecalibration = db.getLatestRecalibrationRun();
    res.json({ ok: true, parameters, lastRecalibration });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch parameters", detail: err.message });
  }
});

app.get("/api/recalibration/history", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const runs = db.getRecentRecalibrationRuns(limit);
    res.json({ ok: true, runs });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history", detail: err.message });
  }
});

app.get("/api/recalibration/history/:runId", (req, res) => {
  try {
    const run = db.getRecalibrationRun(parseInt(req.params.runId));
    if (!run) return res.status(404).json({ error: "Run not found" });
    const changes = db.getParameterHistoryByRun(run.id);
    res.json({ ok: true, run, changes });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch run", detail: err.message });
  }
});

app.post("/api/recalibration/run", (_req, res) => {
  try {
    const result = runRecalibration("manual");
    res.json(result);
  } catch (err) {
    console.error("[recalibration/run] Error:", err.message);
    res.status(500).json({ ok: false, error: "Recalibration failed", detail: err.message });
  }
});

app.post("/api/recalibration/reset", (_req, res) => {
  try {
    db.resetAllModelParams();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset parameters", detail: err.message });
  }
});

// ─── Tournament Endpoints ───

app.post("/api/tournament-snapshot", (req, res) => {
  try {
    const { gameId, snapshot } = req.body;
    if (!gameId || !snapshot) return res.status(400).json({ error: "missing fields" });

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO tournament_games (
        game_id, sport, postseason, tournament_round, neutral_site,
        home_court_adj_used, home_seed, away_seed, style_mismatch_score,
        tempo_mismatch_pct, model_prob, devig_market_prob, model_vs_market_diff,
        public_bias_team, short_turnaround, confidence_multiplier
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      gameId, "ncaab", snapshot.postseason ? 1 : 0, snapshot.tournamentRound,
      snapshot.neutralSite ? 1 : 0, snapshot.homeCurtAdjUsed,
      snapshot.homeSeed, snapshot.awaySeed, snapshot.styleMismatchScore,
      snapshot.tempoMismatchPct, snapshot.modelProb, snapshot.devigMarketProb,
      snapshot.modelVsMarketDiff, snapshot.publicBiasTeam,
      snapshot.shortTurnaround ? 1 : 0, snapshot.confidenceMultiplier
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save tournament snapshot", detail: err.message });
  }
});

app.get("/api/tournament-performance", (req, res) => {
  try {
    const season = req.query.season || new Date().getFullYear();
    const rows = db.prepare(
      "SELECT * FROM tournament_performance WHERE season = ? ORDER BY segment"
    ).all(season);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tournament performance", detail: err.message });
  }
});

app.post("/api/tournament-performance/compute", (req, res) => {
  try {
    const season = new Date().getFullYear();

    const tournBets = db.prepare(`
      SELECT b.*, tg.home_seed, tg.away_seed, tg.public_bias_team, tg.tournament_round
      FROM bets b
      JOIN tournament_games tg ON b.game_id = tg.game_id
      WHERE b.result IN ('win', 'loss', 'push')
    `).all();

    if (tournBets.length === 0) return res.json({ ok: true, message: "no data" });

    // Compute segments
    const segments = ["all_tournament", "favorites", "underdogs", "overs", "unders", "high_seeds", "low_seeds"];
    const upsert = db.prepare(`
      INSERT INTO tournament_performance (sport, season, segment, total_bets, wins, losses, pushes, total_staked, total_profit, roi_pct, avg_edge, hit_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sport, season, segment) DO UPDATE SET
        total_bets=excluded.total_bets, wins=excluded.wins, losses=excluded.losses,
        pushes=excluded.pushes, total_staked=excluded.total_staked, total_profit=excluded.total_profit,
        roi_pct=excluded.roi_pct, avg_edge=excluded.avg_edge, hit_rate=excluded.hit_rate,
        computed_at=datetime('now')
    `);

    for (const seg of segments) {
      const filtered = tournBets.filter(b => {
        if (seg === "all_tournament") return true;
        if (seg === "favorites") return b.market === "ml" && b.edge > 0;
        if (seg === "underdogs") return b.market === "ml" && b.odds_at_pick > 0;
        if (seg === "overs") return b.market === "totals" && b.outcome && b.outcome.startsWith("Over");
        if (seg === "unders") return b.market === "totals" && b.outcome && b.outcome.startsWith("Under");
        if (seg === "high_seeds") return (b.home_seed && b.home_seed <= 4) || (b.away_seed && b.away_seed <= 4);
        if (seg === "low_seeds") return (b.home_seed && b.home_seed > 4) || (b.away_seed && b.away_seed > 4);
        return false;
      });

      const wins = filtered.filter(b => b.result === "win").length;
      const losses = filtered.filter(b => b.result === "loss").length;
      const pushes = filtered.filter(b => b.result === "push").length;
      const totalStaked = filtered.reduce((s, b) => s + (b.stake || 0), 0);
      const totalProfit = filtered.reduce((s, b) => s + (b.profit_loss || 0), 0);
      const roiPct = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
      const avgEdge = filtered.length > 0 ? filtered.reduce((s, b) => s + (b.edge || 0), 0) / filtered.length : 0;
      const hitRate = (wins + losses) > 0 ? wins / (wins + losses) : 0;

      upsert.run("ncaab", season, seg, filtered.length, wins, losses, pushes, totalStaked, totalProfit, roiPct, avgEdge, hitRate);
    }

    res.json({ ok: true, computed: tournBets.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to compute tournament performance", detail: err.message });
  }
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

// ─── Weekly Recalibration Scheduler ───

const RECAL_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days

function maybeRunWeeklyRecalibration() {
  if (process.env.RECALIBRATION_ENABLED === "false") return;
  const lastRun = db.getLatestRecalibrationRun();
  if (lastRun) {
    const lastRunTime = new Date(lastRun.created_at + "Z").getTime();
    const elapsed = Date.now() - lastRunTime;
    if (elapsed < RECAL_INTERVAL) return;
  }
  console.log("[RECAL] Starting weekly recalibration...");
  try {
    const result = runRecalibration("weekly");
    console.log(`[RECAL] Complete: ${result.paramsChanged ?? 0} params updated in ${result.duration ?? 0}ms`);
  } catch (err) {
    console.error("[RECAL] Weekly recalibration failed:", err.message);
  }
}

setTimeout(maybeRunWeeklyRecalibration, 30000);
setInterval(maybeRunWeeklyRecalibration, 24 * 60 * 60 * 1000);
