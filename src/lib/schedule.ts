// ─── Schedule Fetchers (NHL + NBA) ───
// Pulls recent game schedule from sport APIs to feed the fatigue system.
// Fetches the last N days of schedule to detect back-to-backs and rest differentials.

import type { ScheduleEntry } from "./model/fatigue";

// Backend proxy base: replaced by deploy_website with proxy path to port 5000.
// In local dev, resolves to "" (relative paths work in the browser).
const PROXY_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Number of past days to fetch for fatigue context. */
const LOOKBACK_DAYS = 5;

/** Format a Date as YYYY-MM-DD. */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch recent NHL schedule (last N days) from the NHL API via our backend proxy.
 * Returns a flat list of ScheduleEntry objects — one per team per game.
 * Each game produces TWO entries (home + away) so fatigue can look up either team.
 */
export async function fetchRecentSchedule(): Promise<ScheduleEntry[]> {
  const entries: ScheduleEntry[] = [];
  const today = new Date();
  const dateStrings: string[] = [];

  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dateStrings.push(fmtDate(d));
  }

  // Fetch all dates in parallel
  const results = await Promise.allSettled(
    dateStrings.map(async (date) => {
      const url = `${PROXY_BASE}/api/scores/${date}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json() as {
        games?: Array<{
          homeTeam?: { abbrev?: string };
          awayTeam?: { abbrev?: string };
          startTimeUTC?: string;
          gameState?: string;
        }>;
      };
      return data.games ?? [];
    }),
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const game of result.value) {
      const homeAbbrev = game.homeTeam?.abbrev;
      const awayAbbrev = game.awayTeam?.abbrev;
      const startTime = game.startTimeUTC;
      if (!homeAbbrev || !awayAbbrev || !startTime) continue;

      // Only include games that actually happened (FINAL, OFF) or are in progress
      // Skip "FUT" (future) games that haven't been played yet
      const state = game.gameState ?? "";
      if (state === "FUT") continue;

      // Each game generates two entries — one for each team
      entries.push({ team: homeAbbrev, commenceTime: startTime });
      entries.push({ team: awayAbbrev, commenceTime: startTime });
    }
  }

  return entries;
}

// NBA team abbreviation mapping (scoreboardv3 uses triCode)
const NBA_TEAM_MAP: Record<string, string> = {
  ATL: "ATL", BOS: "BOS", BKN: "BKN", CHA: "CHA", CHI: "CHI",
  CLE: "CLE", DAL: "DAL", DEN: "DEN", DET: "DET", GSW: "GSW",
  HOU: "HOU", IND: "IND", LAC: "LAC", LAL: "LAL", MEM: "MEM",
  MIA: "MIA", MIL: "MIL", MIN: "MIN", NOP: "NOP", NYK: "NYK",
  OKC: "OKC", ORL: "ORL", PHI: "PHI", PHX: "PHX", POR: "POR",
  SAC: "SAC", SAS: "SAS", TOR: "TOR", UTA: "UTA", WAS: "WAS",
};

/**
 * Fetch recent NBA schedule (last N days) via our backend proxy.
 * Returns a flat list of ScheduleEntry objects — one per team per game.
 */
export async function fetchNbaRecentSchedule(): Promise<ScheduleEntry[]> {
  const entries: ScheduleEntry[] = [];
  const today = new Date();
  const dateStrings: string[] = [];

  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dateStrings.push(fmtDate(d));
  }

  const results = await Promise.allSettled(
    dateStrings.map(async (date) => {
      const url = `${PROXY_BASE}/api/nba/schedule/${date}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json() as {
        scoreboard?: {
          games?: Array<{
            homeTeam?: { teamTricode?: string };
            awayTeam?: { teamTricode?: string };
            gameTimeUTC?: string;
            gameStatus?: number; // 1=scheduled, 2=in progress, 3=final
          }>;
        };
      };
      return data.scoreboard?.games ?? [];
    }),
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const game of result.value) {
      const homeCode = game.homeTeam?.teamTricode;
      const awayCode = game.awayTeam?.teamTricode;
      const gameTime = game.gameTimeUTC;
      const status = game.gameStatus ?? 0;
      if (!homeCode || !awayCode || !gameTime) continue;

      // Only include completed (3) or in-progress (2) games
      if (status < 2) continue;

      const homeAbbrev = NBA_TEAM_MAP[homeCode] || homeCode;
      const awayAbbrev = NBA_TEAM_MAP[awayCode] || awayCode;

      entries.push({ team: homeAbbrev, commenceTime: gameTime });
      entries.push({ team: awayAbbrev, commenceTime: gameTime });
    }
  }

  return entries;
}
