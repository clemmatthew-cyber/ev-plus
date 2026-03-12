export interface EvBet {
  id: string;
  gameId: string;
  gameTime: string;
  homeTeam: string;
  awayTeam: string;
  market: "ml" | "pl" | "totals";
  outcome: string;
  bestBook: string;
  bestPrice: number;
  bestLine: number | null;
  modelProb: number;
  impliedProb: number;
  fairProb: number;
  edge: number;
  ev: number;
  confidenceScore: number;
  confidenceGrade: "A" | "B" | "C" | "D";
  kellyFraction: number;
  suggestedStake: number;
  placed: boolean;
  surfacedAt: string;
}

// ─── Tracked bet: full snapshot saved when user taps checkmark ───

export interface TrackedBet {
  id: string;             // same as EvBet.id at time of placement
  gameId: string;         // Odds API game ID
  gameTime: string;       // ISO — game start time
  homeTeam: string;       // 3-letter abbrev
  awayTeam: string;
  market: "ml" | "pl" | "totals";
  outcome: string;        // e.g. "STL ML", "PL DET +1.5", "Over 6.5"
  bestBook: string;       // e.g. "DK"
  oddsAtPick: number;     // American odds at placement
  lineAtPick: number | null; // spread/total line at placement
  modelProb: number;
  impliedProb: number;
  fairProb: number;
  edge: number;
  ev: number;
  confidenceScore: number;
  confidenceGrade: "A" | "B" | "C" | "D";
  kellyFraction: number;
  stake: number;          // suggested stake at placement
  placedAt: string;       // ISO — when user tapped checkmark
  // ─── Resolution fields ───
  result: "pending" | "win" | "loss" | "push";
  resolvedAt: string | null;
  homeScore: number | null;
  awayScore: number | null;
  periodType: string | null;  // "REG" | "OT" | "SO"
  profitLoss: number;     // in dollars, 0 while pending
  closingOdds: number | null;   // American odds at game start (for CLV)
  clv: number | null;     // closing line value in cents (closingImplied - pickImplied)
}

// ─── Computed summary from resolved bets ───

export interface TrackerSummary {
  totalBets: number;
  pending: number;
  wins: number;
  losses: number;
  pushes: number;
  record: string;
  roiPct: number;
  totalPL: number;
  avgEdge: number;
  avgCLV: number | null;
  brierScore: number;
  winRate: number;
}

export type MarketFilter = "all" | "ml" | "pl" | "totals";
export type SortBy = "edge" | "confidence" | "gameTime";
export type DayFilter = "all" | string;   // "all" or ISO date "YYYY-MM-DD"
export type TimeFilter = 7 | 14 | 30 | 9999;

// ─── Line movement data from persisted odds_history ───

export interface BookMovement {
  open: number;
  current: number;
  direction: "up" | "down" | "flat";
  magnitude: number;
  snapshots: { price: number; at: string }[];
}

export interface MovementEntry {
  market: string;
  outcomeName: string;
  outcomePoint: number | null;
  books: Record<string, BookMovement>;
  consensus: { direction: "up" | "down" | "flat"; avgOpen: number; avgCurrent: number };
}

export interface MovementData {
  gameId: string;
  movements: MovementEntry[];
}

// Legacy — keep for backwards compat if anything imports it
export type BetResult = TrackedBet;

// ─── Model Evaluation & Calibration Types ───

export interface ModelMetrics {
  brierScore: number | null;
  logLoss: number | null;
  winRate: number;
  roiPct: number;
  avgEdge: number;
  avgClv: number | null;
  totalEvaluated: number;
  wins: number;
  losses: number;
  pushes: number;
  totalPL: number;
  totalStaked: number;
}

export interface CalibrationBucket {
  bucketLabel: string;
  bucketStart: number;
  bucketEnd: number;
  totalPredictions: number;
  totalWins: number;
  actualWinRate: number;
  avgModelProb: number;
  avgEdge: number;
  totalProfit: number;
  roiPct: number;
}

export interface EdgeBucket {
  range: string;
  count: number;
  winRate: number;
  roi: number;
  avgProfit: number;
}

export interface ConfidenceBreakdown {
  grade: string;
  count: number;
  winRate: number;
  roi: number;
  avgEdge: number;
  brierScore: number | null;
}

export interface MarketBreakdown {
  market: string;
  count: number;
  winRate: number;
  roi: number;
  brierScore: number | null;
  avgClv: number | null;
}

export interface DailyMetric {
  date: string;
  totalEvaluated: number;
  wins: number;
  losses: number;
  profitLoss: number;
  brierScore: number | null;
  cumulativeRoi: number | null;
}

// ─── Sportsbook Intelligence Types ───

// ─── Goalie Confirmation Types ───

export type GoalieStatus = 'confirmed' | 'expected' | 'unknown';

export interface GoalieConfirmation {
  team: string;
  goalieName: string;
  status: GoalieStatus;
  source: string;
}

export interface LineupAdjustment {
  team: string;
  adjustmentType: string;
  adjustmentDetail: string | null;
  impactFactor: number;
  confidencePenalty: number;
}

// ─── Sportsbook Intelligence Types ───

export interface SportsbookMetric {
  book: string;
  sharpnessRank: number;
  priceEfficiencyScore: number;
  firstMoverFreq: number;
  avgTimeToMove: number | null;
  avgDistanceFromClose: number | null;
  avgClv: number | null;
  outlierFreq: number;
}

// ─── Betting Alert Types ───

export type AlertType = 'stale_book' | 'sharp_move' | 'confirmed_goalie_ev' | 'market_disagreement';
export type AlertSeverity = 'high' | 'medium' | 'low';

export interface BettingAlert {
  id: number;
  alertType: AlertType;
  severity: AlertSeverity;
  gameId: string;
  market: string | null;
  outcome: string | null;
  book: string | null;
  headline: string;
  detail: Record<string, any>;
  modelEdge: number | null;
  confidenceScore: number | null;
  isRead: boolean;
  createdAt: string;
  expiresAt: string | null;
}
