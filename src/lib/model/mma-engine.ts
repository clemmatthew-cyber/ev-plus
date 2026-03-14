// ─── MMA EV Engine — Elo + Fighter Stats Model ───
// Combines devig cross-book detection with an independent statistical model
// using Elo ratings + fighter career stat differentials from UFCStats.com.
//
// MMA is moneyline-only (h2h) — no spreads or totals.
//
// For each fight:
// 1. Run devig to get fair probabilities (sharpest book consensus)
// 2. Look up both fighters in stats map
// 3. If both found → compute modelProb from Elo + differentials
// 4. If one/both missing → fall back to devig-only
// 5. Edge = modelProb - bestImpliedProb
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
import { MMA_CONFIG } from "./mma-config";
import type { FighterStats } from "../stats/ufcstats";
import { findFighterStats } from "../stats/ufcstats";
import { eloWinProb, bootstrapElo, sequentialElo } from "./mma-elo";
import { computeFinishProbs, finishTypeAdvantage, type FinishProbabilities } from "./mma-finish";
import { styleMatchupAdvantage, stanceMismatch, pressureCounterAdvantage, computeRecentForm, recentFormAdvantage } from "./mma-style";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ─── Feature Weight Constants ───
// 13-feature table — weights sum to 1.00
const WEIGHTS = {
  elo:                 0.28,   // Sequential Elo win probability (strongest single predictor)
  strikingDiff:        0.11,   // SLpM differential + accuracy
  grapplingDiff:       0.08,   // TD differential + sub threat
  defenseDiff:         0.06,   // Str.Def + TD Def
  reachAdvantage:      0.08,   // Reach differential (top predictive feature per research)
  ageFactor:           0.06,   // Age differential — uses real DOB when available
  experienceDiff:      0.03,   // Career fights differential
  finishTypeAdvantage: 0.07,   // Finish profile exploitation
  styleMatchup:        0.06,   // Striker vs grappler interaction
  stanceMismatch:      0.03,   // Southpaw/switch edge
  pressureCounter:     0.03,   // Striking efficiency matchup
  recentForm:          0.05,   // Momentum from last 3/5 fights
  layoffFactor:        0.06,   // Ring rust / layoff penalty
};

// ─── Sigmoid Helper ───
// Maps any real value to (0, 1), centered at 0.5.
export function sigmoid(x: number, scale: number): number {
  return 1 / (1 + Math.exp(-x * scale));
}

// ─── Layoff / Ring Rust Factor ───
// Sweet spot: 60-180 days between fights (slight boost).
// 180-365 days: neutral.
// 365+ days: increasing penalty (ring rust).
// <45 days: slight penalty (short turnaround, potential accumulated damage).

/**
 * Compute days since last fight from fight history.
 * Returns null if no date data is available.
 */
function daysSinceLastFight(history: import("../stats/ufcstats").FightRecord[]): number | null {
  if (!history || history.length === 0) return null;

  // Fight history is most-recent-first from UFCStats
  const lastFight = history[0];
  if (!lastFight.eventDate) return null;

  const parsed = new Date(lastFight.eventDate);
  if (isNaN(parsed.getTime())) return null;

  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Layoff advantage: compares ring rust / activity between two fighters.
 * Uses days since last fight to compute an activity score:
 *   - 60–180 days: optimal (score = 0.55)
 *   - 180–365 days: neutral (score = 0.50)
 *   - 365–550 days: mild rust (score = 0.43)
 *   - 550+ days: significant rust (score = 0.35)
 *   - <45 days: short turnaround penalty (score = 0.45)
 *   - null: neutral (score = 0.50)
 * Returns [0, 1]; 0.5 = neutral, >0.5 = favors A.
 */
function layoffAdvantage(a: FighterStats, b: FighterStats): number {
  function activityScore(days: number | null): number {
    if (days == null) return 0.50;
    if (days < 45)   return 0.45;   // short turnaround
    if (days <= 180) return 0.55;   // sweet spot
    if (days <= 365) return 0.50;   // normal
    if (days <= 550) return 0.43;   // mild ring rust
    return 0.35;                    // significant ring rust
  }

  const aDays = daysSinceLastFight(a.fightHistory);
  const bDays = daysSinceLastFight(b.fightHistory);

  const aScore = activityScore(aDays);
  const bScore = activityScore(bDays);

  // Difference mapped through sigmoid for smooth output
  const diff = aScore - bScore;
  return sigmoid(diff, 8.0);  // scale=8: a 0.10 diff ≈ 0.69 advantage
}

// ─── Feature Computation Functions ───
// Each returns a probability-like score in [0, 1].
// 0.5 = neutral, >0.5 = favors fighter A, <0.5 = favors fighter B.

/**
 * Striking advantage: compare net striking effectiveness.
 * aOffense = SLpM * StrAcc (attacks landing on B)
 * bDefense = SApM * (1 - StrDef) (how much B takes)
 */
function strikingAdvantage(a: FighterStats, b: FighterStats): number {
  const aOffense = a.slpm * a.strAcc;
  const bDefense = b.sapm * (1 - b.strDef);
  const bOffense = b.slpm * b.strAcc;
  const aDefense = a.sapm * (1 - a.strDef);
  const diff = (aOffense - bDefense) - (bOffense - aDefense);
  return sigmoid(diff, 2.0);
}

/**
 * Grappling advantage: takedown offense vs opponent's TD defense + submission threat.
 */
function grapplingAdvantage(a: FighterStats, b: FighterStats): number {
  const aTd = a.tdAvg * a.tdAcc * (1 - b.tdDef);
  const bTd = b.tdAvg * b.tdAcc * (1 - a.tdDef);
  const subDiff = a.subAvg - b.subAvg;
  const diff = (aTd - bTd) + subDiff * 0.3;
  return sigmoid(diff, 1.5);
}

/**
 * Defense advantage: combined striking and takedown defense.
 */
function defenseAdvantage(a: FighterStats, b: FighterStats): number {
  const aDefScore = a.strDef * 0.6 + a.tdDef * 0.4;
  const bDefScore = b.strDef * 0.6 + b.tdDef * 0.4;
  return sigmoid(aDefScore - bDefScore, 3.0);
}

/**
 * Reach advantage: longer reach is a meaningful predictor.
 * Returns 0.5 (neutral) if either fighter has no reach data.
 */
function reachAdvantage(a: FighterStats, b: FighterStats): number {
  if (!a.reach || !b.reach) return 0.5;
  const diff = a.reach - b.reach;
  return sigmoid(diff / 2, 1.0); // 2-inch reach = meaningful
}

/**
 * Age/freshness advantage.
 * Uses real age from DOB when available (from detail page enrichment).
 * Falls back to total-fights proxy when DOB is not available.
 * Younger fighters closer to the MMA peak age (~28-32) get a slight edge.
 */
function ageAdvantage(a: FighterStats, b: FighterStats): number {
  // Prefer real age if available
  if (a.age != null && b.age != null) {
    // Younger fighter gets slight edge (peak MMA age ~28-32)
    const aAgePenalty = Math.abs(a.age - 30) * 0.02;  // distance from peak
    const bAgePenalty = Math.abs(b.age - 30) * 0.02;
    const diff = bAgePenalty - aAgePenalty;  // positive = A closer to peak
    return sigmoid(diff, 3.0);
  }

  // Fallback: use total fights as proxy (original logic)
  const aFights = a.wins + a.losses + a.draws;
  const bFights = b.wins + b.losses + b.draws;
  const diff = (bFights - aFights) * 0.3;
  return sigmoid(diff, 0.5);
}

/**
 * Experience advantage: more fights = more experienced.
 */
function experienceAdvantage(a: FighterStats, b: FighterStats): number {
  const aTotal = a.wins + a.losses + a.draws;
  const bTotal = b.wins + b.losses + b.draws;
  const diff = aTotal - bTotal;
  return sigmoid(diff * 0.1, 1.0);
}

export interface MmaModelResult {
  winProb: number;
  finishProbs: FinishProbabilities;  // { koProb, subProb, decProb }
}

/**
 * Compute the combined MMA model probability for fighter A beating fighter B.
 * Weighted blend of Elo + 12 statistical differentials (13 features total).
 * Returns win probability + finish method probabilities.
 * Win probability is clamped to [0.05, 0.95] — never give absolute certainty.
 */
function computeMmaModelProb(
  a: FighterStats,
  b: FighterStats,
  eloA: number,
  eloB: number,
): MmaModelResult {
  const eloProbA = eloWinProb(eloA, eloB);

  // Compute recent form for each fighter from their fight history
  const aForm = computeRecentForm(a.fightHistory);
  const bForm = computeRecentForm(b.fightHistory);

  const features = {
    elo:                 eloProbA,
    strikingDiff:        strikingAdvantage(a, b),
    grapplingDiff:       grapplingAdvantage(a, b),
    defenseDiff:         defenseAdvantage(a, b),
    reachAdvantage:      reachAdvantage(a, b),
    ageFactor:           ageAdvantage(a, b),
    experienceDiff:      experienceAdvantage(a, b),
    finishTypeAdvantage: finishTypeAdvantage(a, b),
    styleMatchup:        styleMatchupAdvantage(a, b),
    stanceMismatch:      stanceMismatch(a, b),
    pressureCounter:     pressureCounterAdvantage(a, b),
    recentForm:          recentFormAdvantage(aForm, bForm),
    layoffFactor:        layoffAdvantage(a, b),
  };

  let modelProb = 0;
  for (const [key, value] of Object.entries(features)) {
    modelProb += value * WEIGHTS[key as keyof typeof WEIGHTS];
  }

  // Clamp to [0.05, 0.95] — never give absolute certainty
  const winProb = Math.max(0.05, Math.min(0.95, modelProb));

  // Compute finish method probabilities
  const finishProbs = computeFinishProbs(a, b);

  return { winProb, finishProbs };
}

/**
 * Generate MMA EV+ bets combining Elo + fighter stats model with devig pipeline.
 * Falls back gracefully to devig-only if fighter stats are unavailable.
 * MMA only has h2h (moneyline) markets — spreads and totals are not processed.
 */
export function generateMmaEvBets(
  games: GameOdds[],
  config: ModelConfig,
  fighterStats: Map<string, FighterStats> | null,
): EvBet[] {
  const bets: EvBet[] = [];
  let id = 0;
  const cfg = { ...config, ...MMA_CONFIG };

  // MMA only has moneyline (h2h) markets
  const marketDefs = [
    { key: "h2h", mType: "ml" as const },
  ];

  for (const game of games) {
    const hA = teamAbbrev(game.homeTeam);
    const aA = teamAbbrev(game.awayTeam);
    const nBooks = game.bookmakers.length;
    if (nBooks < 2) continue;

    // ─── Fighter stats lookup ───
    const homeFighterStats = fighterStats
      ? findFighterStats(game.homeTeam, fighterStats)
      : null;
    const awayFighterStats = fighterStats
      ? findFighterStats(game.awayTeam, fighterStats)
      : null;
    const hasModel = homeFighterStats != null && awayFighterStats != null;

    // ─── Sequential Elo from fight history (falls back to bootstrap) ───
    const homeElo = homeFighterStats
      ? sequentialElo(homeFighterStats, fighterStats!).elo
      : 1500;
    const awayElo = awayFighterStats
      ? sequentialElo(awayFighterStats, fighterStats!).elo
      : 1500;

    // ─── Pre-compute model probabilities for both sides (if stats available) ───
    // homeModelProb = P(home fighter wins)
    const homeModelResult = hasModel
      ? computeMmaModelProb(homeFighterStats!, awayFighterStats!, homeElo, awayElo)
      : null;
    const homeModelProb = homeModelResult?.winProb ?? null;
    // Store finish probs for future use (informational — not used in EV calc)
    const _finishProbs = homeModelResult?.finishProbs ?? null;
    void _finishProbs;
    const awayModelProb = homeModelProb != null ? 1 - homeModelProb : null;

    for (const mDef of marketDefs) {
      const bookDevigs = devigAllBooks(game, mDef.key);
      if (bookDevigs.length < 2) continue;

      // Group outcomes by name across all books.
      // For each outcome, find:
      //   1. The sharpest book (lowest vig) → fair prob source
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
        if (info.nBooksOffering < 2) continue;

        const bestImplied = americanToImplied(info.bestPrice);
        const bestDecimal = americanToDecimal(info.bestPrice);
        const devigFairProb = info.sharpFairProb;
        const devigEdge = devigFairProb - bestImplied;

        // ─── Statistical model probability ───
        // Fall back to devig fair prob if no model data available
        let modelProb = devigFairProb;
        if (hasModel) {
          // Determine which fighter this outcome refers to
          const isHomeFighter = info.name === game.homeTeam;
          modelProb = isHomeFighter
            ? (homeModelProb ?? devigFairProb)
            : (awayModelProb ?? devigFairProb);
        }

        const modelEdge = modelProb - bestImplied;

        // Surface bet if EITHER edge exceeds threshold
        const minEdge = cfg.minEdge[mDef.mType];
        if (modelEdge < minEdge && devigEdge < minEdge) continue;

        // Use the larger edge as the primary edge
        const primaryEdge = Math.max(modelEdge, devigEdge);
        const primaryProb = modelEdge >= devigEdge ? modelProb : devigFairProb;
        const ev = primaryProb * (bestDecimal - 1) - (1 - primaryProb);

        // Build outcome label: "FLM ML" or "FLA ML" (last-name abbrev)
        const ab = info.name === game.homeTeam ? hA : aA;
        const outcome = `${ab} ML`;

        // Confidence scoring with MMA-specific weights
        // depthWeight = 0 so homeGP/awayGP don't matter — pass 60 (full)
        // goalieWeight = 0 so hasGoalieData doesn't matter — pass true
        const conf = computeConfidence(
          primaryEdge,
          modelProb,       // statistical model probability
          devigFairProb,   // devig fair probability
          nBooks,
          60,              // depthWeight=0 in MMA config so GP doesn't affect score
          60,
          true,            // goalieWeight=0 in MMA config so this doesn't affect score
          mDef.mType,
          cfg,
        );

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
          modelProb: r3(modelProb),       // Elo + stats model probability
          impliedProb: r3(bestImplied),
          fairProb: r3(devigFairProb),    // devig fair probability
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
  }

  return bets.sort((a, b) => b.edge - a.edge);
}
