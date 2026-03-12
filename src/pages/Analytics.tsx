import { useState, useEffect } from "react";
import type {
  ModelMetrics,
  CalibrationBucket,
  EdgeBucket,
  ConfidenceBreakdown,
  MarketBreakdown,
  DailyMetric,
  SportsbookMetric,
  GoalieConfirmation,
} from "../lib/types";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// ─── Helpers ───

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(decimals);
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

function fmtPctRaw(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(decimals)}%`;
}

function plColor(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-[#737373]";
}

function brierColor(n: number | null): string {
  if (n === null) return "text-[#737373]";
  if (n < 0.2) return "text-emerald-400";
  if (n < 0.25) return "text-yellow-400";
  return "text-red-400";
}

const gradeColor: Record<string, string> = {
  A: "text-emerald-400",
  B: "text-cyan-400",
  C: "text-yellow-400",
  D: "text-red-400",
};

// ─── Component ───

export default function Analytics() {
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<ModelMetrics | null>(null);
  const [byMarket, setByMarket] = useState<Record<string, ModelMetrics>>({});
  const [calibration, setCalibration] = useState<CalibrationBucket[]>([]);
  const [edgeData, setEdgeData] = useState<EdgeBucket[]>([]);
  const [confidenceData, setConfidenceData] = useState<ConfidenceBreakdown[]>([]);
  const [dailyData, setDailyData] = useState<DailyMetric[]>([]);
  const [sbMetrics, setSbMetrics] = useState<SportsbookMetric[]>([]);
  const [goalieConfs, setGoalieConfs] = useState<(GoalieConfirmation & { gameDate: string })[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Trigger evaluation + sportsbook analysis first
      await Promise.all([
        fetch(`${API_BASE}/api/evaluation/run`, { method: "POST" }).catch(() => {}),
        fetch(`${API_BASE}/api/sportsbook/analyze`, { method: "POST" }).catch(() => {}),
      ]);

      // Fetch all data in parallel
      const [metricsRes, calRes, edgeRes, confRes, dailyRes, sbRes] = await Promise.all([
        fetch(`${API_BASE}/api/evaluation/metrics`).then(r => r.json()).catch(() => null),
        fetch(`${API_BASE}/api/evaluation/calibration`).then(r => r.json()).catch(() => []),
        fetch(`${API_BASE}/api/evaluation/edge-analysis`).then(r => r.json()).catch(() => []),
        fetch(`${API_BASE}/api/evaluation/confidence-analysis`).then(r => r.json()).catch(() => []),
        fetch(`${API_BASE}/api/evaluation/daily?limit=30`).then(r => r.json()).catch(() => []),
        fetch(`${API_BASE}/api/sportsbook/metrics`).then(r => r.json()).catch(() => ({ metrics: [] })),
      ]);

      if (cancelled) return;

      if (metricsRes) {
        setMetrics(metricsRes.overall);
        setByMarket(metricsRes.byMarket || {});
      }

      // Map calibration snake_case to camelCase
      setCalibration(
        (calRes || []).map((b: Record<string, unknown>) => ({
          bucketLabel: b.bucket_label,
          bucketStart: b.bucket_start,
          bucketEnd: b.bucket_end,
          totalPredictions: b.total_predictions,
          totalWins: b.total_wins,
          actualWinRate: b.actual_win_rate,
          avgModelProb: b.avg_model_prob,
          avgEdge: b.avg_edge,
          totalProfit: b.total_profit,
          roiPct: b.roi_pct,
        }))
      );

      setEdgeData(edgeRes || []);
      setConfidenceData(confRes || []);

      // Map daily snake_case to camelCase
      setDailyData(
        (dailyRes || []).map((d: Record<string, unknown>) => ({
          date: d.metric_date,
          totalEvaluated: d.total_evaluated,
          wins: Math.round(((d.win_rate as number) || 0) * ((d.total_evaluated as number) || 0)),
          losses: (d.total_evaluated as number) - Math.round(((d.win_rate as number) || 0) * ((d.total_evaluated as number) || 0)),
          profitLoss: d.total_profit,
          brierScore: d.brier_score,
          cumulativeRoi: d.cumulative_roi,
        }))
      );

      // Map sportsbook metrics snake_case to camelCase
      setSbMetrics(
        ((sbRes?.metrics) || []).map((m: Record<string, unknown>) => ({
          book: m.book as string,
          sharpnessRank: m.sharpness_rank as number,
          priceEfficiencyScore: m.price_efficiency_score as number,
          firstMoverFreq: m.first_mover_freq as number,
          avgTimeToMove: m.avg_time_to_move as number | null,
          avgDistanceFromClose: m.avg_distance_from_close as number | null,
          avgClv: m.avg_clv as number | null,
          outlierFreq: m.outlier_freq as number,
        }))
      );

      // Fetch goalie confirmations (non-blocking)
      fetch(`${API_BASE}/api/goalie-confirmations`)
        .then(r => r.json())
        .then(data => { if (!cancelled) setGoalieConfs(data || []); })
        .catch(() => {});

      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#737373] text-sm">
        Evaluating model...
      </div>
    );
  }

  const BOOK_NAMES: Record<string, string> = {
    draftkings: "DK", fanduel: "FD", betmgm: "MGM", caesars: "CZR", pointsbetus: "PB", fanatics: "FAN",
  };

  const hasEvalData = metrics && metrics.totalEvaluated > 0;

  if (!hasEvalData && sbMetrics.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-[#737373] text-sm">
        No resolved bets to evaluate yet.
      </div>
    );
  }

  const marketEntries: MarketBreakdown[] = Object.entries(byMarket).map(([market, m]) => ({
    market,
    count: m.totalEvaluated,
    winRate: m.winRate,
    roi: m.roiPct,
    brierScore: m.brierScore,
    avgClv: m.avgClv,
  }));

  const recentDaily = dailyData.slice(0, 7);

  return (
    <div className="px-4 py-4 space-y-4 max-w-3xl mx-auto">
      {hasEvalData && metrics && (
        <>
          {/* 1. Summary Cards */}
          <div className="flex gap-3 overflow-x-auto pb-1">
            <SummaryCard label="Brier Score" value={fmt(metrics.brierScore, 4)} color={brierColor(metrics.brierScore)} />
            <SummaryCard label="Log Loss" value={fmt(metrics.logLoss, 4)} color="text-[#ededed]" />
            <SummaryCard label="ROI" value={fmtPctRaw(metrics.roiPct)} color={plColor(metrics.roiPct)} />
            <SummaryCard label="Win Rate" value={fmtPct(metrics.winRate)} color={metrics.winRate > 0.5 ? "text-emerald-400" : "text-[#ededed]"} />
          </div>

          {/* 2. Record & P/L Strip */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-xs font-mono">
            <span className="text-[#ededed]">{metrics.wins}W-{metrics.losses}L-{metrics.pushes}P</span>
            <span className={plColor(metrics.totalPL)}>P/L ${fmt(metrics.totalPL)}</span>
            <span className="text-[#737373]">Edge {fmtPct(metrics.avgEdge)}</span>
            <span className="text-[#737373]">CLV {metrics.avgClv !== null ? fmt(metrics.avgClv, 1) : "—"}</span>
            <span className="text-[#737373]">{metrics.totalEvaluated} bets</span>
          </div>

          {/* 3. Calibration Table */}
          {calibration.length > 0 && (
            <Section title="Calibration">
              <Table
                cols={["Bucket", "Predicted", "Actual", "Count", "ROI"]}
                rows={calibration.map(b => [
                  b.bucketLabel,
                  fmtPct(b.avgModelProb),
                  <span className={b.actualWinRate > b.avgModelProb ? "text-emerald-400" : b.actualWinRate < b.avgModelProb ? "text-red-400" : ""}>
                    {fmtPct(b.actualWinRate)}
                  </span>,
                  String(b.totalPredictions),
                  <span className={plColor(b.roiPct)}>{fmtPctRaw(b.roiPct)}</span>,
                ])}
              />
            </Section>
          )}

          {/* 4. Edge Performance */}
          {edgeData.some(e => e.count > 0) && (
            <Section title="Edge Performance">
              <Table
                cols={["Edge Range", "Count", "Win Rate", "ROI", "Avg P/L"]}
                rows={edgeData.filter(e => e.count > 0).map(e => [
                  e.range,
                  String(e.count),
                  fmtPct(e.winRate),
                  <span className={plColor(e.roi)}>{fmtPctRaw(e.roi)}</span>,
                  <span className={plColor(e.avgProfit)}>${fmt(e.avgProfit)}</span>,
                ])}
              />
            </Section>
          )}

          {/* 5. Confidence Grade Breakdown */}
          {confidenceData.some(c => c.count > 0) && (
            <Section title="Confidence Grades">
              <Table
                cols={["Grade", "Count", "Win Rate", "ROI", "Avg Edge", "Brier"]}
                rows={confidenceData.filter(c => c.count > 0).map(c => [
                  <span className={`font-semibold ${gradeColor[c.grade] || ""}`}>{c.grade}</span>,
                  String(c.count),
                  fmtPct(c.winRate),
                  <span className={plColor(c.roi)}>{fmtPctRaw(c.roi)}</span>,
                  fmtPct(c.avgEdge),
                  fmt(c.brierScore, 4),
                ])}
              />
            </Section>
          )}

          {/* 6. Market Breakdown */}
          {marketEntries.length > 0 && (
            <Section title="Markets">
              <Table
                cols={["Market", "Count", "Win Rate", "ROI", "Brier", "Avg CLV"]}
                rows={marketEntries.map(m => [
                  m.market.toUpperCase(),
                  String(m.count),
                  fmtPct(m.winRate),
                  <span className={plColor(m.roi)}>{fmtPctRaw(m.roi)}</span>,
                  fmt(m.brierScore, 4),
                  m.avgClv !== null ? fmt(m.avgClv, 1) : "—",
                ])}
              />
            </Section>
          )}

          {/* 7. Daily Trend */}
          {recentDaily.length >= 3 && (
            <Section title="Daily Trend">
              <Table
                cols={["Date", "Bets", "W-L", "P/L", "Brier"]}
                rows={recentDaily.map(d => [
                  d.date,
                  String(d.totalEvaluated),
                  `${d.wins}-${d.losses}`,
                  <span className={plColor(d.profitLoss as number)}>${fmt(d.profitLoss as number)}</span>,
                  fmt(d.brierScore, 4),
                ])}
              />
            </Section>
          )}
        </>
      )}

      {/* 8. Sportsbook Sharpness */}
      {sbMetrics.length > 0 && (
        <Section title="Sportsbook Sharpness">
          <Table
            cols={["Rank", "Book", "Sharpness", "1st Mover", "CLV", "Outlier"]}
            rows={sbMetrics.map(m => {
              const scoreColor = m.priceEfficiencyScore > 70 ? "text-emerald-400"
                : m.priceEfficiencyScore > 50 ? "text-cyan-400"
                : m.priceEfficiencyScore > 30 ? "text-yellow-400"
                : "text-red-400";
              return [
                String(m.sharpnessRank),
                BOOK_NAMES[m.book] || m.book,
                <span className={scoreColor}>{fmt(m.priceEfficiencyScore, 1)}</span>,
                fmtPct(m.firstMoverFreq),
                m.avgClv !== null ? <span className={plColor(m.avgClv)}>{fmt(m.avgClv, 1)}</span> : "—",
                fmtPct(m.outlierFreq),
              ];
            })}
          />
        </Section>
      )}

      {/* 9. Goalie Status */}
      {goalieConfs.length > 0 && (
        <Section title="Goalie Status">
          <Table
            cols={["Team", "Goalie", "Status", "Source"]}
            rows={goalieConfs.map(g => {
              const badge = g.status === "confirmed"
                ? "bg-emerald-500/20 text-emerald-400"
                : g.status === "expected"
                ? "bg-yellow-500/20 text-yellow-400"
                : "bg-white/10 text-[#737373]";
              return [
                g.team,
                g.goalieName,
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${badge}`}>
                  {g.status.toUpperCase()}
                </span>,
                g.source || "—",
              ];
            })}
          />
        </Section>
      )}
    </div>
  );
}

// ─── Sub-components ───

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex-shrink-0 min-w-[120px] px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08]">
      <div className={`text-lg font-mono font-semibold ${color}`}>{value}</div>
      <div className="text-[10px] text-[#737373] mt-0.5">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-[#737373] uppercase tracking-wider mb-2">{title}</h3>
      {children}
    </div>
  );
}

function Table({ cols, rows }: { cols: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/[0.08]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/[0.08]">
            {cols.map((c, i) => (
              <th key={i} className="px-3 py-2 text-left text-[#737373] font-medium">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-white/[0.04] last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-1.5 text-[#ededed] font-mono">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
