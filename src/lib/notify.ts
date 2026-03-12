// ─── Browser Push Notifications for A-Grade Bets ───

import type { EvBet } from "./types";

// Track which bets we already notified about (by id) to avoid spam
const notified = new Set<string>();

/** Request notification permission. Call once on app load. */
export async function requestNotifPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

/** Check for new A-grade bets and fire notifications. Call after each refresh. */
export function notifyNewAGrades(bets: EvBet[]): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const newAGrades = bets.filter(
    b => b.confidenceGrade === "A" && !notified.has(b.id)
  );

  for (const bet of newAGrades) {
    notified.add(bet.id);

    const fmtOdds = bet.bestPrice > 0 ? `+${bet.bestPrice}` : `${bet.bestPrice}`;
    const edge = (bet.edge * 100).toFixed(1);

    new Notification("NHL EV+ · A-Grade Bet", {
      body: `${bet.outcome} ${fmtOdds} (${bet.bestBook}) — +${edge}% edge`,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'><rect width='28' height='28' rx='6' fill='%2322c55e'/><text x='14' y='18' text-anchor='middle' fill='%230a0a0a' font-family='sans-serif' font-weight='700' font-size='11'>EV+</text></svg>",
      tag: bet.id, // prevents duplicates from browser
      requireInteraction: false,
    });
  }
}

/** Seed the notified set with current bets so the first load doesn't spam. */
export function seedNotified(bets: EvBet[]): void {
  for (const b of bets) {
    if (b.confidenceGrade === "A") notified.add(b.id);
  }
}
