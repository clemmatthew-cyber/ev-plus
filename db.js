// ─── SQLite Database Layer for EV+ ───
// Synchronous via better-sqlite3. All CRUD helpers exported for use in server.js.

import Database from "better-sqlite3";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "ev-plus.db");

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ───

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    commence_time TEXT NOT NULL,
    home_score INTEGER,
    away_score INTEGER,
    period_type TEXT,
    game_state TEXT DEFAULT 'scheduled',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS odds_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    sport TEXT NOT NULL,
    book TEXT NOT NULL,
    market TEXT NOT NULL,
    outcome_name TEXT NOT NULL,
    outcome_point REAL,
    price INTEGER NOT NULL,
    snapshot_at TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    game_time TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    market TEXT NOT NULL,
    outcome TEXT NOT NULL,
    best_book TEXT NOT NULL,
    odds_at_pick INTEGER NOT NULL,
    line_at_pick REAL,
    model_prob REAL NOT NULL,
    implied_prob REAL NOT NULL,
    fair_prob REAL NOT NULL,
    edge REAL NOT NULL,
    ev REAL NOT NULL,
    confidence_score REAL NOT NULL,
    confidence_grade TEXT NOT NULL,
    kelly_fraction REAL NOT NULL,
    stake REAL NOT NULL,
    placed_at TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'pending',
    resolved_at TEXT,
    home_score INTEGER,
    away_score INTEGER,
    period_type TEXT,
    profit_loss REAL NOT NULL DEFAULT 0,
    closing_odds INTEGER,
    clv REAL
  );

  CREATE TABLE IF NOT EXISTS bankroll (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    balance REAL NOT NULL,
    peak_balance REAL NOT NULL,
    change_reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS model_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    sport TEXT NOT NULL,
    market TEXT NOT NULL,
    outcome TEXT NOT NULL,
    model_prob REAL NOT NULL,
    fair_prob REAL NOT NULL,
    implied_prob REAL NOT NULL,
    edge REAL NOT NULL,
    ev REAL NOT NULL,
    best_book TEXT NOT NULL,
    best_price INTEGER NOT NULL,
    best_line REAL,
    confidence_score REAL NOT NULL,
    confidence_grade TEXT NOT NULL,
    kelly_fraction REAL NOT NULL,
    suggested_stake REAL NOT NULL,
    snapshot_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_odds_history_game ON odds_history(game_id);
  CREATE INDEX IF NOT EXISTS idx_odds_history_snapshot ON odds_history(snapshot_at);
  CREATE INDEX IF NOT EXISTS idx_odds_history_market ON odds_history(game_id, market, outcome_name, book);
  CREATE INDEX IF NOT EXISTS idx_bets_result ON bets(result);
  CREATE INDEX IF NOT EXISTS idx_bets_game ON bets(game_id);
  CREATE INDEX IF NOT EXISTS idx_bets_closing ON bets(result, closing_odds);
  CREATE INDEX IF NOT EXISTS idx_model_results_game ON model_results(game_id);
  CREATE INDEX IF NOT EXISTS idx_model_results_snapshot ON model_results(snapshot_at);
`);

// ─── Seed bankroll if table is empty ───

const bankrollCount = db.prepare("SELECT COUNT(*) AS cnt FROM bankroll").get();
if (bankrollCount.cnt === 0) {
  db.prepare(
    "INSERT INTO bankroll (balance, peak_balance, change_reason) VALUES (?, ?, ?)"
  ).run(3000, 3000, "init");
}

// ─── Prepared statements ───

const stmts = {
  // Games
  upsertGame: db.prepare(`
    INSERT INTO games (id, sport, home_team, away_team, commence_time, created_at, updated_at)
    VALUES (@id, @sport, @home_team, @away_team, @commence_time, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      commence_time = excluded.commence_time,
      updated_at = datetime('now')
  `),
  updateGame: db.prepare(`
    UPDATE games SET
      home_score = COALESCE(@home_score, home_score),
      away_score = COALESCE(@away_score, away_score),
      period_type = COALESCE(@period_type, period_type),
      game_state = COALESCE(@game_state, game_state),
      updated_at = datetime('now')
    WHERE id = @id
  `),
  getGame: db.prepare("SELECT * FROM games WHERE id = ?"),

  // Odds history
  insertOddsSnapshot: db.prepare(`
    INSERT INTO odds_history (game_id, sport, book, market, outcome_name, outcome_point, price, snapshot_at)
    VALUES (@game_id, @sport, @book, @market, @outcome_name, @outcome_point, @price, @snapshot_at)
  `),
  getOddsHistory: db.prepare("SELECT * FROM odds_history WHERE game_id = ? ORDER BY snapshot_at ASC"),

  // Bets
  getAllBets: db.prepare("SELECT * FROM bets ORDER BY placed_at DESC"),
  getBetById: db.prepare("SELECT * FROM bets WHERE id = ?"),
  getBetByKey: db.prepare(
    "SELECT * FROM bets WHERE game_id = ? AND outcome = ? AND best_book = ?"
  ),
  insertBet: db.prepare(`
    INSERT INTO bets (
      id, game_id, game_time, home_team, away_team, market, outcome, best_book,
      odds_at_pick, line_at_pick, model_prob, implied_prob, fair_prob, edge, ev,
      confidence_score, confidence_grade, kelly_fraction, stake, placed_at,
      result, resolved_at, home_score, away_score, period_type, profit_loss,
      closing_odds, clv
    ) VALUES (
      @id, @game_id, @game_time, @home_team, @away_team, @market, @outcome, @best_book,
      @odds_at_pick, @line_at_pick, @model_prob, @implied_prob, @fair_prob, @edge, @ev,
      @confidence_score, @confidence_grade, @kelly_fraction, @stake, @placed_at,
      @result, @resolved_at, @home_score, @away_score, @period_type, @profit_loss,
      @closing_odds, @clv
    )
  `),
  deleteBet: db.prepare("DELETE FROM bets WHERE id = ?"),
  deletePendingBetByKey: db.prepare(
    "DELETE FROM bets WHERE game_id = ? AND outcome = ? AND best_book = ? AND result = 'pending'"
  ),
  updateBet: db.prepare(`
    UPDATE bets SET
      result = COALESCE(@result, result),
      resolved_at = COALESCE(@resolved_at, resolved_at),
      home_score = COALESCE(@home_score, home_score),
      away_score = COALESCE(@away_score, away_score),
      period_type = COALESCE(@period_type, period_type),
      profit_loss = COALESCE(@profit_loss, profit_loss),
      closing_odds = COALESCE(@closing_odds, closing_odds),
      clv = COALESCE(@clv, clv)
    WHERE id = @id
  `),

  // Bankroll
  getLatestBankroll: db.prepare(
    "SELECT balance, peak_balance FROM bankroll ORDER BY id DESC LIMIT 1"
  ),
  insertBankroll: db.prepare(
    "INSERT INTO bankroll (balance, peak_balance, change_reason) VALUES (?, ?, ?)"
  ),
  getBankrollHistory: db.prepare(
    "SELECT * FROM bankroll ORDER BY id DESC LIMIT ?"
  ),

  // Line movement & closing odds
  getOddsMovement: db.prepare(`
    SELECT book, market, outcome_name, outcome_point, price, snapshot_at
    FROM odds_history
    WHERE game_id = ?
    ORDER BY market, outcome_name, book, snapshot_at ASC
  `),
  getLatestOdds: db.prepare(`
    SELECT price, snapshot_at FROM odds_history
    WHERE game_id = ? AND market = ? AND outcome_name = ? AND book = ?
    ORDER BY snapshot_at DESC LIMIT 1
  `),
  getClosingOdds: db.prepare(`
    SELECT price, snapshot_at FROM odds_history
    WHERE game_id = ? AND market = ? AND outcome_name = ? AND book = ?
      AND snapshot_at <= ?
    ORDER BY snapshot_at DESC LIMIT 1
  `),
  getClosingOddsAnyBook: db.prepare(`
    SELECT price, book, snapshot_at FROM odds_history
    WHERE game_id = ? AND market = ? AND outcome_name = ?
      AND snapshot_at <= ?
    ORDER BY snapshot_at DESC LIMIT 1
  `),
  getPendingBetsNeedingClosing: db.prepare(`
    SELECT * FROM bets WHERE result = 'pending' AND closing_odds IS NULL
  `),

  // Model results
  insertModelResult: db.prepare(`
    INSERT INTO model_results (
      game_id, sport, market, outcome, model_prob, fair_prob, implied_prob,
      edge, ev, best_book, best_price, best_line, confidence_score,
      confidence_grade, kelly_fraction, suggested_stake, snapshot_at
    ) VALUES (
      @game_id, @sport, @market, @outcome, @model_prob, @fair_prob, @implied_prob,
      @edge, @ev, @best_book, @best_price, @best_line, @confidence_score,
      @confidence_grade, @kelly_fraction, @suggested_stake, @snapshot_at
    )
  `),
};

// ─── Exported CRUD helpers ───

// -- Games --

export function upsertGame(game) {
  return stmts.upsertGame.run(game);
}

export const upsertManyGames = db.transaction((games) => {
  for (const g of games) {
    stmts.upsertGame.run(g);
  }
});

export function updateGame(patch) {
  return stmts.updateGame.run(patch);
}

export function getGame(id) {
  return stmts.getGame.get(id);
}

// -- Odds History --

export function insertOddsSnapshot(row) {
  return stmts.insertOddsSnapshot.run(row);
}

export const insertManyOddsSnapshots = db.transaction((rows) => {
  for (const row of rows) {
    stmts.insertOddsSnapshot.run(row);
  }
});

export function getOddsHistory(gameId) {
  return stmts.getOddsHistory.all(gameId);
}

// -- Bets --

export function getAllBets() {
  return stmts.getAllBets.all();
}

export function getBetById(id) {
  return stmts.getBetById.get(id);
}

export function getBetByKey(gameId, outcome, book) {
  return stmts.getBetByKey.get(gameId, outcome, book);
}

export function insertBet(bet) {
  return stmts.insertBet.run(bet);
}

export function deleteBet(id) {
  return stmts.deleteBet.run(id);
}

export function deletePendingBetByKey(gameId, outcome, book) {
  return stmts.deletePendingBetByKey.run(gameId, outcome, book);
}

export function updateBet(patch) {
  return stmts.updateBet.run(patch);
}

export const bulkUpdateBets = db.transaction((updates) => {
  for (const u of updates) {
    stmts.updateBet.run(u);
  }
});

// -- Bankroll --

export function getLatestBankroll() {
  return stmts.getLatestBankroll.get() || { balance: 3000, peak_balance: 3000 };
}

export function insertBankrollEntry(balance, peakBalance, reason) {
  return stmts.insertBankroll.run(balance, peakBalance, reason);
}

export function getBankrollHistory(limit = 100) {
  return stmts.getBankrollHistory.all(limit);
}

// -- Model Results --

export function insertModelResult(row) {
  return stmts.insertModelResult.run(row);
}

export const insertManyModelResults = db.transaction((rows) => {
  for (const row of rows) {
    stmts.insertModelResult.run(row);
  }
});

// -- Line Movement & Closing Odds --

export function getOddsMovement(gameId) {
  return stmts.getOddsMovement.all(gameId);
}

export function getLatestOdds(gameId, market, outcomeName, book) {
  return stmts.getLatestOdds.get(gameId, market, outcomeName, book) || null;
}

export function getClosingOdds(gameId, market, outcomeName, book, beforeTime) {
  return stmts.getClosingOdds.get(gameId, market, outcomeName, book, beforeTime) || null;
}

export function getClosingOddsAnyBook(gameId, market, outcomeName, beforeTime) {
  return stmts.getClosingOddsAnyBook.get(gameId, market, outcomeName, beforeTime) || null;
}

export function getPendingBetsNeedingClosing() {
  return stmts.getPendingBetsNeedingClosing.all();
}

export function americanToImplied(odds) {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
}

// -- Safe schema migration --

function columnExists(table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some(c => c.name === column);
}

export function migrateSchema() {
  // Add any missing columns to existing tables
  if (!columnExists("bets", "closing_odds")) {
    db.exec("ALTER TABLE bets ADD COLUMN closing_odds INTEGER");
  }
  if (!columnExists("bets", "clv")) {
    db.exec("ALTER TABLE bets ADD COLUMN clv REAL");
  }
}

// Run migration on startup
migrateSchema();

// -- Cleanup --

export function close() {
  db.close();
}
