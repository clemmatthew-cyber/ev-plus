# MMA Model Upgrade Spec — Finish Probs + Style + Recent Form

See source files for full implementation:
- `src/lib/model/mma-finish.ts` — Finish probability model
- `src/lib/model/mma-style.ts` — Style classification + interactions + recent form
- `src/lib/model/mma-engine.ts` — 12-feature weighted model
- `src/lib/stats/ufcstats.ts` — Extended with detail page fetching

## Feature Table (12 features, weights sum to 1.00)

| Feature | Weight | Description |
|---|---|---|
| elo | 0.30 | Elo win probability |
| strikingDiff | 0.12 | SLpM differential + accuracy |
| grapplingDiff | 0.08 | TD differential + sub threat |
| defenseDiff | 0.07 | Str.Def + TD Def |
| reachAdvantage | 0.08 | Reach differential |
| ageFactor | 0.07 | Age differential (real DOB when available) |
| experienceDiff | 0.03 | Career fights differential |
| finishTypeAdvantage | 0.08 | Finish profile exploitation |
| styleMatchup | 0.06 | Striker vs grappler interaction |
| stanceMismatch | 0.03 | Southpaw/switch edge |
| pressureCounter | 0.03 | Striking efficiency matchup |
| recentForm | 0.05 | Momentum from last 3/5 fights |
