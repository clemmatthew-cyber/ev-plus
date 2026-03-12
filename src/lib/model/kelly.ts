// ─── Drawdown-Aware Kelly Criterion + Grade-Scaled Staking ───
// Pure functions for position sizing.

import type { ModelConfig } from "./config";

/**
 * Compute the effective Kelly fraction after drawdown adjustment.
 *
 * If bankroll has dropped from peak:
 *   - 0–10% drawdown → full kellyFraction (0.25)
 *   - 10–20% drawdown → linearly scale from 0.25 down to kellyDrawdownFloor (0.15)
 *   - 20%+ drawdown → floor (0.15)
 */
export function adjustedKellyFraction(cfg: ModelConfig): number {
  if (cfg.peakBankroll <= 0) return cfg.kellyFraction;

  const drawdownPct = 1 - cfg.bankroll / cfg.peakBankroll;
  if (drawdownPct <= cfg.drawdownThresholds.start) return cfg.kellyFraction;
  if (drawdownPct >= cfg.drawdownThresholds.max) return cfg.kellyDrawdownFloor;

  // Linear interpolation between start and max
  const range = cfg.drawdownThresholds.max - cfg.drawdownThresholds.start;
  const progress = (drawdownPct - cfg.drawdownThresholds.start) / range;
  return cfg.kellyFraction - progress * (cfg.kellyFraction - cfg.kellyDrawdownFloor);
}

/**
 * Raw Kelly criterion fraction for a single bet.
 *
 * Kelly = (b*p - q) / b
 * where b = decimal odds - 1, p = model probability, q = 1 - p
 *
 * @returns fraction of bankroll (before scaling), clamped to [0, ∞)
 */
export function rawKelly(modelProb: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  const q = 1 - modelProb;
  return Math.max(0, (b * modelProb - q) / b);
}

/**
 * Full stake calculation.
 *
 * Pipeline:
 * 1. Raw Kelly fraction
 * 2. × drawdown-adjusted Kelly multiplier
 * 3. × confidence grade multiplier
 * 4. × bankroll → dollar amount
 * 5. Clamp to [minStake, maxStake]
 * 6. If grade multiplier is 0, return 0 (skip bet)
 */
export function computeStake(
  modelProb: number,
  decimalOdds: number,
  grade: "A" | "B" | "C" | "D",
  cfg: ModelConfig,
): { kellyFraction: number; stake: number } {
  const rk = rawKelly(modelProb, decimalOdds);
  const adjKelly = adjustedKellyFraction(cfg);
  const gradeMult = cfg.gradeMultiplier[grade];

  const fraction = rk * adjKelly * gradeMult;
  if (fraction <= 0 || gradeMult === 0) {
    return { kellyFraction: fraction, stake: 0 };
  }

  const rawDollars = cfg.bankroll * fraction;
  const stake = Math.min(cfg.maxStake, Math.max(cfg.minStake, Math.round(rawDollars)));
  return { kellyFraction: fraction, stake };
}
