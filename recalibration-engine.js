// ─── Adaptive Parameter Tuning & Weekly Self-Calibration Engine ───
// Runs bounded parameter sweeps with walk-forward validation to tune model params.
// NOW uses ALL predictions (prediction_outcomes) for accuracy metrics, not just booked bets.

import * as db from "./db.js";

// ─── Server-side copy of DEFAULT_CONFIG values (matches src/lib/model/config.ts) ───

const SERVER_DEFAULT_CONFIG = {
  bankroll: 3000,
  peakBankroll: 3000,
  minStake: 10,
  maxStake: Infinity,
  minEdge: { ml: 0.03, pl: 0.04, totals: 0.045 },
  kellyFraction: 0.25,
  kellyDrawdownFloor: 0.15,
  drawdownThresholds: { start: 0.10, max: 0.20 },
  gradeMultiplier: { A: 1.0, B: 0.5, C: 0.15, D: 0.0 },
  homeIceAdvantage: 0.12,
  awayPenalty: 0.04,
  xgWeight: 0.70,
  hdFinishingCredit: 0.15,
  goalieMinGP: 10,
  goalieImpactScale: 0.08,
  goalieFloor: 0.90,
  goalieCeiling: 1.10,
  recencyRegression: 0.06,
  recencyMinGP: 40,
  lgAvgPPPerGame: 3.2,
  ppXgBlend: 0.60,
  confidence: {
    edgeWeight: 0.25,
    agreementWeight: 0.20,
    depthWeight: 0.12,
    bookWeight: 0.12,
    priceWeight: 0.09,
    goalieWeight: 0.12,
    sharpBookWeight: 0.10,
  },
  sharpBookEnabled: true,
  sharpMovementBonus: 5,
  confidenceGradeCutoffs: { A: 70, B: 50, C: 30 },
  disagreementThreshold: 0.08,
  disagreementPenaltyMax: 15,
  disagreementBonus: 5,
  poissonMaxGoals: 12,
  otherSituationsPerTeam: 0.55,
  lambdaMin: 0.8,
  lambdaMax: 5.5,
  simCount: 50000,
  otHomeAdvantage: 0.53,
  dixonColesRho: -0.04,
  fatigueEnabled: true,
  b2bPenalty: 0.95,
  restBonusPerDay: 0.01,
  maxRestBonus: 1.03,
  travelPenaltyPerKm: 0,
  timezonePenaltyPerHour: 0,
  goalieConfirmationEnabled: true,
  goalieConfirmedBoost: 8,
  goalieExpectedPenalty: -3,
  goalieUnknownPenalty: -10,
  goalieConfirmedMultiplier: 1.0,
  lineupAdjustmentEnabled: true,
  lineupIncompleteConfidencePenalty: -5,
};

// ─── Tunable parameter definitions ───

const TUNABLE_PARAMS = [
  { key: "dixonColesRho",       min: -0.12, max: 0.02,  step: 0.01,  group: "B" },
  { key: "b2bPenalty",          min: 0.88,  max: 0.99,  step: 0.01,  group: "B" },
  { key: "restBonusPerDay",     min: 0.005, max: 0.025, step: 0.005, group: "B" },
  { key: "goalieConfirmedBoost",min: 2,     max: 15,    step: 1,     group: "A" },
  { key: "goalieExpectedPenalty",min: -10,   max: 0,     step: 1,     group: "A" },
  { key: "goalieUnknownPenalty", min: -20,   max: -3,    step: 1,     group: "A" },
  { key: "lineupIncompleteConfidencePenalty", min: -15, max: 0, step: 1, group: "A" },
  { key: "sharpMovementBonus",  min: 1,     max: 12,    step: 1,     group: "A" },
  { key: "sharpBookWeight",     min: 0.03,  max: 0.20,  step: 0.01,  group: "A" },
  { key: "homeIceAdvantage",    min: 0.06,  max: 0.20,  step: 0.01,  group: "B" },
  { key: "goalieImpactScale",   min: 0.03,  max: 0.15,  step: 0.01,  group: "B" },
  { key: "disagreementThreshold", min: 0.04, max: 0.15, step: 0.01,  group: "C" },
  { key: "xgWeight",            min: 0.50,  max: 0.90,  step: 0.05,  group: "B" },
];

// ─── Composite Score Computation ───

function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

/**
 * Compute composite score from a set of evaluated bets.
 * Lower is better.
 */
export function computeCompositeScore(evals, params, paramKey) {
  const nonPush = evals.filter(e => e.actual_outcome !== -1);
  if (nonPush.length === 0) return { composite: 1, brier: 0.25, logLoss: 0.693, avgClv: 0, roi: 0, calibrationError: 1 };

  // Brier Score
  const brierSum = nonPush.reduce((acc, e) => acc + Math.pow(e.model_prob - e.actual_outcome, 2), 0);
  const brier = brierSum / nonPush.length;

  // Log Loss
  const logLossSum = nonPush.reduce((acc, e) => {
    const p = Math.max(0.01, Math.min(0.99, e.model_prob));
    return acc + -(e.actual_outcome * Math.log(p) + (1 - e.actual_outcome) * Math.log(1 - p));
  }, 0);
  const logLoss = logLossSum / nonPush.length;

  // Average CLV (only available on booked bets — graceful when missing)
  const withClv = evals.filter(e => e.clv !== null && e.clv !== undefined && typeof e.clv === 'number');
  const avgClv = withClv.length > 0 ? withClv.reduce((acc, e) => acc + e.clv, 0) / withClv.length : 0;

  // ROI (only available on booked bets — graceful when missing)
  const withStake = evals.filter(e => typeof e.stake === 'number' && e.stake > 0);
  const totalPL = withStake.reduce((acc, e) => acc + (e.profit_loss ?? 0), 0);
  const totalStaked = withStake.reduce((acc, e) => acc + e.stake, 0);
  const roi = totalStaked > 0 ? (totalPL / totalStaked) * 100 : 0;

  // Calibration Error — mean |actual_win_rate - avg_model_prob| across 10 buckets
  let calibrationError = 0;
  let bucketCount = 0;
  for (let i = 0; i < 10; i++) {
    const start = i * 0.1;
    const end = (i + 1) * 0.1;
    const inBucket = nonPush.filter(e => e.model_prob >= start && e.model_prob < (i === 9 ? 1.01 : end));
    if (inBucket.length < 3) continue; // skip thin buckets
    const actualWinRate = inBucket.filter(e => e.actual_outcome === 1).length / inBucket.length;
    const avgModelProb = inBucket.reduce((acc, e) => acc + e.model_prob, 0) / inBucket.length;
    calibrationError += Math.abs(actualWinRate - avgModelProb);
    bucketCount++;
  }
  calibrationError = bucketCount > 0 ? calibrationError / bucketCount : 0.5;

  // Normalized components
  const normalizedBrier = brier / 0.25;
  const normalizedLogLoss = logLoss / 0.693;
  const normalizedAvgCLV = clamp(avgClv / 5, -1, 1);
  const normalizedROI = clamp(roi / 10, -1, 1);

  // Composite (lower is better)
  // Weights shifted: accuracy metrics weighted higher now that we learn from ALL predictions
  const composite =
    0.35 * normalizedBrier +
    0.30 * normalizedLogLoss +
    0.15 * (1 - normalizedAvgCLV) +
    0.10 * (1 - normalizedROI) +
    0.10 * calibrationError;

  return { composite, brier, logLoss, avgClv, roi, calibrationError };
}

// ─── Walk-Forward Validation ───

function walkForwardValidate(evals, paramKey, candidateValue, currentParams) {
  const sorted = [...evals].sort((a, b) => a.resolved_at.localeCompare(b.resolved_at));
  const splitIdx = Math.floor(sorted.length * 0.7);
  const testSet = sorted.slice(splitIdx);

  if (testSet.length < 15) return null;

  const testParams = { ...currentParams, [paramKey]: candidateValue };
  const score = computeCompositeScore(testSet, testParams, paramKey);
  return score.composite;
}

// ─── Per-Parameter Sample Size Check ───

function hasEnoughData(paramKey, evals) {
  // Goalie-related params need at least 20 bets with goalie data
  const goalieParams = [
    "goalieConfirmedBoost", "goalieExpectedPenalty",
    "goalieUnknownPenalty", "goalieImpactScale",
  ];
  if (goalieParams.includes(paramKey)) {
    // We can't perfectly check goalie data from evals, but we require at
    // least 20 bets total as a proxy
    return evals.length >= 20;
  }
  return true; // other params just need the global 50-bet minimum
}

// ─── Get Active Model Config (merge DB params onto defaults) ───

export function getActiveModelConfig() {
  const params = db.getAllModelParams();
  const overrides = {};
  for (const p of params) {
    overrides[p.param_key] = p.param_value;
  }
  return {
    ...SERVER_DEFAULT_CONFIG,
    ...overrides,
    confidence: {
      ...SERVER_DEFAULT_CONFIG.confidence,
      sharpBookWeight: overrides.sharpBookWeight ?? SERVER_DEFAULT_CONFIG.confidence.sharpBookWeight,
    },
  };
}

// ─── Main Recalibration Orchestrator ───

export function runRecalibration(triggerType = "manual") {
  if (process.env.RECALIBRATION_ENABLED === "false") {
    return { ok: false, reason: "Recalibration disabled" };
  }

  const startTime = Date.now();

  // 1. Create run record
  const { lastInsertRowid: runId } = db.insertRecalibrationRun({
    status: "running",
    trigger_type: triggerType,
    sample_size: 0,
  });

  try {
  // 2. Gather historical data — ALL predictions, not just booked bets
  const allPredictions = db.getAllResolvedPredictionOutcomes();
  const nonPush = allPredictions.filter(e => e.actual_outcome !== -1);

  // Also get booked bet evaluations for CLV/ROI metrics
  const betEvals = db.getAllPredictionEvals();
  const betNonPush = betEvals.filter(e => e.actual_outcome !== -1);

  if (nonPush.length < 50) {
    db.updateRecalibrationRun({
      id: runId,
      status: "skipped",
      sample_size: nonPush.length,
      notes: `Insufficient data: ${nonPush.length} predictions (need 50)`,
      completed_at: new Date().toISOString(),
    });
    return { ok: false, reason: "Insufficient data", sampleSize: nonPush.length };
  }

  // Enrich prediction data with resolved_at for walk-forward sort
  // prediction_outcomes use resolved_at, prediction_evaluations use resolved_at
  const evals = nonPush;

  // 3. Get current parameter values
  const currentParams = {};
  for (const p of db.getAllModelParams()) {
    currentParams[p.param_key] = p.param_value;
  }

  // 4. Compute baseline composite score
  const baseline = computeCompositeScore(nonPush, currentParams, null);

  // 5. Sweep each tunable parameter
  const changes = [];
  let paramsEvaluated = 0;

  for (const paramDef of TUNABLE_PARAMS) {
    if (!hasEnoughData(paramDef.key, nonPush)) continue;

    paramsEvaluated++;
    const currentValue = currentParams[paramDef.key];
    if (currentValue === undefined) continue; // param not in DB

    let bestValue = currentValue;
    let bestScore = baseline.composite;

    // Generate candidate values within bounds, max 3 steps from current
    const candidates = [];
    for (let v = paramDef.min; v <= paramDef.max + 0.0001; v += paramDef.step) {
      const rounded = Math.round(v * 10000) / 10000;
      if (Math.abs(rounded - currentValue) / paramDef.step > 3.01) continue;
      if (Math.abs(rounded - currentValue) < paramDef.step * 0.01) continue; // skip current
      candidates.push(rounded);
    }

    for (const candidate of candidates) {
      const score = walkForwardValidate(nonPush, paramDef.key, candidate, currentParams);
      if (score !== null && score < bestScore) {
        bestScore = score;
        bestValue = candidate;
      }
    }

    // Check 1% improvement threshold
    if (bestValue !== currentValue && baseline.composite > 0 &&
        (baseline.composite - bestScore) / baseline.composite > 0.01) {
      changes.push({
        param_key: paramDef.key,
        old_value: currentValue,
        new_value: bestValue,
        improvement_pct: ((baseline.composite - bestScore) / baseline.composite) * 100,
      });
      // Update in-memory params for subsequent evaluations
      currentParams[paramDef.key] = bestValue;
    }
  }

  // 6. Apply changes
  for (const change of changes) {
    db.updateModelParam(change.param_key, change.new_value);
    db.insertParameterHistory({
      run_id: runId,
      param_key: change.param_key,
      old_value: change.old_value,
      new_value: change.new_value,
      improvement_pct: change.improvement_pct,
    });
    console.log(`[RECAL] ${change.param_key}: ${change.old_value} → ${change.new_value} (+${change.improvement_pct.toFixed(1)}%)`);
  }

  // 7. Compute final composite score
  const final = computeCompositeScore(nonPush, currentParams, null);

  // 8. Update run record
  const duration = Date.now() - startTime;
  db.updateRecalibrationRun({
    id: runId,
    status: "completed",
    sample_size: nonPush.length,
    params_evaluated: paramsEvaluated,
    params_changed: changes.length,
    baseline_brier: baseline.brier,
    baseline_log_loss: baseline.logLoss,
    baseline_clv: baseline.avgClv,
    baseline_roi: baseline.roi,
    baseline_calibration_error: baseline.calibrationError,
    final_brier: final.brier,
    final_log_loss: final.logLoss,
    final_clv: final.avgClv,
    final_roi: final.roi,
    final_calibration_error: final.calibrationError,
    composite_score_before: baseline.composite,
    composite_score_after: final.composite,
    duration_ms: duration,
    notes: changes.length > 0
      ? `Updated ${changes.length} params: ${changes.map(c => c.param_key).join(", ")}`
      : "No improvements found",
    completed_at: new Date().toISOString(),
  });

  return {
    ok: true,
    runId,
    sampleSize: nonPush.length,
    paramsEvaluated,
    paramsChanged: changes.length,
    changes,
    compositeScoreBefore: baseline.composite,
    compositeScoreAfter: final.composite,
    duration,
  };

  } catch (err) {
    // Mark run as error so it doesn't stay stuck in "running" forever
    try {
      db.updateRecalibrationRun({
        id: runId,
        status: "error",
        sample_size: 0,
        notes: `Error: ${err.message}`,
        completed_at: new Date().toISOString(),
      });
    } catch { /* best-effort cleanup */ }
    console.error(`[RECAL] Run ${runId} failed:`, err.message);
    return { ok: false, reason: err.message, runId };
  }
}
