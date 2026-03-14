# MMA Model Upgrade Spec — Finish Probs + Style + Recent Form

## Overview
Extend the existing MMA weighted model with 3 new feature blocks:
1. Finish probability model (KO/Sub/Dec)
2. Style interaction variables
3. Recent form weighting (last 3 / last 5 / career)

Do NOT rebuild. Extend the current sigmoid-weighted system.

---

## 1. Extend FighterStats — Data Collection

### 1a. Add fight history to FighterStats interface

In `src/lib/stats/ufcstats.ts`, extend the `FighterStats` interface:

```typescript
export interface FightRecord {
  result: 'win' | 'loss' | 'draw' | 'nc';
  opponent: string;
  method: 'KO/TKO' | 'SUB' | 'DEC' | 'OTHER';
  round: number;
  time: string;           // "3:38"
  eventDate: string;      // ISO date or raw string from page
}

// Add to FighterStats:
  detailUrl: string | null;   // fighter-details URL from listing page
  dob: string | null;         // "Jul 22, 1989" — raw from page
  age: number | null;         // calculated from DOB
  fightHistory: FightRecord[];
  // Derived finish rates (from career record)
  koRate: number;             // wins by KO/TKO / total wins (0-1)
  subRate: number;            // wins by SUB / total wins (0-1)
  decRate: number;            // wins by DEC / total wins (0-1)
  koLossRate: number;         // losses by KO/TKO / total losses (0-1)
  subLossRate: number;        // losses by SUB / total losses (0-1)
  finishRate: number;         // (KO wins + SUB wins) / total wins
```

### 1b. Capture fighter detail URLs from listing page

In the `fetchLetterPage()` function, the first `<td>` cell contains an `<a>` tag with `href` to the fighter detail page. Extract it:

```typescript
// Inside the .each() loop:
const firstLink = $(cells[0]).find('a').attr('href') || null;
// ... later in the stats object:
detailUrl: firstLink,
```

### 1c. Fetch fighter detail pages for fight history + DOB

Create a new function `fetchFighterDetail(url: string)` that:
1. Fetches the fighter detail page HTML
2. Parses the fight history table rows
3. Extracts DOB from the page
4. Returns `{ dob, fightHistory }`

**IMPORTANT**: We cannot fetch detail pages for all ~4000 fighters (too slow). Instead:
- Keep the listing page fetch as the primary data source (career stats)
- Only fetch detail pages **on demand** when we need fight history for a specific matchup
- Cache detail page results alongside the main cache

Better approach: During the initial 26-letter-page fetch, also parse the detail URL. Then in the engine, when we need fight history for a specific fighter in a matchup, fetch their detail page lazily and cache it.

Add a separate cache and fetcher:

```typescript
const detailCache = new Map<string, { dob: string | null; age: number | null; fightHistory: FightRecord[] }>();
const DETAIL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchFighterDetail(fighterUrl: string): Promise<{
  dob: string | null;
  age: number | null;
  fightHistory: FightRecord[];
}>
```

**Fight history parsing** — on the detail page:
- Table rows: `tr.b-fight-details__table-row`
- First column: W/L (win/loss/draw/nc)
- Method column text examples: "KO/TKO Punch", "SUB Rear Naked Choke", "U-DEC", "S-DEC"
- Parse method: if starts with "KO" or "TKO" → 'KO/TKO'; if starts with "SUB" → 'SUB'; if contains "DEC" → 'DEC'; else → 'OTHER'
- Round column: integer
- Time column: "M:SS"

**DOB parsing** — look for text containing "DOB:" on the page:
```typescript
const dobText = $('li').filter((_, el) => $(el).text().includes('DOB:')).text();
// Parse "DOB: Jul 22, 1989" → calculate age
```

### 1d. Compute derived finish rates

After fetching fight history, compute:
```typescript
const totalWins = fightHistory.filter(f => f.result === 'win').length;
const koWins = fightHistory.filter(f => f.result === 'win' && f.method === 'KO/TKO').length;
const subWins = fightHistory.filter(f => f.result === 'win' && f.method === 'SUB').length;
const decWins = fightHistory.filter(f => f.result === 'win' && f.method === 'DEC').length;

const totalLosses = fightHistory.filter(f => f.result === 'loss').length;
const koLosses = fightHistory.filter(f => f.result === 'loss' && f.method === 'KO/TKO').length;
const subLosses = fightHistory.filter(f => f.result === 'loss' && f.method === 'SUB').length;

stats.koRate = totalWins > 0 ? koWins / totalWins : 0;
stats.subRate = totalWins > 0 ? subWins / totalWins : 0;
stats.decRate = totalWins > 0 ? decWins / totalWins : 0;
stats.koLossRate = totalLosses > 0 ? koLosses / totalLosses : 0;
stats.subLossRate = totalLosses > 0 ? subLosses / totalLosses : 0;
stats.finishRate = totalWins > 0 ? (koWins + subWins) / totalWins : 0;
```

---

## 2. Finish Probability Model

New file: `src/lib/model/mma-finish.ts`

### Inputs
For fighter A vs B:
- A's koRate, subRate, decRate, finishRate
- B's koLossRate, subLossRate, strDef, tdDef

### Computation

```typescript
export interface FinishProbabilities {
  koProb: number;      // P(fight ends by KO/TKO)
  subProb: number;     // P(fight ends by Submission)
  decProb: number;     // P(fight ends by Decision)
}

export function computeFinishProbs(
  a: FighterStats, b: FighterStats
): FinishProbabilities {
  // Raw KO probability: average of A's KO offense and B's KO vulnerability
  const aKoThreat = a.koRate * (1 - b.strDef);   // A's KO rate × B's defensive gap
  const bKoThreat = b.koRate * (1 - a.strDef);
  const rawKoProb = (aKoThreat + bKoThreat) / 2;

  // Raw Sub probability: average of A's Sub offense and B's Sub vulnerability
  const aSubThreat = a.subRate * (1 - b.tdDef);  // A's Sub rate × B's grappling gap
  const bSubThreat = b.subRate * (1 - a.tdDef);
  const rawSubProb = (aSubThreat + bSubThreat) / 2;

  // Decision is the complement
  const rawDecProb = Math.max(0.1, 1 - rawKoProb - rawSubProb);

  // Normalize so they sum to 1
  const total = rawKoProb + rawSubProb + rawDecProb;
  return {
    koProb: rawKoProb / total,
    subProb: rawSubProb / total,
    decProb: rawDecProb / total,
  };
}
```

### How finish probs affect win probability

The finish probability model doesn't directly change the win probability. Instead, it provides a **finish type advantage** signal:
- If fighter A has a high KO rate AND opponent B has high KO loss rate → A gets a small boost
- If fighter A has a high Sub rate AND opponent B has poor TD defense → A gets a small boost
- This becomes a new feature in the weighted model

```typescript
// New feature: finishTypeAdvantage
// Measures how well A's finish profile exploits B's vulnerability
function finishTypeAdvantage(a: FighterStats, b: FighterStats): number {
  // KO exploit: A's KO offense vs B's KO vulnerability
  const koExploit = a.koRate * b.koLossRate;
  // Sub exploit: A's Sub offense vs B's Sub vulnerability
  const subExploit = a.subRate * b.subLossRate;
  // Reverse
  const bKoExploit = b.koRate * a.koLossRate;
  const bSubExploit = b.subRate * a.subLossRate;

  const aFinishThreat = koExploit + subExploit;
  const bFinishThreat = bKoExploit + bSubExploit;
  const diff = aFinishThreat - bFinishThreat;
  return sigmoid(diff, 4.0);
}
```

---

## 3. Style Interaction Variables

New file: `src/lib/model/mma-style.ts`

### 3a. Fighter Style Classification

Classify each fighter into primary style based on their stats:
```typescript
export type FighterStyle = 'striker' | 'grappler' | 'balanced';

export function classifyStyle(stats: FighterStats): FighterStyle {
  const strikingScore = stats.slpm * stats.strAcc;         // offensive striking output
  const grapplingScore = stats.tdAvg * stats.tdAcc + stats.subAvg;  // offensive grappling output

  const ratio = strikingScore / (strikingScore + grapplingScore + 0.01); // avoid div/0
  if (ratio > 0.70) return 'striker';
  if (ratio < 0.40) return 'grappler';
  return 'balanced';
}
```

### 3b. Striker vs Grappler Interaction

```typescript
// Differential: how well does A's style exploit B's weakness?
// Striker vs Grappler: striker gains edge if they have good TDD (can keep it standing)
// Grappler vs Striker: grappler gains edge if they have good TD accuracy (can take it down)
export function styleMatchupAdvantage(a: FighterStats, b: FighterStats): number {
  const aStyle = classifyStyle(a);
  const bStyle = classifyStyle(b);

  // Same style = neutral
  if (aStyle === bStyle) return 0.5;

  if (aStyle === 'striker' && bStyle === 'grappler') {
    // Striker's advantage depends on TDD — can they keep it standing?
    // A's TDD vs B's TD offense
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
```

### 3c. Stance Mismatch

```typescript
export function stanceMismatch(a: FighterStats, b: FighterStats): number {
  const aStance = a.stance.toLowerCase();
  const bStance = b.stance.toLowerCase();

  // Southpaw vs Orthodox: historically southpaws have ~3-5% edge
  if (aStance === 'southpaw' && bStance === 'orthodox') return 0.54;
  if (aStance === 'orthodox' && bStance === 'southpaw') return 0.46;

  // Switch stance = slight advantage (can adapt)
  if (aStance === 'switch' && bStance !== 'switch') return 0.53;
  if (bStance === 'switch' && aStance !== 'switch') return 0.47;

  return 0.5; // same stance = neutral
}
```

### 3d. Pressure vs Counter

```typescript
// Classify striking approach: pressure (high output, absorbs strikes)
// vs counter (lower output, higher defense, higher accuracy)
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
```

---

## 4. Recent Form Weighting

### 4a. Per-fight stats from fight history

Since UFCStats detail pages have per-fight Method/Round but NOT per-fight striking stats, we approximate recent form using:
- Recent win rate (last 3, last 5)
- Recent finish rate (last 3, last 5)
- Recent fight activity (time between fights)

```typescript
export interface RecentForm {
  last3WinRate: number;     // wins / min(3, totalFights)
  last5WinRate: number;     // wins / min(5, totalFights)
  last3FinishRate: number;  // finishes / fights in last 3
  last5FinishRate: number;  // finishes / fights in last 5
  momentum: number;         // weighted form score
}

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
```

### 4b. Recent Form Advantage Feature

```typescript
function recentFormAdvantage(aForm: RecentForm, bForm: RecentForm): number {
  const diff = aForm.momentum - bForm.momentum;
  return sigmoid(diff, 3.0);
}
```

### 4c. Blend recent form into existing stat features

The existing striking/grappling/defense features use career-only stats (from the listing page). Since we don't have per-fight striking stats from the detail page, we KEEP the career stats for those features but add recent form as an independent feature that captures momentum/trajectory.

---

## 5. Updated Weight Table

### New weights (sum = 1.00):
```typescript
const WEIGHTS = {
  elo:                  0.30,   // was 0.40, reduced to make room
  strikingDiff:         0.12,   // was 0.15
  grapplingDiff:        0.08,   // was 0.10
  defenseDiff:          0.07,   // was 0.10
  reachAdvantage:       0.08,   // was 0.10
  ageFactor:            0.07,   // was 0.10 — now uses real DOB when available
  experienceDiff:       0.03,   // was 0.05
  // NEW features:
  finishTypeAdvantage:  0.08,   // finish profile exploitation
  styleMatchup:         0.06,   // striker vs grappler interaction
  stanceMismatch:       0.03,   // southpaw/switch edge
  pressureCounter:      0.03,   // striking efficiency matchup
  recentForm:           0.05,   // momentum from last 3/5 fights
};
// Total: 0.30+0.12+0.08+0.07+0.08+0.07+0.03+0.08+0.06+0.03+0.03+0.05 = 1.00
```

---

## 6. Age Factor Upgrade

When DOB is available from the detail page, use real age instead of total-fights proxy:

```typescript
function ageAdvantage(a: FighterStats, b: FighterStats): number {
  // Prefer real age if available
  if (a.age && b.age) {
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
```

---

## 7. Engine Integration

In `mma-engine.ts`, the `computeMmaModelProb()` function gets updated:

1. Import `computeFinishProbs` from `./mma-finish`
2. Import `styleMatchupAdvantage`, `stanceMismatch`, `pressureCounterAdvantage` from `./mma-style`
3. Import `computeRecentForm`, `recentFormAdvantage` from `./mma-style` (or separate file)
4. Update the features object with all 12 features
5. Update the WEIGHTS constant
6. Return both win prob AND finish probs

New return type:
```typescript
interface MmaModelResult {
  winProb: number;
  finishProbs: FinishProbabilities;  // { koProb, subProb, decProb }
}
```

The `generateMmaEvBets()` function continues to use `winProb` for the EV calculation (unchanged). The finish probs are informational — stored but don't change edge calculation.

---

## 8. Engine Changes — fetchFighterDetail Integration

In `src/lib/engine.ts`, the MMA branch needs to also fetch detail pages for fighters in active matchups:

```typescript
} else if (sport === "mma") {
  let fighterStats = null;
  try {
    fighterStats = await fetchUfcStats();
  } catch {}

  // Enrich with detail pages for fighters in current matchups
  if (fighterStats) {
    const fighterNames = new Set<string>();
    for (const game of games) {
      fighterNames.add(game.homeTeam);
      fighterNames.add(game.awayTeam);
    }
    await enrichFighterDetails(fighterStats, fighterNames);
  }

  bets = generateMmaEvBets(games, { ...config, ...MMA_CONFIG }, fighterStats);
}
```

The `enrichFighterDetails()` function (in ufcstats.ts) fetches detail pages only for fighters in active matchups (not all 4000):

```typescript
export async function enrichFighterDetails(
  statsMap: Map<string, FighterStats>,
  fighterNames: Set<string>,
): Promise<void> {
  const toFetch: { key: string; stats: FighterStats }[] = [];

  for (const name of fighterNames) {
    const fighter = findFighterStats(name, statsMap);
    if (fighter && fighter.detailUrl && fighter.fightHistory.length === 0) {
      const key = fighter.name.toLowerCase().trim();
      toFetch.push({ key, stats: fighter });
    }
  }

  // Fetch in parallel (max ~160 fighters at most for a full UFC card)
  const results = await Promise.allSettled(
    toFetch.map(async ({ key, stats }) => {
      const detail = await fetchFighterDetail(stats.detailUrl!);
      // Mutate the stats in the map with enriched data
      stats.dob = detail.dob;
      stats.age = detail.age;
      stats.fightHistory = detail.fightHistory;
      // Compute derived finish rates
      computeFinishRates(stats);
    })
  );
}
```

---

## 9. Validation — Example Fight Output

After building, create a validation script at `src/lib/model/mma-validate.ts` that:
1. Takes two hardcoded fighter stat objects (e.g. Adesanya vs Du Plessis)
2. Runs all 12 features
3. Prints each feature value and weight
4. Prints final win probability
5. Prints finish probabilities (KO/Sub/Dec)

This should be callable as a standalone function for debugging.

---

## Files to Create
1. `src/lib/model/mma-finish.ts` — finish probability model
2. `src/lib/model/mma-style.ts` — style classification + interaction features + recent form

## Files to Modify
3. `src/lib/stats/ufcstats.ts` — extend FighterStats, add detail page fetcher, add enrichment
4. `src/lib/model/mma-engine.ts` — integrate new features, update weights, add finish prob output
5. `src/lib/engine.ts` — add enrichFighterDetails call in MMA branch

## Files NOT to Touch
- types.ts — EvBet type unchanged
- mma-config.ts — no changes needed
- mma-elo.ts — no changes needed
- server.js — no changes needed
- Any NHL/NBA/NCAAB files
- Any UI/frontend files
