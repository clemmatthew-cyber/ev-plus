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

  CREATE TABLE IF NOT EXISTS prediction_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_id TEXT NOT NULL UNIQUE,
    game_id TEXT NOT NULL,
    market TEXT NOT NULL,
    outcome TEXT NOT NULL,
    model_prob REAL NOT NULL,
    implied_prob REAL NOT NULL,
    fair_prob REAL NOT NULL,
    edge REAL NOT NULL,
    confidence_score REAL NOT NULL,
    confidence_grade TEXT NOT NULL,
    odds_at_pick INTEGER NOT NULL,
    closing_odds INTEGER,
    clv REAL,
    result TEXT NOT NULL,
    actual_outcome INTEGER NOT NULL,
    profit_loss REAL NOT NULL,
    stake REAL NOT NULL,
    resolved_at TEXT NOT NULL,
    evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (bet_id) REFERENCES bets(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pred_eval_resolved ON prediction_evaluations(resolved_at);
  CREATE INDEX IF NOT EXISTS idx_pred_eval_market ON prediction_evaluations(market);
  CREATE INDEX IF NOT EXISTS idx_pred_eval_grade ON prediction_evaluations(confidence_grade);

  CREATE TABLE IF NOT EXISTS calibration_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_start REAL NOT NULL,
    bucket_end REAL NOT NULL,
    bucket_label TEXT NOT NULL,
    total_predictions INTEGER NOT NULL DEFAULT 0,
    total_wins INTEGER NOT NULL DEFAULT 0,
    actual_win_rate REAL NOT NULL DEFAULT 0,
    avg_model_prob REAL NOT NULL DEFAULT 0,
    avg_edge REAL NOT NULL DEFAULT 0,
    total_profit REAL NOT NULL DEFAULT 0,
    roi_pct REAL NOT NULL DEFAULT 0,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_model_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_date TEXT NOT NULL UNIQUE,
    total_evaluated INTEGER NOT NULL DEFAULT 0,
    brier_score REAL,
    log_loss REAL,
    win_rate REAL,
    roi_pct REAL,
    avg_edge REAL,
    avg_clv REAL,
    total_profit REAL NOT NULL DEFAULT 0,
    cumulative_evaluated INTEGER NOT NULL DEFAULT 0,
    cumulative_brier REAL,
    cumulative_log_loss REAL,
    cumulative_win_rate REAL,
    cumulative_roi REAL,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_model_metrics(metric_date);

  CREATE TABLE IF NOT EXISTS sportsbook_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book TEXT NOT NULL UNIQUE,
    total_snapshots INTEGER NOT NULL DEFAULT 0,
    first_mover_count INTEGER NOT NULL DEFAULT 0,
    first_mover_freq REAL NOT NULL DEFAULT 0,
    avg_time_to_move REAL,
    avg_distance_from_close REAL,
    avg_clv REAL,
    outlier_count INTEGER NOT NULL DEFAULT 0,
    outlier_freq REAL NOT NULL DEFAULT 0,
    price_efficiency_score REAL NOT NULL DEFAULT 50,
    sharpness_rank INTEGER,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sportsbook_daily_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_date TEXT NOT NULL,
    book TEXT NOT NULL,
    snapshots_count INTEGER NOT NULL DEFAULT 0,
    first_mover_count INTEGER NOT NULL DEFAULT 0,
    first_mover_freq REAL NOT NULL DEFAULT 0,
    avg_distance_from_consensus REAL,
    outlier_count INTEGER NOT NULL DEFAULT 0,
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(metric_date, book)
  );
  CREATE INDEX IF NOT EXISTS idx_sb_daily_date ON sportsbook_daily_metrics(metric_date);
  CREATE INDEX IF NOT EXISTS idx_sb_daily_book ON sportsbook_daily_metrics(book);

  CREATE TABLE IF NOT EXISTS market_consensus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    market TEXT NOT NULL,
    outcome_name TEXT NOT NULL,
    outcome_point REAL,
    consensus_price REAL NOT NULL,
    num_books INTEGER NOT NULL,
    outlier_book TEXT,
    outlier_distance REAL,
    first_mover_book TEXT,
    snapshot_at TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );
  CREATE INDEX IF NOT EXISTS idx_consensus_game ON market_consensus(game_id);
  CREATE INDEX IF NOT EXISTS idx_consensus_snapshot ON market_consensus(snapshot_at);

  CREATE TABLE IF NOT EXISTS goalie_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    team TEXT NOT NULL,
    goalie_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL DEFAULT 'dailyfaceoff',
    snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(game_date, team, snapshot_at)
  );
  CREATE INDEX IF NOT EXISTS idx_goalie_conf_date ON goalie_confirmations(game_date);
  CREATE INDEX IF NOT EXISTS idx_goalie_conf_team ON goalie_confirmations(team);

  CREATE TABLE IF NOT EXISTS lineup_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    team TEXT NOT NULL,
    adjustment_type TEXT NOT NULL,
    adjustment_detail TEXT,
    impact_factor REAL NOT NULL DEFAULT 1.0,
    confidence_penalty REAL NOT NULL DEFAULT 0,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(game_date, team, adjustment_type, applied_at)
  );
  CREATE INDEX IF NOT EXISTS idx_lineup_adj_date ON lineup_adjustments(game_date);
  CREATE INDEX IF NOT EXISTS idx_lineup_adj_team ON lineup_adjustments(team);

  CREATE TABLE IF NOT EXISTS betting_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    game_id TEXT NOT NULL,
    market TEXT,
    outcome TEXT,
    book TEXT,
    headline TEXT NOT NULL,
    detail TEXT,
    model_edge REAL,
    confidence_score REAL,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_dismissed INTEGER NOT NULL DEFAULT 0,
    webhook_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_type ON betting_alerts(alert_type);
  CREATE INDEX IF NOT EXISTS idx_alerts_game ON betting_alerts(game_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_unread ON betting_alerts(is_read, is_dismissed);
  CREATE INDEX IF NOT EXISTS idx_alerts_created ON betting_alerts(created_at);

  CREATE TABLE IF NOT EXISTS model_parameters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    param_key TEXT NOT NULL UNIQUE,
    param_value REAL NOT NULL,
    default_value REAL NOT NULL,
    min_bound REAL NOT NULL,
    max_bound REAL NOT NULL,
    step_size REAL NOT NULL,
    description TEXT,
    is_tunable INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recalibration_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'running',
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    sample_size INTEGER NOT NULL DEFAULT 0,
    params_evaluated INTEGER NOT NULL DEFAULT 0,
    params_changed INTEGER NOT NULL DEFAULT 0,
    baseline_brier REAL,
    baseline_log_loss REAL,
    baseline_clv REAL,
    baseline_roi REAL,
    baseline_calibration_error REAL,
    final_brier REAL,
    final_log_loss REAL,
    final_clv REAL,
    final_roi REAL,
    final_calibration_error REAL,
    composite_score_before REAL,
    composite_score_after REAL,
    duration_ms INTEGER,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recal_runs_created ON recalibration_runs(created_at);

  CREATE TABLE IF NOT EXISTS parameter_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    param_key TEXT NOT NULL,
    old_value REAL NOT NULL,
    new_value REAL NOT NULL,
    improvement_pct REAL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES recalibration_runs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_param_history_run ON parameter_history(run_id);
  CREATE INDEX IF NOT EXISTS idx_param_history_key ON parameter_history(param_key);
`);

// ─── Seed bankroll if table is empty ───

const bankrollCount = db.prepare("SELECT COUNT(*) AS cnt FROM bankroll").get();
if (bankrollCount.cnt === 0) {
  db.prepare(
    "INSERT INTO bankroll (balance, peak_balance, change_reason) VALUES (?, ?, ?)"
  ).run(3000, 3000, "init");
}

// ─── Seed model_parameters if empty ───

const TUNABLE_PARAMS = [
  { key: 'dixonColesRho',       default: -0.04,  min: -0.12,  max: 0.02,   step: 0.01,  desc: 'Dixon-Coles low-score correlation' },
  { key: 'b2bPenalty',          default: 0.95,   min: 0.88,   max: 0.99,   step: 0.01,  desc: 'Back-to-back lambda penalty' },
  { key: 'restBonusPerDay',     default: 0.01,   min: 0.005,  max: 0.025,  step: 0.005, desc: 'Per-day rest lambda bonus' },
  { key: 'goalieConfirmedBoost',default: 8,      min: 2,      max: 15,     step: 1,     desc: 'Confidence boost for confirmed goalie' },
  { key: 'goalieExpectedPenalty',default: -3,     min: -10,    max: 0,      step: 1,     desc: 'Confidence penalty for expected goalie' },
  { key: 'goalieUnknownPenalty', default: -10,    min: -20,    max: -3,     step: 1,     desc: 'Confidence penalty for unknown goalie' },
  { key: 'lineupIncompleteConfidencePenalty', default: -5, min: -15, max: 0, step: 1, desc: 'Confidence penalty for incomplete lineup data' },
  { key: 'sharpMovementBonus',  default: 5,      min: 1,      max: 12,     step: 1,     desc: 'Confidence bonus when sharp book confirms edge' },
  { key: 'sharpBookWeight',     default: 0.10,   min: 0.03,   max: 0.20,   step: 0.01,  desc: 'Weight of sportsbook intelligence in confidence scoring' },
  { key: 'homeIceAdvantage',    default: 0.12,   min: 0.06,   max: 0.20,   step: 0.01,  desc: 'Home ice lambda advantage' },
  { key: 'goalieImpactScale',   default: 0.08,   min: 0.03,   max: 0.15,   step: 0.01,  desc: 'How much GSAx moves lambdas' },
  { key: 'disagreementThreshold',default: 0.08,  min: 0.04,   max: 0.15,   step: 0.01,  desc: 'Model-market disagreement threshold' },
  { key: 'xgWeight',            default: 0.70,   min: 0.50,   max: 0.90,   step: 0.05,  desc: 'xG vs actual goals weight' },
];

const seedParam = db.prepare(`
  INSERT OR IGNORE INTO model_parameters (param_key, param_value, default_value, min_bound, max_bound, step_size, description)
  VALUES (@param_key, @param_value, @default_value, @min_bound, @max_bound, @step_size, @description)
`);

const paramCount = db.prepare("SELECT COUNT(*) AS cnt FROM model_parameters").get();
if (paramCount.cnt === 0) {
  for (const p of TUNABLE_PARAMS) {
    seedParam.run({
      param_key: p.key,
      param_value: p.default,
      default_value: p.default,
      min_bound: p.min,
      max_bound: p.max,
      step_size: p.step,
      description: p.desc,
    });
  }
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

  // Prediction evaluations
  insertPredictionEval: db.prepare(`
    INSERT INTO prediction_evaluations (
      bet_id, game_id, market, outcome, model_prob, implied_prob, fair_prob,
      edge, confidence_score, confidence_grade, odds_at_pick, closing_odds,
      clv, result, actual_outcome, profit_loss, stake, resolved_at
    ) VALUES (
      @bet_id, @game_id, @market, @outcome, @model_prob, @implied_prob, @fair_prob,
      @edge, @confidence_score, @confidence_grade, @odds_at_pick, @closing_odds,
      @clv, @result, @actual_outcome, @profit_loss, @stake, @resolved_at
    )
  `),
  getPredictionEvalByBetId: db.prepare("SELECT * FROM prediction_evaluations WHERE bet_id = ?"),
  getAllPredictionEvals: db.prepare("SELECT * FROM prediction_evaluations ORDER BY resolved_at DESC"),
  getPredictionEvalsByDateRange: db.prepare("SELECT * FROM prediction_evaluations WHERE resolved_at >= ? AND resolved_at <= ? ORDER BY resolved_at DESC"),
  getPredictionEvalsByMarket: db.prepare("SELECT * FROM prediction_evaluations WHERE market = ? ORDER BY resolved_at DESC"),
  getPredictionEvalsByGrade: db.prepare("SELECT * FROM prediction_evaluations WHERE confidence_grade = ? ORDER BY resolved_at DESC"),
  countPredictionEvals: db.prepare("SELECT COUNT(*) AS count FROM prediction_evaluations"),

  // Calibration buckets
  upsertCalibrationBucket: db.prepare(`
    INSERT OR REPLACE INTO calibration_buckets (
      bucket_start, bucket_end, bucket_label, total_predictions, total_wins,
      actual_win_rate, avg_model_prob, avg_edge, total_profit, roi_pct
    ) VALUES (
      @bucket_start, @bucket_end, @bucket_label, @total_predictions, @total_wins,
      @actual_win_rate, @avg_model_prob, @avg_edge, @total_profit, @roi_pct
    )
  `),
  getAllCalibrationBuckets: db.prepare("SELECT * FROM calibration_buckets ORDER BY bucket_start ASC"),
  clearCalibrationBuckets: db.prepare("DELETE FROM calibration_buckets"),

  // Daily model metrics
  upsertDailyMetrics: db.prepare(`
    INSERT INTO daily_model_metrics (
      metric_date, total_evaluated, brier_score, log_loss, win_rate, roi_pct,
      avg_edge, avg_clv, total_profit, cumulative_evaluated, cumulative_brier,
      cumulative_log_loss, cumulative_win_rate, cumulative_roi
    ) VALUES (
      @metric_date, @total_evaluated, @brier_score, @log_loss, @win_rate, @roi_pct,
      @avg_edge, @avg_clv, @total_profit, @cumulative_evaluated, @cumulative_brier,
      @cumulative_log_loss, @cumulative_win_rate, @cumulative_roi
    ) ON CONFLICT(metric_date) DO UPDATE SET
      total_evaluated = excluded.total_evaluated,
      brier_score = excluded.brier_score,
      log_loss = excluded.log_loss,
      win_rate = excluded.win_rate,
      roi_pct = excluded.roi_pct,
      avg_edge = excluded.avg_edge,
      avg_clv = excluded.avg_clv,
      total_profit = excluded.total_profit,
      cumulative_evaluated = excluded.cumulative_evaluated,
      cumulative_brier = excluded.cumulative_brier,
      cumulative_log_loss = excluded.cumulative_log_loss,
      cumulative_win_rate = excluded.cumulative_win_rate,
      cumulative_roi = excluded.cumulative_roi,
      computed_at = datetime('now')
  `),
  getDailyMetrics: db.prepare("SELECT * FROM daily_model_metrics ORDER BY metric_date DESC LIMIT ?"),
  getDailyMetricsByRange: db.prepare("SELECT * FROM daily_model_metrics WHERE metric_date >= ? AND metric_date <= ? ORDER BY metric_date ASC"),
  getLatestDailyMetrics: db.prepare("SELECT * FROM daily_model_metrics ORDER BY metric_date DESC LIMIT 1"),

  // Sportsbook metrics
  upsertSportsbookMetrics: db.prepare(`
    INSERT INTO sportsbook_metrics (
      book, total_snapshots, first_mover_count, first_mover_freq, avg_time_to_move,
      avg_distance_from_close, avg_clv, outlier_count, outlier_freq,
      price_efficiency_score, sharpness_rank
    ) VALUES (
      @book, @total_snapshots, @first_mover_count, @first_mover_freq, @avg_time_to_move,
      @avg_distance_from_close, @avg_clv, @outlier_count, @outlier_freq,
      @price_efficiency_score, @sharpness_rank
    ) ON CONFLICT(book) DO UPDATE SET
      total_snapshots = excluded.total_snapshots,
      first_mover_count = excluded.first_mover_count,
      first_mover_freq = excluded.first_mover_freq,
      avg_time_to_move = excluded.avg_time_to_move,
      avg_distance_from_close = excluded.avg_distance_from_close,
      avg_clv = excluded.avg_clv,
      outlier_count = excluded.outlier_count,
      outlier_freq = excluded.outlier_freq,
      price_efficiency_score = excluded.price_efficiency_score,
      sharpness_rank = excluded.sharpness_rank,
      computed_at = datetime('now')
  `),
  getSportsbookMetrics: db.prepare("SELECT * FROM sportsbook_metrics ORDER BY sharpness_rank ASC"),
  getSportsbookMetricsByBook: db.prepare("SELECT * FROM sportsbook_metrics WHERE book = ?"),

  // Sportsbook daily metrics
  upsertSportsbookDaily: db.prepare(`
    INSERT INTO sportsbook_daily_metrics (
      metric_date, book, snapshots_count, first_mover_count, first_mover_freq,
      avg_distance_from_consensus, outlier_count
    ) VALUES (
      @metric_date, @book, @snapshots_count, @first_mover_count, @first_mover_freq,
      @avg_distance_from_consensus, @outlier_count
    ) ON CONFLICT(metric_date, book) DO UPDATE SET
      snapshots_count = excluded.snapshots_count,
      first_mover_count = excluded.first_mover_count,
      first_mover_freq = excluded.first_mover_freq,
      avg_distance_from_consensus = excluded.avg_distance_from_consensus,
      outlier_count = excluded.outlier_count,
      computed_at = datetime('now')
  `),
  getSportsbookDailyByDate: db.prepare("SELECT * FROM sportsbook_daily_metrics WHERE metric_date = ?"),
  getSportsbookDailyByBook: db.prepare("SELECT * FROM sportsbook_daily_metrics WHERE book = ? ORDER BY metric_date DESC LIMIT ?"),

  // Market consensus
  insertMarketConsensus: db.prepare(`
    INSERT INTO market_consensus (
      game_id, market, outcome_name, outcome_point, consensus_price,
      num_books, outlier_book, outlier_distance, first_mover_book, snapshot_at
    ) VALUES (
      @game_id, @market, @outcome_name, @outcome_point, @consensus_price,
      @num_books, @outlier_book, @outlier_distance, @first_mover_book, @snapshot_at
    )
  `),
  getMarketConsensusByGame: db.prepare("SELECT * FROM market_consensus WHERE game_id = ? ORDER BY snapshot_at DESC"),

  // Bulk helpers for sportsbook
  getAllOddsHistory: db.prepare("SELECT * FROM odds_history ORDER BY snapshot_at ASC"),
  getDistinctOddsGameIds: db.prepare("SELECT DISTINCT game_id FROM odds_history"),

  // Goalie confirmations
  upsertGoalieConfirmation: db.prepare(`
    INSERT INTO goalie_confirmations (game_date, team, goalie_name, status, source, snapshot_at)
    VALUES (@game_date, @team, @goalie_name, @status, @source, datetime('now'))
    ON CONFLICT(game_date, team, snapshot_at) DO UPDATE SET
      goalie_name = excluded.goalie_name,
      status = excluded.status,
      source = excluded.source
  `),
  getGoalieConfirmation: db.prepare(
    "SELECT * FROM goalie_confirmations WHERE game_date = ? AND team = ? ORDER BY snapshot_at DESC LIMIT 1"
  ),
  getGoalieConfirmationsByDate: db.prepare(
    "SELECT * FROM goalie_confirmations WHERE game_date = ? ORDER BY snapshot_at DESC"
  ),
  getLatestGoalieConfirmations: db.prepare(`
    SELECT gc.* FROM goalie_confirmations gc
    INNER JOIN (
      SELECT game_date, team, MAX(snapshot_at) as max_snap
      FROM goalie_confirmations
      WHERE game_date = ?
      GROUP BY game_date, team
    ) latest ON gc.game_date = latest.game_date AND gc.team = latest.team AND gc.snapshot_at = latest.max_snap
  `),

  // Lineup adjustments
  insertLineupAdjustment: db.prepare(`
    INSERT INTO lineup_adjustments (game_date, team, adjustment_type, adjustment_detail, impact_factor, confidence_penalty)
    VALUES (@game_date, @team, @adjustment_type, @adjustment_detail, @impact_factor, @confidence_penalty)
  `),
  getLineupAdjustments: db.prepare(
    "SELECT * FROM lineup_adjustments WHERE game_date = ? AND team = ? ORDER BY applied_at DESC"
  ),
  getLineupAdjustmentsByDate: db.prepare(
    "SELECT * FROM lineup_adjustments WHERE game_date = ? ORDER BY applied_at DESC"
  ),

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

  // Betting alerts
  insertAlert: db.prepare(`
    INSERT INTO betting_alerts (
      alert_type, severity, game_id, market, outcome, book, headline, detail,
      model_edge, confidence_score, expires_at
    ) VALUES (
      @alert_type, @severity, @game_id, @market, @outcome, @book, @headline, @detail,
      @model_edge, @confidence_score, @expires_at
    )
  `),
  getActiveAlerts: db.prepare(`
    SELECT * FROM betting_alerts
    WHERE is_dismissed = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC
  `),
  getActiveAlertsByType: db.prepare(`
    SELECT * FROM betting_alerts
    WHERE is_dismissed = 0 AND (expires_at IS NULL OR expires_at > datetime('now')) AND alert_type = ?
    ORDER BY created_at DESC
  `),
  getAlertsByGame: db.prepare("SELECT * FROM betting_alerts WHERE game_id = ? ORDER BY created_at DESC"),
  getUnreadAlertCount: db.prepare(`
    SELECT COUNT(*) AS count FROM betting_alerts
    WHERE is_read = 0 AND is_dismissed = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))
  `),
  markAlertRead: db.prepare("UPDATE betting_alerts SET is_read = 1 WHERE id = ?"),
  markAlertDismissed: db.prepare("UPDATE betting_alerts SET is_dismissed = 1 WHERE id = ?"),
  markAlertWebhookSent: db.prepare("UPDATE betting_alerts SET webhook_sent = 1 WHERE id = ?"),
  getRecentAlertsByType: db.prepare(`
    SELECT * FROM betting_alerts WHERE alert_type = ? ORDER BY created_at DESC LIMIT ?
  `),
  cleanupExpiredAlerts: db.prepare("DELETE FROM betting_alerts WHERE expires_at < datetime('now', '-24 hours')"),

  // Model parameters
  getModelParam: db.prepare("SELECT * FROM model_parameters WHERE param_key = ?"),
  getAllModelParams: db.prepare("SELECT * FROM model_parameters ORDER BY param_key ASC"),
  getTunableModelParams: db.prepare("SELECT * FROM model_parameters WHERE is_tunable = 1 ORDER BY param_key ASC"),
  updateModelParam: db.prepare(`
    UPDATE model_parameters SET param_value = @param_value, updated_at = datetime('now')
    WHERE param_key = @param_key
  `),
  resetModelParam: db.prepare(`
    UPDATE model_parameters SET param_value = default_value, updated_at = datetime('now')
    WHERE param_key = ?
  `),
  resetAllModelParams: db.prepare(`
    UPDATE model_parameters SET param_value = default_value, updated_at = datetime('now')
  `),

  // Recalibration runs
  insertRecalibrationRun: db.prepare(`
    INSERT INTO recalibration_runs (status, trigger_type, sample_size)
    VALUES (@status, @trigger_type, @sample_size)
  `),
  updateRecalibrationRun: db.prepare(`
    UPDATE recalibration_runs SET
      status = COALESCE(@status, status),
      params_evaluated = COALESCE(@params_evaluated, params_evaluated),
      params_changed = COALESCE(@params_changed, params_changed),
      baseline_brier = COALESCE(@baseline_brier, baseline_brier),
      baseline_log_loss = COALESCE(@baseline_log_loss, baseline_log_loss),
      baseline_clv = COALESCE(@baseline_clv, baseline_clv),
      baseline_roi = COALESCE(@baseline_roi, baseline_roi),
      baseline_calibration_error = COALESCE(@baseline_calibration_error, baseline_calibration_error),
      final_brier = COALESCE(@final_brier, final_brier),
      final_log_loss = COALESCE(@final_log_loss, final_log_loss),
      final_clv = COALESCE(@final_clv, final_clv),
      final_roi = COALESCE(@final_roi, final_roi),
      final_calibration_error = COALESCE(@final_calibration_error, final_calibration_error),
      composite_score_before = COALESCE(@composite_score_before, composite_score_before),
      composite_score_after = COALESCE(@composite_score_after, composite_score_after),
      duration_ms = COALESCE(@duration_ms, duration_ms),
      notes = COALESCE(@notes, notes),
      completed_at = COALESCE(@completed_at, completed_at)
    WHERE id = @id
  `),
  getRecalibrationRun: db.prepare("SELECT * FROM recalibration_runs WHERE id = ?"),
  getLatestRecalibrationRun: db.prepare("SELECT * FROM recalibration_runs ORDER BY created_at DESC LIMIT 1"),
  getRecentRecalibrationRuns: db.prepare("SELECT * FROM recalibration_runs ORDER BY created_at DESC LIMIT ?"),

  // Parameter history
  insertParameterHistory: db.prepare(`
    INSERT INTO parameter_history (run_id, param_key, old_value, new_value, improvement_pct)
    VALUES (@run_id, @param_key, @old_value, @new_value, @improvement_pct)
  `),
  getParameterHistoryByRun: db.prepare("SELECT * FROM parameter_history WHERE run_id = ? ORDER BY param_key ASC"),
  getParameterHistoryByKey: db.prepare("SELECT * FROM parameter_history WHERE param_key = ? ORDER BY changed_at DESC LIMIT ?"),
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

// -- Prediction Evaluations --

export function insertPredictionEval(row) {
  return stmts.insertPredictionEval.run(row);
}

export function getPredictionEvalByBetId(betId) {
  return stmts.getPredictionEvalByBetId.get(betId) || null;
}

export function getAllPredictionEvals() {
  return stmts.getAllPredictionEvals.all();
}

export function getPredictionEvalsByDateRange(start, end) {
  return stmts.getPredictionEvalsByDateRange.all(start, end);
}

export function getPredictionEvalsByMarket(market) {
  return stmts.getPredictionEvalsByMarket.all(market);
}

export function getPredictionEvalsByGrade(grade) {
  return stmts.getPredictionEvalsByGrade.all(grade);
}

export function countPredictionEvals() {
  return stmts.countPredictionEvals.get();
}

// -- Calibration Buckets --

export function upsertCalibrationBucket(row) {
  return stmts.upsertCalibrationBucket.run(row);
}

export function getAllCalibrationBuckets() {
  return stmts.getAllCalibrationBuckets.all();
}

export function clearCalibrationBuckets() {
  return stmts.clearCalibrationBuckets.run();
}

// -- Daily Model Metrics --

export function upsertDailyMetrics(row) {
  return stmts.upsertDailyMetrics.run(row);
}

export function getDailyMetrics(limit = 30) {
  return stmts.getDailyMetrics.all(limit);
}

export function getDailyMetricsByRange(start, end) {
  return stmts.getDailyMetricsByRange.all(start, end);
}

export function getLatestDailyMetrics() {
  return stmts.getLatestDailyMetrics.get() || null;
}

// -- Sportsbook Metrics --

export function upsertSportsbookMetrics(row) {
  return stmts.upsertSportsbookMetrics.run(row);
}

export function getSportsbookMetrics() {
  return stmts.getSportsbookMetrics.all();
}

export function getSportsbookMetricsByBook(book) {
  return stmts.getSportsbookMetricsByBook.get(book) || null;
}

// -- Sportsbook Daily Metrics --

export function upsertSportsbookDaily(row) {
  return stmts.upsertSportsbookDaily.run(row);
}

export function getSportsbookDailyByDate(date) {
  return stmts.getSportsbookDailyByDate.all(date);
}

export function getSportsbookDailyByBook(book, limit = 14) {
  return stmts.getSportsbookDailyByBook.all(book, limit);
}

// -- Market Consensus --

export function insertMarketConsensus(row) {
  return stmts.insertMarketConsensus.run(row);
}

export function getMarketConsensusByGame(gameId) {
  return stmts.getMarketConsensusByGame.all(gameId);
}

// -- Goalie Confirmations --

export function upsertGoalieConfirmation(row) { return stmts.upsertGoalieConfirmation.run(row); }
export function getGoalieConfirmation(gameDate, team) { return stmts.getGoalieConfirmation.get(gameDate, team) || null; }
export function getGoalieConfirmationsByDate(gameDate) { return stmts.getGoalieConfirmationsByDate.all(gameDate); }
export function getLatestGoalieConfirmations(gameDate) { return stmts.getLatestGoalieConfirmations.all(gameDate); }

// -- Lineup Adjustments --

export function insertLineupAdjustment(row) { return stmts.insertLineupAdjustment.run(row); }
export function getLineupAdjustments(gameDate, team) { return stmts.getLineupAdjustments.all(gameDate, team); }
export function getLineupAdjustmentsByDate(gameDate) { return stmts.getLineupAdjustmentsByDate.all(gameDate); }

// -- Bulk Odds Helpers --

export function getAllOddsHistory() {
  return stmts.getAllOddsHistory.all();
}

export function getDistinctOddsGameIds() {
  return stmts.getDistinctOddsGameIds.all().map(r => r.game_id);
}

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

// -- Betting Alerts --

export function insertAlert(row) {
  return stmts.insertAlert.run(row);
}

export function getActiveAlerts(type) {
  if (type) return stmts.getActiveAlertsByType.all(type);
  return stmts.getActiveAlerts.all();
}

export function getAlertsByGame(gameId) {
  return stmts.getAlertsByGame.all(gameId);
}

export function getUnreadAlertCount() {
  return stmts.getUnreadAlertCount.get().count;
}

export function markAlertRead(id) {
  return stmts.markAlertRead.run(id);
}

export function markAlertDismissed(id) {
  return stmts.markAlertDismissed.run(id);
}

export function markAlertWebhookSent(id) {
  return stmts.markAlertWebhookSent.run(id);
}

export function getRecentAlertsByType(alertType, limit = 20) {
  return stmts.getRecentAlertsByType.all(alertType, limit);
}

export function cleanupExpiredAlerts() {
  return stmts.cleanupExpiredAlerts.run();
}

// -- Model Parameters --

export function getModelParam(key) {
  return stmts.getModelParam.get(key) || null;
}

export function getAllModelParams() {
  return stmts.getAllModelParams.all();
}

export function getTunableModelParams() {
  return stmts.getTunableModelParams.all();
}

export function updateModelParam(paramKey, paramValue) {
  return stmts.updateModelParam.run({ param_key: paramKey, param_value: paramValue });
}

export function resetModelParam(key) {
  return stmts.resetModelParam.run(key);
}

export function resetAllModelParams() {
  return stmts.resetAllModelParams.run();
}

// -- Recalibration Runs --

export function insertRecalibrationRun(row) {
  return stmts.insertRecalibrationRun.run(row);
}

export function updateRecalibrationRun(patch) {
  return stmts.updateRecalibrationRun.run(patch);
}

export function getRecalibrationRun(id) {
  return stmts.getRecalibrationRun.get(id) || null;
}

export function getLatestRecalibrationRun() {
  return stmts.getLatestRecalibrationRun.get() || null;
}

export function getRecentRecalibrationRuns(limit = 10) {
  return stmts.getRecentRecalibrationRuns.all(limit);
}

// -- Parameter History --

export function insertParameterHistory(row) {
  return stmts.insertParameterHistory.run(row);
}

export function getParameterHistoryByRun(runId) {
  return stmts.getParameterHistoryByRun.all(runId);
}

export function getParameterHistoryByKey(key, limit = 20) {
  return stmts.getParameterHistoryByKey.all(key, limit);
}

// -- Cleanup --

export function close() {
  db.close();
}
