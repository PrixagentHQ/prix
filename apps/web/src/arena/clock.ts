import type { MarketStatus } from '@prix/contracts';
import { TICK_FIRST_HOUR_UTC, TICK_LAST_HOUR_UTC } from '@prix/contracts';

/**
 * Where the league stands on its schedule (docs/CONTRACTS.md section 10): rounds start on the
 * hour from 15:00 to 19:00 UTC on trading days, and the market is checked only when a round
 * starts. A check therefore speaks for the window of rounds it was made in, and for no later
 * time: at night, the check on record is the one of the last round of the day before. Outside
 * the window, or inside it before this window's first check, the page says that no round is
 * running and when the next is due, and never repeats an old check as if it were made now.
 *
 * This is a reading of times on the schedule, not a figure: whether the market is open, what
 * failed and every rank stay the API's own. Pure and server only, so it can be tested.
 */

const HOUR_MS = 3_600_000;

export type LeagueClock =
  /** A round is still being processed. */
  | { kind: 'round' }
  /** The check on record is from this window and the market was open. `next` is the next round today, if any. */
  | { kind: 'open'; next: string | null }
  /** The check on record is from this window and the market was closed or the league paused. */
  | { kind: 'closed' }
  /**
   * No round is running and the check on record is from an earlier window, or there is none.
   * `next` is the next round's start when it falls later today on a weekday; null means the next
   * trading day, which the page cannot know ahead of a holiday.
   */
  | { kind: 'between'; next: string | null };

function hourOf(day: string, hour: number): number {
  return Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
}

/**
 * True on Monday to Friday, in UTC. The rounds follow the Stock Tokens' week; the crypto assets
 * trade only in those rounds, though their feeds publish every day (docs/CONTRACTS.md section 21).
 */
function weekday(now: number): boolean {
  const day = new Date(now).getUTCDay();
  return day >= 1 && day <= 5;
}

/** The start of the next round on the schedule today, or null when none is left today. */
export function nextRoundToday(now: number): string | null {
  if (!weekday(now)) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const at = Math.max(Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS, hourOf(day, TICK_FIRST_HOUR_UTC));
  return at > hourOf(day, TICK_LAST_HOUR_UTC) ? null : new Date(at).toISOString();
}

/**
 * True when the market check on record was made in the window of rounds that `now` falls in:
 * today from the first round hour until an hour after the last. Outside that window no check
 * is current, because none is made there.
 */
export function checkIsCurrent(market: MarketStatus, now: number): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  const start = hourOf(day, TICK_FIRST_HOUR_UTC);
  const end = hourOf(day, TICK_LAST_HOUR_UTC) + HOUR_MS;
  if (now < start || now >= end) return false;
  const checked = Date.parse(market.checkedAt);
  return Number.isFinite(checked) && checked >= start && checked < end;
}

export function leagueClock(
  league: { market: MarketStatus | null; round: { tickId: string } | null },
  now: number,
): LeagueClock {
  if (league.round) return { kind: 'round' };
  const market = league.market;
  if (!market || !checkIsCurrent(market, now)) return { kind: 'between', next: nextRoundToday(now) };
  return market.open ? { kind: 'open', next: nextRoundToday(now) } : { kind: 'closed' };
}
