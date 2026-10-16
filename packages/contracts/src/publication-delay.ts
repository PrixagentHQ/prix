import type { AgentId, IsoTime, TickId, UtcDay } from './primitives.ts';

/**
 * The publication delay of Prix Live, as the league applies it to its public reads and its follow notes.
 * Prix Live itself is not part of this repository: in this copy no agent is linked, so nothing is held
 * back, and the rule and its port stay so that the league's reads keep one shape.
 */

/**
 * A tick of day D of a Live-linked agent is held back from every public read (agent page, feeds, league
 * row holdings, data API, MCP, share images) and from every follower notification (Telegram, push, email)
 * until D at 20:00 UTC: its targets, fills, reason and the holdings it left. Figures (return, drawdown,
 * equity) stay live. The owner's own session sees it at once.
 */
export const LIVE_REVEAL_HOUR_UTC = 20;

export function liveRevealAt(tickId: TickId): IsoTime {
  return `${tickId.slice(0, 10)}T${String(LIVE_REVEAL_HOUR_UTC).padStart(2, '0')}:00:00.000Z`;
}

export function liveHeldBack(tickId: TickId, now: Date): boolean {
  return now.toISOString() < liveRevealAt(tickId);
}

/** The same rule for a Live leg, which carries its day and no tick: held back until 20:00 UTC of that day. */
export function liveLegHeldBack(day: UtcDay, now: Date): boolean {
  return now.toISOString() < `${day}T${String(LIVE_REVEAL_HOUR_UTC).padStart(2, '0')}:00:00.000Z`;
}

/** Which agents are linked; in this copy none is. */
export interface LiveLinkStore {
  /** Agent ids with an open link, for the delay. One indexed read, cached by the caller for 30 seconds. */
  linkedAgentIds(): Promise<AgentId[]>;
  link(agentId: AgentId, at: IsoTime): Promise<{ created: boolean }>;
  unlink(agentId: AgentId, at: IsoTime): Promise<void>;
}
