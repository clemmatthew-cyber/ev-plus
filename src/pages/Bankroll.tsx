import { useState, useEffect, useMemo, useRef } from "react";
import type { TrackedBet } from "@/lib/types";
import { getAllBets } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  ReferenceLine,
} from "recharts";



// ─── Aggregate bets by calendar date ───

interface DayBucket {
  date: string;          // "MM/DD"
  dateKey: string;       // "YYYY-MM-DD" for sorting
  pnl: number;
  risked: number;
  won: number;
  betsResolved: number;
}

function bucketByDay(bets: TrackedBet[]): DayBucket[] {
  const resolved = bets.filter(b => b.result !== "pending" && b.resolvedAt);
  const map = new Map<string, DayBucket>();

  for (const b of resolved) {
    const d = new Date(b.resolvedAt!);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const date = `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;

    let bucket = map.get(dateKey);
    if (!bucket) {
      bucket = { date, dateKey, pnl: 0, risked: 0, won: 0, betsResolved: 0 };
      map.set(dateKey, bucket);
    }
    bucket.pnl += b.profitLoss;
    bucket.risked += b.stake;
    if (b.result === "win") bucket.won += b.profitLoss + b.stake;
    bucket.betsResolved++;
  }

  return [...map.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

// ─── Build running balance series ───

interface BalancePoint {
  date: string;
  balance: number;
}

function buildBalanceSeries(days: DayBucket[]): BalancePoint[] {
  let balance = STARTING_BANKROLL;
  const pts: BalancePoint[] = [{ date: "Start", balance }];
  for (const d of days) {
    balance += d.pnl;
    pts.push({ date: d.date, balance: Math.round(balance * 100) / 100 });
  }
  return pts;
}

// ─── Custom tooltip ───

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-white/10 rounded px-3 py-2 text-xs shadow-xl">
      <div className="text-[#737373] mb-1">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="font-mono text-[#ededed]">
          <span className="text-[#737373] mr-1.5">{p.name}:</span>
          {typeof p.value === "number" ? (
            <span className={p.value >= 0 ? "text-emerald-400" : "text-red-400"}>
              {p.value >= 0 ? "+" : ""}${p.value.toFixed(2)}
            </span>
          ) : (
            p.value
          )}
        </div>
      ))}
    </div>
  );
}

export default function Bankroll() {
  const { bankroll: STARTING_BANKROLL, setBankroll } = useSettings();
  const [bets, setBets] = useState<TrackedBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getAllBets().then(all => {
      setBets(all);
      setLoading(false);
    });
  }, []);

  const handleEditStart = () => {
    setEditValue(String(STARTING_BANKROLL));
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleSave = async () => {
    const val = parseFloat(editValue);
    if (!isNaN(val) && val >= 0) {
      await setBankroll(val);
    }
    setEditing(false);
  };

  const days = useMemo(() => bucketByDay(bets), [bets]);
  const balanceSeries = useMemo(() => buildBalanceSeries(days), [days]);

  const resolved = bets.filter(b => b.result !== "pending");
  const totalPL = resolved.reduce((s, b) => s + b.profitLoss, 0);
  const totalRisked = resolved.reduce((s, b) => s + b.stake, 0);
  const totalWon = resolved.filter(b => b.result === "win").reduce((s, b) => s + b.profitLoss + b.stake, 0);
  const currentBalance = STARTING_BANKROLL + totalPL;

  // Drawdown: distance from peak balance
  let peak = STARTING_BANKROLL;
  let maxDrawdown = 0;
  let runningBal = STARTING_BANKROLL;
  for (const d of days) {
    runningBal += d.pnl;
    if (runningBal > peak) peak = runningBal;
    const dd = (peak - runningBal) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const currentDrawdown = peak > 0 ? (peak - currentBalance) / peak : 0;

  // Units (1 unit = $100 for a $3000 bankroll, or use average stake)
  const avgStake = totalRisked > 0 && resolved.length > 0 ? totalRisked / resolved.length : 100;
  const unitsRisked = totalRisked / avgStake;
  const unitsWon = totalWon / avgStake;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-[#737373]">
        <div className="flex flex-col items-center gap-2">
          <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <span>Loading bankroll data...</span>
        </div>
      </div>
    );
  }

  if (resolved.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-60 gap-4">
        {/* Editable balance */}
        <div className="flex flex-col items-center gap-1">
          <div className="text-[10px] uppercase tracking-wider text-[#737373]">Bankroll</div>
          {editing ? (
            <div className="flex items-center gap-2">
              <span className="text-lg font-mono text-[#737373]">$</span>
              <input
                ref={inputRef}
                type="number"
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSave()}
                className="w-28 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-lg font-mono font-semibold text-[#ededed] text-center outline-none focus:border-emerald-500/50"
              />
              <button
                onClick={handleSave}
                className="px-2.5 py-1 text-xs font-medium bg-emerald-600 text-white rounded hover:bg-emerald-500 transition-colors"
              >
                Save
              </button>
            </div>
          ) : (
            <button
              onClick={handleEditStart}
              className="text-2xl font-mono font-semibold text-[#ededed] hover:text-emerald-400 transition-colors"
            >
              ${STARTING_BANKROLL.toLocaleString()}
            </button>
          )}
          {!editing && <div className="text-[10px] text-[#737373]">tap to edit</div>}
        </div>
        <div className="text-sm text-[#737373]">No resolved bets yet.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4 overflow-y-auto">
      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white/[0.03] rounded-lg px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wider text-[#737373]">Balance</div>
          {editing ? (
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-sm font-mono text-[#737373]">$</span>
              <input
                ref={inputRef}
                type="number"
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSave()}
                className="w-20 bg-white/[0.06] border border-white/10 rounded px-1.5 py-0.5 text-sm font-mono font-semibold text-[#ededed] outline-none focus:border-emerald-500/50"
              />
              <button
                onClick={handleSave}
                className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-600 text-white rounded hover:bg-emerald-500 transition-colors"
              >
                OK
              </button>
            </div>
          ) : (
            <button
              onClick={handleEditStart}
              className={`text-lg font-mono font-semibold ${currentBalance >= STARTING_BANKROLL ? "text-emerald-400" : "text-red-400"} hover:opacity-75 transition-opacity`}
            >
              ${currentBalance.toFixed(0)}
            </button>
          )}
        </div>
        <KpiCard
          label="Total P/L"
          value={`${totalPL >= 0 ? "+" : ""}$${totalPL.toFixed(0)}`}
          color={totalPL >= 0 ? "text-emerald-400" : "text-red-400"}
        />
        <KpiCard
          label="Drawdown"
          value={`${(currentDrawdown * 100).toFixed(1)}%`}
          sub={`Max: ${(maxDrawdown * 100).toFixed(1)}%`}
          color={currentDrawdown > 0.1 ? "text-red-400" : "text-[#ededed]"}
        />
        <KpiCard
          label="ROI"
          value={`${totalRisked > 0 ? ((totalPL / totalRisked) * 100).toFixed(1) : 0}%`}
          color={totalPL >= 0 ? "text-emerald-400" : "text-red-400"}
        />
      </div>

      {/* Balance Line Chart */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-[#737373] font-medium mb-2">Running Balance</h3>
        <div className="h-44 sm:h-52">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={balanceSeries} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#737373", fontSize: 10 }}
                axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "#737373", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => `$${v}`}
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={STARTING_BANKROLL} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
              <Line
                type="monotone"
                dataKey="balance"
                name="Balance"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "#22c55e" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Daily P&L Bar Chart */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-[#737373] font-medium mb-2">Daily P&L</h3>
        <div className="h-36 sm:h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={days} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#737373", fontSize: 10 }}
                axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "#737373", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => `$${v}`}
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" />
              <Bar dataKey="pnl" name="P/L" radius={[2, 2, 0, 0]}>
                {days.map((d, i) => (
                  <Cell key={i} fill={d.pnl >= 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Units Summary */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-[#737373] font-medium mb-2">Units</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white/[0.03] rounded-lg px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-[#737373]">Risked</div>
            <div className="text-sm font-mono font-semibold text-[#ededed]">{unitsRisked.toFixed(1)}u</div>
            <div className="text-[10px] font-mono text-[#737373]">${totalRisked.toFixed(0)}</div>
          </div>
          <div className="bg-white/[0.03] rounded-lg px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-[#737373]">Won</div>
            <div className="text-sm font-mono font-semibold text-emerald-400">{unitsWon.toFixed(1)}u</div>
            <div className="text-[10px] font-mono text-[#737373]">${totalWon.toFixed(0)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── KPI Card ───

function KpiCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="bg-white/[0.03] rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-[#737373]">{label}</div>
      <div className={`text-lg font-mono font-semibold ${color ?? "text-[#ededed]"}`}>{value}</div>
      {sub && <div className="text-[10px] font-mono text-[#737373]">{sub}</div>}
    </div>
  );
}
