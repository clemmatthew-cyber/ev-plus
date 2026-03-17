// ─── NBA EV Generator — Hybrid Pace-Projection + Devig Model ───
// Combines independent scoring projections with cross-book devig:
// 1. Fetch NBA team ratings (pace, O/D ratings, recency, home/away splits)
// 2. Project game scores and convert to market probabilities
// 3. Devig all books to find sharpest fair probability
// 4. Blend model + devig probabilities (35% model, 65% sharp devig)
// 5. Edge = blendedProb - impliedProb(bestPrice)
//
// Falls back to pure devig if NBA stats are unavailable.
// devigAllBooks is preserved here as it's imported by ncaab-engine.ts.

import type { EvBet } from "../types";
import type { GameOdds } from "../odds";
import { americanToImplied, shinDevig } from "./devig";
import type { ModelConfig } from "./config";
import { generateNbaEvBetsHybrid } from "./nba-engine";
import type { NbaTeamRatings } from "../stats/nba-stats";
import type { ScheduleEntry } from "./fatigue";

export interface BookDevig {
  book: string;
  vig: number;           // total overround (sum of implied probs)
  outcomes: {
    name: string;
    point?: number;
    price: number;        // American odds
    impliedProb: number;  // raw implied (with vig)
    fairProb: number;     // devigged fair probability
  }[];
}

/**
 * Devig all books for a given market, return per-book devigged lines.
 * Used by both NBA and NCAAB engines.
 */
export function devigAllBooks(game: GameOdds, marketKey: string): BookDevig[] {
  const results: BookDevig[] = [];

  for (const bk of game.bookmakers) {
    const market = bk.markets.find(m => m.key === marketKey);
    if (!market) continue;

    const rawProbs = market.outcomes.map(o => americanToImplied(o.price));
    const vig = rawProbs.reduce((s, p) => s + p, 0);
    const fairProbs = shinDevig(rawProbs);

    results.push({
      book: bk.key,
      vig,
      outcomes: market.outcomes.map((o, i) => ({
        name: o.name,
        point: o.point,
        price: o.price,
        impliedProb: rawProbs[i],
        fairProb: fairProbs[i],
      })),
    });
  }

  return results;
}

/**
 * Generate NBA EV+ bets — hybrid pace-projection + devig model.
 * Accepts optional ratings and schedule data for the full hybrid pipeline.
 * Falls back to pure devig when ratings are null.
 */
export function generateNbaEvBets(
  games: GameOdds[],
  config: ModelConfig,
  ratings?: Map<string, NbaTeamRatings> | null,
  schedule?: ScheduleEntry[],
): EvBet[] {
  return generateNbaEvBetsHybrid({
    games,
    config,
    ratings: ratings ?? null,
    schedule: schedule ?? [],
  });
}
