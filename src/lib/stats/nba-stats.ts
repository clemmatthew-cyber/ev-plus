// ─── NBA Team Ratings Fetcher ───
// Fetches advanced team stats from NBA.com via our server proxy.
// Returns pace-adjusted offensive/defensive ratings with recency and home/away splits.

export interface NbaTeamRatings {
  team: string;           // NBA.com abbreviation
  gamesPlayed: number;
  // Full season
  offRtg: number;         // points per 100 possessions
  defRtg: number;         // points allowed per 100 possessions
  pace: number;           // possessions per 48 min
  netRtg: number;         // offRtg - defRtg
  // Last 10 games
  offRtg10: number;
  defRtg10: number;
  pace10: number;
  netRtg10: number;
  // Home splits
  homeOffRtg: number;
  homeDefRtg: number;
  homePace: number;
  // Away splits
  awayOffRtg: number;
  awayDefRtg: number;
  awayPace: number;
}

// Backend proxy base
const PROXY_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Module-level cache
let ratingsCache: { data: Map<string, NbaTeamRatings>; ts: number } | null = null;
const CACHE_TTL = 30 * 60_000; // 30 minutes

// NBA.com abbreviations that differ from The Odds API / standard abbreviations.
// Currently identical, but kept as a lookup in case NBA.com ever diverges.
const NBA_ABBREV_MAP: Record<string, string> = {
  // Add overrides here if NBA.com starts using different codes, e.g.:
  // "PHX": "PHO",  // if NBA.com used PHO instead of PHX
};

interface NbaApiResponse {
  resultSets: {
    headers: string[];
    rowSet: (string | number)[][];
  }[];
}

/**
 * Parse NBA.com leaguedashteamstats response into a Map keyed by team abbreviation.
 * Returns a map of team abbrev → { offRtg, defRtg, pace, netRtg, gamesPlayed }.
 */
function parseStatsResponse(data: NbaApiResponse): Map<string, { offRtg: number; defRtg: number; pace: number; netRtg: number; gamesPlayed: number }> {
  const result = new Map<string, { offRtg: number; defRtg: number; pace: number; netRtg: number; gamesPlayed: number }>();
  const rs = data.resultSets?.[0];
  if (!rs) return result;

  const headers = rs.headers;
  const iTeam = headers.indexOf("TEAM_ABBREVIATION");
  const iGP = headers.indexOf("GP");
  const iOffRtg = headers.indexOf("OFF_RATING");
  const iDefRtg = headers.indexOf("DEF_RATING");
  const iPace = headers.indexOf("PACE");
  const iNetRtg = headers.indexOf("NET_RATING");

  if (iTeam === -1 || iOffRtg === -1 || iDefRtg === -1 || iPace === -1) return result;

  for (const row of rs.rowSet) {
    const abbrev = String(row[iTeam]);
    const mapped = NBA_ABBREV_MAP[abbrev] || abbrev;
    result.set(mapped, {
      offRtg: Number(row[iOffRtg]) || 110,
      defRtg: Number(row[iDefRtg]) || 110,
      pace: Number(row[iPace]) || 100,
      netRtg: iNetRtg !== -1 ? Number(row[iNetRtg]) || 0 : (Number(row[iOffRtg]) || 110) - (Number(row[iDefRtg]) || 110),
      gamesPlayed: iGP !== -1 ? Number(row[iGP]) || 0 : 0,
    });
  }

  return result;
}

/**
 * Fetch NBA team ratings from all 4 variants via server proxy.
 * Returns a Map keyed by team abbreviation with full/last10/home/away splits.
 * Caches for 30 minutes.
 */
export async function fetchNbaTeamRatings(): Promise<Map<string, NbaTeamRatings>> {
  // Return cached if fresh
  if (ratingsCache && Date.now() - ratingsCache.ts < CACHE_TTL) {
    return ratingsCache.data;
  }

  const url = `${PROXY_BASE}/api/nba/team-stats`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NBA stats proxy returned ${res.status}`);

  const raw = await res.json() as {
    fullSeason: NbaApiResponse;
    last10: NbaApiResponse;
    home: NbaApiResponse;
    away: NbaApiResponse;
  };

  const full = parseStatsResponse(raw.fullSeason);
  const last10 = parseStatsResponse(raw.last10);
  const homeStats = parseStatsResponse(raw.home);
  const awayStats = parseStatsResponse(raw.away);

  const ratings = new Map<string, NbaTeamRatings>();

  // Compute league averages from actual data (fallback to static if empty)
  let lgOffRtg = 112;
  let lgDefRtg = 112;
  let lgPace = 100;
  if (full.size > 0) {
    let sumOff = 0, sumDef = 0, sumPace = 0, n = 0;
    for (const [, s] of full) {
      sumOff += s.offRtg;
      sumDef += s.defRtg;
      sumPace += s.pace;
      n++;
    }
    lgOffRtg = sumOff / n;
    lgDefRtg = sumDef / n;
    lgPace = sumPace / n;
  }

  for (const [team, fs] of full) {
    const l10 = last10.get(team);
    const hs = homeStats.get(team);
    const as = awayStats.get(team);

    ratings.set(team, {
      team,
      gamesPlayed: fs.gamesPlayed,
      // Full season
      offRtg: fs.offRtg,
      defRtg: fs.defRtg,
      pace: fs.pace,
      netRtg: fs.netRtg,
      // Last 10 — fallback to full season if missing
      offRtg10: l10?.offRtg ?? fs.offRtg,
      defRtg10: l10?.defRtg ?? fs.defRtg,
      pace10: l10?.pace ?? fs.pace,
      netRtg10: l10?.netRtg ?? fs.netRtg,
      // Home splits — fallback to full season
      homeOffRtg: hs?.offRtg ?? fs.offRtg,
      homeDefRtg: hs?.defRtg ?? fs.defRtg,
      homePace: hs?.pace ?? fs.pace,
      // Away splits — fallback to full season
      awayOffRtg: as?.offRtg ?? fs.offRtg,
      awayDefRtg: as?.defRtg ?? fs.defRtg,
      awayPace: as?.pace ?? fs.pace,
    });
  }

  // Early-season regression: if gamesPlayed < 15, regress toward league average
  for (const [, r] of ratings) {
    if (r.gamesPlayed < 15 && r.gamesPlayed > 0) {
      const w = r.gamesPlayed / 15; // 0..1
      r.offRtg = r.offRtg * w + lgOffRtg * (1 - w);
      r.defRtg = r.defRtg * w + lgDefRtg * (1 - w);
      r.pace = r.pace * w + lgPace * (1 - w);
      r.netRtg = r.offRtg - r.defRtg;
    }
  }

  ratingsCache = { data: ratings, ts: Date.now() };
  return ratings;
}
