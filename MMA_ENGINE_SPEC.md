# MMA Statistical Engine — Implementation Spec

See `MMA_UPGRADE_SPEC.md` for the 12-feature upgrade spec.

## Overview
Replace the MMA pure-devig fallback with a full statistical engine using Elo ratings + fighter stats from UFCStats.com.
MMA is moneyline-only (h2h) — no spreads or totals.

## Architecture
- `src/lib/stats/ufcstats.ts` — Fighter stats fetcher (26 letter pages, ~4000 fighters, 24h cache)
- `src/lib/model/mma-elo.ts` — Elo rating system (bootstrap from W/L record)
- `src/lib/model/mma-engine.ts` — 12-feature weighted model + devig pipeline
- `src/lib/model/mma-finish.ts` — Finish probability model (KO/Sub/Dec)
- `src/lib/model/mma-style.ts` — Style classification, matchup interactions, recent form
- `src/lib/model/mma-config.ts` — MMA-specific thresholds and confidence weights

## Data Flow
1. Fetch all fighter stats from UFCStats listing pages (26 letter pages in parallel)
2. For fighters in active matchups, fetch detail pages for fight history + DOB
3. Bootstrap Elo from win/loss record
4. Compute 12-feature model probability for each fight
5. Combine with devig fair probability from cross-book consensus
6. Surface bets where model edge OR devig edge exceeds threshold
