import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { EvBet, MarketFilter, SortBy, DayFilter } from "@/lib/types";
import { format as fmtDate, startOfDay, isToday, isTomorrow } from "date-fns";
import type { MovementDir } from "@/lib/movement";
import { runPipeline } from "@/lib/engine";
import { placeBet, unplaceBet, isBetTracked } from "@/lib/store";
import { recordSnapshot, getMovementMap } from "@/lib/movement";
import { requestNotifPermission, seedNotified, notifyNewAGrades } from "@/lib/notify";
import { useSettings } from "@/lib/settings";
import BetRow from "@/components/BetRow";

export default function Board() {
  const { sport } = useSettings();
  const [bets, setBets] = useState<EvBet[]>([]);
  const [movements, setMovements] = useState<Map<string, MovementDir>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("edge");
  const [showAll, setShowAll] = useState(false);
  const [dayFilter, setDayFilter] = useState<DayFilter>("all");
  const firstLoad = useRef(true);

  // Request notification permission once
  useEffect(() => { requestNotifPermission(); }, []);

  // Hydrate placed state from IndexedDB after pipeline loads
  const hydrateTracked = useCallback(async (evBets: EvBet[]) => {
    const hydrated = await Promise.all(
      evBets.map(async b => ({
        ...b,
        placed: await isBetTracked(b.gameId, b.outcome, b.bestBook),
      }))
    );
    return hydrated;
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const result = await runPipeline(sport);

      // Line movement: record snapshot + compute directions
      recordSnapshot(result);
      setMovements(getMovementMap(result));

      // Notifications: seed on first load, notify on subsequent
      if (firstLoad.current) {
        seedNotified(result);
        firstLoad.current = false;
      } else {
        notifyNewAGrades(result);
      }

      const hydrated = await hydrateTracked(result);
      setBets(hydrated);
      setLastSync(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
    } catch (e: any) {
      setError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [hydrateTracked, sport]);

  useEffect(() => {
    setLoading(true);
    firstLoad.current = true;
    refresh();
    const interval = setInterval(refresh, 5 * 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const togglePlaced = async (id: string) => {
    const bet = bets.find(b => b.id === id);
    if (!bet) return;

    if (bet.placed) {
      await unplaceBet(bet.gameId, bet.outcome, bet.bestBook);
    } else {
      await placeBet(bet);
    }

    setBets(prev => prev.map(b => b.id === id ? { ...b, placed: !b.placed } : b));
  };

  // Extract unique game days from bets
  const dayTabs = useMemo(() => {
    const daySet = new Map<string, Date>();
    for (const b of bets) {
      const d = startOfDay(new Date(b.gameTime));
      const key = fmtDate(d, "yyyy-MM-dd");
      if (!daySet.has(key)) daySet.set(key, d);
    }
    const sorted = [...daySet.entries()].sort(([a], [b]) => a.localeCompare(b));
    return sorted.map(([key, d]) => ({
      key,
      label: isToday(d) ? "Today" : isTomorrow(d) ? "Tmrw" : fmtDate(d, "EEE M/d"),
    }));
  }, [bets]);

  let filtered = bets;
  if (dayFilter !== "all") filtered = filtered.filter(b => fmtDate(startOfDay(new Date(b.gameTime)), "yyyy-MM-dd") === dayFilter);
  if (marketFilter !== "all") filtered = filtered.filter(b => b.market === marketFilter);
  if (!showAll) filtered = filtered.filter(b => b.confidenceGrade === "A" || b.confidenceGrade === "B");
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === "edge") return b.edge - a.edge;
    if (sortBy === "confidence") return b.confidenceScore - a.confidenceScore;
    return new Date(a.gameTime).getTime() - new Date(b.gameTime).getTime();
  });

  const plLabel = sport === "nhl" ? "PL" : "Sprd";
  const filters: { key: MarketFilter; label: string }[] = [
    { key: "all", label: "All" }, { key: "ml", label: "ML" }, { key: "pl", label: plLabel }, { key: "totals", label: "O/U" },
  ];
  const sorts: { key: SortBy; label: string }[] = [
    { key: "edge", label: "Edge" }, { key: "confidence", label: "Conf" }, { key: "gameTime", label: "Time" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Day tabs */}
      {dayTabs.length > 1 && (
        <div className="flex items-center gap-1 px-4 py-2 border-b border-white/[0.04] overflow-x-auto scrollbar-hide">
          <button onClick={() => setDayFilter("all")}
            className={`px-2.5 py-1 text-[11px] font-medium rounded whitespace-nowrap transition-colors ${dayFilter === "all" ? "bg-emerald-500/20 text-emerald-400" : "text-[#737373] hover:text-[#ededed]"}`}
          >All Days</button>
          {dayTabs.map(d => (
            <button key={d.key} onClick={() => setDayFilter(d.key)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded whitespace-nowrap transition-colors ${dayFilter === d.key ? "bg-emerald-500/20 text-emerald-400" : "text-[#737373] hover:text-[#ededed]"}`}
            >{d.label}</button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-white/[0.04]">
        <div className="flex items-center gap-1">
          {filters.map(f => (
            <button key={f.key} onClick={() => setMarketFilter(f.key)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${marketFilter === f.key ? "bg-white/10 text-[#ededed]" : "text-[#737373] hover:text-[#ededed]"}`}
            >{f.label}</button>
          ))}
          <div className="w-px h-4 bg-white/[0.08] mx-1" />
          <button onClick={() => setShowAll(!showAll)}
            className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${showAll ? "bg-white/10 text-[#ededed]" : "text-[#737373] hover:text-[#ededed]"}`}
          >{showAll ? "All" : "A+B"}</button>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {sorts.map(s => (
              <button key={s.key} onClick={() => setSortBy(s.key)}
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${sortBy === s.key ? "bg-white/10 text-[#ededed]" : "text-[#737373] hover:text-[#ededed]"}`}
              >{s.label}</button>
            ))}
          </div>
          {lastSync && <span className="text-[10px] text-[#737373] font-mono hidden sm:block">sync {lastSync}</span>}
        </div>
      </div>

      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-medium text-[#737373] uppercase tracking-wider border-b border-white/[0.03] sm:gap-3 sm:px-4 max-w-3xl">
        <div className="w-8 flex-shrink-0">Conf</div>
        <div className="hidden sm:block w-14 flex-shrink-0">Time</div>
        <div className="w-20 sm:w-24 flex-shrink-0">Game</div>
        <div className="flex-1 min-w-0">Market</div>
        <div className="hidden sm:block w-10 flex-shrink-0">Book</div>
        <div className="w-16 flex-shrink-0 text-right">Odds</div>
        <div className="w-14 flex-shrink-0 text-right">Edge</div>
        <div className="w-6 flex-shrink-0" />
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-sm text-[#737373]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span>Loading live odds...</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-sm text-red-400">
            <span>{error}</span>
            <button onClick={refresh} className="text-xs text-emerald-500 hover:underline">Retry</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-[#737373]">No EV+ bets found right now.</div>
        ) : (
          filtered.map(bet => (
            <BetRow
              key={bet.id}
              bet={bet}
              movement={movements.get(bet.id) ?? "flat"}
              onToggle={() => togglePlaced(bet.id)}
            />
          ))
        )}
      </div>

      {/* Footer */}
      {!loading && filtered.length > 0 && (
        <div className="px-4 py-1.5 border-t border-white/[0.04] text-[10px] text-[#737373] font-mono">
          {filtered.length} bet{filtered.length !== 1 ? "s" : ""} · {filtered.filter(b => b.placed).length} placed
        </div>
      )}
    </div>
  );
}
