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

export interface FightRecord {
  result: 'win' | 'loss' | 'draw' | 'nc';
  opponent: string;
  method: 'KO/TKO' | 'SUB' | 'DEC' | 'OTHER';
  round: number;
  time: string;           // "3:38"
  eventDate: string;      // ISO date or raw string from page
}

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
  // Extended fields — populated by enrichFighterDetails()
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

    // Extract fighter detail URL from the first <a> tag in the first <td> cell
    const firstLink = $(cells[0]).find('a').attr('href') || $(cells[1]).find('a').attr('href') || null;

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
      // Extended fields — populated later by enrichFighterDetails()
      detailUrl: firstLink,
      dob: null,
      age: null,
      fightHistory: [],
      koRate: 0,
      subRate: 0,
      decRate: 0,
      koLossRate: 0,
      subLossRate: 0,
      finishRate: 0,
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

// ─── Fighter Detail Page Fetcher ───
// Fetches fight history + DOB for individual fighters on demand.
// Only called for fighters in active matchups (not all ~4000).

const detailCache = new Map<string, { dob: string | null; age: number | null; fightHistory: FightRecord[] }>();
let detailCacheTimestamp = new Map<string, number>();
const DETAIL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Calculate age from a DOB string like "Jul 22, 1989".
 * Returns null if unparseable.
 */
function calcAge(dobStr: string): number | null {
  const parsed = new Date(dobStr);
  if (isNaN(parsed.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - parsed.getFullYear();
  const mDiff = now.getMonth() - parsed.getMonth();
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < parsed.getDate())) {
    age--;
  }
  return age;
}

/**
 * Parse method text from fight history to normalized method type.
 */
function parseMethod(text: string): FightRecord['method'] {
  const t = text.trim().toUpperCase();
  if (t.startsWith('KO') || t.startsWith('TKO')) return 'KO/TKO';
  if (t.startsWith('SUB')) return 'SUB';
  if (t.includes('DEC')) return 'DEC';
  return 'OTHER';
}

/**
 * Fetch and parse a fighter detail page for fight history + DOB.
 * Caches results for 24 hours.
 */
export async function fetchFighterDetail(fighterUrl: string): Promise<{
  dob: string | null;
  age: number | null;
  fightHistory: FightRecord[];
}> {
  const now = Date.now();
  const cached = detailCache.get(fighterUrl);
  const cachedAt = detailCacheTimestamp.get(fighterUrl) ?? 0;
  if (cached && now - cachedAt < DETAIL_CACHE_TTL) {
    return cached;
  }

  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const res = await fetch(fighterUrl, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`UFCStats detail fetch failed for ${fighterUrl}: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // ─── Parse DOB ───
  let dob: string | null = null;
  $('li').each((_i, el) => {
    const text = $(el).text();
    if (text.includes('DOB:')) {
      const match = text.match(/DOB:\s*(.+)/);
      if (match) {
        dob = match[1].trim();
      }
      return false; // break
    }
  });

  const age = dob ? calcAge(dob) : null;

  // ─── Parse fight history table ───
  const fightHistory: FightRecord[] = [];

  $('tr.b-fight-details__table-row').each((_i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 7) return;

    const getCellText = (idx: number) => $(cells[idx]).text().trim().replace(/\s+/g, ' ');

    const resultText = getCellText(0).toLowerCase();
    let result: FightRecord['result'];
    if (resultText === 'win' || resultText === 'w') {
      result = 'win';
    } else if (resultText === 'loss' || resultText === 'l') {
      result = 'loss';
    } else if (resultText === 'draw' || resultText === 'd') {
      result = 'draw';
    } else if (resultText === 'nc' || resultText === 'no contest') {
      result = 'nc';
    } else {
      return; // skip header rows or unknown rows
    }

    // Column layout: Result, Fighter (opponent), KD, Str, Td, Sub, Event, Method, Round, Time
    // We need: opponent (col 1), method (col 7), round (col 8), time (col 9)
    // But layout can vary — use text parsing
    const opponent = $(cells[1]).find('a').first().text().trim() || getCellText(1);
    const methodText = getCellText(7);
    const roundText = getCellText(8);
    const timeText = getCellText(9);
    // Event date — look in the Event column (col 6)
    const eventText = $(cells[6]).find('a').first().text().trim() || getCellText(6);
    // Date may be a second line in the event cell
    const eventLines = $(cells[6]).text().trim().replace(/\s+/g, ' ').split(/\s{2,}/);
    const eventDate = eventLines.length > 1 ? eventLines[eventLines.length - 1].trim() : eventText;

    const method = parseMethod(methodText);
    const round = parseInt(roundText, 10) || 0;
    const time = timeText || '';

    if (!opponent) return; // skip malformed rows

    fightHistory.push({
      result,
      opponent,
      method,
      round,
      time,
      eventDate,
    });
  });

  const detail = { dob, age, fightHistory };
  detailCache.set(fighterUrl, detail);
  detailCacheTimestamp.set(fighterUrl, now);
  return detail;
}

/**
 * Compute derived finish rates from fight history and update stats in-place.
 */
export function computeFinishRates(stats: FighterStats): void {
  const history = stats.fightHistory;
  if (history.length === 0) return;

  const totalWins = history.filter(f => f.result === 'win').length;
  const koWins = history.filter(f => f.result === 'win' && f.method === 'KO/TKO').length;
  const subWins = history.filter(f => f.result === 'win' && f.method === 'SUB').length;
  const decWins = history.filter(f => f.result === 'win' && f.method === 'DEC').length;

  const totalLosses = history.filter(f => f.result === 'loss').length;
  const koLosses = history.filter(f => f.result === 'loss' && f.method === 'KO/TKO').length;
  const subLosses = history.filter(f => f.result === 'loss' && f.method === 'SUB').length;

  stats.koRate = totalWins > 0 ? koWins / totalWins : 0;
  stats.subRate = totalWins > 0 ? subWins / totalWins : 0;
  stats.decRate = totalWins > 0 ? decWins / totalWins : 0;
  stats.koLossRate = totalLosses > 0 ? koLosses / totalLosses : 0;
  stats.subLossRate = totalLosses > 0 ? subLosses / totalLosses : 0;
  stats.finishRate = totalWins > 0 ? (koWins + subWins) / totalWins : 0;
}

/**
 * Enrich fighter stats with fight history and DOB for fighters in active matchups.
 * Fetches detail pages only for fighters in the given name set (not all ~4000).
 * Mutates the statsMap entries in-place.
 */
export async function enrichFighterDetails(
  statsMap: Map<string, FighterStats>,
  fighterNames: Set<string>,
): Promise<void> {
  const toFetch: { stats: FighterStats }[] = [];

  for (const name of fighterNames) {
    const fighter = findFighterStats(name, statsMap);
    if (fighter && fighter.detailUrl && fighter.fightHistory.length === 0) {
      toFetch.push({ stats: fighter });
    }
  }

  // Fetch in parallel — at most ~20-40 fighters per UFC card
  await Promise.allSettled(
    toFetch.map(async ({ stats }) => {
      const detail = await fetchFighterDetail(stats.detailUrl!);
      stats.dob = detail.dob;
      stats.age = detail.age;
      stats.fightHistory = detail.fightHistory;
      computeFinishRates(stats);
    })
  );
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
