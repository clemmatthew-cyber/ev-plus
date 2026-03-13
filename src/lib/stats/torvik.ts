// ─── Bart Torvik Data Integration ───
// Fetches team efficiency data (AdjOE, AdjDE, tempo, SOS) from barttorvik.com.
// The trank.php endpoint has a JS browser verification wall. To bypass it:
//   1. GET the page (which sets a session cookie)
//   2. POST with js_test_submitted=1 + the session cookie → returns JSON
//
// Field mapping (per team array — 37 fields total):
//   [0]  = Team name (e.g. "Duke", "Kentucky", "North Carolina")
//   [1]  = AdjOE  (Adjusted Offensive Efficiency — pts per 100 possessions)
//   [2]  = AdjDE  (Adjusted Defensive Efficiency — pts allowed per 100 possessions)
//   [3]  = Barthag (power rating / win probability proxy)
//   [5]  = Wins
//   [6]  = Games played
//   [15] = Tempo  (possessions per game, adjusted)
//   [34] = SOS    (Strength of Schedule)

export interface TorvikStats {
  team: string;
  adjOE: number;
  adjDE: number;
  barthag: number;
  tempo: number;
  sos: number;
  gamesPlayed: number;
  wins: number;
}

/** League average efficiency — computed once from Torvik data and cached */
export let leagueAvgEfficiency = 109.0; // sensible fallback

let cachedStats: Map<string, TorvikStats> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch team-level efficiency data from Bart Torvik.
 * The trank.php endpoint has a JS verification wall:
 *   1. POST with js_test_submitted=1 -> returns 302 + Set-Cookie: js_verified=true
 *   2. Follow redirect with the cookie -> returns JSON
 * Node.js fetch doesn't auto-forward cookies on redirects, so we handle manually.
 * Caches for 1 hour per pipeline run.
 */
export async function fetchTorvikStats(): Promise<Map<string, TorvikStats>> {
  const now = Date.now();
  if (cachedStats && now - cacheTimestamp < CACHE_TTL) {
    return cachedStats;
  }

  const year = new Date().getFullYear();
  const url = `https://barttorvik.com/trank.php?year=${year}&json=1`;
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

  // Step 1: POST with js_test_submitted=1 (don't follow redirect)
  const step1 = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "js_test_submitted=1",
    redirect: "manual",
  });

  // Extract the js_verified cookie from the 302 response
  let cookie = "";
  const setCookieHeader = step1.headers.get("set-cookie");
  if (setCookieHeader) {
    cookie = setCookieHeader.split(";")[0].trim();
  }
  if (!cookie && typeof step1.headers.getSetCookie === "function") {
    const setCookies = step1.headers.getSetCookie();
    if (setCookies.length > 0) {
      cookie = setCookies[0].split(";")[0].trim();
    }
  }
  await step1.text().catch(() => {});

  // Step 2: Follow redirect with the js_verified cookie
  const redirectUrl = step1.headers.get("location") || url;
  const finalUrl = redirectUrl.startsWith("http") ? redirectUrl : `https://barttorvik.com${redirectUrl}`;

  const step2 = await fetch(finalUrl, {
    method: "GET",
    headers: {
      "User-Agent": ua,
      ...(cookie ? { "Cookie": cookie } : {}),
    },
  });

  if (!step2.ok) {
    throw new Error(`Torvik fetch failed: ${step2.status}`);
  }

  const text = await step2.text();
  if (text.trim().startsWith("<") || !text.trim().startsWith("[")) {
    throw new Error("Torvik returned HTML instead of JSON");
  }

  const raw: any[][] = JSON.parse(text);
  const map = new Map<string, TorvikStats>();

  // Compute league average efficiency
  let totalOE = 0;
  let countOE = 0;

  for (const row of raw) {
    if (!row[0] || typeof row[1] !== "number") continue;
    const stats: TorvikStats = {
      team: row[0],
      adjOE: row[1],
      adjDE: row[2],
      barthag: row[3],
      tempo: row[15],
      sos: row[34],
      gamesPlayed: row[6] ?? 0,
      wins: row[5] ?? 0,
    };
    map.set(stats.team, stats);
    totalOE += row[1];
    countOE++;
  }

  // Update league average (used in model calculations)
  if (countOE > 0) {
    leagueAvgEfficiency = totalOE / countOE;
  }

  cachedStats = map;
  cacheTimestamp = now;
  return map;
}

/** Clear the cache (useful for testing) */
export function clearTorvikCache(): void {
  cachedStats = null;
  cacheTimestamp = 0;
}

// ─── Team Name Matching ───
// The Odds API uses full names like "Kentucky Wildcats", "Florida Gators".
// Torvik uses school names: "Kentucky", "Florida", "North Carolina".
// Strategy: strip mascot suffix, then try direct match, then fuzzy fallback.

/** Common mascot suffixes that the Odds API appends */
const MASCOTS = new Set([
  "wildcats", "gators", "bulldogs", "tigers", "bears", "hawks", "eagles",
  "cardinals", "cougars", "huskies", "wolverines", "spartans", "hoosiers",
  "badgers", "cornhuskers", "sooners", "longhorns", "aggies", "seminoles",
  "cavaliers", "volunteers", "crimson tide", "blue devils", "tar heels",
  "jayhawks", "mountaineers", "buckeyes", "nittany lions", "fighting irish",
  "golden gophers", "hawkeyes", "razorbacks", "gamecocks", "rebels",
  "commodores", "boilermakers", "illini", "terrapins", "terps",
  "hurricanes", "panthers", "demon deacons", "yellow jackets",
  "wolfpack", "orange", "red raiders", "horned frogs", "cyclones",
  "cowboys", "bobcats", "broncos", "knights", "owls", "rams",
  "mustangs", "bearcats", "shockers", "pirates", "colonials",
  "explorers", "peacocks", "gaels", "dons", "toreros",
  "zags", "pilots", "waves", "lions", "leopards",
  "raiders", "patriots", "phoenix", "paladins",
  "catamounts", "bison", "thundering herd", "mean green",
  "miners", "roadrunners", "islanders", "jaguars",
  "blazers", "trojans", "bruins", "sun devils", "beavers", "ducks",
  "buffaloes", "utes", "aztecs", "falcons", "lobos", "anteaters",
  "gauchos", "highlanders", "matadors", "titans", "49ers",
  "aggies", "lumberjacks", "tritons", "hornets", "lancers",
  "49ers", "rainbow warriors", "warriors", "toreros",
  "red storm", "musketeers", "friars", "hoyas", "bluejays",
  "orange", "scarlet knights", "golden flash", "chips",
  "rockets", "redhawks", "zips", "thunderbirds",
  "penguins", "golden flashes", "broncs", "purple eagles",
  "stags", "jaspers", "griffs", "red foxes",
  "seawolves", "great danes",
]);

/**
 * Static overrides for cases where automated matching fails.
 * Key = Odds API name (lowercase), Value = Torvik name.
 */
const NAME_OVERRIDES: Record<string, string> = {
  "uconn huskies": "Connecticut",
  "connecticut huskies": "Connecticut",
  "pitt panthers": "Pittsburgh",
  "pittsburgh panthers": "Pittsburgh",
  "ole miss rebels": "Mississippi",
  "mississippi rebels": "Mississippi",
  "lsu tigers": "LSU",
  "louisiana state tigers": "LSU",
  "smu mustangs": "SMU",
  "southern methodist mustangs": "SMU",
  "tcu horned frogs": "TCU",
  "texas christian horned frogs": "TCU",
  "byu cougars": "BYU",
  "brigham young cougars": "BYU",
  "ucf knights": "UCF",
  "central florida knights": "UCF",
  "ucla bruins": "UCLA",
  "usc trojans": "USC",
  "unlv rebels": "UNLV",
  "utep miners": "UTEP",
  "vcu rams": "VCU",
  "vmi keydets": "VMI",
  "umbc retrievers": "UMBC",
  "unc greensboro spartans": "UNC Greensboro",
  "unc wilmington seahawks": "UNC Wilmington",
  "unc asheville bulldogs": "UNC Asheville",
  "uc irvine anteaters": "UC Irvine",
  "uc davis aggies": "UC Davis",
  "uc riverside highlanders": "UC Riverside",
  "uc san diego tritons": "UC San Diego",
  "uc santa barbara gauchos": "UC Santa Barbara",
  "st. john's red storm": "St. John's",
  "saint john's red storm": "St. John's",
  "saint mary's gaels": "Saint Mary's",
  "saint louis billikens": "Saint Louis",
  "saint joseph's hawks": "Saint Joseph's",
  "saint peter's peacocks": "Saint Peter's",
  "st. bonaventure bonnies": "St. Bonaventure",
  "saint bonaventure bonnies": "St. Bonaventure",
  "north carolina tar heels": "North Carolina",
  "nc state wolfpack": "N.C. State",
  "north carolina state wolfpack": "N.C. State",
  "miami hurricanes": "Miami FL",
  "miami (fl) hurricanes": "Miami FL",
  "miami (oh) redhawks": "Miami OH",
  "texas a&m aggies": "Texas A&M",
  "penn state nittany lions": "Penn St.",
  "ohio state buckeyes": "Ohio St.",
  "michigan state spartans": "Michigan St.",
  "florida state seminoles": "Florida St.",
  "iowa state cyclones": "Iowa St.",
  "kansas state wildcats": "Kansas St.",
  "oklahoma state cowboys": "Oklahoma St.",
  "oregon state beavers": "Oregon St.",
  "washington state cougars": "Washington St.",
  "colorado state rams": "Colorado St.",
  "boise state broncos": "Boise St.",
  "fresno state bulldogs": "Fresno St.",
  "san diego state aztecs": "San Diego St.",
  "san jose state spartans": "San Jose St.",
  "utah state aggies": "Utah St.",
  "wichita state shockers": "Wichita St.",
  "ball state cardinals": "Ball St.",
  "kent state golden flashes": "Kent St.",
  "mississippi state bulldogs": "Mississippi St.",
  "arkansas state red wolves": "Arkansas St.",
  "georgia state panthers": "Georgia St.",
  "appalachian state mountaineers": "Appalachian St.",
  "arizona state sun devils": "Arizona St.",
  "illinois state redbirds": "Illinois St.",
  "indiana state sycamores": "Indiana St.",
  "missouri state bears": "Missouri St.",
  "murray state racers": "Murray St.",
  "weber state wildcats": "Weber St.",
  "montana state bobcats": "Montana St.",
  "north dakota state bison": "North Dakota St.",
  "south dakota state jackrabbits": "South Dakota St.",
  "portland state vikings": "Portland St.",
  "sacramento state hornets": "Sacramento St.",
  "sam houston state bearkats": "Sam Houston St.",
  "mcneese state cowboys": "McNeese St.",
  "nicholls state colonels": "Nicholls St.",
  "southeastern louisiana lions": "Southeastern Louisiana",
  "texas state bobcats": "Texas St.",
  "texas tech red raiders": "Texas Tech",
  "south carolina gamecocks": "South Carolina",
  "south carolina state bulldogs": "South Carolina St.",
  "north carolina a&t aggies": "North Carolina A&T",
  "north carolina central eagles": "North Carolina Central",
  "alabama a&m bulldogs": "Alabama A&M",
  "alabama state hornets": "Alabama St.",
  "alcorn state braves": "Alcorn St.",
  "jackson state tigers": "Jackson St.",
  "grambling state tigers": "Grambling St.",
  "mississippi valley state delta devils": "Mississippi Valley St.",
  "prairie view a&m panthers": "Prairie View A&M",
  "texas southern tigers": "Texas Southern",
  "coppin state eagles": "Coppin St.",
  "delaware state hornets": "Delaware St.",
  "maryland eastern shore hawks": "Maryland Eastern Shore",
  "morgan state bears": "Morgan St.",
  "norfolk state spartans": "Norfolk St.",
  "south florida bulls": "South Florida",
  "florida atlantic owls": "Florida Atlantic",
  "florida gulf coast eagles": "Florida Gulf Coast",
  "east tennessee state buccaneers": "East Tennessee St.",
  "southeast missouri state redhawks": "Southeast Missouri St.",
  "tennessee state tigers": "Tennessee St.",
  "tennessee tech golden eagles": "Tennessee Tech",
  "austin peay governors": "Austin Peay",
  "long island sharks": "LIU",
  "liu sharks": "LIU",
  "fiu panthers": "FIU",
  "siu edwardsville cougars": "SIU Edwardsville",
  "loyola chicago ramblers": "Loyola Chicago",
  "loyola marymount lions": "Loyola Marymount",
  "loyola maryland greyhounds": "Loyola MD",
  "mount st. mary's mountaineers": "Mount St. Mary's",
  "depaul blue demons": "DePaul",
  "charleston cougars": "Charleston",
  "college of charleston cougars": "Charleston",
  "william & mary tribe": "William & Mary",
  "green bay phoenix": "Green Bay",
  "little rock trojans": "Little Rock",
  "middle tennessee blue raiders": "Middle Tennessee",
  "umass lowell river hawks": "UMass Lowell",
  "massachusetts minutemen": "Massachusetts",
  "louisiana ragin' cajuns": "Louisiana",
  "louisiana tech bulldogs": "Louisiana Tech",
  "louisiana monroe warhawks": "Louisiana Monroe",
  "cal baptist lancers": "Cal Baptist",
  "cal poly mustangs": "Cal Poly",
  "cal state bakersfield roadrunners": "Cal St. Bakersfield",
  "cal state fullerton titans": "Cal St. Fullerton",
  "cal state northridge matadors": "Cal St. Northridge",
  "central connecticut blue devils": "Central Connecticut",
  "gardner-webb runnin' bulldogs": "Gardner Webb",
  "gardner webb runnin' bulldogs": "Gardner Webb",
  "grand canyon antelopes": "Grand Canyon",
  "tarleton state texans": "Tarleton St.",
  "texas a&m corpus christi islanders": "Texas A&M Corpus Chris",
  "texas a&m-corpus christi islanders": "Texas A&M Corpus Chris",
  "ut arlington mavericks": "UT Arlington",
  "ut rio grande valley vaqueros": "UT Rio Grande Valley",
  "detroit mercy titans": "Detroit Mercy",
  "iu indianapolis jaguars": "IU Indy",
  "purdue fort wayne mastodons": "Purdue Fort Wayne",
  "nebraska omaha mavericks": "Nebraska Omaha",
  "northern kentucky norse": "Northern Kentucky",
  "illinois chicago flames": "Illinois Chicago",
  "arkansas pine bluff golden lions": "Arkansas Pine Bluff",
  "houston christian huskies": "Houston Christian",
  "east texas a&m lions": "East Texas A&M",
  "bethune-cookman wildcats": "Bethune Cookman",
  "bethune cookman wildcats": "Bethune Cookman",
  "new mexico state aggies": "New Mexico St.",
  "kennesaw state owls": "Kennesaw St.",
  "jacksonville state gamecocks": "Jacksonville St.",
  "cleveland state vikings": "Cleveland St.",
  "youngstown state penguins": "Youngstown St.",
  "wright state raiders": "Wright St.",
  "charleston southern buccaneers": "Charleston Southern",
  "southern illinois salukis": "Southern Illinois",
  "southern indiana screaming eagles": "Southern Indiana",
  "western kentucky hilltoppers": "Western Kentucky",
  "western michigan broncos": "Western Michigan",
  "western illinois leathernecks": "Western Illinois",
  "western carolina catamounts": "Western Carolina",
  "eastern kentucky colonels": "Eastern Kentucky",
  "eastern michigan eagles": "Eastern Michigan",
  "eastern illinois panthers": "Eastern Illinois",
  "eastern washington eagles": "Eastern Washington",
  "central michigan chippewas": "Central Michigan",
  "central arkansas bears": "Central Arkansas",
  "northern illinois huskies": "Northern Illinois",
  "northern iowa panthers": "Northern Iowa",
  "northern arizona lumberjacks": "Northern Arizona",
  "northern colorado bears": "Northern Colorado",
  "north florida ospreys": "North Florida",
  "north texas mean green": "North Texas",
  "north alabama lions": "North Alabama",
  "south alabama jaguars": "South Alabama",
  "georgia southern eagles": "Georgia Southern",
  "georgia tech yellow jackets": "Georgia Tech",
  "wake forest demon deacons": "Wake Forest",
  "virginia tech hokies": "Virginia Tech",
  "west virginia mountaineers": "West Virginia",
  "bowling green falcons": "Bowling Green",
  "stephen f. austin lumberjacks": "Stephen F. Austin",
  "stephen f austin lumberjacks": "Stephen F. Austin",
  "coastal carolina chanticleers": "Coastal Carolina",
  "northwestern state demons": "Northwestern St.",
  "idaho state bengals": "Idaho St.",
  "utah valley wolverines": "Utah Valley",
  "utah tech trailblazers": "Utah Tech",
  "west georgia wolves": "West Georgia",
  "southern utah thunderbirds": "Southern Utah",
  "southern miss golden eagles": "Southern Miss",
  "stony brook seawolves": "Stony Brook",
  "robert morris colonials": "Robert Morris",
  "fairleigh dickinson knights": "Fairleigh Dickinson",
  "sacred heart pioneers": "Sacred Heart",
  "saint francis red flash": "Saint Francis",
  "new orleans privateers": "New Orleans",
  "incarnate word cardinals": "Incarnate Word",
  "hampton pirates": "Hampton",
  "high point panthers": "High Point",
  "longwood lancers": "Longwood",
  "tennessee martin skyhawks": "Tennessee Martin",
  "morehead state eagles": "Morehead St.",
  "oral roberts golden eagles": "Oral Roberts",
  "south dakota coyotes": "South Dakota",
  "north dakota fighting hawks": "North Dakota",
};

/**
 * Extract the school name from an Odds API team name by stripping the mascot.
 * e.g. "Kentucky Wildcats" → "Kentucky", "Florida Gators" → "Florida"
 */
function extractSchoolName(oddsName: string): string {
  const lower = oddsName.toLowerCase().trim();

  // Check direct overrides first
  const override = NAME_OVERRIDES[lower];
  if (override) return override;

  // Try stripping known mascot suffixes (longest first for multi-word mascots)
  const sortedMascots = [...MASCOTS].sort((a, b) => b.length - a.length);
  for (const mascot of sortedMascots) {
    if (lower.endsWith(` ${mascot}`)) {
      const school = oddsName.slice(0, -(mascot.length + 1)).trim();
      return school;
    }
  }

  // Fallback: return as-is
  return oddsName;
}

/**
 * Simple string similarity (Dice coefficient on bigrams).
 */
function similarity(a: string, b: string): number {
  const lower_a = a.toLowerCase();
  const lower_b = b.toLowerCase();
  if (lower_a === lower_b) return 1;

  const bigramsA = new Set<string>();
  for (let i = 0; i < lower_a.length - 1; i++) bigramsA.add(lower_a.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < lower_b.length - 1; i++) bigramsB.add(lower_b.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) if (bigramsB.has(bg)) intersection++;
  return (2 * intersection) / (bigramsA.size + bigramsB.size) || 0;
}

/**
 * Look up Torvik stats for an Odds API team name.
 * Tries: 1) direct override, 2) school name extraction + exact match,
 *        3) fuzzy match with minimum 0.6 similarity threshold.
 */
export function findTeamStats(
  oddsName: string,
  statsMap: Map<string, TorvikStats>,
): TorvikStats | null {
  // 1. Direct match (rare but possible)
  if (statsMap.has(oddsName)) return statsMap.get(oddsName)!;

  // 2. Extract school name and try exact match
  const school = extractSchoolName(oddsName);
  if (statsMap.has(school)) return statsMap.get(school)!;

  // 3. Fuzzy match against all Torvik team names
  let bestMatch = "";
  let bestScore = 0;
  for (const torvikName of statsMap.keys()) {
    const score = similarity(school, torvikName);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = torvikName;
    }
  }

  if (bestScore >= 0.6) return statsMap.get(bestMatch)!;

  return null;
}
