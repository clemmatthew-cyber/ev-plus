// ─── Global Settings Context ───
// Sport selector + odds format toggle. Pure in-memory via React state.

import { createContext, useContext } from "react";

export type Sport = "nhl" | "nba" | "mma";
export type OddsFormat = "american" | "decimal";

export interface Settings {
  sport: Sport;
  oddsFormat: OddsFormat;
}

export interface SettingsCtx extends Settings {
  setSport: (s: Sport) => void;
  setOddsFormat: (f: OddsFormat) => void;
}

export const DEFAULT_SETTINGS: Settings = { sport: "nhl", oddsFormat: "american" };

export async function loadSettings(): Promise<Settings> {
  return DEFAULT_SETTINGS;
}

export async function saveSettings(_s: Settings): Promise<void> {
  // Settings live in React state; no persistence needed
}

export const SettingsContext = createContext<SettingsCtx>({
  ...DEFAULT_SETTINGS,
  setSport: () => {},
  setOddsFormat: () => {},
});

export function useSettings(): SettingsCtx {
  return useContext(SettingsContext);
}

// ─── Sport display info ───

export const SPORTS: { key: Sport; label: string; enabled: boolean }[] = [
  { key: "nhl", label: "NHL", enabled: true },
  { key: "nba", label: "NBA", enabled: true },
  { key: "mma", label: "MMA", enabled: true },
];

// ─── Odds formatter ───

export function fmtOdds(price: number, format: OddsFormat): string {
  if (format === "american") {
    return price > 0 ? `+${price}` : `${price}`;
  }
  const dec = price > 0 ? price / 100 + 1 : 100 / Math.abs(price) + 1;
  return dec.toFixed(2);
}
