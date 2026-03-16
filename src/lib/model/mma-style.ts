// ─── MMA Style Interaction Variables ───
// Fighter style classification, matchup interactions, stance analysis,
// pressure vs. counter dynamics, and recent form weighting.

import type { FighterStats } from "../stats/ufcstats";
import type { FightRecord } from "../stats/ufcstats";

/**
 * Sigmoid helper — maps any real value to (0, 1), centered at 0.5.
 */
function sigmoid(x: number, scale: number): number {
  return 1 / (1 + Math.exp(-x * scale));
}

// ─── Style Classification ───

export type FighterStyle = 'striker' | 'grappler' | 'balanced';

/**
 * Classify a fighter's primary combat style based on their career stats.
 * Uses the ratio of striking output to total offensive output.
 */
export function classifyStyle(stats: FighterStats): FighterStyle {
  const strikingScore = stats.slpm * stats.strAcc;                          // offensive striking output
  const grapplingScore = stats.tdAvg * stats.tdAcc + stats.subAvg;          // offensive grappling output

  const ratio = strikingScore / (strikingScore + grapplingScore + 0.01);    // avoid div/0
  if (ratio > 0.70) return 'striker';
  if (ratio < 0.40) return 'grappler';
  return 'balanced';
}

// ─── Style Matchup Advantage ───

/**
 * Compute the style matchup advantage for A vs B.
 * Striker vs Grappler interactions consider each fighter's ability to impose their game.
 * Returns a [0, 1] value; 0.5 = neutral, >0.5 = favors A.
 */
export function styleMatchupAdvantage(a: FighterStats, b: FighterStats): number {
  const aStyle = classifyStyle(a);
  const bStyle = classifyStyle(b);

  // Same style = neutral
  if (aStyle === bStyle) return 0.5;

  if (aStyle === 'striker' && bStyle === 'grappler') {
    // Striker's advantage depends on TDD — can they keep it standing?
    const tddAdvantage = a.tdDef - (b.tdAvg * b.tdAcc * 0.1); // normalized
    return sigmoid(tddAdvantage, 2.0);
  }

  if (aStyle === 'grappler' && bStyle === 'striker') {
    // Grappler's advantage depends on TD success rate against striker
    const tdAdvantage = (a.tdAvg * a.tdAcc) - b.tdDef;
    return sigmoid(tdAdvantage, 2.0);
  }

  // Balanced vs specialist — slight edge to balanced
  if (aStyle === 'balanced') return 0.52;
  if (bStyle === 'balanced') return 0.48;

  return 0.5;
}

// ─── Stance Mismatch ───

/**
 * Compute stance-based matchup edge.
 * Southpaws historically have a small edge vs orthodox fighters.
 * Switch fighters have slight adaptability advantage.
 * Returns a [0, 1] value; 0.5 = neutral, >0.5 = favors A.
 */
export function stanceMismatch(a: FighterStats, b: FighterStats): number {
  const aStance = (a.stance || '').toLowerCase();
  const bStance = (b.stance || '').toLowerCase();

  // Southpaw vs Orthodox: historically southpaws have ~3-5% edge
  if (aStance === 'southpaw' && bStance === 'orthodox') return 0.54;
  if (aStance === 'orthodox' && bStance === 'southpaw') return 0.46;

  // Switch stance = slight advantage (can adapt)
  if (aStance === 'switch' && bStance !== 'switch') return 0.53;
  if (bStance === 'switch' && aStance !== 'switch') return 0.47;

  return 0.5; // same stance = neutral
}

// ─── Pressure vs Counter Advantage ───

/**
 * Compute striking efficiency matchup advantage.
 * Pressure fighters have high output but absorb more; counter fighters are efficient.
 * Returns a [0, 1] value; 0.5 = neutral, >0.5 = favors A.
 */
export function pressureCounterAdvantage(a: FighterStats, b: FighterStats): number {
  // Pressure fighter: high SLpM, higher SApM (willing to trade)
  // Counter fighter: lower SLpM, high StrDef, high StrAcc

  const aPressureScore = a.slpm - a.sapm;  // net output
  const bPressureScore = b.slpm - b.sapm;

  // If A is more of a pressure fighter and B is a counter fighter:
  // Counter fighters tend to have advantage vs pressure in MMA (can pick apart)
  // But pressure fighters who also have good accuracy are dangerous
  const aEfficiency = a.strAcc * a.strDef;  // composite efficiency
  const bEfficiency = b.strAcc * b.strDef;

  const diff = aEfficiency - bEfficiency;
  return sigmoid(diff, 3.0);
}

// ─── Recent Form ───

export interface RecentForm {
  last3WinRate: number;     // wins / min(3, totalFights)
  last5WinRate: number;     // wins / min(5, totalFights)
  last3FinishRate: number;  // finishes / fights in last 3
  last5FinishRate: number;  // finishes / fights in last 5
  momentum: number;         // weighted form score
}

/**
 * Compute recent form metrics from fight history.
 * History should be ordered most-recent first (as UFCStats provides it).
 * Falls back to neutral (0.5) values if history is empty.
 */
export function computeRecentForm(history: FightRecord[]): RecentForm {
  if (history.length === 0) {
    return { last3WinRate: 0.5, last5WinRate: 0.5, last3FinishRate: 0, last5FinishRate: 0, momentum: 0.5 };
  }

  // Fight history is ordered most recent first
  const last3 = history.slice(0, Math.min(3, history.length));
  const last5 = history.slice(0, Math.min(5, history.length));

  const winRate = (fights: FightRecord[]) =>
    fights.filter(f => f.result === 'win').length / fights.length;

  const finishRate = (fights: FightRecord[]) =>
    fights.filter(f => f.result === 'win' && (f.method === 'KO/TKO' || f.method === 'SUB')).length /
    Math.max(1, fights.filter(f => f.result === 'win').length);

  const l3wr = winRate(last3);
  const l5wr = winRate(last5);
  const careerWR = winRate(history);
  const l3fr = finishRate(last3);
  const l5fr = finishRate(last5);

  // Weighted momentum: 50% last3, 30% last5, 20% career
  const momentum = l3wr * 0.50 + l5wr * 0.30 + careerWR * 0.20;

  return { last3WinRate: l3wr, last5WinRate: l5wr, last3FinishRate: l3fr, last5FinishRate: l5fr, momentum };
}

/**
 * Recent form advantage feature for the weighted win-prob model.
 * Compares momentum scores between A and B.
 * Returns a [0, 1] value; 0.5 = neutral, >0.5 = favors A.
 */
export function recentFormAdvantage(aForm: RecentForm, bForm: RecentForm): number {
  const diff = aForm.momentum - bForm.momentum;
  return sigmoid(diff, 3.0);
}
