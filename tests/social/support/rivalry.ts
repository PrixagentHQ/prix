import type { Division, RankTapeDay, Rivalry, RivalryDayResult, RivalryEvent } from '@prix/contracts';
import { RIVALRY_WINDOW_TAPE_DAYS, rivalryGap, rivalryId } from '@prix/contracts';
import { rivalryEngine } from '@prix/reputation/rivalry';
import { testId } from '../../support/fixtures.ts';
import { day } from './dna.ts';

/** Agents with ids that sort in the order of their names: A < B < C < D < E. */
export const A = 'agentaaaaaaa';
export const B = 'agentbbbbbbb';
export const C = 'agentccccccc';
export const D = 'agentddddddd';
export const E = 'agenteeeeeee';
export const F = 'agentfffffff';

export const S1 = 'seasonaaaaaa';
export const S2 = 'seasonbbbbbb';

/** One tape day of the open division: `ranks` are [agent, rank] pairs, in any order. */
export function tape(
  index: number,
  ranks: ReadonlyArray<readonly [string, number]>,
  options: { season?: string; division?: Division } = {},
): RankTapeDay {
  return {
    seasonId: options.season ?? S1,
    division: options.division ?? 'open',
    day: day(index),
    method: 'v1',
    ranks: [...ranks].sort((x, y) => x[1] - y[1]),
  };
}

/** A filler agent, far from everyone else's rank. */
export const filler = (n: number): string => testId('fill', n);

/** The state a store would hold after the engine's results, kept apart from the engine's own `replay`. */
export class RivalryBook {
  readonly rows = new Map<string, Rivalry>();
  readonly events: RivalryEvent[] = [];

  private key(r: Pick<Rivalry, 'seasonId' | 'division' | 'agentA' | 'agentB'>): string {
    return `${r.seasonId}|${r.division}|${r.agentA}|${r.agentB}`;
  }

  active(seasonId: string, division: Division): Rivalry[] {
    return [...this.rows.values()].filter(
      (r) => r.seasonId === seasonId && r.division === division && r.status === 'active',
    );
  }

  apply(result: RivalryDayResult): void {
    for (const row of result.upserts) this.rows.set(this.key(row), structuredClone(row));
    this.events.push(...structuredClone(result.events));
  }

  /** Active rivalries of the agent, over every season. */
  activeOf(agent: string): Rivalry[] {
    return [...this.rows.values()].filter((r) => r.status === 'active' && (r.agentA === agent || r.agentB === agent));
  }
}

/**
 * The way the rivalry job drives the engine, written again here from the document: tape days in order,
 * the rivalries of the season before a season's first day ended with `endSeason`, then `matchDay`
 * over the last ten tape days of the season and division with the stored active rivalries.
 */
export function fold(
  tapes: readonly RankTapeDay[],
  observe?: (book: RivalryBook, t: RankTapeDay) => void,
): RivalryBook {
  const book = new RivalryBook();
  const seen = new Map<string, RankTapeDay[]>();
  const lastSeason = new Map<Division, string>();
  for (const t of tapes) {
    const before = lastSeason.get(t.division);
    if (before !== undefined && before !== t.seasonId) {
      const old = seen.get(`${before}|${t.division}`) ?? [];
      book.apply(
        rivalryEngine.endSeason({
          active: book.active(before, t.division),
          lastTape: old[old.length - 1] ?? null,
          day: t.day,
        }),
      );
    }
    lastSeason.set(t.division, t.seasonId);
    const key = `${t.seasonId}|${t.division}`;
    const days = [...(seen.get(key) ?? []), t];
    seen.set(key, days);
    book.apply(
      rivalryEngine.matchDay({
        seasonId: t.seasonId,
        division: t.division,
        tape: days.slice(-RIVALRY_WINDOW_TAPE_DAYS),
        active: book.active(t.seasonId, t.division),
      }),
    );
    observe?.(book, t);
  }
  return book;
}

export interface Measure {
  close: number;
  swaps: number;
}

/**
 * Close days and swaps of a pair over a window of tape days, from the definition in the document:
 * close is a day on which both are ranked within `g` places; a swap is a flip of the order between
 * two consecutive window days on both of which both are ranked.
 */
export function measure(window: readonly RankTapeDay[], a: string, b: string, g: number): Measure {
  let close = 0;
  let swaps = 0;
  let previous: number | null = null;
  for (const t of window) {
    const ra = t.ranks.find(([id]) => id === a)?.[1];
    const rb = t.ranks.find(([id]) => id === b)?.[1];
    if (ra === undefined || rb === undefined) {
      previous = null;
      continue;
    }
    if (Math.abs(ra - rb) <= g) close += 1;
    const order = ra < rb ? -1 : 1;
    if (previous !== null && previous !== order) swaps += 1;
    previous = order;
  }
  return { close, swaps };
}

export { rivalryGap, rivalryId };
