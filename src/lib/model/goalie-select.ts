// ─── Smart Goalie Selection (Fix 5) ───
// Picks the likely starter based on GP + recency, not just total GP.

import type { GoalieStats } from '../stats';

export interface GoalieStart {
  team: string;
  goalieName: string;
  date: string;
}

/**
 * Select the most likely starter using recency-weighted GP.
 * If we have recent start data, heavily weight recent appearances.
 * Otherwise, fall back to total GP (existing behavior).
 */
export function selectLikelyStarter(
  goalies: GoalieStats[],
  recentStarts?: GoalieStart[],
): GoalieStats | null {
  if (!goalies || goalies.length === 0) return null;
  if (!recentStarts || recentStarts.length === 0) {
    // Fallback: most GP (existing behavior)
    return goalies[0]; // already sorted by GP desc
  }

  // Count recent starts per goalie (last 10 starts)
  const last10 = recentStarts.slice(0, 10);
  const startCounts = new Map<string, number>();
  for (const s of last10) {
    const key = s.goalieName.toLowerCase().trim();
    startCounts.set(key, (startCounts.get(key) || 0) + 1);
  }

  // Score each goalie: recentStarts * 5 + totalGP
  let best: GoalieStats | null = null;
  let bestScore = -1;
  for (const g of goalies) {
    const name = g.name.toLowerCase().trim();
    // Try exact match, then last-name match
    let recentCount = startCounts.get(name) || 0;
    if (recentCount === 0) {
      const lastName = name.split(' ').pop() || '';
      for (const [k, v] of startCounts) {
        if (k.includes(lastName)) { recentCount = v; break; }
      }
    }
    const score = recentCount * 5 + g.gamesPlayed;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }

  return best;
}
