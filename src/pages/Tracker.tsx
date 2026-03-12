import { useState, useEffect, useMemo, useCallback } from "react";
import type { TrackedBet, TimeFilter } from "@/lib/types";
import { getAllBets, computeSummary, deleteBet } from "@/lib/store";
import { resolveAllPending, captureClosingOdds } from "@/lib/resolver";
import { useSettings, fmtOdds as formatOdds } from "@/lib/settings";
import ConfidenceBadge from "@/components/ConfidenceBadge";
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;
};

export default function Tracker() {
  const [bets, setBets] = useState<TrackedBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [days, setDays] = useState<TimeFilter>(30);

  const loadBets = useCallback(async () => {
    const all = await getAllBets();
    // Sort: pending first (by game time), then resolved (by resolved time desc)
    all.sort((a, b) => {
      if (a.result === "pending" && b.result !== "pending") return -1;
      if (a.result !== "pending" && b.result === "pending") return 1;
      if (a.result === "pending" && b.result === "pending") {
        return new Date(a.gameTime).getTime() - new Date(b.gameTime).getTime();
      }
      return new Date(b.resolvedAt ?? b.placedAt).getTime() - new Date(a.resolvedAt ?? a.placedAt).getTime();
    });
    setBets(all);
    setLoading(false);
  }, []);

  // Auto-resolve on mount and every 5 minutes
  useEffect(() => {
    let mounted = true;
    const resolve = async () => {
      if (!mounted) return;
      setResolving(true);
      try {
        await captureClosingOdds();
        const n = await resolveAllPending();
        if (n > 0) await loadBets();
      } catch (e) {
        console.warn("[resolver]", e);
      } finally {
        if (mounted) setResolving(false);
      }
    };

    loadBets().then(resolve);
    const interval = setInterval(resolve, 5 * 60_000);
    return () => { mounted = false; clearInterval(interval); };
  }, [loadBets]);

  // Filter by time window
  const filtered = useMemo(() => {
    if (days === 9999) return bets;
    const cutoff = Date.now() - days * 24 * 3600_000;
    return bets.filter(b => new Date(b.placedAt).getTime() >= cutoff);
  }, [bets, days]);

  const summary = useMemo(() => computeSummary(filtered), [filtered]);

  const handleDelete = async (id: string) => {
    await deleteBet(id);
    await loadBets();
  };

  const periods: { value: TimeFilter; label: string }[] = [
    { value: 7, label: "7d" }, { value: 14, label: "14d" },
    { value: 30, label: "30d" }, { value: 9999, label: "All" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Summary */}
      <div className="px-4 py-3 border-b border-white/[0.04]">
        {filtered.length === 0 && !loading ? (
          <div className="text-xs text-[#737373]">No tracked bets yet. Tap the checkmark on the Board to track a bet.</div>
        ) : (
          <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
            <Stat label="Record" value={summary.record || "0-0"} />
            <Stat label="ROI" value={`${summary.roiPct > 0 ? "+" : ""}${summary.roiPct}%`} color={summary.roiPct >= 0 ? "text-emerald-400" : "text-red-400"} />
            <Stat label="P/L" value={`${summary.totalPL >= 0 ? "+" : ""}$${summary.totalPL}`} color={summary.totalPL >= 0 ? "text-emerald-400" : "text-red-400"} />
            <Stat label="Brier" value={summary.brierScore.toFixed(3)} />
            <Stat label="Win%" value={`${summary.winRate}%`} />
            {summary.avgCLV !== null && <Stat label="CLV" value={`${summary.avgCLV > 0 ? "+" : ""}${summary.avgCLV}%`} color={summary.avgCLV >= 0 ? "text-emerald-400" : "text-red-400"} />}
            <Stat label="Edge" value={`+${(summary.avgEdge * 100).toFixed(1)}%`} />
            {summary.pending > 0 && <Stat label="Pending" value={String(summary.pending)} />}
          </div>
        )}
      </div>

      {/* Period filter + resolve indicator */}
      <div className="flex items-center justify-between gap-1 px-4 py-2 border-b border-white/[0.03]">
        <div className="flex items-center gap-1">
          {periods.map(p => (
            <button key={p.value} onClick={() => setDays(p.value)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${days === p.value ? "bg-white/10 text-[#ededed]" : "text-[#737373] hover:text-[#ededed]"}`}
            >{p.label}</button>
          ))}
        </div>
        {resolving && (
          <div className="flex items-center gap-1.5 text-[10px] text-[#737373]">
            <div className="w-3 h-3 border border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span>resolving...</span>
          </div>
        )}
      </div>

      {/* Column header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-[#737373] uppercase tracking-wider border-b border-white/[0.03] sm:gap-2 sm:px-4 max-w-4xl">
        <div className="w-10 flex-shrink-0">Date</div>
        <div className="hidden sm:block w-8 flex-shrink-0">Conf</div>
        <div className="w-[4.5rem] sm:w-24 flex-shrink-0">Game</div>
        <div className="flex-1 min-w-[3rem]">Pick</div>
        <div className="hidden sm:block w-12 flex-shrink-0 text-right">Odds</div>
        <div className="w-11 sm:w-12 flex-shrink-0 text-right">Edge</div>
        <div className="hidden sm:block w-12 flex-shrink-0 text-right">CLV</div>
        <div className="w-6 sm:w-8 flex-shrink-0 text-center">W/L</div>
        <div className="w-14 sm:w-16 flex-shrink-0 text-right">P/L</div>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-sm text-[#737373]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span>Loading tracked bets...</span>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-[#737373]">No bets in this period.</div>
        ) : (
          filtered.map(b => <TrackerRow key={b.id} bet={b} onDelete={() => handleDelete(b.id)} />)
        )}
      </div>

      {/* Footer */}
      {!loading && filtered.length > 0 && (
        <div className="px-4 py-1.5 border-t border-white/[0.04] text-[10px] text-[#737373] font-mono">
          {summary.totalBets} resolved · {summary.pending} pending
        </div>
      )}
    </div>
  );
}

// ─── Tracker Row (expandable) ───

function TrackerRow({ bet, onDelete }: { bet: TrackedBet; onDelete: () => void }) {
  const { oddsFormat } = useSettings();
  const fmtOdds = (p: number) => formatOdds(p, oddsFormat);
  const [open, setOpen] = useState(false);
  const isPending = bet.result === "pending";

  const resultBadge = isPending
    ? "bg-zinc-500/15 text-zinc-400"
    : bet.result === "win"
      ? "bg-emerald-500/15 text-emerald-400"
      : bet.result === "loss"
        ? "bg-red-500/15 text-red-400"
        : "bg-amber-500/15 text-amber-400";

  const resultLabel = isPending ? "..." : bet.result === "win" ? "W" : bet.result === "loss" ? "L" : "P";

  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-3 py-2 text-xs border-b border-white/[0.03] cursor-pointer hover:bg-zinc-900/50 transition-colors sm:gap-2 sm:px-4 max-w-4xl"
        onClick={() => setOpen(!open)}
      >
        <div className="w-10 flex-shrink-0 text-[#737373] font-mono">{fmtDate(bet.gameTime)}</div>
        <div className="hidden sm:block w-8 flex-shrink-0"><ConfidenceBadge grade={bet.confidenceGrade} /></div>
        <div className="w-[4.5rem] sm:w-24 flex-shrink-0 font-medium truncate text-[#ededed]">{bet.awayTeam} @ {bet.homeTeam}</div>
        <div className="flex-1 min-w-[3rem] text-[#ededed]/90 truncate">{bet.outcome}</div>
        <div className="hidden sm:block w-12 flex-shrink-0 text-right font-mono text-[#737373]">{fmtOdds(bet.oddsAtPick)}</div>
        <div className="w-11 sm:w-12 flex-shrink-0 text-right font-mono text-emerald-600">+{(bet.edge * 100).toFixed(1)}%</div>
        <div className={`hidden sm:block w-12 flex-shrink-0 text-right font-mono ${
          bet.clv === null ? "text-[#737373]" : bet.clv > 0 ? "text-emerald-400" : bet.clv < 0 ? "text-red-400" : "text-[#737373]"
        }`}>
          {bet.clv !== null ? `${bet.clv > 0 ? "+" : ""}${bet.clv.toFixed(1)}%` : "—"}
        </div>
        <div className="w-6 sm:w-8 flex-shrink-0 text-center">
          <span className={`inline-block w-5 h-5 leading-5 rounded text-[10px] font-bold ${resultBadge}`}>{resultLabel}</span>
        </div>
        <div className={`w-14 sm:w-16 flex-shrink-0 text-right font-mono font-medium ${
          isPending ? "text-[#737373]" : bet.profitLoss > 0 ? "text-emerald-400" : bet.profitLoss < 0 ? "text-red-400" : "text-[#737373]"
        }`}>
          {isPending ? "—" : `${bet.profitLoss > 0 ? "+" : ""}$${bet.profitLoss}`}
        </div>
      </div>

      {open && (
        <div className="px-4 py-3 bg-zinc-900/30 border-b border-white/[0.04] sm:px-6 max-w-4xl">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 text-xs">
            <div><span className="text-[#737373]">Model</span><span className="ml-2 font-mono text-[#ededed]">{(bet.modelProb * 100).toFixed(1)}%</span></div>
            <div><span className="text-[#737373]">Fair</span><span className="ml-2 font-mono text-[#ededed]">{(bet.fairProb * 100).toFixed(1)}%</span></div>
            <div><span className="text-[#737373]">Implied</span><span className="ml-2 font-mono text-[#ededed]">{(bet.impliedProb * 100).toFixed(1)}%</span></div>
            <div><span className="text-[#737373]">EV</span><span className="ml-2 font-mono text-emerald-400">+{(bet.ev * 100).toFixed(1)}%</span></div>
            <div><span className="text-[#737373]">Kelly</span><span className="ml-2 font-mono text-[#ededed]">{(bet.kellyFraction * 100).toFixed(1)}%</span></div>
            <div><span className="text-[#737373]">Stake</span><span className="ml-2 font-mono text-[#ededed]">${bet.stake}</span></div>
            <div><span className="text-[#737373]">Book</span><span className="ml-2 font-mono text-[#ededed]">{bet.bestBook}</span></div>
            <div><span className="text-[#737373]">Conf</span><span className="ml-2 font-mono text-[#ededed]">{bet.confidenceScore.toFixed(0)}</span></div>
            {bet.homeScore !== null && (
              <div><span className="text-[#737373]">Score</span><span className="ml-2 font-mono text-[#ededed]">{bet.awayTeam} {bet.awayScore} - {bet.homeTeam} {bet.homeScore}{bet.periodType && bet.periodType !== "REG" ? ` (${bet.periodType})` : ""}</span></div>
            )}
            {bet.closingOdds !== null && (
              <div><span className="text-[#737373]">Close</span><span className="ml-2 font-mono text-[#ededed]">{fmtOdds(bet.closingOdds)}</span></div>
            )}
            {bet.clv !== null && (
              <div><span className="text-[#737373]">CLV</span><span className={`ml-2 font-mono ${bet.clv >= 0 ? "text-emerald-400" : "text-red-400"}`}>{bet.clv > 0 ? "+" : ""}{bet.clv.toFixed(1)}%</span></div>
            )}
          </div>
          {isPending && (
            <button
              onClick={e => { e.stopPropagation(); onDelete(); }}
              className="mt-3 px-3 py-1 text-[11px] text-red-400 bg-red-500/10 rounded hover:bg-red-500/20 transition-colors"
            >Remove bet</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Stat Cell ───

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-[#737373]">{label}</span>
      <span className={`text-sm font-mono font-semibold ${color ?? "text-[#ededed]"}`}>{value}</span>
    </div>
  );
}
