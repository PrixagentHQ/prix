import type { DecisionRow, LiveLinkStore, StandingRow, StandingSource } from '@prix/contracts';
import { liveHeldBack } from '@prix/contracts';

/**
 * The publication delay of Prix Live (docs/CONTRACTS.md section 24.8, r2 19, F10).
 *
 * A tick of day D of an agent linked to a Live wallet is held back from every public read until
 * 20:00 UTC on D: its targets, its fills, its reason, and the holdings it left. Figures (return,
 * drawdown, equity) stay live. The owner's own session sees everything at once.
 *
 * The league runs its rounds from 15:00 to 19:00 UTC, so every tick of a day is held back until the
 * same day's 20:00, and nothing is held back between 20:00 and the next day's first round. The links
 * are read only when some tick in an answer is held back, so most reads cost nothing extra.
 */

/** How long one isolate trusts its copy of the linked agents (`LiveLinkStore.linkedAgentIds`). */
const LINKS_TTL_MS = 30_000;

/** Which agents are linked, as of one read. */
export type LinkedTest = (agentId: string) => boolean;

export interface LiveDelay {
  /**
   * The linked agents, read at most once per 30 seconds in this isolate. When the read fails every
   * agent counts as linked: holding a paper agent's day back until 20:00 is harmless, showing a
   * Live agent's day early is not.
   */
  linked(now: Date): Promise<LinkedTest>;
  /** Drops the copy, after this isolate linked or unlinked an agent. */
  forget(): void;
}

const NOBODY: LinkedTest = () => false;
const EVERYBODY: LinkedTest = () => true;

/** A delay with no links: nothing is ever held back. For an app built without Live. */
export const NO_LIVE_DELAY: LiveDelay = { linked: async () => NOBODY, forget: () => undefined };

/** The delay over the league's `live_links`. One instance per app, so per isolate. */
export function createLiveDelay(links: LiveLinkStore | null | undefined): LiveDelay {
  if (links === null || links === undefined) return NO_LIVE_DELAY;
  let copy: { readAt: number; ids: ReadonlySet<string> } | null = null;
  let failureLogged = false;
  return {
    async linked(now) {
      const at = now.getTime();
      if (copy !== null && at >= copy.readAt && at - copy.readAt < LINKS_TTL_MS) {
        const ids = copy.ids;
        return (agentId) => ids.has(agentId);
      }
      try {
        const ids: ReadonlySet<string> = new Set(await links.linkedAgentIds());
        copy = { readAt: at, ids };
        return (agentId) => ids.has(agentId);
      } catch (error) {
        if (!failureLogged) {
          failureLogged = true;
          console.error(
            JSON.stringify({ event: 'live_links_unread', error: error instanceof Error ? error.name : 'unknown' }),
          );
        }
        return EVERYBODY;
      }
    },
    forget() {
      copy = null;
    },
  };
}

/** True while a tick's details are held back at `now`. Null (no tick) is never held back. */
export function heldBack(tickId: string | null | undefined, now: Date): boolean {
  return typeof tickId === 'string' && liveHeldBack(tickId, now);
}

/** Where the holdings of an agent read come from once the delay is applied. */
export type HoldingsSource =
  /** The portfolio as stored: nothing of it is held back, or the viewer may see it. */
  | { kind: 'latest' }
  /** The portfolio the newest row that is not held back left. */
  | { kind: 'row'; row: DecisionRow }
  /** Every row of the agent is held back: the starting portfolio, which is all anyone knew before. */
  | { kind: 'start' };

export interface DelayedRows {
  /** The rows a viewer may see, newest first, as given. */
  rows: DecisionRow[];
  holdings: HoldingsSource;
  /** True when something was held back from this viewer. */
  affected: boolean;
}

/**
 * The rows and the holdings source of one agent's read.
 *
 * `rows` are the agent's newest rows, newest first, as `Store.listDecisions` gives them; `lastTickId`
 * is the tick of the row its stored portfolio comes from. `exempt` is true for the agent's owner.
 * A day has at most five rounds and every read asks for at least 30 rows, so the newest row that is
 * not held back is always among them when the agent has one; when it has none, the agent's first
 * rows are all of today and it held the starting portfolio before them.
 */
export async function delayAgentRows(
  delay: LiveDelay,
  agentId: string,
  rows: readonly DecisionRow[],
  lastTickId: string | null,
  now: Date,
  exempt: boolean,
): Promise<DelayedRows> {
  const unaffected: DelayedRows = { rows: [...rows], holdings: { kind: 'latest' }, affected: false };
  if (exempt) return unaffected;
  const latestHeld = heldBack(lastTickId, now);
  if (!latestHeld && !rows.some((row) => heldBack(row.tickId, now))) return unaffected;
  if (!(await delay.linked(now))(agentId)) return unaffected;
  const visible = rows.filter((row) => !heldBack(row.tickId, now));
  if (!latestHeld) return { rows: visible, holdings: { kind: 'latest' }, affected: true };
  const revealed = visible[0];
  return {
    rows: visible,
    holdings: revealed === undefined ? { kind: 'start' } : { kind: 'row', row: revealed },
    affected: true,
  };
}

/**
 * League rows with the holdings left off every linked agent whose latest row is held back. The row
 * keeps its figures; `topHoldings` and `cashWeightBps` are optional in the schema, and leaving them
 * out says "not shown" where an empty list would say "all cash".
 */
export async function delayStandingRows(
  delay: LiveDelay,
  sources: readonly StandingSource[],
  rows: StandingRow[],
  now: Date,
): Promise<StandingRow[]> {
  if (!sources.some((source) => heldBack(source.lastTickId, now))) return rows;
  const linked = await delay.linked(now);
  const lastTick = new Map(sources.map((source) => [source.agentId, source.lastTickId]));
  return rows.map((row) => {
    // A row whose source is missing cannot be shown to be old, so it is treated as today's.
    const held = lastTick.has(row.agentId) ? heldBack(lastTick.get(row.agentId), now) : true;
    if (!held || !linked(row.agentId)) return row;
    const { topHoldings: _topHoldings, cashWeightBps: _cashWeightBps, ...rest } = row;
    return rest;
  });
}

/**
 * Feed items without the held-back rounds of linked agents. `exempt` names the agents whose owner
 * is asking: their items stay. A page may come back shorter than its limit; its cursor still points
 * after the last row the store read, so no item is ever shown twice or skipped once revealed.
 */
export async function delayFeedItems<T extends { agentId: string; tickId: string }>(
  delay: LiveDelay,
  items: readonly T[],
  now: Date,
  exempt: (agentId: string) => boolean | Promise<boolean> = () => false,
): Promise<T[]> {
  if (!items.some((item) => heldBack(item.tickId, now))) return [...items];
  const linked = await delay.linked(now);
  const held = new Set<string>();
  for (const item of items) {
    if (heldBack(item.tickId, now) && linked(item.agentId)) held.add(item.agentId);
  }
  for (const agentId of [...held]) {
    if (await exempt(agentId)) held.delete(agentId);
  }
  return items.filter((item) => !(held.has(item.agentId) && heldBack(item.tickId, now)));
}
