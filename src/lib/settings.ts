// ─── Global Settings Context ───
// Sport selector + odds format toggle + bankroll. Pure in-memory via React state.

import { createContext, useContext } from "react";

export type Sport = "nhl" | "nba" | "ncaab";
export type OddsFormat = "american" | "decimal";

export interface Settings {
  sport: Sport;
  oddsFormat: OddsFormat;
  bankroll: number;
  peakBankroll: number;
}

export interface SettingsCtx extends Settings {
  setSport: (s: Sport) => void;
  setOddsFormat: (f: OddsFormat) => void;
  setBankroll: (b: number) => Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = {
  sport: "nhl",
  oddsFormat: "american",
  bankroll: 3000,
  peakBankroll: 3000,
};

// Backend proxy base (replaced by deploy_website)
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export async function fetchBankroll(): Promise<{ balance: number; peakBalance: number }> {
  try {
    const res = await fetch(`${API_BASE}/api/bankroll`);
    if (res.ok) return await res.json();
  } catch {}
  return { balance: 3000, peakBalance: 3000 };
}

export async function updateBankroll(balance: number): Promise<{ balance: number; peakBalance: number }> {
  try {
    const res = await fetch(`${API_BASE}/api/bankroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ balance }),
    });
    if (res.ok) return await res.json();
  } catch {}
  return { balance, peakBalance: balance };
}

// F-9: localStorage persistence for sport/oddsFormat preferences
const SETTINGS_KEY = 'ev-plus-settings';

function loadPersistedSettings(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export async function loadSettings(): Promise<Settings> {
  const br = await fetchBankroll();
  const persisted = loadPersistedSettings();
  return {
    ...DEFAULT_SETTINGS,
    ...persisted,
    bankroll: br.balance,
    peakBankroll: br.peakBalance,
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sport: s.sport, oddsFormat: s.oddsFormat }));
  } catch {}
}

export const SettingsContext = createContext<SettingsCtx>({
  ...DEFAULT_SETTINGS,
  setSport: () => {},
  setOddsFormat: () => {},
  setBankroll: async () => {},
});

export function useSettings(): SettingsCtx {
  return useContext(SettingsContext);
}

// ─── Sport display info ───

export const SPORTS: { key: Sport; label: string; enabled: boolean }[] = [
  { key: "nhl", label: "NHL", enabled: true },
  { key: "nba", label: "NBA", enabled: true },
  { key: "ncaab", label: "NCAAB", enabled: true },
];

// ─── Odds formatter ───

export function fmtOdds(price: number, format: OddsFormat): string {
  if (format === "american") {
    return price > 0 ? `+${price}` : `${price}`;
  }
  const dec = price > 0 ? price / 100 + 1 : 100 / Math.abs(price) + 1;
  return dec.toFixed(2);
}
