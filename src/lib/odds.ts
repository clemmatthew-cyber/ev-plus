// ─── The Odds API — Direct + Backend Proxy Fallback ───

import { americanToImplied, americanToDecimal, shinDevig } from "./model/devig";

// Re-export for use by other modules
export { americanToImplied, americanToDecimal };

export interface GameOdds {
  id: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  bookmakers: {
    key: string;
    title: string;
    markets: {
      key: string;
      outcomes: { name: string; price: number; point?: number }[];
    }[];
  }[];
}

/** Power devig — re-exported from model for backwards compat */
export const devigPower = shinDevig;

const SPORT_KEYS: Record<string, string> = {
  nhl: "icehockey_nhl",
  nba: "basketball_nba",
  mma: "mma_mixed_martial_arts",
};

const ODDS_API_KEY = "a03c63d84fa0e5dd7141a9b0b389b6bf";

// Backend proxy base: replaced by deploy_website with proxy path to port 5000
const PROXY_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const BOOKS = "draftkings,fanduel,betmgm,caesars,pointsbetus,fanatics";

function parseGameOdds(raw: any[]): GameOdds[] {
  return raw.map((g) => ({
    id: g.id,
    commenceTime: g.commence_time,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    bookmakers: (g.bookmakers || []).map((b: any) => ({
      key: b.key,
      title: b.title,
      markets: (b.markets || []).map((m: any) => ({
        key: m.key,
        outcomes: (m.outcomes || []).map((o: any) => ({
          name: o.name,
          price: o.price,
          point: o.point,
        })),
      })),
    })),
  }));
}

/** Sleep helper */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Try a single fetch attempt across all sources */
async function tryFetchOdds(sport: string, sportKey: string): Promise<GameOdds[] | null> {
  // 1. Backend proxy first (works in deployed iframe where cross-origin is blocked)
  if (PROXY_BASE) {
    try {
      const res = await fetch(`${PROXY_BASE}/api/odds?sport=${sport}`);
      if (res.ok) return parseGameOdds(await res.json());
    } catch { /* proxy unreachable */ }
  }

  // 2. Same-origin backend (Railway / local dev)
  try {
    const res = await fetch(`/api/odds?sport=${sport}`);
    if (res.ok) return parseGameOdds(await res.json());
  } catch { /* ignore */ }

  // 3. Direct Odds API (works in normal browsers with CORS)
  try {
    const url =
      `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/` +
      `?apiKey=${ODDS_API_KEY}` +
      `&regions=us` +
      `&markets=h2h,spreads,totals` +
      `&oddsFormat=american` +
      `&bookmakers=${BOOKS}`;
    const res = await fetch(url);
    if (res.ok) return parseGameOdds(await res.json());
  } catch { /* CORS blocked or network error */ }

  return null;
}

export async function fetchNhlOdds(sport = "nhl"): Promise<GameOdds[]> {
  const sportKey = SPORT_KEYS[sport] || SPORT_KEYS.nhl;

  // Retry up to 4 times with backoff — handles Railway cold starts (~10-15s)
  const delays = [0, 3000, 5000, 7000];
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const result = await tryFetchOdds(sport, sportKey);
    if (result) return result;
  }

  throw new Error("Could not reach odds service");
}

export interface BestLine {
  book: string;
  price: number;
  point?: number;
  impliedProb: number;
  fairProb: number;
  decimalOdds: number;
}

export function findBestLine(
  game: GameOdds, marketKey: string, outcomeName: string, outcomePoint?: number
): BestLine | null {
  let bestPrice = -Infinity;
  let bestBook = "";
  let bestAllOutcomes: { name: string; price: number; point?: number }[] = [];

  for (const bk of game.bookmakers) {
    const market = bk.markets.find(m => m.key === marketKey);
    if (!market) continue;
    const outcome = marketKey === "h2h"
      ? market.outcomes.find(o => o.name === outcomeName)
      : market.outcomes.find(o => o.name === outcomeName && o.point === outcomePoint);
    if (outcome && outcome.price > bestPrice) {
      bestPrice = outcome.price;
      bestBook = bk.key;
      bestAllOutcomes = market.outcomes;
    }
  }
  if (bestPrice === -Infinity) return null;

  // De-vig using Shin/power method from model
  const rawProbs = bestAllOutcomes.map(o => americanToImplied(o.price));
  const fairProbs = shinDevig(rawProbs);
  const idx = marketKey === "h2h"
    ? bestAllOutcomes.findIndex(o => o.name === outcomeName)
    : bestAllOutcomes.findIndex(o => o.name === outcomeName && o.point === outcomePoint);
  if (idx === -1) return null;

  return {
    book: bestBook,
    price: bestPrice,
    point: bestAllOutcomes[idx].point,
    impliedProb: americanToImplied(bestPrice),
    fairProb: fairProbs[idx],
    decimalOdds: americanToDecimal(bestPrice),
  };
}

const BOOK_NAMES: Record<string, string> = {
  draftkings: "DK", fanduel: "FD", betmgm: "MGM", caesars: "CZR", pointsbetus: "PB", fanatics: "FAN",
};
export const bookName = (k: string) => BOOK_NAMES[k] || k.toUpperCase().slice(0, 3);

const ABBREVS: Record<string, string> = {
  // ─── NHL ───
  "Anaheim Ducks":"ANA","Boston Bruins":"BOS","Buffalo Sabres":"BUF",
  "Calgary Flames":"CGY","Carolina Hurricanes":"CAR","Chicago Blackhawks":"CHI",
  "Colorado Avalanche":"COL","Columbus Blue Jackets":"CBJ","Dallas Stars":"DAL",
  "Detroit Red Wings":"DET","Edmonton Oilers":"EDM","Florida Panthers":"FLA",
  "Los Angeles Kings":"LAK","Minnesota Wild":"MIN","Montréal Canadiens":"MTL",
  "Nashville Predators":"NSH","New Jersey Devils":"NJD","New York Islanders":"NYI",
  "New York Rangers":"NYR","Ottawa Senators":"OTT","Philadelphia Flyers":"PHI",
  "Pittsburgh Penguins":"PIT","San Jose Sharks":"SJS","Seattle Kraken":"SEA",
  "St Louis Blues":"STL","Tampa Bay Lightning":"TBL","Toronto Maple Leafs":"TOR",
  "Utah Mammoth":"UTA","Vancouver Canucks":"VAN","Vegas Golden Knights":"VGK",
  "Washington Capitals":"WSH","Winnipeg Jets":"WPG",
  // ─── NBA ───
  "Atlanta Hawks":"ATL","Boston Celtics":"BOS","Brooklyn Nets":"BKN",
  "Charlotte Hornets":"CHA","Chicago Bulls":"CHI","Cleveland Cavaliers":"CLE",
  "Dallas Mavericks":"DAL","Denver Nuggets":"DEN","Detroit Pistons":"DET",
  "Golden State Warriors":"GSW","Houston Rockets":"HOU","Indiana Pacers":"IND",
  "Los Angeles Clippers":"LAC","Los Angeles Lakers":"LAL","Memphis Grizzlies":"MEM",
  "Miami Heat":"MIA","Milwaukee Bucks":"MIL","Minnesota Timberwolves":"MIN",
  "New Orleans Pelicans":"NOP","New York Knicks":"NYK","Oklahoma City Thunder":"OKC",
  "Orlando Magic":"ORL","Philadelphia 76ers":"PHI","Phoenix Suns":"PHX",
  "Portland Trail Blazers":"POR","Sacramento Kings":"SAC","San Antonio Spurs":"SAS",
  "Toronto Raptors":"TOR","Utah Jazz":"UTA","Washington Wizards":"WAS",
};
export const teamAbbrev = (name: string) => ABBREVS[name] || name.split(" ").pop()?.toUpperCase().slice(0, 3) || "???";
