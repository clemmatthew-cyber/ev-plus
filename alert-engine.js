// ─── Betting Alert Engine ───
// Detects high-confidence EV opportunities from market conditions,
// goalie confirmations, and sharp-book intelligence.

import * as db from "./db.js";
import { analyzeConsensus } from "./sportsbook-intelligence.js";

const BOOK_NAMES = {
  draftkings: "DK", fanduel: "FD", betmgm: "MGM",
  caesars: "CZR", pointsbetus: "PB", fanatics: "FAN",
};

function bookLabel(key) {
  return BOOK_NAMES[key] || key;
}

// ─── Dedup helper: check if similar alert already exists within cooldown ───

function isDuplicate(recentAlerts, gameId, extraKeys, cooldownMinutes) {
  const now = Date.now();
  for (const a of recentAlerts) {
    if (a.game_id !== gameId) continue;
    const age = (now - new Date(a.created_at + "Z").getTime()) / 60_000;
    if (age > cooldownMinutes) continue;
    // Check extra keys match in detail
    let match = true;
    if (extraKeys) {
      try {
        const d = JSON.parse(a.detail || "{}");
        for (const [k, v] of Object.entries(extraKeys)) {
          if (d[k] !== v) { match = false; break; }
        }
      } catch { match = false; }
    }
    if (match) return true;
  }
  return false;
}

// ─── A. Stale Book Alerts ───

function detectStaleBookAlerts(currentOdds, bets) {
  const alerts = [];
  const recentAlerts = db.getRecentAlertsByType("stale_book", 30);

  // Group current odds by game/market/outcome
  const groups = new Map();
  for (const row of currentOdds) {
    const key = `${row.game_id}|${row.market}|${row.outcome_name}`;
    if (!groups.has(key)) groups.set(key, { game_id: row.game_id, market: row.market, outcome_name: row.outcome_name, books: [] });
    groups.get(key).books.push({ book: row.book, price: row.price });
  }

  for (const [, g] of groups) {
    if (g.books.length < 3) continue;

    // Get last 2 snapshots per book from odds_history
    const history = db.getOddsHistory(g.game_id);
    const bookSnapshots = new Map();
    for (const h of history) {
      if (h.market !== g.market || h.outcome_name !== g.outcome_name) continue;
      if (!bookSnapshots.has(h.book)) bookSnapshots.set(h.book, []);
      bookSnapshots.get(h.book).push(h);
    }

    // Identify stale vs moved books
    const staleBooks = [];
    const movedBooks = [];
    for (const [book, snaps] of bookSnapshots) {
      if (snaps.length < 2) continue;
      const last = snaps[snaps.length - 1].price;
      const prev = snaps[snaps.length - 2].price;
      const diff = last - prev;
      if (Math.abs(diff) <= 1) {
        staleBooks.push({ book, price: last });
      } else {
        movedBooks.push({ book, price: last, diff });
      }
    }

    if (movedBooks.length < 2 || staleBooks.length === 0) continue;

    // Check if moved books moved in same direction
    const sameDir = movedBooks.every(m => m.diff > 0) || movedBooks.every(m => m.diff < 0);
    if (!sameDir) continue;

    const direction = movedBooks[0].diff > 0 ? "up" : "down";
    const avgMove = movedBooks.reduce((a, m) => a + Math.abs(m.diff), 0) / movedBooks.length;
    if (avgMove < 3) continue;

    // Get game for expires_at
    const game = db.getGame(g.game_id);

    for (const sb of staleBooks) {
      // Check if there's an edge from bets for this outcome
      const matchingBet = bets.find(b =>
        b.game_id === g.game_id && b.outcome === g.outcome_name && b.best_book === sb.book
      );
      const edge = matchingBet ? matchingBet.edge : null;

      if (isDuplicate(recentAlerts, g.game_id, { book: sb.book, market: g.market }, 30)) continue;

      const severity = edge && edge > 0.06 ? "high" : edge && edge > 0.04 ? "medium" : "low";

      alerts.push({
        alert_type: "stale_book",
        severity,
        game_id: g.game_id,
        market: g.market,
        outcome: g.outcome_name,
        book: sb.book,
        headline: `Stale price at ${bookLabel(sb.book)}: ${g.outcome_name} ${sb.price > 0 ? "+" : ""}${sb.price} (market moved ${direction})`,
        detail: JSON.stringify({ book: sb.book, market: g.market, price: sb.price, direction, avgMove, movedBooks: movedBooks.map(m => m.book), edge }),
        model_edge: edge,
        confidence_score: matchingBet?.confidence_score ?? null,
        expires_at: game?.commence_time ?? null,
      });
    }
  }

  return alerts;
}

// ─── B. Sharp Move Alerts ───

function detectSharpMoveAlerts(currentOdds) {
  const alerts = [];
  const recentAlerts = db.getRecentAlertsByType("sharp_move", 30);

  // Get sportsbook metrics to identify sharp books
  const metrics = db.getSportsbookMetrics();
  const sharpBooks = metrics.filter(m => m.sharpness_rank <= 2).map(m => m.book);
  const softBooks = metrics.filter(m => m.sharpness_rank > 3).map(m => m.book);

  if (sharpBooks.length === 0) return alerts;

  // Group current odds by game/market/outcome
  const groups = new Map();
  for (const row of currentOdds) {
    const key = `${row.game_id}|${row.market}|${row.outcome_name}`;
    if (!groups.has(key)) groups.set(key, { game_id: row.game_id, market: row.market, outcome_name: row.outcome_name, books: new Map() });
    groups.get(key).books.set(row.book, row.price);
  }

  for (const [, g] of groups) {
    const history = db.getOddsHistory(g.game_id);
    const bookSnapshots = new Map();
    for (const h of history) {
      if (h.market !== g.market || h.outcome_name !== g.outcome_name) continue;
      if (!bookSnapshots.has(h.book)) bookSnapshots.set(h.book, []);
      bookSnapshots.get(h.book).push(h);
    }

    for (const sharpBook of sharpBooks) {
      const snaps = bookSnapshots.get(sharpBook);
      if (!snaps || snaps.length < 2) continue;

      const last = snaps[snaps.length - 1].price;
      const prev = snaps[snaps.length - 2].price;
      const move = Math.abs(last - prev);
      if (move <= 3) continue;

      // Check if soft books still lag
      let laggingCount = 0;
      for (const softBook of softBooks) {
        const softSnaps = bookSnapshots.get(softBook);
        if (!softSnaps || softSnaps.length < 2) continue;
        const softLast = softSnaps[softSnaps.length - 1].price;
        const softPrev = softSnaps[softSnaps.length - 2].price;
        if (Math.abs(softLast - softPrev) <= 1) laggingCount++;
      }

      if (laggingCount < 2) continue;

      if (isDuplicate(recentAlerts, g.game_id, { market: g.market, outcome: g.outcome_name }, 30)) continue;

      const game = db.getGame(g.game_id);
      const severity = move > 7 ? "high" : "medium";

      alerts.push({
        alert_type: "sharp_move",
        severity,
        game_id: g.game_id,
        market: g.market,
        outcome: g.outcome_name,
        book: sharpBook,
        headline: `Sharp move at ${bookLabel(sharpBook)}: ${g.outcome_name} → ${last > 0 ? "+" : ""}${last} (soft books lag)`,
        detail: JSON.stringify({ sharpBook, market: g.market, outcome: g.outcome_name, newPrice: last, oldPrice: prev, move, laggingSoftBooks: laggingCount }),
        model_edge: null,
        confidence_score: null,
        expires_at: game?.commence_time ?? null,
      });
    }
  }

  return alerts;
}

// ─── C. Confirmed Goalie EV Alerts ───

function detectConfirmedGoalieEvAlerts(bets, goalieConfirmations) {
  const alerts = [];
  const recentAlerts = db.getRecentAlertsByType("confirmed_goalie_ev", 20);

  if (!goalieConfirmations || goalieConfirmations.length === 0) return alerts;

  // Filter recently confirmed goalies (snapshot_at within last 30 min)
  const now = Date.now();
  const recentConfirmations = goalieConfirmations.filter(gc => {
    if (gc.status !== "confirmed") return false;
    const snapTime = new Date(gc.snapshot_at + (gc.snapshot_at.endsWith("Z") ? "" : "Z")).getTime();
    return (now - snapTime) < 30 * 60_000;
  });

  for (const gc of recentConfirmations) {
    // Find matching bets for this team's game
    const teamBets = bets.filter(b => {
      const outcomeUpper = (b.outcome || "").toUpperCase();
      return outcomeUpper.includes(gc.team);
    });

    for (const bet of teamBets) {
      if (!bet.edge || bet.edge <= 0) continue;

      if (isDuplicate(recentAlerts, bet.game_id, { team: gc.team }, 120)) continue;

      const game = db.getGame(bet.game_id);
      const severity = bet.confidence_grade === "A" ? "high" : bet.confidence_grade === "B" ? "medium" : "low";
      const edgePct = (bet.edge * 100).toFixed(1);

      alerts.push({
        alert_type: "confirmed_goalie_ev",
        severity,
        game_id: bet.game_id,
        market: bet.market,
        outcome: bet.outcome,
        book: bet.best_book,
        headline: `Goalie confirmed: ${gc.goalie_name} (${gc.team}) — ${bet.outcome} has ${edgePct}% edge at ${bookLabel(bet.best_book)}`,
        detail: JSON.stringify({ team: gc.team, goalieName: gc.goalie_name, outcome: bet.outcome, book: bet.best_book, edge: bet.edge, confidenceGrade: bet.confidence_grade }),
        model_edge: bet.edge,
        confidence_score: bet.confidence_score,
        expires_at: game?.commence_time ?? null,
      });
    }
  }

  return alerts;
}

// ─── D. Market Disagreement Alerts ───

function detectMarketDisagreementAlerts(currentOdds) {
  const alerts = [];
  const recentAlerts = db.getRecentAlertsByType("market_disagreement", 20);

  // Group by game
  const byGame = new Map();
  for (const row of currentOdds) {
    if (!byGame.has(row.game_id)) byGame.set(row.game_id, []);
    byGame.get(row.game_id).push(row);
  }

  const metrics = db.getSportsbookMetrics();
  const sharpBooks = metrics.filter(m => m.sharpness_rank <= 2).map(m => m.book);

  for (const [gameId, rows] of byGame) {
    const consensusEntries = analyzeConsensus(rows);

    for (const entry of consensusEntries) {
      if (!entry.outlier_book || entry.outlier_distance === 0) continue;

      const threshold = entry.market === "h2h" ? 20 : 15;
      if (entry.outlier_distance < threshold) continue;

      // Higher confidence if outlier is soft book and consensus aligns with sharp
      const outlierIsSharp = sharpBooks.includes(entry.outlier_book);
      const severity = entry.outlier_distance > 30 ? "high" : entry.outlier_distance > 20 ? "medium" : "low";

      if (isDuplicate(recentAlerts, gameId, { market: entry.market, outcome: entry.outcome_name, outlier_book: entry.outlier_book }, 60)) continue;

      const game = db.getGame(gameId);
      const outlierPrice = rows.find(r => r.book === entry.outlier_book && r.market === entry.market && r.outcome_name === entry.outcome_name)?.price;

      alerts.push({
        alert_type: "market_disagreement",
        severity,
        game_id: gameId,
        market: entry.market,
        outcome: entry.outcome_name,
        book: entry.outlier_book,
        headline: `Market disagreement: ${bookLabel(entry.outlier_book)} at ${outlierPrice != null ? (outlierPrice > 0 ? "+" : "") + outlierPrice : "?"} vs consensus ${Math.round(entry.consensus_price)} on ${entry.outcome_name}`,
        detail: JSON.stringify({ outlier_book: entry.outlier_book, market: entry.market, outcome: entry.outcome_name, outlierPrice, consensusPrice: entry.consensus_price, outlierDistance: entry.outlier_distance, outlierIsSharp }),
        model_edge: null,
        confidence_score: null,
        expires_at: game?.commence_time ?? null,
      });
    }
  }

  return alerts;
}

// ─── Webhook Dispatcher ───

async function dispatchWebhook(url, alert) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: alert.alert_type,
        severity: alert.severity,
        headline: alert.headline,
        detail: JSON.parse(alert.detail || "{}"),
        game_id: alert.game_id,
        created_at: alert.created_at,
      }),
    });
    if (response.ok && alert.id) {
      db.markAlertWebhookSent(alert.id);
    }
  } catch (err) {
    console.error(`[ALERT] Webhook failed:`, err.message);
  }
}

// ─── Orchestrator ───

export async function runAlertEngine(currentOdds, currentBets, goalieConfirmations) {
  const alerts = [];

  alerts.push(...detectStaleBookAlerts(currentOdds, currentBets));
  alerts.push(...detectSharpMoveAlerts(currentOdds));
  alerts.push(...detectConfirmedGoalieEvAlerts(currentBets, goalieConfirmations));
  alerts.push(...detectMarketDisagreementAlerts(currentOdds));

  // Persist all new alerts
  const insertedAlerts = [];
  for (const alert of alerts) {
    try {
      const result = db.insertAlert(alert);
      alert.id = result.lastInsertRowid;
      insertedAlerts.push(alert);
    } catch (err) {
      console.error(`[ALERT] Insert failed:`, err.message);
    }
  }

  // Fire webhooks for high/medium severity
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    for (const alert of insertedAlerts.filter(a => a.severity !== "low")) {
      await dispatchWebhook(webhookUrl, alert);
    }
  }

  // Log all alerts
  for (const alert of insertedAlerts) {
    console.log(`[ALERT][${alert.severity.toUpperCase()}][${alert.alert_type}] ${alert.headline}`);
  }

  // Cleanup old expired alerts
  db.cleanupExpiredAlerts();

  return { newAlerts: insertedAlerts.length, alerts: insertedAlerts };
}
