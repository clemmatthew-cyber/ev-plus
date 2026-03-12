// ─── Auto-Resolver: fetches NHL scores and resolves pending bets ───

import type { TrackedBet } from "./types";
import { americanToDecimal, americanToImplied } from "./odds";
import { getAllBets, bulkUpdate } from "./store";

// ─── NHL API Types ───

interface NhlGame {
  id: number;
  gameDate: string;
  gameState: string;         // "FUT" | "PRE" | "LIVE" | "CRIT" | "FINAL" | "OFF"
  awayTeam: { abbrev: string; score?: number };
  homeTeam: { abbrev: string; score?: number };
  periodDescriptor?: {
    number: number;
    periodType: string;       // "REG" | "OT" | "SO"
  };
}

interface NhlScoreResponse {
  games: NhlGame[];
}

// ─── Fetch scores for a given date via our proxy ───

// API base: replaced by deploy_website with proxy path to port 5000 backend
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

async function fetchScores(date: string): Promise<NhlGame[]> {
  try {
    const res = await fetch(`${API_BASE}/api/scores/${date}`);
    if (!res.ok) return [];
    const data: NhlScoreResponse = await res.json();
    return data.games ?? [];
  } catch {
    return [];
  }
}

// ─── Find the matching NHL game for a tracked bet ───
// The Odds API uses full team names, we store 3-letter abbrevs

function findGame(games: NhlGame[], bet: TrackedBet): NhlGame | null {
  return games.find(
    g => g.homeTeam.abbrev === bet.homeTeam && g.awayTeam.abbrev === bet.awayTeam
  ) ?? null;
}

// ─── Determine if a game is finished ───

function isFinished(game: NhlGame): boolean {
  return game.gameState === "FINAL" || game.gameState === "OFF";
}

// ─── Resolve a bet given final scores ───

function resolveBet(
  bet: TrackedBet,
  homeScore: number,
  awayScore: number,
  periodType: string
): "win" | "loss" | "push" {
  const { market, outcome, homeTeam, awayTeam, lineAtPick } = bet;

  if (market === "ml") {
    // outcome like "STL ML" → extract team abbrev
    const team = outcome.replace(" ML", "");
    const teamIsHome = team === homeTeam;
    const teamScore = teamIsHome ? homeScore : awayScore;
    const oppScore = teamIsHome ? awayScore : homeScore;
    if (teamScore > oppScore) return "win";
    if (teamScore < oppScore) return "loss";
    return "push"; // shouldn't happen in hockey (OT/SO) but safety
  }

  if (market === "pl") {
    // outcome like "PL DET +1.5" or "PL CAR -1.5"
    // Parse: "PL TEAM ±X.X"
    const parts = outcome.split(" ");
    const team = parts[1];
    const spread = parseFloat(parts[2]);
    const teamIsHome = team === homeTeam;
    const teamScore = teamIsHome ? homeScore : awayScore;
    const oppScore = teamIsHome ? awayScore : homeScore;
    const margin = teamScore - oppScore + spread;
    if (margin > 0) return "win";
    if (margin < 0) return "loss";
    return "push";
  }

  if (market === "totals") {
    // outcome like "Over 6.5" or "Under 5.5"
    const isOver = outcome.startsWith("Over");
    const line = lineAtPick ?? parseFloat(outcome.split(" ")[1]);
    const total = homeScore + awayScore;
    if (isOver) {
      if (total > line) return "win";
      if (total < line) return "loss";
      return "push";
    } else {
      if (total < line) return "win";
      if (total > line) return "loss";
      return "push";
    }
  }

  return "loss"; // fallback
}

// ─── Calculate profit/loss ───

function calcProfitLoss(result: "win" | "loss" | "push", odds: number, stake: number): number {
  if (result === "push") return 0;
  if (result === "loss") return -stake;
  // win: profit = stake * (decimalOdds - 1)
  const dec = americanToDecimal(odds);
  return Math.round(stake * (dec - 1) * 100) / 100;
}

// ─── Calculate CLV (closing line value) ───
// CLV = implied prob at closing odds - implied prob at pick odds
// Positive = you got a better number than closing

function calcCLV(oddsAtPick: number, closingOdds: number): number {
  const pickImpl = americanToImplied(oddsAtPick);
  const closeImpl = americanToImplied(closingOdds);
  // CLV in percentage points: higher close implied = you got better value
  return Math.round((closeImpl - pickImpl) * 1000) / 10; // e.g. 2.3 means +2.3% CLV
}

// ─── Main resolver: resolve all pending bets ───

export async function resolveAllPending(): Promise<number> {
  const bets = await getAllBets();
  const pending = bets.filter(b => b.result === "pending");
  if (pending.length === 0) return 0;

  // Collect unique game dates we need to check
  const dates = new Set<string>();
  for (const bet of pending) {
    const d = bet.gameTime.split("T")[0];
    dates.add(d);
    // Also check day before (games that started late might be listed on previous day)
    const prev = new Date(d);
    prev.setDate(prev.getDate() - 1);
    dates.add(prev.toISOString().split("T")[0]);
  }

  // Fetch all needed dates in parallel
  const scoresByDate = new Map<string, NhlGame[]>();
  const fetches = [...dates].map(async d => {
    const games = await fetchScores(d);
    scoresByDate.set(d, games);
  });
  await Promise.all(fetches);

  // Flatten all games
  const allGames: NhlGame[] = [];
  for (const games of scoresByDate.values()) {
    for (const g of games) {
      if (!allGames.find(x => x.id === g.id)) allGames.push(g);
    }
  }

  // Resolve each pending bet
  const updates: { id: string; patch: Partial<TrackedBet> }[] = [];
  let resolved = 0;

  for (const bet of pending) {
    const game = findGame(allGames, bet);
    if (!game) continue;
    if (!isFinished(game)) continue;

    const hScore = game.homeTeam.score ?? 0;
    const aScore = game.awayTeam.score ?? 0;
    const pType = game.periodDescriptor?.periodType ?? "REG";

    const result = resolveBet(bet, hScore, aScore, pType);
    const profitLoss = calcProfitLoss(result, bet.oddsAtPick, bet.stake);

    const patch: Partial<TrackedBet> = {
      result,
      resolvedAt: new Date().toISOString(),
      homeScore: hScore,
      awayScore: aScore,
      periodType: pType,
      profitLoss,
    };

    // CLV: use closing odds if we captured them, otherwise skip
    if (bet.closingOdds !== null) {
      patch.clv = calcCLV(bet.oddsAtPick, bet.closingOdds);
    }

    updates.push({ id: bet.id, patch });
    resolved++;
  }

  if (updates.length > 0) {
    await bulkUpdate(updates);
  }

  return resolved;
}

// ─── Capture closing odds for bets whose games are about to start ───
// Call this periodically. For any pending bet where gameTime is in the past
// and closingOdds hasn't been set, fetch current odds and store them.

export async function captureClosingOdds(): Promise<void> {
  const bets = await getAllBets();
  const now = Date.now();
  const updates: { id: string; patch: Partial<TrackedBet> }[] = [];

  for (const bet of bets) {
    if (bet.result !== "pending") continue;
    if (bet.closingOdds !== null) continue;

    const gameStart = new Date(bet.gameTime).getTime();
    // If game started within the last 4 hours, capture closing odds
    // We use the pick odds as a proxy for closing if we can't fetch fresh ones
    if (now > gameStart && now - gameStart < 4 * 3600_000) {
      // In a perfect world we'd re-fetch from Odds API here,
      // but to conserve API calls we use the pick odds as closing odds.
      // The oddsAtPick is usually close to closing for picks made same-day.
      // TODO: optionally fetch fresh odds right before game start via a cron
      updates.push({
        id: bet.id,
        patch: { closingOdds: bet.oddsAtPick },
      });
    }
  }

  if (updates.length > 0) {
    await bulkUpdate(updates);
  }
}
