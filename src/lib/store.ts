// ─── Bet Storage — SQLite-backed via API endpoints ───
// All mutations go through the Express server which persists to SQLite.
// This module runs in the BROWSER and calls /api/bets endpoints.

import type { EvBet, TrackedBet } from "./types";

// Backend proxy base: replaced by deploy_website with proxy path to port 5000
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export async function getAllBets(): Promise<TrackedBet[]> {
  try {
    const res = await fetch(`${API_BASE}/api/bets`);
    if (res.ok) return await res.json();
  } catch {}
  return [];
}

export async function placeBet(ev: EvBet): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/bets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameId: ev.gameId,
        gameTime: ev.gameTime,
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        market: ev.market,
        outcome: ev.outcome,
        bestBook: ev.bestBook,
        oddsAtPick: ev.bestPrice,
        lineAtPick: ev.bestLine,
        modelProb: ev.modelProb,
        impliedProb: ev.impliedProb,
        fairProb: ev.fairProb,
        edge: ev.edge,
        ev: ev.ev,
        confidenceScore: ev.confidenceScore,
        confidenceGrade: ev.confidenceGrade,
        kellyFraction: ev.kellyFraction,
        stake: ev.suggestedStake,
        placedAt: new Date().toISOString(),
        result: "pending",
      }),
    });
    if (!res.ok) throw new Error(`Store operation failed: ${res.status}`);
  } catch (err) {
    console.error('[store]', err);
    throw err;
  }
}

export async function unplaceBet(gameId: string, outcome: string, book: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/bets/unplace-by-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId, outcome, book }),
    });
    if (!res.ok) throw new Error(`Store operation failed: ${res.status}`);
  } catch (err) {
    console.error('[store]', err);
    throw err;
  }
}

export async function isBetTracked(gameId: string, outcome: string, book: string): Promise<boolean> {
  try {
    const bets = await getAllBets();
    return bets.some(b => b.gameId === gameId && b.outcome === outcome && b.bestBook === book);
  } catch {
    return false;
  }
}

export async function updateBet(id: string, patch: Partial<TrackedBet>): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/bets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Store operation failed: ${res.status}`);
  } catch (err) {
    console.error('[store]', err);
    throw err;
  }
}

export async function bulkUpdate(updates: { id: string; patch: Partial<TrackedBet> }[]): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/bets/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    if (!res.ok) throw new Error(`Store operation failed: ${res.status}`);
  } catch (err) {
    console.error('[store]', err);
    throw err;
  }
}

export async function deleteBet(id: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/bets/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Store operation failed: ${res.status}`);
  } catch (err) {
    console.error('[store]', err);
    throw err;
  }
}

export function computeSummary(bets: TrackedBet[]): import("./types").TrackerSummary {
  const pending = bets.filter(b => b.result === "pending").length;
  const resolved = bets.filter(b => b.result !== "pending");
  const wins = resolved.filter(b => b.result === "win").length;
  const losses = resolved.filter(b => b.result === "loss").length;
  const pushes = resolved.filter(b => b.result === "push").length;
  const totalPL = resolved.reduce((s, b) => s + b.profitLoss, 0);
  const totalWagered = resolved.reduce((s, b) => s + b.stake, 0);
  const avgEdge = resolved.length > 0
    ? resolved.reduce((s, b) => s + b.edge, 0) / resolved.length
    : 0;
  const clvBets = resolved.filter(b => b.clv !== null);
  const avgCLV = clvBets.length > 0
    ? clvBets.reduce((s, b) => s + (b.clv ?? 0), 0) / clvBets.length
    : null;
  const brierBets = resolved.filter(b => b.result === "win" || b.result === "loss");
  const brier = brierBets.length > 0
    ? brierBets.reduce((s, b) => {
        const actual = b.result === "win" ? 1 : 0;
        return s + Math.pow(b.modelProb - actual, 2);
      }, 0) / brierBets.length
    : 0;

  return {
    totalBets: resolved.length,
    pending,
    wins,
    losses,
    pushes,
    record: `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ""}`,
    roiPct: totalWagered > 0 ? Math.round((totalPL / totalWagered) * 1000) / 10 : 0,
    totalPL: Math.round(totalPL * 100) / 100,
    avgEdge: Math.round(avgEdge * 1000) / 1000,
    avgCLV: avgCLV !== null ? Math.round(avgCLV * 10) / 10 : null,
    brierScore: Math.round(brier * 1000) / 1000,
    winRate: resolved.length > 0 ? Math.round((wins / resolved.length) * 1000) / 10 : 0,
  };
}
