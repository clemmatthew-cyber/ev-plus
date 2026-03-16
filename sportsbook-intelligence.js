// ─── Sportsbook Intelligence & Sharp-Book Detection Engine ───
// Analyzes odds data across all books to detect sharp books, first-movers,
// consensus/outliers, and provides sharp-book signals for confidence scoring.

import * as db from "./db.js";

const BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "pointsbetus", "fanatics"];

// Outlier distance thresholds (in American odds cents)
const OUTLIER_THRESHOLD_ML = 15;
const OUTLIER_THRESHOLD_OTHER = 10;

// ─── Helper: median of an array ───

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── analyzeConsensus ───
// Input: array of odds_history rows for a game at a single snapshot time
// Returns: array of consensus entries per market/outcome

export function analyzeConsensus(oddsRows) {
  const groups = new Map();
  for (const row of oddsRows) {
    const key = `${row.market}|${row.outcome_name}|${row.outcome_point ?? ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        market: row.market,
        outcome_name: row.outcome_name,
        outcome_point: row.outcome_point,
        books: [],
      });
    }
    groups.get(key).books.push({ book: row.book, price: row.price });
  }

  const results = [];
  for (const [, g] of groups) {
    if (g.books.length < 2) continue;

    const prices = g.books.map((b) => b.price);
    const consensusPrice = median(prices);
    const threshold = g.market === "h2h" ? OUTLIER_THRESHOLD_ML : OUTLIER_THRESHOLD_OTHER;

    // Find outlier: book with max |price - consensus|
    let outlierBook = null;
    let outlierDistance = 0;
    for (const b of g.books) {
      const dist = Math.abs(b.price - consensusPrice);
      if (dist > outlierDistance) {
        outlierDistance = dist;
        outlierBook = b.book;
      }
    }
    // Only flag as outlier if above threshold
    if (outlierDistance <= threshold) {
      outlierBook = null;
      outlierDistance = 0;
    }

    results.push({
      market: g.market,
      outcome_name: g.outcome_name,
      outcome_point: g.outcome_point,
      consensus_price: consensusPrice,
      num_books: g.books.length,
      outlier_book: outlierBook,
      outlier_distance: outlierDistance,
    });
  }
  return results;
}

// ─── detectFirstMovers ───
// Input: array of odds_history rows for a game across ALL snapshot times
// Returns: Map<string, { firstMoverBook, timeLags: Map<book, seconds> }>

export function detectFirstMovers(oddsRows) {
  // Group by market|outcome_name|outcome_point
  const groups = new Map();
  for (const row of oddsRows) {
    const key = `${row.market}|${row.outcome_name}|${row.outcome_point ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const results = new Map();

  for (const [key, rows] of groups) {
    // Sort by snapshot_at
    rows.sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at));

    // Get initial prices per book (from first snapshot)
    const initialPrices = new Map();
    const firstSnapshotAt = rows[0]?.snapshot_at;
    for (const r of rows) {
      if (r.snapshot_at === firstSnapshotAt) {
        initialPrices.set(r.book, r.price);
      }
    }

    if (initialPrices.size < 2) continue;
    const initialConsensus = median([...initialPrices.values()]);

    // Find first mover: first book whose price changes from initial consensus direction
    let firstMoverBook = null;
    let firstMoveTime = null;
    const timeLags = new Map();

    // Track which books have moved
    const bookMoved = new Map();

    for (const r of rows) {
      if (r.snapshot_at === firstSnapshotAt) continue;
      const initial = initialPrices.get(r.book);
      if (initial === undefined) continue;
      if (bookMoved.has(r.book)) continue;

      const moved = Math.abs(r.price - initial) > 2; // threshold: moved > 2 cents
      if (!moved) continue;

      bookMoved.set(r.book, r.snapshot_at);

      if (!firstMoverBook) {
        firstMoverBook = r.book;
        firstMoveTime = new Date(r.snapshot_at).getTime();
      } else {
        const lag = (new Date(r.snapshot_at).getTime() - firstMoveTime) / 1000;
        timeLags.set(r.book, lag);
      }
    }

    if (firstMoverBook) {
      results.set(key, { firstMoverBook, timeLags });
    }
  }

  return results;
}

// ─── computeBookSharpness ───
// Reads all odds_history + bets + market_consensus data
// Computes per-book sharpness metrics

export function computeBookSharpness(allOdds) {
  const resolvedBets = db.getAllBets().filter((b) => b.result !== "pending");

  // Group odds by game
  const oddsByGame = new Map();
  for (const row of allOdds) {
    if (!oddsByGame.has(row.game_id)) oddsByGame.set(row.game_id, []);
    oddsByGame.get(row.game_id).push(row);
  }

  // Per-book accumulators
  const bookStats = new Map();
  for (const book of BOOKS) {
    bookStats.set(book, {
      totalSnapshots: 0,
      firstMoverCount: 0,
      timeLags: [],
      distancesFromClose: [],
      clvValues: [],
      outlierCount: 0,
      totalEligibleMovements: 0,
    });
  }

  // Count snapshots per book
  for (const row of allOdds) {
    const stat = bookStats.get(row.book);
    if (stat) stat.totalSnapshots++;
  }

  // Detect first movers per game
  for (const [, gameOdds] of oddsByGame) {
    const firstMovers = detectFirstMovers(gameOdds);

    for (const [, fm] of firstMovers) {
      // Count eligible movements only for books that had odds for this game
      for (const book of BOOKS) {
        const hadOdds = gameOdds.some((r) => r.book === book);
        const stat = bookStats.get(book);
        if (stat && hadOdds) stat.totalEligibleMovements++;
      }

      const stat = bookStats.get(fm.firstMoverBook);
      if (stat) stat.firstMoverCount++;

      for (const [book, lag] of fm.timeLags) {
        const s = bookStats.get(book);
        if (s) s.timeLags.push(lag);
      }
    }
  }

  // Compute closing line distances for resolved bets
  for (const bet of resolvedBets) {
    if (!bet.closing_odds) continue;
    const stat = bookStats.get(bet.best_book);
    if (!stat) continue;

    const dist = Math.abs(bet.odds_at_pick - bet.closing_odds);
    stat.distancesFromClose.push(dist);

    if (bet.clv !== null && bet.clv !== undefined) {
      stat.clvValues.push(bet.clv);
    }
  }

  // Compute outlier counts from consensus data
  const consensusRows = [];
  const gameIds = db.getDistinctOddsGameIds();
  for (const gameId of gameIds) {
    const rows = db.getMarketConsensusByGame(gameId);
    consensusRows.push(...rows);
  }
  for (const row of consensusRows) {
    if (row.outlier_book) {
      const stat = bookStats.get(row.outlier_book);
      if (stat) stat.outlierCount++;
    }
  }

  // Compute scores and ranks
  const bookMetrics = [];
  const maxTimeLag = 3600; // normalize against 1 hour
  const maxDistFromClose = 50; // normalize against 50 cents

  for (const [book, stat] of bookStats) {
    const firstMoverFreq = stat.totalEligibleMovements > 0
      ? stat.firstMoverCount / stat.totalEligibleMovements
      : 0;
    const avgTimeToMove = stat.timeLags.length > 0
      ? stat.timeLags.reduce((a, b) => a + b, 0) / stat.timeLags.length
      : null;
    const avgDistFromClose = stat.distancesFromClose.length > 0
      ? stat.distancesFromClose.reduce((a, b) => a + b, 0) / stat.distancesFromClose.length
      : null;
    const avgClv = stat.clvValues.length > 0
      ? stat.clvValues.reduce((a, b) => a + b, 0) / stat.clvValues.length
      : null;
    const outlierFreq = stat.totalSnapshots > 0
      ? stat.outlierCount / stat.totalSnapshots
      : 0;

    // Composite score (0-100)
    const normTimeToMove = avgTimeToMove !== null
      ? Math.min(1, avgTimeToMove / maxTimeLag)
      : 0.5;
    const normDistFromClose = avgDistFromClose !== null
      ? Math.min(1, avgDistFromClose / maxDistFromClose)
      : 0.5;

    const score =
      firstMoverFreq * 35 +
      (1 - normTimeToMove) * 25 +
      (1 - normDistFromClose) * 25 +
      outlierFreq * 15;

    // Scale to 0-100
    const priceEfficiencyScore = Math.min(100, Math.max(0, score));

    bookMetrics.push({
      book,
      total_snapshots: stat.totalSnapshots,
      first_mover_count: stat.firstMoverCount,
      first_mover_freq: Math.round(firstMoverFreq * 1000) / 1000,
      avg_time_to_move: avgTimeToMove !== null ? Math.round(avgTimeToMove) : null,
      avg_distance_from_close: avgDistFromClose !== null ? Math.round(avgDistFromClose * 100) / 100 : null,
      avg_clv: avgClv !== null ? Math.round(avgClv * 100) / 100 : null,
      outlier_count: stat.outlierCount,
      outlier_freq: Math.round(outlierFreq * 1000) / 1000,
      price_efficiency_score: Math.round(priceEfficiencyScore * 10) / 10,
    });
  }

  // Rank by price_efficiency_score DESC
  bookMetrics.sort((a, b) => b.price_efficiency_score - a.price_efficiency_score);
  bookMetrics.forEach((m, i) => {
    m.sharpness_rank = i + 1;
  });

  return bookMetrics;
}

// ─── runSportsbookAnalysis ───
// Orchestrator: calls analysis functions, persists results

export function runSportsbookAnalysis() {
  // 1. Compute consensus for all games and persist
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const allOdds = db.getOddsHistorySince(thirtyDaysAgo);
  const oddsByGameAndSnapshot = new Map();
  for (const row of allOdds) {
    const key = `${row.game_id}|${row.snapshot_at}`;
    if (!oddsByGameAndSnapshot.has(key)) {
      oddsByGameAndSnapshot.set(key, { game_id: row.game_id, snapshot_at: row.snapshot_at, rows: [] });
    }
    oddsByGameAndSnapshot.get(key).rows.push(row);
  }

  let consensusCount = 0;
  for (const [, snap] of oddsByGameAndSnapshot) {
    const consensusEntries = analyzeConsensus(snap.rows);
    for (const entry of consensusEntries) {
      try {
        db.insertMarketConsensus({
          game_id: snap.game_id,
          market: entry.market,
          outcome_name: entry.outcome_name,
          outcome_point: entry.outcome_point ?? null,
          consensus_price: entry.consensus_price,
          num_books: entry.num_books,
          outlier_book: entry.outlier_book ?? null,
          outlier_distance: entry.outlier_distance || null,
          first_mover_book: null,
          snapshot_at: snap.snapshot_at,
        });
        consensusCount++;
      } catch {
        // Ignore duplicates
      }
    }
  }

  // 2. Detect first movers and update consensus entries
  const oddsByGame = new Map();
  for (const row of allOdds) {
    if (!oddsByGame.has(row.game_id)) oddsByGame.set(row.game_id, []);
    oddsByGame.get(row.game_id).push(row);
  }

  // 3. Compute book sharpness
  const bookMetrics = computeBookSharpness(allOdds);

  // 4. Persist book metrics
  for (const m of bookMetrics) {
    db.upsertSportsbookMetrics(m);
  }

  // 5. Compute daily metrics
  const today = new Date().toISOString().slice(0, 10);
  const todayOdds = allOdds.filter((r) => r.snapshot_at.startsWith(today));
  const todayByBook = new Map();
  for (const row of todayOdds) {
    if (!todayByBook.has(row.book)) todayByBook.set(row.book, []);
    todayByBook.get(row.book).push(row);
  }

  for (const book of BOOKS) {
    const bookOdds = todayByBook.get(book) || [];
    // Count first movers for today
    const todayGameOdds = new Map();
    for (const row of bookOdds) {
      if (!todayGameOdds.has(row.game_id)) todayGameOdds.set(row.game_id, []);
      todayGameOdds.get(row.game_id).push(row);
    }

    let fmCount = 0;
    let eligibleMovements = 0;
    for (const [gameId] of todayGameOdds) {
      const gameOdds = oddsByGame.get(gameId) || [];
      const todayGameRows = gameOdds.filter((r) => r.snapshot_at.startsWith(today));
      const firstMovers = detectFirstMovers(todayGameRows);
      for (const [, fm] of firstMovers) {
        eligibleMovements++;
        if (fm.firstMoverBook === book) fmCount++;
      }
    }

    db.upsertSportsbookDaily({
      metric_date: today,
      book,
      snapshots_count: bookOdds.length,
      first_mover_count: fmCount,
      first_mover_freq: eligibleMovements > 0 ? Math.round((fmCount / eligibleMovements) * 1000) / 1000 : 0,
      avg_distance_from_consensus: null,
      outlier_count: 0,
    });
  }

  return {
    ok: true,
    booksAnalyzed: bookMetrics.length,
    consensusEntries: consensusCount,
    sharpestBook: bookMetrics[0]?.book || null,
    metrics: bookMetrics,
  };
}

// ─── computeLiveConsensus ───
// Input: array of odds snapshot rows just inserted
// Computes consensus for the current snapshot and persists

export function computeLiveConsensus(snapshotRows) {
  // Group by game_id
  const byGame = new Map();
  for (const row of snapshotRows) {
    if (!byGame.has(row.game_id)) byGame.set(row.game_id, []);
    byGame.get(row.game_id).push(row);
  }

  let count = 0;
  for (const [gameId, rows] of byGame) {
    const consensusEntries = analyzeConsensus(rows);
    for (const entry of consensusEntries) {
      try {
        db.insertMarketConsensus({
          game_id: gameId,
          market: entry.market,
          outcome_name: entry.outcome_name,
          outcome_point: entry.outcome_point ?? null,
          consensus_price: entry.consensus_price,
          num_books: entry.num_books,
          outlier_book: entry.outlier_book ?? null,
          outlier_distance: entry.outlier_distance || null,
          first_mover_book: null,
          snapshot_at: rows[0]?.snapshot_at || new Date().toISOString(),
        });
        count++;
      } catch {
        // Ignore errors
      }
    }
  }
  return count;
}

// ─── getSharpBookWeight ───
// Returns a weight 0.5-1.5 based on book's price_efficiency_score

export function getSharpBookWeight(book) {
  const metric = db.getSportsbookMetricsByBook(book);
  if (!metric) return 1.0;
  // Map 0-100 score to 0.5-1.5 weight
  return 0.5 + (metric.price_efficiency_score / 100);
}

// ─── isSharpMovement ───
// Returns true if a sharp book (top 2) moved the line in the same direction

export function isSharpMovement(gameId, market, outcome) {
  const metrics = db.getSportsbookMetrics();
  const sharpBooks = metrics.filter((m) => m.sharpness_rank <= 2).map((m) => m.book);
  if (sharpBooks.length === 0) return false;

  const consensusRows = db.getMarketConsensusByGame(gameId);
  return consensusRows.some(
    (r) => r.market === market && r.outcome_name === outcome && sharpBooks.includes(r.first_mover_book)
  );
}
