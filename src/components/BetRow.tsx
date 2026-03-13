import { useState, useRef } from "react";
import type { EvBet } from "@/lib/types";
import type { MovementDir } from "@/lib/movement";
import { useSettings, fmtOdds as formatOdds } from "@/lib/settings";
import ConfidenceBadge from "./ConfidenceBadge";
import { format } from "date-fns";
const fmtTime = (iso: string) => format(new Date(iso), "h:mma").toLowerCase();

// ─── Sportsbook deep-link map ───

const BOOK_LINKS: Record<string, string> = {
  DK: "https://sportsbook.draftkings.com/leagues/hockey/nhl",
  FD: "https://sportsbook.fanduel.com/hockey",
  MGM: "https://sports.betmgm.com/en/sports/hockey-12/betting/usa-9/nhl-34",
  CZR: "https://www.caesars.com/sportsbook-and-casino/nhl",
  PB: "https://pointsbet.com/sports/ice-hockey/NHL",
};

// ─── Movement arrow component ───

function MovementArrow({ dir }: { dir: MovementDir }) {
  if (dir === "flat") return null;
  return (
    <span
      className={`ml-0.5 text-[10px] leading-none ${
        dir === "up" ? "text-emerald-400" : "text-red-400"
      }`}
    >
      {dir === "up" ? "↑" : "↓"}
    </span>
  );
}

// ─── Swipe threshold (px) ───
const SWIPE_THRESHOLD = 60;

interface Props {
  bet: EvBet;
  movement: MovementDir;
  onToggle: () => void;
}

export default function BetRow({ bet, movement, onToggle }: Props) {
  const { oddsFormat } = useSettings();
  const fmtOdds = (p: number) => formatOdds(p, oddsFormat);
  const [open, setOpen] = useState(false);
  const edgeColor =
    bet.edge >= 0.07
      ? "text-emerald-400"
      : bet.edge >= 0.05
        ? "text-emerald-500"
        : "text-emerald-600";

  // ─── Swipe-to-place state ───
  const touchStartX = useRef(0);
  const touchDelta = useRef(0);
  const rowRef = useRef<HTMLDivElement>(null);
  const [swiping, setSwiping] = useState(false);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchDelta.current = 0;
    setSwiping(false);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartX.current;
    touchDelta.current = dx;
    // Only track rightward swipe
    if (dx > 10) {
      setSwiping(true);
      if (rowRef.current) {
        const clamped = Math.min(dx, SWIPE_THRESHOLD + 20);
        rowRef.current.style.transform = `translateX(${clamped}px)`;
        rowRef.current.style.transition = "none";
      }
    }
  };

  const onTouchEnd = () => {
    if (rowRef.current) {
      rowRef.current.style.transform = "translateX(0)";
      rowRef.current.style.transition = "transform 200ms ease-out";
    }
    if (touchDelta.current >= SWIPE_THRESHOLD && !bet.placed) {
      onToggle();
    }
    setSwiping(false);
  };

  const bookUrl = BOOK_LINKS[bet.bestBook] || "#";

  return (
    <div className="relative overflow-hidden">
      {/* Swipe reveal background */}
      <div className="absolute inset-0 flex items-center pl-4 bg-emerald-600/20 pointer-events-none">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-emerald-400"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <span className="ml-1.5 text-[11px] font-medium text-emerald-400">
          Place
        </span>
      </div>

      {/* Row content (slides on swipe) */}
      <div
        ref={rowRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className="relative bg-[#0a0a0a]"
      >
        <div
          className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-zinc-900/50 transition-colors border-b border-white/[0.04] sm:gap-3 sm:px-4 max-w-3xl"
          onClick={() => !swiping && setOpen(!open)}
        >
          <div className="w-8 flex-shrink-0">
            <ConfidenceBadge grade={bet.confidenceGrade} />
          </div>
          {bet.tournamentType && bet.tournamentType !== 'none' && (
            <span className="hidden sm:inline-block flex-shrink-0 text-[9px] font-semibold px-1 py-0.5 rounded bg-purple-500/20 text-purple-300">
              {bet.tournamentType === 'conference' ? 'CONF' : 'NCAA'}
            </span>
          )}
          {bet.upsetSignal && (
            <span className="flex-shrink-0 text-[9px] font-semibold px-1 py-0.5 rounded bg-red-500/20 text-red-300" title="Defensive upset signal">
              UPSET
            </span>
          )}
          <div className="hidden sm:block w-14 flex-shrink-0 text-xs text-[#737373] font-mono">
            {fmtTime(bet.gameTime)}
          </div>
          <div className="w-20 sm:w-24 flex-shrink-0 text-xs font-medium truncate text-[#ededed]">
            {bet.awaySeed != null && (
              <span className={bet.seedSource === 'actual' ? 'text-[#ededed]' : 'text-[#737373]'}>
                {bet.seedSource === 'estimated' ? '~' : ''}{bet.awaySeed}{' '}
              </span>
            )}
            {bet.awayTeam}
            {bet.shortTurnaround?.away && <span className="ml-0.5 text-[10px] text-amber-400" title="Back-to-back">B2B</span>}
            {' @ '}
            {bet.homeSeed != null && (
              <span className={bet.seedSource === 'actual' ? 'text-[#ededed]' : 'text-[#737373]'}>
                {bet.seedSource === 'estimated' ? '~' : ''}{bet.homeSeed}{' '}
              </span>
            )}
            {bet.homeTeam}
            {bet.shortTurnaround?.home && <span className="ml-0.5 text-[10px] text-amber-400" title="Back-to-back">B2B</span>}
          </div>
          <div className="flex-1 min-w-0 text-xs font-medium text-[#ededed]/90 truncate">
            {bet.outcome}
          </div>
          <div className="hidden sm:block w-10 flex-shrink-0 text-xs text-[#737373] font-mono">
            {bet.bestBook}
          </div>
          <div className="w-16 flex-shrink-0 text-xs font-mono text-[#ededed]/80 text-right flex items-center justify-end">
            {fmtOdds(bet.bestPrice)}<MovementArrow dir={movement} />
          </div>
          <div
            className={`w-14 flex-shrink-0 text-xs font-mono font-semibold text-right ${edgeColor}`}
          >
            +{(bet.edge * 100).toFixed(1)}%
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className={`w-6 h-6 flex-shrink-0 flex items-center justify-center rounded transition-colors ${
              bet.placed
                ? "bg-emerald-500/20 text-emerald-400"
                : "text-zinc-700 hover:text-zinc-500"
            }`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
        </div>

        {/* Expanded detail panel */}
        {open && (
          <div className="px-4 py-3 bg-zinc-900/30 border-b border-white/[0.04] sm:px-6 max-w-3xl">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 text-xs">
              <div>
                <span className="text-[#737373]">Model</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  {(bet.modelProb * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-[#737373]">Fair</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  {(bet.fairProb * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-[#737373]">Implied</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  {(bet.impliedProb * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-[#737373]">EV</span>
                <span className="ml-2 font-mono text-emerald-400">
                  +{(bet.ev * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-[#737373]">Kelly</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  {(bet.kellyFraction * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-[#737373]">Stake</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  ${bet.suggestedStake}
                </span>
              </div>
              <div>
                <span className="text-[#737373]">Conf</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  {bet.confidenceScore.toFixed(0)}
                </span>
              </div>
              <div className="sm:hidden">
                <span className="text-[#737373]">Book</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  {bet.bestBook}
                </span>
              </div>
              <div className="sm:hidden">
                <span className="text-[#737373]">Time</span>
                <span className="ml-2 font-mono text-[#ededed]">
                  {fmtTime(bet.gameTime)}
                </span>
              </div>
              {bet.upsetSignal && bet.defensiveMismatch != null && (
                <div>
                  <span className="text-[#737373]">Def Mismatch</span>
                  <span className="ml-2 font-mono text-red-300">
                    {bet.defensiveMismatch.toFixed(1)}
                  </span>
                </div>
              )}
            </div>

            {/* Bet Now deep-link */}
            <a
              href={bookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 text-[11px] font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              Bet Now on {bet.bestBook}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
