// ─── NHL Schedule Fetcher ───
// Pulls recent game schedule from NHL API (api-web.nhle.com) to feed the
// fatigue system. Fetches the last N days of schedule to detect back-to-backs
// and rest-day differentials.
//
// Uses the backend proxy at /api/scores/:date which is already wired in server.js.

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
