# MMA Statistical Engine — Implementation Spec

## Overview
Replace the MMA pure-devig fallback (currently routes to `generateNbaEvBets()`) with a full statistical engine using Elo ratings + fighter stats from UFCStats.com. MMA is **moneyline-only** (h2h) — no spreads or totals.

## Architecture (follows NCAAB pattern)

### New Files to Create

#### 1. `src/lib/stats/ufcstats.ts` — Fighter Stats Fetcher
**Purpose**: Fetch and cache fighter career stats from UFCStats.com.

**Data source**: `http://ufcstats.com/statistics/fighters?char={a-z}&page=all`
- Each letter page lists fighters in an HTML table
- Columns: First, Last, Nickname, Ht., Wt., Reach, Stance, W, L, D, Belt, SLpM, Str.Acc., SApM, Str.Def., TD Avg, TD Acc., TD Def., Sub. Avg
- The fighter detail page (linked from name) has DOB and per-fight history, but we only need the listing page stats for now

**Interface**:
```typescript
export interface FighterStats {
  name: string;           // "First Last" — matches Odds API format
  nickname: string;
  height: number | null;  // inches
  weight: number | null;  // lbs
  reach: number | null;   // inches
  stance: string;         // "Orthodox" | "Southpaw" | "Switch"
  wins: number;
  losses: number;
  draws: number;
  slpm: number;           // Significant Strikes Landed per Min
  strAcc: number;         // Striking Accuracy (0-1)
  sapm: number;           // Significant Strikes Absorbed per Min
  strDef: number;         // Strike Defense (0-1)
  tdAvg: number;          // Takedown Average per 15 min
  tdAcc: number;          // Takedown Accuracy (0-1)
  tdDef: number;          // Takedown Defense (0-1)
  subAvg: number;         // Submission Attempts per 15 min
}
```

**Implementation**:
- Use `cheerio` (already in package.json from server.js imports) to parse HTML tables
- Fetch all 26 letter pages (a-z) in parallel with `Promise.all`
- Cache for 24 hours (fighter stats don't change within a day)
- Name normalization: store as `"First Last"` lowercase for lookup

**Name matching function**:
```typescript
export function findFighterStats(
  oddsName: string,               // "Madars Fleminas" from The Odds API
  statsMap: Map<string, FighterStats>,
): FighterStats | null
```
- Normalize: lowercase, trim
- Direct map lookup first
- If no match: try last-name-first-name swap
- If no match: fuzzy similarity (Dice coefficient, threshold 0.8 — names should be very close)

#### 2. `src/lib/model/mma-elo.ts` — Elo Rating System
**Purpose**: Maintain and compute Elo ratings for all UFC fighters.

**Constants**:
```typescript
const DEFAULT_ELO = 1500;
const K_FACTOR = 235;          // Research: optimal for MMA prediction
const FINISH_BONUS = 15;       // Extra Elo shift for KO/TKO/Sub finishes
const EXPERIENCE_FLOOR = 1350; // New fighters start closer to underdog range
```

**Interface**:
```typescript
export interface EloRating {
  name: string;
  elo: number;
  fights: number;           // total fights tracked
  lastUpdated: string;      // ISO date
}
```

**Elo → Win Probability**:
```typescript
export function eloWinProb(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}
```

**Bootstrap strategy**:
- Since we don't have historical fight results in this initial build, initialize all fighters at `DEFAULT_ELO`
- Apply a record-based adjustment: `elo = DEFAULT_ELO + (wins - losses) * 12`
  - Clamp to [1200, 1900] range
  - This gives fighters with strong records a higher starting Elo
- Over time as we track results, the Elo will self-correct

**Storage**: In-memory Map<string, EloRating>, cached alongside fighter stats. No new DB tables needed initially — Elo is computed from win/loss record on each fetch.

#### 3. `src/lib/model/mma-engine.ts` — Main MMA Engine
**Purpose**: Generate MMA EV+ bets combining Elo model + fighter stat differentials + devig.

**Follows exact same pattern as `ncaab-engine.ts`**:
1. For each fight, run devig to get fair probabilities
2. Run statistical model to get independent probability (Elo + differentials)
3. `modelProb` = statistical probability
4. `fairProb` = devig fair probability
5. Edge = modelProb - bestImpliedProb
6. Surface bet if EITHER model edge OR devig edge exceeds threshold
7. When both agree → confidence boost

**Statistical Model — Feature Weights**:
```typescript
// Final model probability is a weighted blend:
const WEIGHTS = {
  elo: 0.40,              // Elo win probability (strongest single predictor)
  strikingDiff: 0.15,     // SLpM differential + accuracy
  grapplingDiff: 0.10,    // TD differential + sub threat
  defenseDiff: 0.10,      // Str.Def + TD Def
  reachAdvantage: 0.10,   // Reach differential (top predictive feature per research)
  ageFactor: 0.10,        // Age differential (top-2 most predictive feature)
  experienceDiff: 0.05,   // Career fights differential
};
```

**Feature Computation Functions**:

```typescript
// Each returns a probability-like score in [0, 1] range
// 0.5 = neutral, >0.5 = favors fighter A, <0.5 = favors fighter B

function strikingAdvantage(a: FighterStats, b: FighterStats): number {
  // Compare: SLpM * StrAcc vs opponent's SApM * (1 - StrDef)
  const aOffense = a.slpm * a.strAcc;
  const bDefense = b.sapm * (1 - b.strDef);
  const bOffense = b.slpm * b.strAcc;
  const aDefense = a.sapm * (1 - a.strDef);
  const diff = (aOffense - bDefense) - (bOffense - aDefense);
  return sigmoid(diff, 2.0);  // sigmoid with scale factor
}

function grapplingAdvantage(a: FighterStats, b: FighterStats): number {
  // TD offense vs opponent's TD defense + submission threat
  const aTd = a.tdAvg * a.tdAcc * (1 - b.tdDef);
  const bTd = b.tdAvg * b.tdAcc * (1 - a.tdDef);
  const subDiff = a.subAvg - b.subAvg;
  const diff = (aTd - bTd) + subDiff * 0.3;
  return sigmoid(diff, 1.5);
}

function defenseAdvantage(a: FighterStats, b: FighterStats): number {
  const aDefScore = a.strDef * 0.6 + a.tdDef * 0.4;
  const bDefScore = b.strDef * 0.6 + b.tdDef * 0.4;
  return sigmoid(aDefScore - bDefScore, 3.0);
}

function reachAdvantage(a: FighterStats, b: FighterStats): number {
  if (!a.reach || !b.reach) return 0.5; // neutral if missing
  const diff = a.reach - b.reach;
  return sigmoid(diff / 2, 1.0); // 2-inch reach = meaningful
}

function ageAdvantage(a: FighterStats, b: FighterStats): number {
  // DOB not on listing page — use record as proxy for career length
  // More fights often = older. We'll compare total fights as proxy.
  // Future enhancement: fetch DOB from detail pages
  const aFights = a.wins + a.losses + a.draws;
  const bFights = b.wins + b.losses + b.draws;
  // Slight edge to fighter with fewer fights (younger/hungrier) if similar record quality
  const diff = (bFights - aFights) * 0.3;
  return sigmoid(diff, 0.5);
}

function experienceAdvantage(a: FighterStats, b: FighterStats): number {
  const aTotal = a.wins + a.losses + a.draws;
  const bTotal = b.wins + b.losses + b.draws;
  const diff = aTotal - bTotal;
  return sigmoid(diff * 0.1, 1.0);
}

// Sigmoid helper: maps any real value to (0, 1), centered at 0.5
function sigmoid(x: number, scale: number): number {
  return 1 / (1 + Math.exp(-x * scale));
}
```

**Combining into final probability**:
```typescript
function computeMmaModelProb(
  a: FighterStats, b: FighterStats,
  eloA: number, eloB: number,
): number {
  const eloProbA = eloWinProb(eloA, eloB);
  const features = {
    elo: eloProbA,
    strikingDiff: strikingAdvantage(a, b),
    grapplingDiff: grapplingAdvantage(a, b),
    defenseDiff: defenseAdvantage(a, b),
    reachAdvantage: reachAdvantage(a, b),
    ageFactor: ageAdvantage(a, b),
    experienceDiff: experienceAdvantage(a, b),
  };

  let modelProb = 0;
  for (const [key, value] of Object.entries(features)) {
    modelProb += value * WEIGHTS[key as keyof typeof WEIGHTS];
  }

  // Clamp to [0.05, 0.95] — never give absolute certainty
  return Math.max(0.05, Math.min(0.95, modelProb));
}
```

**Engine function** (mirrors `generateNcaabEvBets`):
```typescript
export function generateMmaEvBets(
  games: GameOdds[],
  config: ModelConfig,
  fighterStats: Map<string, FighterStats> | null,
): EvBet[]
```

- Only process `h2h` market (moneyline). MMA has no spreads/totals.
- For each fight:
  1. Devig all books (same as NBA/NCAAB)
  2. Look up both fighters in `fighterStats`
  3. If both found → compute `modelProb` from Elo + differentials
  4. If one/both missing → fall back to devig-only (like NCAAB when Torvik fails)
  5. Edge = max(modelEdge, devigEdge)
  6. Confidence scoring with MMA-specific weights (no goalie, no GP depth)
  7. Kelly staking

#### 4. `src/lib/model/mma-config.ts` — MMA Config Overrides
```typescript
export const MMA_CONFIG = {
  minEdge: {
    ml: 0.025,      // 2.5% — MMA lines are less efficient than major sports
    pl: 0.04,       // won't be used (no spreads in MMA) but required by type
    totals: 0.045,  // won't be used (no totals in MMA) but required by type
  },
  confidence: {
    edgeWeight: 0.30,        // Edge matters most in MMA
    agreementWeight: 0.25,   // Model vs devig agreement — very important
    depthWeight: 0.00,       // No "games played" concept
    bookWeight: 0.15,        // More books = better
    priceWeight: 0.10,       // Avoid extreme favorites
    goalieWeight: 0.00,      // No goalies
    sharpBookWeight: 0.10,   // Sportsbook intelligence
  },
};
```

### Files to Modify

#### 5. `src/lib/engine.ts` — Route MMA to new engine
Change the `else` branch at line 101-104 from:
```typescript
} else {
  // NBA, MMA, and any future sport → devig model
  bets = generateNbaEvBets(games, config);
}
```
To:
```typescript
} else if (sport === "mma") {
  // MMA → Elo + fighter stats model + devig, with graceful fallback
  let fighterStats: Map<string, import("./stats/ufcstats").FighterStats> | null = null;
  try {
    fighterStats = await fetchUfcStats();
  } catch {
    // UFCStats fetch failed — fall back to devig-only
  }
  bets = generateMmaEvBets(games, { ...config, ...MMA_CONFIG }, fighterStats);
} else {
  // NBA and any future sport → devig model
  bets = generateNbaEvBets(games, config);
}
```

Add imports at top:
```typescript
import { MMA_CONFIG } from "./model/mma-config";
import { generateMmaEvBets } from "./model/mma-engine";
import { fetchUfcStats } from "./stats/ufcstats";
```

#### 6. `src/lib/odds.ts` — No changes needed
MMA fighter names from The Odds API are "First Last" format, matching our UFCStats format.
The `teamAbbrev` fallback `name.split(" ").pop()?.toUpperCase().slice(0, 3)` will produce last-name abbreviations for fighters, which is fine for MMA display.

#### 7. `server.js` — Add UFCStats proxy endpoint
Add a proxy endpoint for UFCStats (the frontend doesn't directly call it, but the backend engine does — just for diagnostics/debug):

```javascript
// ─── MMA fighter stats diagnostic ───
app.get("/api/mma/fighters", async (req, res) => {
  try {
    // Import dynamically since it's a TS module compiled to dist
    const stats = await import("./dist/lib/stats/ufcstats.js");
    const map = await stats.fetchUfcStats();
    const fighters = [...map.values()].sort((a, b) => {
      const aTotal = a.wins + a.losses + a.draws;
      const bTotal = b.wins + b.losses + b.draws;
      return bTotal - aTotal;
    });
    res.json({ count: fighters.length, fighters: fighters.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

### NO UI Changes
The frontend already handles MMA — it displays fights with ML outcomes. The confidence badge, edge percentage, and book recommendation all render the same way regardless of sport. No frontend changes needed.

### NO New DB Tables
Elo is bootstrapped from win/loss record each time fighter stats are fetched. Fighter stats are cached in memory for 24 hours. This keeps the implementation clean and avoids DB migrations.

### Implementation Order
1. `src/lib/stats/ufcstats.ts` — fetcher + name matching (most critical, most complex)
2. `src/lib/model/mma-elo.ts` — Elo computation
3. `src/lib/model/mma-config.ts` — config overrides
4. `src/lib/model/mma-engine.ts` — main engine combining everything
5. `src/lib/engine.ts` — route MMA to new engine
6. `server.js` — diagnostic endpoint
7. Build + verify

### Key Constraints
- **DO NOT modify any NHL, NBA, or NCAAB code**
- **DO NOT change the UI or frontend components**
- **DO NOT add new DB tables** (keep it simple, in-memory cache)
- **DO NOT change the EvBet type** — use existing fields
- MMA only has `h2h` market — only process moneyline
- Graceful fallback to devig-only if UFCStats fetch fails
- All new files follow existing code style (TypeScript, r3 rounding, etc.)
