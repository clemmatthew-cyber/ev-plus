// ─── MoneyPuck Team + Goalie Stats — via backend proxy ───
// Parses 5on5, 5on4 (PP), 4on5 (PK), "all" situations
// Includes danger-zone xG splits, high-danger conversion rates
// Goalie GSAx (Goals Saved Above Expected) for per-game adjustments

export interface SituationStats {
  gamesPlayed: number;
  iceTime: number;
  xGoalsFor: number;
  xGoalsAgainst: number;
  goalsFor: number;
  goalsAgainst: number;
  shotsFor: number;
  shotsAgainst: number;
  highDangerXgFor: number;
  highDangerXgAgainst: number;
  highDangerGoalsFor: number;
  highDangerGoalsAgainst: number;
  medDangerXgFor: number;
  medDangerXgAgainst: number;
  lowDangerXgFor: number;
  lowDangerXgAgainst: number;
  penaltiesFor: number;
  penaltiesAgainst: number;
}

export interface TeamStats {
  team: string;
  gamesPlayed: number;
  // Per-game averages from "all" (kept for backwards compat)
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  avgXgFor: number;
  avgXgAgainst: number;
  // Situation splits (totals, not per-game)
  ev: SituationStats;   // 5on5
  pp: SituationStats;   // 5on4
  pk: SituationStats;   // 4on5
  all: SituationStats;  // all situations
}

export interface GoalieStats {
  name: string;
  team: string;
  gamesPlayed: number;
  iceTime: number;
  xGoals: number;       // expected goals against
  goals: number;        // actual goals against
  onGoal: number;       // shots on goal faced
  gsax: number;         // goals saved above expected (xGoals - goals, positive = good)
  gsaxPer60: number;    // GSAx per 60 minutes
  svPct: number;        // save percentage
  xSvPct: number;       // expected save percentage
}

const MP_MAP: Record<string, string> = {
  "L.A": "LAK", "N.J": "NJD", "S.J": "SJS", "T.B": "TBL",
};

// Backend proxy base: replaced by deploy_website with proxy path to port 5000
const PROXY_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// MoneyPuck direct URLs
const MP_TEAMS_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/teams.csv";
const MP_GOALIES_URL = "https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/goalies.csv";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Single attempt to fetch CSV: proxy → same-origin → direct */
async function tryFetchCsv(proxyPath: string, directUrl: string): Promise<string | null> {
  if (PROXY_BASE) {
    try {
      const res = await fetch(`${PROXY_BASE}${proxyPath}`);
      if (res.ok) return await res.text();
    } catch { /* proxy unavailable */ }
  }
  try {
    const res = await fetch(proxyPath);
    if (res.ok) return await res.text();
  } catch { /* not available */ }
  try {
    const res = await fetch(directUrl);
    if (res.ok) return await res.text();
  } catch { /* CORS blocked */ }
  return null;
}

/** Fetch CSV with retry for cold starts */
async function fetchCsv(proxyPath: string, directUrl: string): Promise<string> {
  const delays = [0, 3000, 5000];
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const result = await tryFetchCsv(proxyPath, directUrl);
    if (result) return result;
  }
  return "";
}

function normTeam(mp: string): string {
  return MP_MAP[mp] || mp;
}

// ─── Parse situation row into SituationStats ───

function parseSituation(cols: string[], idx: (n: string) => number): SituationStats {
  const f = (n: string) => parseFloat(cols[idx(n)]) || 0;
  return {
    gamesPlayed: f("games_played") || 1,
    iceTime: f("iceTime"),
    xGoalsFor: f("xGoalsFor"),
    xGoalsAgainst: f("xGoalsAgainst"),
    goalsFor: f("goalsFor"),
    goalsAgainst: f("goalsAgainst"),
    shotsFor: f("shotsOnGoalFor"),
    shotsAgainst: f("shotsOnGoalAgainst"),
    highDangerXgFor: f("highDangerxGoalsFor"),
    highDangerXgAgainst: f("highDangerxGoalsAgainst"),
    highDangerGoalsFor: f("highDangerGoalsFor"),
    highDangerGoalsAgainst: f("highDangerGoalsAgainst"),
    medDangerXgFor: f("mediumDangerxGoalsFor"),
    medDangerXgAgainst: f("mediumDangerxGoalsAgainst"),
    lowDangerXgFor: f("lowDangerxGoalsFor"),
    lowDangerXgAgainst: f("lowDangerxGoalsAgainst"),
    penaltiesFor: f("penaltiesFor"),
    penaltiesAgainst: f("penaltiesAgainst"),
  };
}

// ─── Team Stats Cache ───

let teamCache: Map<string, TeamStats> | null = null;
let teamCacheTime = 0;

export async function fetchTeamStats(): Promise<Map<string, TeamStats>> {
  if (teamCache && Date.now() - teamCacheTime < 4 * 3600_000) return teamCache;

  const csvText = await fetchCsv("/api/stats", MP_TEAMS_URL);
  if (!csvText) {
    console.warn("[Stats] Team stats unavailable, using odds-only mode");
    return new Map();
  }

  const lines = csvText.trim().split("\n");
  const headers = lines[0].split(",");
  const idx = (name: string) => headers.indexOf(name);

  // Temp storage: team → situation → SituationStats
  const raw = new Map<string, Map<string, SituationStats>>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const sit = cols[idx("situation")];
    if (!["all", "5on5", "5on4", "4on5"].includes(sit)) continue;

    const team = normTeam(cols[idx("team")]);
    if (!raw.has(team)) raw.set(team, new Map());
    raw.get(team)!.set(sit, parseSituation(cols, idx));
  }

  const map = new Map<string, TeamStats>();

  for (const [team, sits] of raw) {
    const all = sits.get("all");
    const ev = sits.get("5on5");
    const pp = sits.get("5on4");
    const pk = sits.get("4on5");
    if (!all) continue;

    const gp = all.gamesPlayed;
    const emptySit: SituationStats = {
      gamesPlayed: gp, iceTime: 0,
      xGoalsFor: 0, xGoalsAgainst: 0, goalsFor: 0, goalsAgainst: 0,
      shotsFor: 0, shotsAgainst: 0,
      highDangerXgFor: 0, highDangerXgAgainst: 0,
      highDangerGoalsFor: 0, highDangerGoalsAgainst: 0,
      medDangerXgFor: 0, medDangerXgAgainst: 0,
      lowDangerXgFor: 0, lowDangerXgAgainst: 0,
      penaltiesFor: 0, penaltiesAgainst: 0,
    };

    map.set(team, {
      team,
      gamesPlayed: gp,
      avgGoalsFor: all.goalsFor / gp,
      avgGoalsAgainst: all.goalsAgainst / gp,
      avgXgFor: all.xGoalsFor / gp,
      avgXgAgainst: all.xGoalsAgainst / gp,
      ev: ev || emptySit,
      pp: pp || emptySit,
      pk: pk || emptySit,
      all,
    });
  }

  teamCache = map;
  teamCacheTime = Date.now();
  return map;
}

// ─── Goalie Stats Cache ───

let goalieCache: Map<string, GoalieStats[]> | null = null; // team → goalies (sorted by games desc)
let goalieCacheTime = 0;

export async function fetchGoalieStats(): Promise<Map<string, GoalieStats[]>> {
  if (goalieCache && Date.now() - goalieCacheTime < 4 * 3600_000) return goalieCache;

  const csvText = await fetchCsv("/api/goalies", MP_GOALIES_URL);
  if (!csvText) {
    console.warn("[Stats] Goalie stats unavailable");
    return new Map();
  }

  const lines = csvText.trim().split("\n");
  const headers = lines[0].split(",");
  const idx = (name: string) => headers.indexOf(name);

  const map = new Map<string, GoalieStats[]>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols[idx("situation")] !== "all") continue;

    const team = normTeam(cols[idx("team")]);
    const gp = parseFloat(cols[idx("games_played")]) || 0;
    if (gp < 3) continue; // skip extremely small samples

    const iceTime = parseFloat(cols[idx("icetime")]) || 0;
    const xGoals = parseFloat(cols[idx("xGoals")]) || 0;
    const goals = parseFloat(cols[idx("goals")]) || 0;
    const onGoal = parseFloat(cols[idx("ongoal")]) || 1;

    const gsax = xGoals - goals; // positive = saved more than expected
    const minutes = iceTime / 60;
    const gsaxPer60 = minutes > 0 ? (gsax / minutes) * 60 : 0;
    const svPct = onGoal > 0 ? 1 - goals / onGoal : 0.9;
    const xSvPct = onGoal > 0 ? 1 - xGoals / onGoal : 0.9;

    const entry: GoalieStats = {
      name: cols[idx("name")],
      team,
      gamesPlayed: gp,
      iceTime,
      xGoals,
      goals,
      onGoal,
      gsax,
      gsaxPer60,
      svPct,
      xSvPct,
    };

    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(entry);
  }

  // Sort by games played desc (starter first)
  for (const [, goalies] of map) {
    goalies.sort((a, b) => b.gamesPlayed - a.gamesPlayed);
  }

  goalieCache = map;
  goalieCacheTime = Date.now();
  return map;
}

/** Get starter goalie (most GP) for a team */
export function getStarter(goalies: Map<string, GoalieStats[]>, team: string): GoalieStats | null {
  const list = goalies.get(team);
  return list?.[0] || null;
}

// ─── League Averages ───

export interface LeagueAverages {
  goalsPerGame: number;       // total goals per game (both teams)
  evXgForPerGame: number;     // avg 5on5 xGF per team per game
  evXgAgainstPerGame: number; // avg 5on5 xGA per team per game
  ppXgPerGame: number;        // avg PP xGF per team per game
  pkXgPerGame: number;        // avg PK xGA per team per game
  ppPerGame: number;          // avg power plays per team per game
}

export function leagueAvg(stats: Map<string, TeamStats>): number {
  let totalG = 0, totalGP = 0;
  for (const s of stats.values()) { totalG += s.avgGoalsFor * s.gamesPlayed; totalGP += s.gamesPlayed; }
  return totalGP > 0 ? (totalG / totalGP) * 2 : 6.0;
}

export function leagueAverages(stats: Map<string, TeamStats>): LeagueAverages {
  let totalGP = 0;
  let totalGoals = 0;
  let totalEvXgF = 0, totalEvXgA = 0;
  let totalPpXgF = 0, totalPkXgA = 0;
  let totalPP = 0;

  for (const s of stats.values()) {
    const gp = s.gamesPlayed;
    totalGP += gp;
    totalGoals += s.all.goalsFor;
    totalEvXgF += s.ev.xGoalsFor;
    totalEvXgA += s.ev.xGoalsAgainst;
    totalPpXgF += s.pp.xGoalsFor;
    totalPkXgA += s.pk.xGoalsAgainst;
    totalPP += s.all.penaltiesAgainst; // opponent penalties = our PP opportunities
  }

  const n = totalGP || 1;
  return {
    goalsPerGame: (totalGoals / n) * 2,
    evXgForPerGame: totalEvXgF / n,
    evXgAgainstPerGame: totalEvXgA / n,
    ppXgPerGame: totalPpXgF / n,
    pkXgPerGame: totalPkXgA / n,
    ppPerGame: totalPP / n,
  };
}
