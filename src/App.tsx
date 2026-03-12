import { useState, useEffect, useCallback } from "react";
import Board from "./pages/Board";
import Tracker from "./pages/Tracker";
import Bankroll from "./pages/Bankroll";
import Analytics from "./pages/Analytics";
import AlertBadge from "./components/AlertBadge";
import {
  SettingsContext,
  loadSettings,
  saveSettings,
  updateBankroll,
  SPORTS,
  type Sport,
  type OddsFormat,
  type Settings,
  DEFAULT_SETTINGS,
} from "./lib/settings";

type Tab = "board" | "tracker" | "bankroll" | "analytics";

export default function App() {
  const [tab, setTab] = useState<Tab>("board");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [sportOpen, setSportOpen] = useState(false);

  // Load persisted settings
  useEffect(() => {
    loadSettings().then(s => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const setSport = useCallback((s: Sport) => {
    setSettings(prev => {
      const next = { ...prev, sport: s };
      saveSettings(next);
      return next;
    });
    setSportOpen(false);
  }, []);

  const setOddsFormat = useCallback((f: OddsFormat) => {
    setSettings(prev => {
      const next = { ...prev, oddsFormat: f };
      saveSettings(next);
      return next;
    });
  }, []);

  const setBankroll = useCallback(async (b: number) => {
    const result = await updateBankroll(b);
    setSettings(prev => ({
      ...prev,
      bankroll: result.balance,
      peakBankroll: result.peakBalance,
    }));
  }, []);

  const ctxValue = { ...settings, setSport, setOddsFormat, setBankroll };

  const tabs: { key: Tab; label: string }[] = [
    { key: "board", label: "Board" },
    { key: "tracker", label: "Tracker" },
    { key: "bankroll", label: "Bankroll" },
    { key: "analytics", label: "Analytics" },
  ];

  if (!loaded) return null;

  return (
    <SettingsContext.Provider value={ctxValue}>
      <div className="flex flex-col h-[100dvh] overflow-hidden bg-[#0a0a0a] safe-top">
        {/* Nav */}
        <header className="sticky top-0 z-50 flex items-center justify-between px-4 py-3 border-b border-white/[0.08] bg-[#0a0a0a]/95 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="6" fill="#22c55e" />
              <text x="14" y="18" textAnchor="middle" fill="#0a0a0a" fontFamily="Inter,sans-serif" fontWeight="700" fontSize="11">EV+</text>
            </svg>

            {/* Sport selector dropdown */}
            <div className="relative">
              <button
                onClick={() => setSportOpen(!sportOpen)}
                className="flex items-center gap-1 text-sm font-semibold tracking-tight text-[#ededed] hover:text-white transition-colors"
              >
                {SPORTS.find(s => s.key === settings.sport)?.label ?? "NHL"} EV+
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 text-[#737373]">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {sportOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSportOpen(false)} />
                  <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden min-w-[120px]">
                    {SPORTS.map(s => (
                      <button
                        key={s.key}
                        onClick={() => setSport(s.key)}
                        disabled={!s.enabled}
                        className={`block w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                          settings.sport === s.key
                            ? "bg-emerald-600/20 text-emerald-400"
                            : s.enabled
                              ? "text-[#ededed] hover:bg-white/5"
                              : "text-[#737373]/50 cursor-not-allowed"
                        }`}
                      >
                        {s.label}
                        {!s.enabled && <span className="ml-1.5 text-[9px] text-[#737373]">soon</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Odds format toggle */}
            <button
              onClick={() => setOddsFormat(settings.oddsFormat === "american" ? "decimal" : "american")}
              className="px-2 py-1 text-[10px] font-mono font-medium rounded bg-white/[0.05] text-[#737373] hover:text-[#ededed] hover:bg-white/[0.08] transition-colors"
              title="Toggle odds format"
            >
              {settings.oddsFormat === "american" ? "US" : "DEC"}
            </button>

            {/* Alert bell */}
            <AlertBadge />

            {/* Tab nav */}
            <nav className="flex items-center gap-1">
              {tabs.map(t => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    tab === t.key ? "bg-white/10 text-[#ededed]" : "text-[#737373] hover:text-[#ededed]"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          {tab === "board" ? <Board /> : tab === "tracker" ? <Tracker /> : tab === "bankroll" ? <Bankroll /> : <Analytics />}
        </main>

        {/* Safe area bottom */}
        <div className="safe-bottom" />
      </div>
    </SettingsContext.Provider>
  );
}
