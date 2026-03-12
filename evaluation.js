// ─── Model Evaluation & Calibration Engine ───
// Computes prediction accuracy metrics, calibration buckets, and daily trends.

import * as db from "./db.js";

// ─── Evaluate resolved bets that haven't been evaluated yet ───

export function evaluateResolvedBets() {
  const allBets = db.getAllBets();
  const resolved = allBets.filter(b => b.result !== "pending");
  let count = 0;

  for (const bet of resolved) {
    // Skip if already evaluated
    const existing = db.getPredictionEvalByBetId(bet.id);
    if (existing) continue;

    const actualOutcome = bet.result === "win" ? 1 : bet.result === "loss" ? 0 : -1;

    db.insertPredictionEval({
      bet_id: bet.id,
      game_id: bet.game_id,
      market: bet.market,
      outcome: bet.outcome,
      model_prob: bet.model_prob,
      implied_prob: bet.implied_prob,
      fair_prob: bet.fair_prob,
      edge: bet.edge,
      confidence_score: bet.confidence_score,
      confidence_grade: bet.confidence_grade,
      odds_at_pick: bet.odds_at_pick,
      closing_odds: bet.closing_odds,
      clv: bet.clv,
      result: bet.result,
      actual_outcome: actualOutcome,
      profit_loss: bet.profit_loss,
      stake: bet.stake,
      resolved_at: bet.resolved_at,
    });
    count++;
  }

  return count;
}

// ─── Pure metric computation from evaluation rows ───

export function computeMetrics(evals) {
  if (evals.length === 0) {
    return {
      brierScore: null,
      logLoss: null,
      winRate: 0,
      roiPct: 0,
      avgEdge: 0,
      avgClv: null,
      totalEvaluated: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      totalPL: 0,
      totalStaked: 0,
    };
  }

  const wins = evals.filter(e => e.result === "win").length;
  const losses = evals.filter(e => e.result === "loss").length;
  const pushes = evals.filter(e => e.result === "push").length;
  const nonPush = evals.filter(e => e.actual_outcome !== -1);

  // Brier Score
  let brierScore = null;
  if (nonPush.length > 0) {
    const sum = nonPush.reduce((acc, e) => {
      return acc + Math.pow(e.model_prob - e.actual_outcome, 2);
    }, 0);
    brierScore = sum / nonPush.length;
  }

  // Log Loss
  let logLoss = null;
  if (nonPush.length > 0) {
    const sum = nonPush.reduce((acc, e) => {
      const p = Math.max(0.01, Math.min(0.99, e.model_prob));
      const actual = e.actual_outcome;
      return acc + -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
    }, 0);
    logLoss = sum / nonPush.length;
  }

  // Win Rate (exclude pushes)
  const winRate = nonPush.length > 0 ? wins / nonPush.length : 0;

  // ROI
  const totalPL = evals.reduce((acc, e) => acc + e.profit_loss, 0);
  const totalStaked = evals.reduce((acc, e) => acc + e.stake, 0);
  const roiPct = totalStaked > 0 ? (totalPL / totalStaked) * 100 : 0;

  // Average Edge
  const avgEdge = evals.reduce((acc, e) => acc + e.edge, 0) / evals.length;

  // Average CLV
  const withClv = evals.filter(e => e.clv !== null && e.clv !== undefined);
  const avgClv = withClv.length > 0
    ? withClv.reduce((acc, e) => acc + e.clv, 0) / withClv.length
    : null;

  return {
    brierScore,
    logLoss,
    winRate,
    roiPct,
    avgEdge,
    avgClv,
    totalEvaluated: evals.length,
    wins,
    losses,
    pushes,
    totalPL,
    totalStaked,
  };
}

// ─── Calibration buckets: 10 equal bins [0-10%, 10-20%, ..., 90-100%] ───

export function computeCalibrationBuckets(evals) {
  db.clearCalibrationBuckets();

  const buckets = [];
  for (let i = 0; i < 10; i++) {
    const start = i * 0.1;
    const end = (i + 1) * 0.1;
    const label = `${i * 10}-${(i + 1) * 10}%`;
    const inBucket = evals.filter(e => e.model_prob >= start && e.model_prob < (i === 9 ? 1.01 : end));

    if (inBucket.length === 0) continue;

    const totalWins = inBucket.filter(e => e.actual_outcome === 1).length;
    const totalProfit = inBucket.reduce((acc, e) => acc + e.profit_loss, 0);
    const totalStake = inBucket.reduce((acc, e) => acc + e.stake, 0);

    const bucket = {
      bucket_start: start,
      bucket_end: end,
      bucket_label: label,
      total_predictions: inBucket.length,
      total_wins: totalWins,
      actual_win_rate: totalWins / inBucket.length,
      avg_model_prob: inBucket.reduce((acc, e) => acc + e.model_prob, 0) / inBucket.length,
      avg_edge: inBucket.reduce((acc, e) => acc + e.edge, 0) / inBucket.length,
      total_profit: totalProfit,
      roi_pct: totalStake > 0 ? (totalProfit / totalStake) * 100 : 0,
    };

    db.upsertCalibrationBucket(bucket);
    buckets.push(bucket);
  }

  return buckets;
}

// ─── Daily metrics: group by resolved_at date, compute running cumulative ───

export function computeDailyMetrics(evals) {
  // Group by date
  const byDate = new Map();
  for (const e of evals) {
    const date = e.resolved_at.split("T")[0];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(e);
  }

  // Sort dates ascending
  const sortedDates = [...byDate.keys()].sort();

  // Running cumulative accumulators
  let cumEvals = [];

  for (const date of sortedDates) {
    const dayEvals = byDate.get(date);
    cumEvals = cumEvals.concat(dayEvals);

    const dayMetrics = computeMetrics(dayEvals);
    const cumMetrics = computeMetrics(cumEvals);

    db.upsertDailyMetrics({
      metric_date: date,
      total_evaluated: dayMetrics.totalEvaluated,
      brier_score: dayMetrics.brierScore,
      log_loss: dayMetrics.logLoss,
      win_rate: dayMetrics.winRate,
      roi_pct: dayMetrics.roiPct,
      avg_edge: dayMetrics.avgEdge,
      avg_clv: dayMetrics.avgClv,
      total_profit: dayMetrics.totalPL,
      cumulative_evaluated: cumMetrics.totalEvaluated,
      cumulative_brier: cumMetrics.brierScore,
      cumulative_log_loss: cumMetrics.logLoss,
      cumulative_win_rate: cumMetrics.winRate,
      cumulative_roi: cumMetrics.roiPct,
    });
  }
}

// ─── Full evaluation orchestrator ───

export function runFullEvaluation() {
  const newlyEvaluated = evaluateResolvedBets();
  const evals = db.getAllPredictionEvals();
  const buckets = computeCalibrationBuckets(evals);
  computeDailyMetrics(evals);
  const metrics = computeMetrics(evals);

  return {
    newlyEvaluated,
    totalEvaluated: evals.length,
    metrics,
    buckets,
  };
}
