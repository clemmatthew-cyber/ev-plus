// ─── NBA EV Generator — Pure Devig Model ───
// Basketball scores are too high for Poisson. Instead we:
// 1. For each market, devig every book's lines via power method to get fair probs
// 2. Use the "sharpest" fair line as truth (lowest total vig = sharpest)
// 3. Find the best price across ALL books for each outcome
// 4. Edge = sharpFairProb - impliedProb(bestPrice)
// 5. Score confidence, compute Kelly, filter by edge threshold.
//
// This mimics how sharp bettors work: they trust the sharpest book's
// lines as "true" and look for +EV at softer books.

import type { EvBet } from "../types";
import type { GameOdds } from "../odds";
import { bookName, teamAbbrev } from "../odds";
import { americanToImplied, americanToDecimal, shinDevig } from "./devig";
import { computeStake } from "./kelly";
import { computeConfidence } from "./confidence";
import type { ModelConfig } from "./config";
import { NBA_CONFIG } from "./nba-config";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

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
 * Generate NBA EV+ bets — pure devig, no Poisson.
 */
export function generateNbaEvBets(
  games: GameOdds[],
  config: ModelConfig,
): EvBet[] {
  const bets: EvBet[] = [];
  let id = 0;
  const cfg = { ...config, ...NBA_CONFIG };

  for (const game of games) {
    const hA = teamAbbrev(game.homeTeam);
    const aA = teamAbbrev(game.awayTeam);
    const nBooks = game.bookmakers.length;
    if (nBooks < 2) continue; // Need at least 2 books for cross-book edge

    const marketDefs = [
      { key: "h2h", mType: "ml" as const },
      { key: "spreads", mType: "pl" as const },
      { key: "totals", mType: "totals" as const },
    ];

    for (const mDef of marketDefs) {
      const bookDevigs = devigAllBooks(game, mDef.key);
      if (bookDevigs.length < 2) continue;

      // Group outcomes by name+point across all books.
      // For each outcome, find:
      //   1. The sharpest book that offers it (lowest vig) → fair prob source
      //   2. The best price across all books → bet target
      const outcomeKeys = new Map<string, {
        name: string;
        point?: number;
        sharpFairProb: number;
        sharpVig: number;
        bestPrice: number;
        bestBook: string;
        nBooksOffering: number;
      }>();

      for (const bd of bookDevigs) {
        for (const o of bd.outcomes) {
          const key = o.point != null ? `${o.name}|${o.point}` : o.name;
          const existing = outcomeKeys.get(key);

          if (!existing) {
            outcomeKeys.set(key, {
              name: o.name,
              point: o.point,
              sharpFairProb: o.fairProb,
              sharpVig: bd.vig,
              bestPrice: o.price,
              bestBook: bd.book,
              nBooksOffering: 1,
            });
            continue;
          }

          existing.nBooksOffering++;

          // Update sharpest if this book has lower vig
          if (bd.vig < existing.sharpVig) {
            existing.sharpFairProb = o.fairProb;
            existing.sharpVig = bd.vig;
          }

          // Update best price if this book has better odds
          if (o.price > existing.bestPrice) {
            existing.bestPrice = o.price;
            existing.bestBook = bd.book;
          }
        }
      }

      // Evaluate each outcome for EV
      for (const [, info] of outcomeKeys) {
        // Need at least 2 books for cross-book comparison
        if (info.nBooksOffering < 2) continue;

        const bestImplied = americanToImplied(info.bestPrice);
        const bestDecimal = americanToDecimal(info.bestPrice);
        const edge = info.sharpFairProb - bestImplied;

        const minEdge = cfg.minEdge[mDef.mType];
        if (edge < minEdge) continue;

        const ev = info.sharpFairProb * (bestDecimal - 1) - (1 - info.sharpFairProb);

        // Build outcome label
        let outcome: string;
        if (mDef.mType === "ml") {
          const ab = info.name === game.homeTeam ? hA : aA;
          outcome = `${ab} ML`;
        } else if (mDef.mType === "pl") {
          const ab = info.name === game.homeTeam ? hA : aA;
          const sign = (info.point ?? 0) > 0 ? "+" : "";
          outcome = `${ab} ${sign}${info.point}`;
        } else {
          outcome = `${info.name} ${info.point}`;
        }

        const conf = computeConfidence(
          edge, info.sharpFairProb, bestImplied, nBooks,
          82, 82,          // NBA = 82 game season
          false,           // no goalie data for NBA
          mDef.mType, cfg,
        );

        const { kellyFraction, stake } = computeStake(
          info.sharpFairProb, bestDecimal, conf.grade, cfg,
        );
        if (stake <= 0) continue;

        bets.push({
          id: `ev-${++id}`,
          gameId: game.id,
          gameTime: game.commenceTime,
          homeTeam: hA,
          awayTeam: aA,
          market: mDef.mType,
          outcome,
          bestBook: bookName(info.bestBook),
          bestPrice: info.bestPrice,
          bestLine: info.point ?? null,
          modelProb: r3(info.sharpFairProb),
          impliedProb: r3(bestImplied),
          fairProb: r3(info.sharpFairProb),
          edge: r3(edge),
          ev: r3(ev),
          confidenceScore: conf.score,
          confidenceGrade: conf.grade,
          kellyFraction: r3(kellyFraction),
          suggestedStake: stake,
          placed: false,
          surfacedAt: new Date().toISOString(),
        });
      }
    }
  }

  return bets.sort((a, b) => b.edge - a.edge);
}
