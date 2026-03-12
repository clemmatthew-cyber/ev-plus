// ─── Line Movement Tracker ───
// Stores odds snapshots in memory for movement arrows,
// and persists to SQLite via /api/odds-snapshot for historical data.

import type { EvBet } from "./types";

// Backend proxy base: replaced by deploy_website with proxy path to port 5000
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface Snapshot {
  price: number;
  ts: number;
}

// Map<betKey, Snapshot[]> — ring buffer of snapshots per bet
const history = new Map<string, Snapshot[]>();
const MAX_SNAPSHOTS = 12; // ~60 min at 5-min refresh intervals
const MOVEMENT_WINDOW = 30 * 60_000; // 30 minutes

function betKey(b: EvBet): string {
  return `${b.gameId}|${b.outcome}|${b.bestBook}`;
}

/** Record current odds for all bets. Call on every pipeline refresh. */
export function recordSnapshot(bets: EvBet[]): void {
  const now = Date.now();
  const snapshotAt = new Date(now).toISOString();

  for (const b of bets) {
    const key = betKey(b);
    let snaps = history.get(key);
    if (!snaps) {
      snaps = [];
      history.set(key, snaps);
    }
    snaps.push({ price: b.bestPrice, ts: now });
    // Trim old snapshots beyond ring buffer
    if (snaps.length > MAX_SNAPSHOTS) snaps.shift();
  }

  // Persist to SQLite via server (fire-and-forget)
  if (bets.length > 0) {
    const snapshots = bets.map(b => ({
      gameId: b.gameId,
      sport: "nhl", // movement tracking is per-refresh; sport is set at pipeline level
      book: b.bestBook,
      market: b.market,
      outcomeName: b.outcome,
      outcomePoint: b.bestLine,
      price: b.bestPrice,
      snapshotAt,
    }));
    fetch(`${API_BASE}/api/odds-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots }),
    }).catch(() => {});
  }
}

export type MovementDir = "up" | "down" | "flat";

/** Get movement direction for a bet: compare current price to oldest snapshot within 30-min window. */
export function getMovement(bet: EvBet): MovementDir {
  const key = betKey(bet);
  const snaps = history.get(key);
  if (!snaps || snaps.length < 2) return "flat";

  const now = Date.now();
  // Find oldest snapshot within the window
  const inWindow = snaps.filter(s => now - s.ts <= MOVEMENT_WINDOW);
  if (inWindow.length < 2) return "flat";

  const oldest = inWindow[0];
  const current = bet.bestPrice;

  // In American odds: higher positive = better for bettor, more negative = worse
  // Movement "up" = odds improved (price went up / less negative)
  if (current > oldest.price + 2) return "up";   // +2 cent threshold to avoid noise
  if (current < oldest.price - 2) return "down";
  return "flat";
}

/** Get a movement map for all bets at once. */
export function getMovementMap(bets: EvBet[]): Map<string, MovementDir> {
  const map = new Map<string, MovementDir>();
  for (const b of bets) {
    map.set(b.id, getMovement(b));
  }
  return map;
}
