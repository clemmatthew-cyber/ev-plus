// ─── NCAAB EV Engine — Devig + Statistical Model ───
// Combines the existing devig cross-book detection with an independent
// statistical probability model using Bart Torvik efficiency data.
//
// For each game:
// 1. Run devig to get fair probabilities (sharpest book consensus)
// 2. Run statistical model to get independent probabilities from Torvik data
// 3. modelProb = Torvik statistical probability
// 4. fairProb = devig fair probability
// 5. Edge = modelProb - bestImpliedProb (statistical edge)
// 6. Surface bet if EITHER model edge OR devig edge exceeds threshold
// 7. When both agree → confidence boost

import type { EvBet } from "../types";
import type { GameOdds } from "../odds";
import { bookName, teamAbbrev } from "../odds";
import { americanToImplied, americanToDecimal } from "./devig";
import { devigAllBooks } from "./nba";
import { computeStake } from "./kelly";
import { computeConfidence } from "./confidence";
import type { ModelConfig } from "./config";
import { NCAAB_CONFIG } from "./ncaab-config";
import { computeNcaabProjection, normalCDF } from "./ncaab-model";
import type { TorvikStats } from "../stats/torvik";
import { findTeamStats } from "../stats/torvik";
import { detectTournamentContext, computeTournamentAdjustments, buildTournamentSnapshot } from "./tournament";
import { TOURNAMENT_CONFIG } from "./tournament-config";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// Backend proxy base for fire-and-forget snapshot saves
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Fire-and-forget: persist tournament game snapshot to server */
function saveTournamentSnapshot(gameId: string, snapshot: ReturnType<typeof buildTournamentSnapshot>): void {
  fetch(`${API_BASE}/api/tournament-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, snapshot }),
  }).catch(() => {});
}

/**
 * Generate NCAAB EV+ bets combining devig pipeline with Torvik statistical model.
 * Falls back to devig-only if Torvik stats are unavailable.
 */
export function generateNcaabEvBets(
  games: GameOdds[],
  config: ModelConfig,
  torvikStats: Map<string, TorvikStats> | null,
): EvBet[] {
  const bets: EvBet[] = [];
  let id = 0;
  const cfg = { ...config, ...NCAAB_CONFIG };
  const seasonGP = NCAAB_CONFIG.ncaabModel.seasonGamesPlayed;

  for (const game of games) {
    const hA = teamAbbrev(game.homeTeam);
    const aA = teamAbbrev(game.awayTeam);
    const nBooks = game.bookmakers.length;
    if (nBooks < 2) continue;

    // ─── Torvik statistical model (if available) ───
    const homeTorvikStats = torvikStats ? findTeamStats(game.homeTeam, torvikStats) : null;
    const awayTorvikStats = torvikStats ? findTeamStats(game.awayTeam, torvikStats) : null;
    const hasModel = homeTorvikStats != null && awayTorvikStats != null;

    // ─── Tournament detection ───
    const tournCtx = detectTournamentContext(
      game, homeTorvikStats, awayTorvikStats, torvikStats ?? undefined,
    );
    const tournAdj = tournCtx.isTournament
      ? computeTournamentAdjustments(tournCtx, homeTorvikStats, awayTorvikStats, torvikStats!)
      : null;

    let projection: ReturnType<typeof computeNcaabProjection> | null = null;
    if (hasModel) {
      projection = computeNcaabProjection(
        homeTorvikStats, awayTorvikStats,
        tournCtx.isTournament, // neutral site for all tournament games
      );

      // Apply tournament total/spread adjustments and recompute win probs
      if (tournCtx.isTournament && tournAdj && projection) {
        const adjustedSpread = projection.projectedSpread + tournAdj.spreadAdjustment;
        const adjustedTotal = projection.projectedTotal + tournAdj.totalAdjustment;
        const adjustedDiff = -adjustedSpread;
        const sigma = NCAAB_CONFIG.ncaabModel.scoringMarginSigma *
          TOURNAMENT_CONFIG.tournamentSigmaMultiplier;
        const adjustedHomeWinProb = normalCDF(adjustedDiff / sigma);
        projection = {
          ...projection,
          projectedSpread: adjustedSpread,
          projectedTotal: adjustedTotal,
          homeWinProb: adjustedHomeWinProb,
          awayWinProb: 1 - adjustedHomeWinProb,
        };
      }
    }

    const homeGP = homeTorvikStats?.gamesPlayed ?? seasonGP;
    const awayGP = awayTorvikStats?.gamesPlayed ?? seasonGP;

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
        const devigFairProb = info.sharpFairProb;
        const devigEdge = devigFairProb - bestImplied;

        // ─── Statistical model probability ───
        let modelProb = devigFairProb; // fallback: same as devig if no model
        if (hasModel && projection) {
          modelProb = getModelProbForOutcome(
            mDef.mType, info.name, info.point, game, projection,
            tournCtx.isTournament,
          );
        }

        const modelEdge = modelProb - bestImplied;

        // Surface bet if EITHER edge exceeds threshold
        const minEdge = cfg.minEdge[mDef.mType];
        if (modelEdge < minEdge && devigEdge < minEdge) continue;

        // Use the larger edge as the primary edge
        let primaryEdge = Math.max(modelEdge, devigEdge);
        const primaryProb = modelEdge >= devigEdge ? modelProb : devigFairProb;
        const ev = primaryProb * (bestDecimal - 1) - (1 - primaryProb);

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

        // ─── Tournament: public bias edge boost ───
        if (tournCtx.isTournament && tournAdj && tournCtx.publicBiasTeam) {
          if (mDef.mType === "ml" || mDef.mType === "pl") {
            const isAgainstPublic = info.name !== tournCtx.publicBiasTeam;
            if (isAgainstPublic) {
              primaryEdge += tournAdj.publicBiasEdgeBoost;
            }
          }
        }

        // Confidence: pass actual NCAAB GP and goalie-bypassed config
        const conf = computeConfidence(
          primaryEdge,
          modelProb,        // model prob = Torvik (independent signal)
          devigFairProb,     // fair prob = devig (consensus signal)
          nBooks,
          homeGP,            // actual NCAAB GP, not 82
          awayGP,
          true,              // pass true to avoid goalie penalty (weight is 0 anyway)
          mDef.mType,
          cfg,
        );

        // ─── Tournament: apply confidence multiplier ───
        if (tournCtx.isTournament && tournAdj) {
          const adjusted = Math.max(0, Math.min(100, conf.score * tournAdj.confidenceMultiplier));
          conf.score = Math.round(adjusted);
          // Re-grade based on adjusted score
          const cuts = cfg.confidenceGradeCutoffs ?? { A: 70, B: 50, C: 30 };
          conf.grade = adjusted >= cuts.A ? "A" : adjusted >= cuts.B ? "B" : adjusted >= cuts.C ? "C" : "D";
        }

        const { kellyFraction, stake } = computeStake(
          primaryProb, bestDecimal, conf.grade, cfg,
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
          modelProb: r3(modelProb),         // Torvik statistical probability
          impliedProb: r3(bestImplied),
          fairProb: r3(devigFairProb),       // devig fair probability
          edge: r3(primaryEdge),
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

    // ─── Tournament: save snapshot once per game ───
    if (tournCtx.isTournament && tournAdj && projection) {
      const hcaUsed = tournCtx.isNeutralSite ? 0 : NCAAB_CONFIG.ncaabModel.homeCourtAdvantage;
      const snapshot = buildTournamentSnapshot(
        tournCtx, tournAdj,
        projection.homeWinProb,
        0, // placeholder — devig prob varies by outcome
        hcaUsed,
        homeTorvikStats, awayTorvikStats,
      );
      saveTournamentSnapshot(game.id, snapshot);
    }
  }

  return bets.sort((a, b) => b.edge - a.edge);
}

/**
 * Map statistical model probability to a specific market outcome.
 * When isTournament is true, uses wider sigma from TOURNAMENT_CONFIG.
 */
function getModelProbForOutcome(
  market: "ml" | "pl" | "totals",
  outcomeName: string,
  outcomePoint: number | undefined,
  game: GameOdds,
  projection: ReturnType<typeof computeNcaabProjection>,
  isTournament = false,
): number {
  const sigmaMultiplier = isTournament ? TOURNAMENT_CONFIG.tournamentSigmaMultiplier : 1;

  if (market === "ml") {
    // Moneyline: direct win probability (already adjusted in projection for tournament)
    return outcomeName === game.homeTeam
      ? projection.homeWinProb
      : projection.awayWinProb;
  }

  if (market === "pl" && outcomePoint != null) {
    // Spread: P(team covers spread)
    const sigma = NCAAB_CONFIG.ncaabModel.scoringMarginSigma * sigmaMultiplier;
    const projectedDiff = -projection.projectedSpread; // home - away

    if (outcomeName === game.homeTeam) {
      return 1 - normalCDF((-outcomePoint - projectedDiff) / sigma);
    } else {
      return normalCDF((outcomePoint - projectedDiff) / sigma);
    }
  }

  if (market === "totals" && outcomePoint != null) {
    const sigma = NCAAB_CONFIG.ncaabModel.scoringMarginSigma * sigmaMultiplier;
    const projTotal = projection.projectedTotal;
    const totalSigma = sigma * 1.2;

    if (outcomeName === "Over") {
      return 1 - normalCDF((outcomePoint - projTotal) / totalSigma);
    } else {
      return normalCDF((outcomePoint - projTotal) / totalSigma);
    }
  }

  // Fallback: no model opinion → return 0.5
  return 0.5;
}


