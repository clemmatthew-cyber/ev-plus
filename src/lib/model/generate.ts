// ─── generateEvBets — Core Orchestrator ───
// Takes raw data + config, returns scored EvBet[] array.
// No side effects, no fetching — pure transformation.

import type { EvBet, GoalieConfirmation, GoalieStatus } from "../types";
import type { GameOdds, BestLine } from "../odds";
import { findBestLine, bookName, teamAbbrev } from "../odds";
import type { TeamStats, GoalieStats, LeagueAverages } from "../stats";
// getStarter replaced by selectLikelyStarter (Fix 5)

import type { ModelConfig } from "./config";
import { estimateMatchupLambdas } from "./lambdas";
import { buildGrid, buildGridDC, mlProb, plProb, totalProb } from "./poisson";
import { computeStake } from "./kelly";
import { computeConfidence } from "./confidence";
import { simulateGame, type SimulationResult } from "./simulation";
import { computeFatigueAdjustment, type ScheduleEntry } from "./fatigue";
import { computeFormFactor, computeHomeAwaySplit, type RecentGameResult } from "./form";
import { fitDixonColesRho, buildGameResultsForFitting } from "./fit-rho";
import { selectLikelyStarter, type GoalieStart } from "./goalie-select";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Compute league-average GSAx/60 across all goalies.
 * Used as the baseline for goalie adjustment.
 */
function computeLeagueAvgGsax(goalies: Map<string, GoalieStats[]>): number {
  let totalGsax = 0;
  let totalMinutes = 0;
  for (const list of goalies.values()) {
    for (const g of list) {
      if (g.gamesPlayed < 5) continue;
      const minutes = g.iceTime / 60;
      totalGsax += g.gsax;
      totalMinutes += minutes;
    }
  }
  if (totalMinutes <= 0) return 0;
  return (totalGsax / totalMinutes) * 60; // GSAx per 60 minutes
}

export interface GenerateInput {
  games: GameOdds[];
  stats: Map<string, TeamStats>;
  goalies: Map<string, GoalieStats[]>;
  lg: LeagueAverages;
  lgGoalsPerGame: number;
  config: ModelConfig;
  recentGames?: ScheduleEntry[];
  sharpBookScores?: Map<string, number>;
  goalieConfirmations?: Map<string, GoalieConfirmation>;
  recentResults?: RecentGameResult[];
  recentGoalieStarts?: Map<string, GoalieStart[]>;
}

/**
 * Find a goalie by name in the goalie stats map.
 * Tries exact match first, then last-name match.
 */
function findGoalieByName(
  goalies: Map<string, GoalieStats[]>,
  team: string,
  name: string,
): GoalieStats | null {
  const list = goalies.get(team);
  if (!list) return null;
  const normalized = name.toLowerCase().trim();
  return list.find(g => g.name.toLowerCase().trim() === normalized)
    || list.find(g => normalized.includes(g.name.toLowerCase().split(' ').pop() || ''))
    || null;
}

/**
 * Main bet generation pipeline.
 *
 * For each game:
 * 1. Look up team stats + starter goalies
 * 2. Estimate matchup lambdas (xG Poisson + situation splits + goalie adj)
 * 3. For each market (ML, PL, totals), compute modelProb via Poisson grid
 * 4. Find best line across books, extract fairProb via Shin devig
 * 5. Compute edge, EV, confidence, Kelly stake
 * 6. Filter by market-specific min edge + grade-based stake > 0
 * 7. Return sorted by edge descending
 */
export function generateEvBets(input: GenerateInput): EvBet[] {
  const { games, stats, goalies, lg, lgGoalsPerGame, config: cfg, recentGames, sharpBookScores, goalieConfirmations, recentResults, recentGoalieStarts } = input;
  const hasStats = stats.size > 0;
  const hasGoalies = goalies.size > 0;
  const max = cfg.poissonMaxGoals;

  const lgAvgGsax = hasGoalies ? computeLeagueAvgGsax(goalies) : 0;

  // Fix 3: Fit Dixon-Coles rho from recent results if available
  let fittedRho = cfg.dixonColesRho;
  if (recentResults && recentResults.length > 100) {
    const gameResults = buildGameResultsForFitting(recentResults, stats, lg);
    if (gameResults.length >= 50) {
      fittedRho = fitDixonColesRho(gameResults);
    }
  }

  const bets: EvBet[] = [];
  let id = 0;

  for (const game of games) {
    const hA = teamAbbrev(game.homeTeam);
    const aA = teamAbbrev(game.awayTeam);
    const hS = stats.get(hA);
    const aS = stats.get(aA);
    const nBooks = game.bookmakers.length;

    // Fix 5: Smart goalie selection — use recency when available
    let hGoalie = hasGoalies
      ? selectLikelyStarter(goalies.get(hA) ?? [], recentGoalieStarts?.get(hA))
      : null;
    let aGoalie = hasGoalies
      ? selectLikelyStarter(goalies.get(aA) ?? [], recentGoalieStarts?.get(aA))
      : null;

    // ── Goalie confirmation override ──
    let hGoalieStatus: GoalieStatus = 'unknown';
    let aGoalieStatus: GoalieStatus = 'unknown';

    if (cfg.goalieConfirmationEnabled && goalieConfirmations) {
      const hConf = goalieConfirmations.get(hA);
      const aConf = goalieConfirmations.get(aA);

      if (hConf) {
        hGoalieStatus = hConf.status;
        if (hConf.status === 'confirmed' && hasGoalies) {
          const confirmed = findGoalieByName(goalies, hA, hConf.goalieName);
          if (confirmed) hGoalie = confirmed;
        }
      }

      if (aConf) {
        aGoalieStatus = aConf.status;
        if (aConf.status === 'confirmed' && hasGoalies) {
          const confirmed = findGoalieByName(goalies, aA, aConf.goalieName);
          if (confirmed) aGoalie = confirmed;
        }
      }
    }

    // ── Estimate lambdas ──
    let { homeLam, awayLam, hasGoalieData } = hS && aS
      ? estimateMatchupLambdas(hS, aS, hGoalie, aGoalie, lg, lgAvgGsax, cfg)
      : { homeLam: lgGoalsPerGame / 2, awayLam: lgGoalsPerGame / 2, hasGoalieData: false };

    // ── Apply fatigue adjustment ──
    const fatigue = computeFatigueAdjustment(
      game.commenceTime, hA, aA, recentGames ?? [], {
        fatigueEnabled: cfg.fatigueEnabled,
        b2bPenalty: cfg.b2bPenalty,
        restBonusPerDay: cfg.restBonusPerDay,
        maxRestBonus: cfg.maxRestBonus,
        travelPenaltyPerKm: cfg.travelPenaltyPerKm,
        timezonePenaltyPerHour: cfg.timezonePenaltyPerHour,
      },
    );
    homeLam *= fatigue.homeFactor;
    awayLam *= fatigue.awayFactor;

    // Fix 1: Apply recent form factor
    if (recentResults && recentResults.length > 0 && hS && aS) {
      const homeForm = computeFormFactor(hA, recentResults, hS.avgGoalsFor, hS.avgGoalsAgainst, cfg);
      const awayForm = computeFormFactor(aA, recentResults, aS.avgGoalsFor, aS.avgGoalsAgainst, cfg);
      homeLam *= homeForm;
      awayLam *= awayForm;
    }

    // Fix 2: Apply per-team home/away splits
    if (recentResults && recentResults.length > 0) {
      const homeSplit = computeHomeAwaySplit(hA, recentResults, {
        homeAwaySplitEnabled: cfg.homeAwaySplitEnabled,
        homeAwaySplitWeight: cfg.homeAwaySplitWeight,
      });
      homeLam *= homeSplit.homeOffenseFactor;
      awayLam /= homeSplit.homeDefenseFactor; // better home D = opponent scores less
    }

    const hGP = hS?.gamesPlayed ?? 40;
    const aGP = aS?.gamesPlayed ?? 40;

    // ── Try Monte Carlo simulation as primary engine ──
    let sim: SimulationResult | null = null;
    try {
      sim = simulateGame(homeLam, awayLam, {
        simCount: cfg.simCount,
        otHomeAdvantage: cfg.otHomeAdvantage,
        dixonColesRho: fittedRho,  // Fix 3: use season-fitted rho
        simMaxScore: cfg.simMaxScore,
        simSpreadLines: cfg.simSpreadLines,
      });
      // Validate result
      if (!isFinite(sim.homeWinProb) || !isFinite(sim.awayWinProb) ||
          sim.homeWinProb <= 0 || sim.awayWinProb <= 0) {
        sim = null;
      }
    } catch (e) {
      console.warn(`[Model] Simulation failed for ${hA} vs ${aA}:`, e instanceof Error ? e.message : e);  // N-20
      sim = null;
    }

    // Build Poisson grid as fallback (with Dixon-Coles correction using fitted rho)
    const homeGrid = sim ? buildGrid(homeLam, awayLam, max) : buildGridDC(homeLam, awayLam, max, fittedRho);
    const awayGrid = sim ? buildGrid(awayLam, homeLam, max) : buildGridDC(awayLam, homeLam, max, fittedRho);

    // ── Helper: evaluate one bet opportunity ──
    function tryBet(
      market: "ml" | "pl" | "totals",
      outcome: string,
      mp: number,
      bl: BestLine,
    ): void {
      const minEdge = cfg.minEdge[market];
      const edge = mp - bl.fairProb;
      if (edge < minEdge) return;

      const ev = mp * (bl.decimalOdds - 1) - (1 - mp);

      const sbScore = sharpBookScores?.get(bl.book);
      const conf = computeConfidence(
        edge, mp, bl.fairProb, nBooks, hGP, aGP,
        hasGoalieData, market, cfg, sbScore,
        hGoalieStatus, aGoalieStatus,
      );

      const { kellyFraction, stake } = computeStake(mp, bl.decimalOdds, conf.grade, cfg);
      if (stake <= 0) return; // grade D or zero stake

      bets.push({
        id: `ev-${++id}`,
        gameId: game.id,
        gameTime: game.commenceTime,
        homeTeam: hA,
        awayTeam: aA,
        market,
        outcome,
        bestBook: bookName(bl.book),
        bestPrice: bl.price,
        bestLine: bl.point ?? null,
        modelProb: r3(mp),
        impliedProb: r3(bl.impliedProb),
        fairProb: r3(bl.fairProb),
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

    // ── Moneyline ──
    for (const [team, isHome] of [
      [game.homeTeam, true],
      [game.awayTeam, false],
    ] as [string, boolean][]) {
      const bl = findBestLine(game, "h2h", team);
      if (!bl) continue;
      const ab = isHome ? hA : aA;
      const mp = sim
        ? (isHome ? sim.homeWinProb : sim.awayWinProb)
        : mlProb(isHome ? homeLam : awayLam, isHome ? awayLam : homeLam, max, isHome ? homeGrid : awayGrid);
      tryBet("ml", `${ab} ML`, mp, bl);
    }

    // ── Puckline ──
    for (const [team, isHome, spread] of [
      [game.homeTeam, true, -1.5],
      [game.homeTeam, true, 1.5],
      [game.awayTeam, false, 1.5],
      [game.awayTeam, false, -1.5],
    ] as [string, boolean, number][]) {
      const bl = findBestLine(game, "spreads", team, spread);
      if (!bl) continue;
      const ab = isHome ? hA : aA;
      let mp: number;
      const simSpread = sim?.spreadProbs.get(spread);
      if (sim && simSpread) {
        mp = isHome ? simSpread.homeCovers : simSpread.awayCovers;
      } else {
        mp = plProb(isHome ? homeLam : awayLam, isHome ? awayLam : homeLam, spread, max, isHome ? homeGrid : awayGrid);
      }
      tryBet("pl", `PL ${ab} ${spread > 0 ? "+" : ""}${spread}`, mp, bl);
    }

    // ── Totals ──
    // Fix 6: Empty-net goal adjustment for close games
    const isCloseGame = Math.abs(homeLam - awayLam) < 0.5;
    const enBoost = isCloseGame ? cfg.emptyNetBoost : 0;

    const lines = new Set<number>();
    for (const bk of game.bookmakers)
      for (const m of bk.markets)
        if (m.key === "totals") for (const o of m.outcomes) if (o.point != null) lines.add(Math.round(o.point * 10) / 10);  // C-31: round floats before dedup

    // Fix 6: For simulation path, shift total probs for close games
    if (sim && isCloseGame && enBoost > 0) {
      for (const [, probs] of sim.totalProbs) {
        const shift = enBoost * 0.1; // small probability shift toward over
        probs.over = Math.min(0.95, probs.over + shift);
        probs.under = Math.max(0.05, probs.under - shift);
      }
    }

    for (const line of lines) {
      for (const [name, isOver] of [["Over", true], ["Under", false]] as [string, boolean][]) {
        const bl = findBestLine(game, "totals", name, line);
        if (!bl) continue;
        let mp: number;
        const simTotal = sim?.totalProbs.get(line);
        if (sim && simTotal) {
          mp = isOver ? simTotal.over : simTotal.under;
        } else {
          // Fix 6: Apply empty-net boost to Poisson grid path
          const halfBoost = enBoost / 2;
          mp = totalProb(homeLam + halfBoost, awayLam + halfBoost, line, isOver, max);
        }
        tryBet("totals", `${name} ${line}`, mp, bl);
      }
    }
  }

  return bets.sort((a, b) => b.edge - a.edge);
}
