// ─── Schedule Fatigue Adjustments ───
// Adjusts team scoring expectations based on rest, back-to-backs, and travel.

export interface ScheduleEntry {
  team: string;          // team abbreviation
  commenceTime: string;  // ISO datetime
}

export interface FatigueConfig {
  fatigueEnabled: boolean;
  b2bPenalty: number;              // multiplier for back-to-back (e.g. 0.95 = 5% reduction)
  restBonusPerDay: number;         // bonus per extra rest day over opponent
  maxRestBonus: number;            // cap on rest bonus multiplier
  travelPenaltyPerKm: number;     // per-km penalty (0 = disabled)
  timezonePenaltyPerHour: number;  // per-hour TZ penalty (0 = disabled)
}

export interface FatigueAdjustment {
  homeFactor: number;  // multiplier on homeLam (< 1 = tired, > 1 = rested)
  awayFactor: number;  // multiplier on awayLam
  reasons: string[];   // human-readable reasons (for debugging)
}

const HOURS_28 = 28 * 60 * 60 * 1000; // 28 hours in ms

/**
 * Compute rest days since last game for a team.
 * Returns Infinity if no recent game found.
 */
function restDaysSinceLast(
  team: string,
  gameTime: Date,
  schedule: ScheduleEntry[],
): number {
  let mostRecent = -Infinity;
  for (const entry of schedule) {
    if (entry.team !== team) continue;
    const t = new Date(entry.commenceTime).getTime();
    if (t < gameTime.getTime() && t > mostRecent) {
      mostRecent = t;
    }
  }
  if (mostRecent === -Infinity) return Infinity;
  return (gameTime.getTime() - mostRecent) / (24 * 60 * 60 * 1000);
}

/**
 * Check if a team is on a back-to-back (played within ~28 hours).
 */
function isBackToBack(
  team: string,
  gameTime: Date,
  schedule: ScheduleEntry[],
): boolean {
  for (const entry of schedule) {
    if (entry.team !== team) continue;
    const t = new Date(entry.commenceTime).getTime();
    const diff = gameTime.getTime() - t;
    if (diff > 0 && diff <= HOURS_28) return true;
  }
  return false;
}

/**
 * Compute fatigue adjustment factors for a matchup.
 * Returns neutral (1.0, 1.0) if fatigue is disabled or no schedule data.
 */
export function computeFatigueAdjustment(
  gameTime: string,
  homeTeam: string,
  awayTeam: string,
  schedule: ScheduleEntry[],
  cfg: FatigueConfig,
): FatigueAdjustment {
  if (!cfg.fatigueEnabled || schedule.length === 0) {
    return { homeFactor: 1.0, awayFactor: 1.0, reasons: [] };
  }

  const gt = new Date(gameTime);
  let homeFactor = 1.0;
  let awayFactor = 1.0;
  const reasons: string[] = [];

  // Back-to-back detection
  const homeB2B = isBackToBack(homeTeam, gt, schedule);
  const awayB2B = isBackToBack(awayTeam, gt, schedule);

  if (homeB2B) {
    homeFactor *= cfg.b2bPenalty;
    reasons.push(`${homeTeam} B2B penalty (×${cfg.b2bPenalty})`);
  }
  if (awayB2B) {
    awayFactor *= cfg.b2bPenalty;
    reasons.push(`${awayTeam} B2B penalty (×${cfg.b2bPenalty})`);
  }

  // Rest advantage comparison
  const homeRest = restDaysSinceLast(homeTeam, gt, schedule);
  const awayRest = restDaysSinceLast(awayTeam, gt, schedule);

  if (homeRest !== Infinity && awayRest !== Infinity) {
    const restDiff = Math.floor(homeRest) - Math.floor(awayRest);
    if (restDiff >= 1) {  // N-3: lowered from 2 to capture 1-day rest advantage
      const bonus = Math.min(1 + restDiff * cfg.restBonusPerDay, cfg.maxRestBonus);
      homeFactor *= bonus;
      reasons.push(`${homeTeam} rest advantage: ${restDiff}d (×${bonus.toFixed(3)})`);
    } else if (restDiff <= -1) {  // N-3: lowered from -2
      const bonus = Math.min(1 + Math.abs(restDiff) * cfg.restBonusPerDay, cfg.maxRestBonus);
      awayFactor *= bonus;
      reasons.push(`${awayTeam} rest advantage: ${Math.abs(restDiff)}d (×${bonus.toFixed(3)})`);
    }
  }

  // Travel/timezone hooks (disabled by default, ready for future use)
  // These would apply cfg.travelPenaltyPerKm and cfg.timezonePenaltyPerHour
  // when distance/timezone data becomes available.

  return { homeFactor, awayFactor, reasons };
}
