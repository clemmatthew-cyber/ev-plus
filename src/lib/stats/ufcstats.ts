// ─── UFCStats Fighter Data Integration ───
// Fetches career fighter stats from ufcstats.com listing pages.
// Each letter page lists fighters alphabetically with career averages.
//
// URL pattern: http://ufcstats.com/statistics/fighters?char={a-z}&page=all
// HTML table columns (in order):
//   First, Last, Nickname, Ht., Wt., Reach, Stance, W, L, D, Belt,
//   SLpM, Str.Acc., SApM, Str.Def., TD Avg, TD Acc., TD Def., Sub. Avg
//
// Caches for 24 hours — fighter career stats don't change within a day.

import * as cheerio from "cheerio";

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

let cachedStats: Map<string, FighterStats> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Parse a height string like "5' 11\"" into total inches.
 * Returns null if the format doesn't match.
 */
function parseHeight(s: string): number | null {
  const m = s.trim().match(/^(\d+)'\s*(\d+)"/);
  if (!m) return null;
  return parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
}

/**
 * Parse a percentage string like "53%" into a decimal 0.53.
 * Returns 0 if empty/missing.
 */
function parsePct(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (!m) return 0;
  return parseFloat(m[1]) / 100;
}

/**
 * Parse a numeric field, returning 0 for empty/invalid.
 */
function parseNum(s: string): number {
  const val = parseFloat(s.trim());
  return isNaN(val) ? 0 : val;
}

/**
 * Parse a reach field like '72.0"' or '72"' into inches.
 * Returns null if empty/missing.
 */
function parseReach(s: string): number | null {
  const m = s.trim().match(/^([\d.]+)/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return isNaN(val) ? null : Math.round(val);
}

/**
 * Parse a weight field like "155 lbs." or "155" into a number.
 * Returns null if unparseable.
 */
function parseWeight(s: string): number | null {
  const m = s.trim().match(/^(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/**
 * Fetch and parse a single UFCStats letter page.
 * Returns an array of FighterStats parsed from the HTML table.
 */
async function fetchLetterPage(letter: string): Promise<FighterStats[]> {
  const url = `http://ufcstats.com/statistics/fighters?char=${letter}&page=all`;
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const res = await fetch(url, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`UFCStats fetch failed for letter '${letter}': ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const fighters: FighterStats[] = [];

  // Each fighter is a <tr class="b-statistics__table-row"> inside the table
  $("tr.b-statistics__table-row").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 19) return;

    const getText = (idx: number) => $(cells[idx]).text().trim();

    const firstName = getText(0);
    const lastName = getText(1);

    // Skip header rows or empty rows
    if (!firstName && !lastName) return;

    const name = `${firstName} ${lastName}`.trim();
    if (!name || name === " ") return;

    const stats: FighterStats = {
      name,
      nickname: getText(2),
      height: parseHeight(getText(3)),
      weight: parseWeight(getText(4)),
      reach: parseReach(getText(5)),   // reach is in inches format (e.g., "72.0"")
      stance: getText(6),
      wins: parseNum(getText(7)),
      losses: parseNum(getText(8)),
      draws: parseNum(getText(9)),
      // Index 10 = Belt (skip)
      slpm: parseNum(getText(11)),
      strAcc: parsePct(getText(12)),
      sapm: parseNum(getText(13)),
      strDef: parsePct(getText(14)),
      tdAvg: parseNum(getText(15)),
      tdAcc: parsePct(getText(16)),
      tdDef: parsePct(getText(17)),
      subAvg: parseNum(getText(18)),
    };

    fighters.push(stats);
  });

  return fighters;
}

/**
 * Fetch all UFC fighter stats by hitting all 26 letter pages in parallel.
 * Caches for 24 hours. Returns a Map keyed by lowercase "first last" name.
 */
export async function fetchUfcStats(): Promise<Map<string, FighterStats>> {
  const now = Date.now();
  if (cachedStats && now - cacheTimestamp < CACHE_TTL) {
    return cachedStats;
  }

  const letters = "abcdefghijklmnopqrstuvwxyz".split("");

  // Fetch all pages in parallel, tolerating individual page failures
  const results = await Promise.allSettled(
    letters.map(letter => fetchLetterPage(letter))
  );

  const map = new Map<string, FighterStats>();

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const fighter of result.value) {
      // Store with lowercase name as key for case-insensitive lookup
      const key = fighter.name.toLowerCase().trim();
      if (key) {
        map.set(key, fighter);
      }
    }
  }

  cachedStats = map;
  cacheTimestamp = now;
  return map;
}

/** Clear the cache (useful for testing) */
export function clearUfcStatsCache(): void {
  cachedStats = null;
  cacheTimestamp = 0;
}

// ─── Fighter Name Matching ───
// The Odds API sends fighter names as "First Last" (e.g., "Madars Fleminas").
// UFCStats listing pages store names the same way, but casing may differ.
// Strategy:
//   1. Normalize to lowercase, try direct map lookup
//   2. Try first/last name swap (some APIs flip name order)
//   3. Fuzzy Dice coefficient similarity, threshold 0.8 (names should be very close)

/**
 * Compute Dice coefficient similarity between two strings (on character bigrams).
 */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  return (2 * intersection) / (bigramsA.size + bigramsB.size) || 0;
}

/**
 * Look up a fighter by their Odds API name ("First Last" format).
 * Tries direct match, name swap, then fuzzy fallback (Dice ≥ 0.8).
 */
export function findFighterStats(
  oddsName: string,
  statsMap: Map<string, FighterStats>,
): FighterStats | null {
  const normalized = oddsName.toLowerCase().trim();

  // 1. Direct lookup
  const direct = statsMap.get(normalized);
  if (direct) return direct;

  // 2. First/last name swap
  const parts = normalized.split(/\s+/);
  if (parts.length >= 2) {
    const swapped = [...parts.slice(1), parts[0]].join(" ");
    const swappedResult = statsMap.get(swapped);
    if (swappedResult) return swappedResult;
  }

  // 3. Fuzzy match with Dice coefficient — threshold 0.8 (names must be very close)
  let bestMatch = "";
  let bestScore = 0;
  for (const key of statsMap.keys()) {
    const score = diceSimilarity(normalized, key);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = key;
    }
  }

  if (bestScore >= 0.8) return statsMap.get(bestMatch)!;

  return null;
}
