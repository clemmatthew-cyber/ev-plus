// ─── March Madness / Tournament Adjustment Layer ───
// Extends the NCAAB engine with tournament-specific adjustments.
// Does NOT replace the existing model — wraps and adjusts its outputs.

import type { TorvikStats } from "../stats/torvik";
import type { GameOdds } from "../odds";
import { TOURNAMENT_CONFIG, CONFERENCE_TOURNAMENT_VENUES, ACTUAL_SEEDS } from "./tournament-config";

// ── Tournament Detection ──

export interface TournamentContext {
  isTournament: boolean;
  tournamentType: 'conference' | 'ncaa' | 'none';
  tournamentRound: string | null;   // "R64", "R32", "S16", "E8", "F4", "NCG", "play_in", or null
  isNeutralSite: boolean;
  homeSeed: number | null;
  awaySeed: number | null;
  seedSource: 'actual' | 'estimated';
  homeConference: string | null;
  awayConference: string | null;
  isCrossConference: boolean;
  shortTurnaround: {
    home: boolean;
    away: boolean;
  };
  homePriorTournamentGame: boolean;
  awayPriorTournamentGame: boolean;
  publicBiasTeam: string | null;    // which team (if any) is the "public" side
}

// ── In-memory per-team last-game-time cache for short turnaround detection ──
const teamLastGameTime = new Map<string, Date>();

/** Record a game time for both teams (call as games are processed). */
export function recordTeamGameTime(homeTeam: string, awayTeam: string, gameTime: Date): void {
  const existing = teamLastGameTime.get(homeTeam);
  if (!existing || gameTime > existing) teamLastGameTime.set(homeTeam, gameTime);
  const existingAway = teamLastGameTime.get(awayTeam);
  if (!existingAway || gameTime > existingAway) teamLastGameTime.set(awayTeam, gameTime);
}

/** Check if a team played within the last 24 hours. */
function isShortTurnaround(teamName: string, currentGameTime: Date): boolean {
  const lastGame = teamLastGameTime.get(teamName);
  if (!lastGame) return false;
  const hoursBetween = (currentGameTime.getTime() - lastGame.getTime()) / (1000 * 60 * 60);
  return hoursBetween > 0 && hoursBetween < 24;
}

/** Check if a game is during the conference tournament window at a neutral site. */
function isConferenceTournament(gameDate: Date, venue?: string): boolean {
  const month = gameDate.getMonth(); // 0-indexed
  const day = gameDate.getDate();

  // Must be March 4-15
  if (month !== 2 || day < TOURNAMENT_CONFIG.confTournamentStartDay || day > TOURNAMENT_CONFIG.confTournamentEndDay) {
    return false;
  }

  // If venue matches known neutral sites, definitely conf tournament
  if (venue) {
    const venueLower = venue.toLowerCase();
    if (CONFERENCE_TOURNAMENT_VENUES.some(v => venueLower.includes(v.toLowerCase()))) {
      return true;
    }
  }

  // During March 4-15, conservatively default to conference tournament
  return true;
}

/** Look up seed: actual seeds take precedence, then Barthag estimation. */
function getTeamSeed(
  stats: TorvikStats,
  allStats: Map<string, TorvikStats>,
): { seed: number | null; source: 'actual' | 'estimated' } {
  // Check actual seeds first (populated after Selection Sunday)
  const actual = ACTUAL_SEEDS[stats.team];
  if (actual != null) {
    return { seed: actual, source: 'actual' };
  }
  // Fall back to Barthag estimation
  const estimated = estimateSeed(stats, allStats);
  return { seed: estimated, source: 'estimated' };
}

/**
 * Detect whether a game is part of March Madness / NCAA Tournament
 * or a conference tournament.
 *
 * Detection strategy (since The Odds API doesn't flag tournament games):
 * - If date >= March 14 and sport is NCAAB → NCAA tournament
 * - If date is March 4-15 and game at known neutral site → conference tournament
 * - Round detection via date ranges (approximate)
 */
export function detectTournamentContext(
  game: GameOdds,
  homeStats: TorvikStats | null,
  awayStats: TorvikStats | null,
  allStats?: Map<string, TorvikStats>,
  recentTournamentGameIds?: Set<string>,
): TournamentContext {
  const gameDate = new Date(game.commenceTime);
  const month = gameDate.getMonth(); // 0-indexed
  const day = gameDate.getDate();

  const isNcaaTournament =
    (month === TOURNAMENT_CONFIG.tournamentStartMonth && day >= TOURNAMENT_CONFIG.tournamentStartDay) ||
    (month === 3); // April

  const isConfTournament = !isNcaaTournament && isConferenceTournament(gameDate, (game as any).venue);

  const isTournament = isNcaaTournament || isConfTournament;

  if (!isTournament) {
    return {
      isTournament: false,
      tournamentType: 'none',
      tournamentRound: null,
      isNeutralSite: false,
      homeSeed: null,
      awaySeed: null,
      seedSource: 'estimated',
      homeConference: null,
      awayConference: null,
      isCrossConference: false,
      shortTurnaround: { home: false, away: false },
      homePriorTournamentGame: false,
      awayPriorTournamentGame: false,
      publicBiasTeam: null,
    };
  }

  const tournamentType: 'conference' | 'ncaa' = isNcaaTournament ? 'ncaa' : 'conference';
  const tournamentRound = isNcaaTournament ? estimateTournamentRound(gameDate) : null;

  // Seed lookup with actual/estimated tracking
  const homeSeedInfo = homeStats && allStats ? getTeamSeed(homeStats, allStats) : null;
  const awaySeedInfo = awayStats && allStats ? getTeamSeed(awayStats, allStats) : null;
  const homeSeed = homeSeedInfo?.seed ?? null;
  const awaySeed = awaySeedInfo?.seed ?? null;
  // If either seed is actual, report 'actual'; otherwise 'estimated'
  const seedSource: 'actual' | 'estimated' =
    (homeSeedInfo?.source === 'actual' || awaySeedInfo?.source === 'actual') ? 'actual' : 'estimated';

  // Cross-conference: in NCAA tournament proper (R64+), almost all are cross-conference.
  // Conference tournaments are NOT cross-conference.
  const isCrossConference = tournamentType === 'ncaa' && tournamentRound !== null && tournamentRound !== "play_in";

  // Short turnaround detection
  const homeShort = homeStats ? isShortTurnaround(homeStats.team, gameDate) : false;
  const awayShort = awayStats ? isShortTurnaround(awayStats.team, gameDate) : false;

  // Track this game for future turnaround detection
  if (homeStats && awayStats) {
    recordTeamGameTime(homeStats.team, awayStats.team, gameDate);
  }

  const homePriorTournamentGame = false;
  const awayPriorTournamentGame = false;

  // Public bias detection
  const publicBiasTeam = homeStats && awayStats && allStats
    ? detectPublicBias(
        game.homeTeam, game.awayTeam,
        homeStats, awayStats,
        homeSeed, awaySeed,
        allStats,
      )
    : null;

  return {
    isTournament: true,
    tournamentType,
    tournamentRound,
    isNeutralSite: true,  // Both NCAA and conference tournament games are at neutral sites
    homeSeed,
    awaySeed,
    seedSource,
    homeConference: null,  // Not available from Torvik data
    awayConference: null,
    isCrossConference,
    shortTurnaround: { home: homeShort, away: awayShort },
    homePriorTournamentGame,
    awayPriorTournamentGame,
    publicBiasTeam,
  };
}

/**
 * Estimate tournament round from game date.
 * Uses the standard NCAA tournament calendar structure.
 */
function estimateTournamentRound(gameDate: Date): string | null {
  const month = gameDate.getMonth(); // 0-indexed
  const day = gameDate.getDate();
  const dow = gameDate.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  if (month === 2) { // March
    if (day >= 14 && day <= 17) return "play_in";
    if (day >= 18 && day <= 20) return "R64";
    if (day >= 21 && day <= 23) return "R32";
    if (day >= 24 && day <= 27) return "S16";
    if (day >= 28 && day <= 31) return "E8";
  }

  if (month === 3) { // April
    if (day <= 3) return "E8"; // late Elite 8 spillover
    if (day >= 4 && day <= 6) {
      // Saturday = Final Four
      return dow === 6 ? "F4" : "F4";
    }
    if (day >= 7 && day <= 8) return "NCG"; // Monday = Championship
  }

  return null;
}

/**
 * Estimate seed from Torvik data (Barthag rank → approximate seed).
 * - barthag rank 1-4 → seed 1
 * - barthag rank 5-8 → seed 2
 * - ...up to rank 61-68 → seed 16
 */
export function estimateSeed(
  stats: TorvikStats,
  allStats: Map<string, TorvikStats>,
): number | null {
  // Rank all teams by Barthag (descending)
  const sorted = [...allStats.values()]
    .filter(s => typeof s.barthag === "number")
    .sort((a, b) => b.barthag - a.barthag);

  const rank = sorted.findIndex(s => s.team === stats.team);
  if (rank === -1) return null;

  // Map rank to seed: top 4 = seed 1, next 4 = seed 2, etc.
  const seed = Math.min(16, Math.floor(rank / 4) + 1);
  return seed;
}

// ── Public Bias Detection ──

/**
 * Brand-name programs that attract heavy public betting.
 */
const PUBLIC_DARLINGS = new Set([
  "Duke", "Kentucky", "North Carolina", "Kansas", "UCLA",
  "Michigan", "Gonzaga", "Louisville", "Syracuse", "Indiana",
  "Arizona", "Villanova", "Connecticut", "Michigan St.", "Ohio St.",
  "Texas", "Alabama", "Tennessee", "Purdue", "Creighton",
  "Auburn", "Houston", "Baylor",
]);

/**
 * Detect public bias in a tournament matchup.
 * Returns the Torvik team name of the "public" side, or null.
 */
export function detectPublicBias(
  homeTeam: string,
  awayTeam: string,
  homeStats: TorvikStats | null,
  awayStats: TorvikStats | null,
  homeSeed: number | null,
  awaySeed: number | null,
  allStats: Map<string, TorvikStats>,
): string | null {
  const homeIsDarling = homeStats ? PUBLIC_DARLINGS.has(homeStats.team) : false;
  const awayIsDarling = awayStats ? PUBLIC_DARLINGS.has(awayStats.team) : false;

  // If both are darlings or neither is, no clear public side
  if (homeIsDarling === awayIsDarling) return null;

  // The darling is the public side, but only if they're a high seed (1-4)
  if (homeIsDarling && homeSeed !== null && homeSeed <= TOURNAMENT_CONFIG.publicSeedThreshold) {
    return homeStats!.team;
  }
  if (awayIsDarling && awaySeed !== null && awaySeed <= TOURNAMENT_CONFIG.publicSeedThreshold) {
    return awayStats!.team;
  }

  return null;
}

// ── Tournament Adjustments ──

export interface TournamentAdjustments {
  spreadAdjustment: number;         // points to add to projected spread
  totalAdjustment: number;          // points to add to projected total
  confidenceMultiplier: number;     // multiply confidence score by this (0.7-1.0)
  publicBiasEdgeBoost: number;      // extra edge for going AGAINST public side
  tempoMismatchFactor: number;      // normalized tempo mismatch (0-1 scale)
  styleMismatchScore: number;       // 0-100 how different the teams' styles are
}

/**
 * Compute tournament-specific adjustments to apply on top of the base model.
 */
export function computeTournamentAdjustments(
  ctx: TournamentContext,
  homeStats: TorvikStats | null,
  awayStats: TorvikStats | null,
  allStats: Map<string, TorvikStats>,
): TournamentAdjustments {
  let spreadAdjustment = 0;
  let totalAdjustment = 0;
  let confidenceMultiplier = TOURNAMENT_CONFIG.baseConfidenceMultiplier;
  let publicBiasEdgeBoost = 0;
  let tempoMismatchFactor = 0;
  let styleMismatchScore = 0;

  // 1. Public bias edge boost
  if (ctx.publicBiasTeam) {
    publicBiasEdgeBoost = TOURNAMENT_CONFIG.publicBiasEdgeBoost;
  }

  // 2. Tempo/style mismatch
  if (homeStats && awayStats) {
    const avgTempo = (homeStats.tempo + awayStats.tempo) / 2;
    if (avgTempo > 0) {
      tempoMismatchFactor = Math.abs(homeStats.tempo - awayStats.tempo) / avgTempo;
    }

    // Offensive philosophy difference
    const avgOE = (homeStats.adjOE + awayStats.adjOE) / 2;
    const oeDiff = avgOE > 0 ? Math.abs(homeStats.adjOE - awayStats.adjOE) / avgOE : 0;

    // Style mismatch score: 0-100 combining tempo and OE differences
    styleMismatchScore = Math.min(100, Math.round((tempoMismatchFactor * 60 + oeDiff * 40) * 100));

    // If significant tempo mismatch, adjust total downward
    // (slow team tends to control pace in tournament games)
    if (tempoMismatchFactor > TOURNAMENT_CONFIG.tempoMismatchThreshold) {
      totalAdjustment = TOURNAMENT_CONFIG.tempoMismatchTotalAdjustment * tempoMismatchFactor /
        TOURNAMENT_CONFIG.tempoMismatchThreshold;
      // Cap at 2x the base adjustment
      totalAdjustment = Math.max(totalAdjustment, TOURNAMENT_CONFIG.tempoMismatchTotalAdjustment * 2);
    }

    // High mismatch → additional confidence reduction
    if (tempoMismatchFactor > TOURNAMENT_CONFIG.highMismatchThreshold) {
      confidenceMultiplier -= TOURNAMENT_CONFIG.highMismatchPenalty;
    }
  }

  // 3. Cross-conference penalty
  if (ctx.isCrossConference) {
    confidenceMultiplier -= TOURNAMENT_CONFIG.crossConferencePenalty;
  }

  // 4. Short turnaround spread penalty (per-team)
  // If home team has short turnaround, penalize home (add to spread = away favored more)
  if (ctx.shortTurnaround.home) {
    spreadAdjustment += TOURNAMENT_CONFIG.shortTurnaroundPenalty;
  }
  // If away team has short turnaround, penalize away (subtract from spread = home favored more)
  if (ctx.shortTurnaround.away) {
    spreadAdjustment -= TOURNAMENT_CONFIG.shortTurnaroundPenalty;
  }

  // 5. Apply confidence floor
  confidenceMultiplier = Math.max(confidenceMultiplier, TOURNAMENT_CONFIG.confidenceFloor);

  return {
    spreadAdjustment,
    totalAdjustment,
    confidenceMultiplier,
    publicBiasEdgeBoost,
    tempoMismatchFactor,
    styleMismatchScore,
  };
}

// ── Snapshot Data for DB ──

export interface TournamentSnapshot {
  postseason: boolean;
  tournamentType: 'conference' | 'ncaa' | 'none';
  tournamentRound: string | null;
  neutralSite: boolean;
  homeCurtAdjUsed: number;
  homeSeed: number | null;
  awaySeed: number | null;
  seedSource: 'actual' | 'estimated';
  styleMismatchScore: number;
  tempoMismatchPct: number;
  modelProb: number;
  devigMarketProb: number;
  modelVsMarketDiff: number;
  publicBiasTeam: string | null;
  shortTurnaround: { home: boolean; away: boolean };
  confidenceMultiplier: number;
}

/**
 * Build the tournament snapshot for DB storage.
 */
export function buildTournamentSnapshot(
  ctx: TournamentContext,
  adjustments: TournamentAdjustments,
  modelProb: number,
  devigProb: number,
  hcaUsed: number,
  homeStats: TorvikStats | null,
  awayStats: TorvikStats | null,
): TournamentSnapshot {
  const avgTempo = homeStats && awayStats
    ? (homeStats.tempo + awayStats.tempo) / 2
    : 0;
  const tempoMismatchPct = avgTempo > 0 && homeStats && awayStats
    ? (Math.abs(homeStats.tempo - awayStats.tempo) / avgTempo) * 100
    : 0;

  return {
    postseason: ctx.isTournament,
    tournamentType: ctx.tournamentType,
    tournamentRound: ctx.tournamentRound,
    neutralSite: ctx.isNeutralSite,
    homeCurtAdjUsed: hcaUsed,
    homeSeed: ctx.homeSeed,
    awaySeed: ctx.awaySeed,
    seedSource: ctx.seedSource,
    styleMismatchScore: adjustments.styleMismatchScore,
    tempoMismatchPct: Math.round(tempoMismatchPct * 10) / 10,
    modelProb,
    devigMarketProb: devigProb,
    modelVsMarketDiff: Math.round((modelProb - devigProb) * 1000) / 1000,
    publicBiasTeam: ctx.publicBiasTeam,
    shortTurnaround: ctx.shortTurnaround,
    confidenceMultiplier: adjustments.confidenceMultiplier,
  };
}
