// ─── Bet Storage — pure in-memory (session-scoped) ───
// Works everywhere including sandboxed iframes.
// When running on your own Express server, bets persist within the session.

import type { EvBet, TrackedBet } from "./types";

let betsStore: TrackedBet[] = [];

export async function getAllBets(): Promise<TrackedBet[]> {
  return [...betsStore];
}

export async function placeBet(ev: EvBet): Promise<void> {
  const dup = betsStore.find(
    b => b.gameId === ev.gameId && b.outcome === ev.outcome && b.bestBook === ev.bestBook
  );
  if (dup) return;

  betsStore.push({
    id: `tb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
    resolvedAt: null,
    homeScore: null,
    awayScore: null,
    periodType: null,
    profitLoss: 0,
    closingOdds: null,
    clv: null,
  });
}

export async function unplaceBet(gameId: string, outcome: string, book: string): Promise<void> {
  betsStore = betsStore.filter(
    b => !(b.gameId === gameId && b.outcome === outcome && b.bestBook === book && b.result === "pending")
  );
}

export async function isBetTracked(gameId: string, outcome: string, book: string): Promise<boolean> {
  return betsStore.some(b => b.gameId === gameId && b.outcome === outcome && b.bestBook === book);
}

export async function updateBet(id: string, patch: Partial<TrackedBet>): Promise<void> {
  const idx = betsStore.findIndex(b => b.id === id);
  if (idx !== -1) betsStore[idx] = { ...betsStore[idx], ...patch };
}

export async function bulkUpdate(updates: { id: string; patch: Partial<TrackedBet> }[]): Promise<void> {
  for (const { id, patch } of updates) {
    const idx = betsStore.findIndex(b => b.id === id);
    if (idx !== -1) betsStore[idx] = { ...betsStore[idx], ...patch };
  }
}

export async function deleteBet(id: string): Promise<void> {
  betsStore = betsStore.filter(b => b.id !== id);
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
  const brier = resolved.length > 0
    ? resolved.reduce((s, b) => {
        const actual = b.result === "win" ? 1 : 0;
        return s + Math.pow(b.modelProb - actual, 2);
      }, 0) / resolved.length
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
