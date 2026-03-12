// ─── NHL EV+ Backend Proxy ───
// Keeps API key server-side, proxies MoneyPuck (CORS), caches both for 3 min.

import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 5000;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) {
  console.error("FATAL: ODDS_API_KEY not set in environment. Create a .env file.");
  process.exit(1);
}

// ─── Cache ───

const CACHE_TTL = 3 * 60_000; // 3 minutes

const cache = {
  odds: { data: null, ts: 0 },
  stats: { data: null, ts: 0 },
  goalies: { data: null, ts: 0 },
};

function isFresh(entry) {
  return entry.data !== null && Date.now() - entry.ts < CACHE_TTL;
}

// ─── Sport key map (Odds API sport slugs) ───

const SPORT_KEYS = {
  nhl: "icehockey_nhl",
  nba: "basketball_nba",
  mma: "mma_mixed_martial_arts",
};

// ─── /api/odds ───
// Proxies The Odds API — supports ?sport=nhl|nba|mma (default nhl)
// Per-sport cache so switching sports doesn't nuke the other cache.

const oddsCache = new Map(); // sportKey → { data, ts }

app.get("/api/odds", async (req, res) => {
  const sportParam = (req.query.sport || "nhl").toString().toLowerCase();
  const sportKey = SPORT_KEYS[sportParam] || SPORT_KEYS.nhl;

  try {
    const cached = oddsCache.get(sportKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached.data);
    }

    const url =
      `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/` +
      `?apiKey=${ODDS_API_KEY}` +
      `&regions=us` +
      `&markets=h2h,spreads,totals` +
      `&oddsFormat=american` +
      `&bookmakers=draftkings,fanduel,betmgm,caesars,pointsbetus`;

    const upstream = await fetch(url);
    if (!upstream.ok) {
      const body = await upstream.text();
      console.error(`[odds] upstream ${upstream.status}: ${body.slice(0, 200)}`);
      return res.status(upstream.status).json({ error: `Odds API ${upstream.status}` });
    }

    const remaining = upstream.headers.get("x-requests-remaining");
    const used = upstream.headers.get("x-requests-used");
    if (remaining) console.log(`[odds] ${sportParam} requests remaining: ${remaining}, used: ${used}`);

    const data = await upstream.json();

    oddsCache.set(sportKey, { data, ts: Date.now() });

    res.setHeader("X-Cache", "MISS");
    res.json(data);
  } catch (err) {
    console.error("[odds] error:", err.message);
    const cached = oddsCache.get(sportKey);
    if (cached) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cached.data);
    }
    res.status(502).json({ error: "Odds API unreachable" });
  }
});

// ─── /api/stats ───
// Proxies MoneyPuck team CSV to avoid CORS

app.get("/api/stats", async (_req, res) => {
  try {
    if (isFresh(cache.stats)) {
      res.setHeader("X-Cache", "HIT");
      return res.type("text/csv").send(cache.stats.data);
    }

    const url =
      "https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/teams.csv";

    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.error(`[stats] upstream ${upstream.status}`);
      return res.status(upstream.status).json({ error: `MoneyPuck ${upstream.status}` });
    }

    const csv = await upstream.text();

    cache.stats.data = csv;
    cache.stats.ts = Date.now();

    res.setHeader("X-Cache", "MISS");
    res.type("text/csv").send(csv);
  } catch (err) {
    console.error("[stats] error:", err.message);
    if (cache.stats.data) {
      res.setHeader("X-Cache", "STALE");
      return res.type("text/csv").send(cache.stats.data);
    }
    res.status(502).json({ error: "MoneyPuck unreachable" });
  }
});

// ─── /api/goalies ───
// Proxies MoneyPuck goalie CSV to avoid CORS

app.get("/api/goalies", async (_req, res) => {
  try {
    if (isFresh(cache.goalies)) {
      res.setHeader("X-Cache", "HIT");
      return res.type("text/csv").send(cache.goalies.data);
    }

    const url =
      "https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/goalies.csv";

    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.error(`[goalies] upstream ${upstream.status}`);
      return res.status(upstream.status).json({ error: `MoneyPuck ${upstream.status}` });
    }

    const csv = await upstream.text();

    cache.goalies.data = csv;
    cache.goalies.ts = Date.now();

    res.setHeader("X-Cache", "MISS");
    res.type("text/csv").send(csv);
  } catch (err) {
    console.error("[goalies] error:", err.message);
    if (cache.goalies.data) {
      res.setHeader("X-Cache", "STALE");
      return res.type("text/csv").send(cache.goalies.data);
    }
    res.status(502).json({ error: "MoneyPuck unreachable" });
  }
});

// ─── /api/scores/:date ───
// Proxies NHL API daily scores (avoids CORS from browser)

const scoresCache = new Map(); // date → { data, ts }

app.get("/api/scores/:date", async (req, res) => {
  const { date } = req.params;
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format, use YYYY-MM-DD" });
  }

  try {
    const cached = scoresCache.get(date);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached.data);
    }

    const url = `https://api-web.nhle.com/v1/score/${date}`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.error(`[scores] upstream ${upstream.status}`);
      return res.status(upstream.status).json({ error: `NHL API ${upstream.status}` });
    }

    const data = await upstream.json();
    scoresCache.set(date, { data, ts: Date.now() });

    // Evict old cache entries (keep last 7 days)
    if (scoresCache.size > 14) {
      const oldest = [...scoresCache.keys()].sort()[0];
      scoresCache.delete(oldest);
    }

    res.setHeader("X-Cache", "MISS");
    res.json(data);
  } catch (err) {
    console.error("[scores] error:", err.message);
    const cached = scoresCache.get(date);
    if (cached) {
      res.setHeader("X-Cache", "STALE");
      return res.json(cached.data);
    }
    res.status(502).json({ error: "NHL API unreachable" });
  }
});

// ─── /api/bankroll ───
// Simple in-memory bankroll store (persists across requests, resets on server restart)

let bankrollState = { balance: 3000, peakBalance: 3000 };

app.use(express.json());

app.get("/api/bankroll", (_req, res) => {
  res.json(bankrollState);
});

app.post("/api/bankroll", (req, res) => {
  const { balance } = req.body;
  if (typeof balance !== "number" || balance < 0 || balance > 1_000_000) {
    return res.status(400).json({ error: "Invalid balance" });
  }
  bankrollState.balance = Math.round(balance * 100) / 100;
  if (bankrollState.balance > bankrollState.peakBalance) {
    bankrollState.peakBalance = bankrollState.balance;
  }
  console.log(`[bankroll] updated to $${bankrollState.balance}`);
  res.json(bankrollState);
});

// ─── /api/health ───

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    cache: {
      odds: oddsCache.size > 0 ? "cached" : "empty",
      stats: isFresh(cache.stats) ? "fresh" : cache.stats.data ? "stale" : "empty",
      goalies: isFresh(cache.goalies) ? "fresh" : cache.goalies.data ? "stale" : "empty",
    },
    uptime: Math.round(process.uptime()),
  });
});

// ─── Static files (React dist) ───

app.use(express.static(join(__dirname, "dist")));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

// ─── Start ───

app.listen(PORT, () => {
  console.log(`[server] NHL EV+ running on http://localhost:${PORT}`);
});
