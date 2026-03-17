// ─── NBA Hybrid Engine — Pace Projections + Devig ───
// Combines independent scoring projections with cross-book devig to find edges.
//
// For each game:
// 1. Project scores using pace-adjusted ratings + fatigue
// 2. Devig all books to get sharp fair probabilities
// 3. Blend: blendedProb = modelWeight * modelProb + (1-modelWeight) * sharpFairProb
// 4. Edge = blendedProb - impliedProb(bestPrice)
// 5. Score confidence using actual model-vs-market agreement

import type { EvBet } from "../types";
import type { GameOdds } from "../odds";
import { bookName, teamAbbrev } from "../odds";
import { americanToImplied, americanToDecimal } from "./devig";
import { devigAllBooks } from "./nba";
import { computeStake } from "./kelly";
import { computeConfidence } from "./confidence";
import type { ModelConfig } from "./config";
import { NBA_CONFIG } from "./nba-config";
import type { NbaTeamRatings } from "../stats/nba-stats";
import { projectNbaGame, spreadCoverProb, spreadToWinProb, normalCDF } from "./nba-projections";
import { computeFatigueAdjustment, type ScheduleEntry } from "./fatigue";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

interface NbaEngineInput {
  games: GameOdds[];
  config: ModelConfig;
  ratings: Map<string, NbaTeamRatings> | null;
  schedule: ScheduleEntry[];
}

/**
 * Find the team ratings for a given full team name.
 * The Odds API uses full names, NBA.com uses abbreviations.
 */
function findRatings(
  fullName: string,
  ratings: Map<string, NbaTeamRatings>,
): NbaTeamRatings | undefined {
  const abbrev = teamAbbrev(fullName);
  return ratings.get(abbrev);
}

/**
 * Generate NBA EV+ bets using the hybrid pace-projection + devig model.
 *
 * When ratings are available:
 *   - Projects scores from pace-adjusted O/D ratings
 *   - Blends model probability with sharp devig probability
 *   - Uses actual games played for confidence depth scoring
 *
 * When ratings are unavailable (fallback):
 *   - Falls back to pure devig (same as before)
 */
export function generateNbaEvBetsHybrid(input: NbaEngineInput): EvBet[] {
  const { games, config, ratings, schedule } = input;
  const bets: EvBet[] = [];
  let id = 0;
  const cfg = { ...config, ...NBA_CONFIG };
  const hasRatings = ratings !== null && ratings.size > 0;

  const projCfg = {
    recencyWeight: cfg.recencyWeight ?? 0.40,
    homeCourtAdj: cfg.homeCourtAdj ?? 3.0,
  };

  const fatigueCfg = {
    fatigueEnabled: cfg.fatigueEnabled ?? true,
    b2bPenalty: cfg.b2bPenalty ?? 0.97,
    restBonusPerDay: cfg.restBonusPerDay ?? 0.008,
    maxRestBonus: cfg.maxRestBonus ?? 1.02,
    travelPenaltyPerKm: 0,
    timezonePenaltyPerHour: 0,
  };

  const modelWeight = cfg.modelWeight ?? 0.35;

  for (const game of games) {
    const hA = teamAbbrev(game.homeTeam);
    const aA = teamAbbrev(game.awayTeam);
    const nBooks = game.bookmakers.length;
    if (nBooks < 2) continue;

    // Try to get ratings for projection
    const homeRatings = hasRatings ? findRatings(game.homeTeam, ratings!) : undefined;
    const awayRatings = hasRatings ? findRatings(game.awayTeam, ratings!) : undefined;
    const hasProjection = homeRatings !== undefined && awayRatings !== undefined;

    // Compute fatigue adjustment
    const fatigue = hasProjection
      ? computeFatigueAdjustment(game.commenceTime, hA, aA, schedule, fatigueCfg)
      : undefined;

    // Get projection if we have ratings for both teams
    const projection = hasProjection
      ? projectNbaGame(homeRatings!, awayRatings!, projCfg, fatigue)
      : null;

    // Games played for confidence depth scoring
    const homeGP = homeRatings?.gamesPlayed ?? 82;
    const awayGP = awayRatings?.gamesPlayed ?? 82;

    const marketDefs = [
      { key: "h2h", mType: "ml" as const },
      { key: "spreads", mType: "pl" as const },
      { key: "totals", mType: "totals" as const },
    ];

    for (const mDef of marketDefs) {
      const bookDevigs = devigAllBooks(game, mDef.key);
      if (bookDevigs.length < 2) continue;

      // Group outcomes by name+point across all books
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

          if (bd.vig < existing.sharpVig) {
            existing.sharpFairProb = o.fairProb;
            existing.sharpVig = bd.vig;
          }

          if (o.price > existing.bestPrice) {
            existing.bestPrice = o.price;
            existing.bestBook = bd.book;
          }
        }
      }

      // Evaluate each outcome for EV
      for (const [, info] of outcomeKeys) {
        if (info.nBooksOffering < 2) continue;

        const bestImplied = americanToImplied(info.bestPrice);
        const bestDecimal = americanToDecimal(info.bestPrice);

        // Compute model probability from projection (if available)
        let modelProb: number | null = null;
        if (projection) {
          if (mDef.mType === "ml") {
            // Moneyline: win probability
            modelProb = info.name === game.homeTeam
              ? projection.homeWinProb
              : projection.awayWinProb;
          } else if (mDef.mType === "pl" && info.point != null) {
            // Spread: cover probability
            const isHome = info.name === game.homeTeam;
            const margin = isHome ? projection.margin : -projection.margin;
            modelProb = spreadCoverProb(margin, info.point);
          } else if (mDef.mType === "totals" && info.point != null) {
            // Totals: over/under probability
            const isOver = info.name === "Over";
            const overProb = 1 - normalCDF((info.point - projection.total) / 10);
            modelProb = isOver ? overProb : 1 - overProb;
          }
        }

        // Blend model probability with sharp devig probability
        let blendedProb: number;
        if (modelProb !== null) {
          blendedProb = modelWeight * modelProb + (1 - modelWeight) * info.sharpFairProb;
        } else {
          // No projection available — use pure devig
          blendedProb = info.sharpFairProb;
        }

        const edge = blendedProb - bestImplied;
        const minEdge = cfg.minEdge[mDef.mType];
        if (edge < minEdge) continue;

        const ev = blendedProb * (bestDecimal - 1) - (1 - blendedProb);

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

        // For confidence: modelProb is the projection, fairProb is the devig line
        // When both are available, disagreement penalty/bonus actually means something
        const confModelProb = modelProb ?? blendedProb;
        const confFairProb = info.sharpFairProb;

        const conf = computeConfidence(
          edge, confModelProb, confFairProb, nBooks,
          homeGP, awayGP,
          false,           // no goalie data for NBA
          mDef.mType, cfg,
        );

        const { kellyFraction, stake } = computeStake(
          blendedProb, bestDecimal, conf.grade, cfg,
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
          modelProb: r3(confModelProb),
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

