import type { RankTapeDay, Rivalry } from '@prix/contracts';
import { RIVALRY_FORM_CLOSE_DAYS, RIVALRY_KEEP_CLOSE_DAYS, RIVALRY_MAX_ACTIVE_PER_AGENT } from '@prix/contracts';
import { rivalryEngine } from '@prix/reputation/rivalry';
import { describe, expect, it } from 'vitest';
import { createRng } from '../support/prng.ts';
import { day } from './support/dna.ts';
import { A, B, C, D, E, F, filler, fold, measure, rivalryGap, rivalryId, S1, S2, tape } from './support/rivalry.ts';

/**
 * The rivalry engine (docs/contracts/phase-6-social.md section 5.4) from its rules: a gap of one place
 * below 20 ranked agents and two from 20; close at 5 days and one swap to form, 3 close days to keep,
 * two active rivalries at most per agent; an overtake event, an `apart` end, a `season_end` end.
 */

describe('a rivalry that forms, has an overtake and ends apart', () => {
  // Agents A and B trade the first two places, F sits far below. Fewer than 20 are ranked: gap 1.
  //   T0 A1 B2   T1 B1 A2   T2 A1 B2   T3 A1 B2   T4 A1 B2    -> by T4: close 5 days, swaps 2 (T0-T1, T1-T2)
  //   T5 B1 A2                                                   -> an overtake by B
  //   T6..T13 A1 B4 F5                                           -> apart: window T4..T13 holds 2 close days
  // It cannot form earlier: at T3 only four days are close.
  const days: RankTapeDay[] = [
    tape(0, [
      [A, 1],
      [B, 2],
      [F, 5],
    ]),
    tape(1, [
      [B, 1],
      [A, 2],
      [F, 5],
    ]),
    tape(2, [
      [A, 1],
      [B, 2],
      [F, 5],
    ]),
    tape(3, [
      [A, 1],
      [B, 2],
      [F, 5],
    ]),
    tape(4, [
      [A, 1],
      [B, 2],
      [F, 5],
    ]),
    tape(5, [
      [B, 1],
      [A, 2],
      [F, 5],
    ]),
    ...Array.from({ length: 8 }, (_, k) =>
      tape(6 + k, [
        [A, 1],
        [B, 4],
        [F, 5],
      ]),
    ),
  ];

  it('forms on the fifth close day, with the facts the sentence uses', () => {
    const book = fold(days.slice(0, 5));
    expect(book.events).toHaveLength(1);
    expect(book.events[0]).toEqual({
      seasonId: S1,
      agentA: A,
      agentB: B,
      day: day(4),
      seq: 0,
      kind: 'formed',
      subject: null,
      rankA: 1,
      rankB: 2,
      detail: { gap: 1, closeDays: 5, swaps: 2, windowDays: 5 },
    });
    const row = book.rows.get(`${S1}|open|${A}|${B}`) as Rivalry;
    expect(row).toMatchObject({
      status: 'active',
      formedDay: day(4),
      endedDay: null,
      endReason: null,
      leader: A,
      leadChanges: 0,
      lastDay: day(4),
    });
    // The series starts with the window that formed it, one point per tape day.
    expect(row.series).toEqual([
      [day(0), 1, 2],
      [day(1), 2, 1],
      [day(2), 1, 2],
      [day(3), 1, 2],
      [day(4), 1, 2],
    ]);
  });

  it('does not form on the fourth close day', () => {
    expect(fold(days.slice(0, 4)).rows.size).toBe(0);
  });

  it('records an overtake by the agent now higher, and a lead change', () => {
    const book = fold(days.slice(0, 6));
    const overtake = book.events.find((e) => e.kind === 'overtake');
    expect(overtake).toMatchObject({ day: day(5), seq: 0, subject: B, rankA: 2, rankB: 1 });
    const row = book.rows.get(`${S1}|open|${A}|${B}`) as Rivalry;
    expect(row.leader).toBe(B);
    expect(row.leadChanges).toBe(1);
    expect(row.series).toHaveLength(6);
    expect(row.series[5]).toEqual([day(5), 2, 1]);
  });

  it('ends apart when fewer than 3 of the last 10 days are close, and not before', () => {
    // T12 window T3..T12 holds the close days T3, T4, T5: three, kept. T13 window T4..T13: two, ended.
    const kept = fold(days.slice(0, 13));
    expect((kept.rows.get(`${S1}|open|${A}|${B}`) as Rivalry).status).toBe('active');
    const ended = fold(days);
    // Two lead changes: B passes A on T5, and A passes B again on T6 when B drops to 4.
    const row = ended.rows.get(`${S1}|open|${A}|${B}`) as Rivalry;
    expect(row).toMatchObject({ status: 'ended', endedDay: day(13), endReason: 'apart', leadChanges: 2 });
    const last = ended.events[ended.events.length - 1];
    expect(last).toMatchObject({ kind: 'ended', day: day(13), subject: null });
    expect(last?.detail).toMatchObject({ closeDays: 2, windowDays: 10 });
    // Ended is final for the engine's active list: another day changes nothing.
    const later = fold([
      ...days,
      tape(14, [
        [A, 1],
        [B, 4],
        [F, 5],
      ]),
    ]);
    expect(later.events).toHaveLength(ended.events.length);
  });

  it('replay equals the stored result of the day-by-day run', () => {
    const book = fold(days);
    const replayed = rivalryEngine.replay({ tapes: days });
    expect(replayed.rivalries).toEqual([...book.rows.values()]);
    expect(replayed.events).toEqual(book.events);
  });
});

describe('the gap grows from 20 ranked agents', () => {
  // A and B alternate between ranks 1 and 3 with a filler between them: a gap of two places each day.
  const trade = (index: number, count: number) => {
    const order = index % 2 === 0 ? [A, B] : [B, A];
    const ranks: Array<[string, number]> = [
      [order[0] as string, 1],
      [filler(0), 2],
      [order[1] as string, 3],
    ];
    for (let n = 1; n < count - 2; n++) ranks.push([filler(n), 3 + n]);
    return tape(index, ranks);
  };

  it('rivalryGap is 1 below 20 and 2 from 20', () => {
    expect(rivalryGap(19)).toBe(1);
    expect(rivalryGap(20)).toBe(2);
    expect(rivalryGap(250)).toBe(2);
  });

  it('forms at a gap of two places when 20 are ranked', () => {
    const book = fold(Array.from({ length: 6 }, (_, i) => trade(i, 20)));
    const row = book.rows.get(`${S1}|open|${A}|${B}`);
    expect(row?.status).toBe('active');
    expect(row?.formedDay).toBe(day(4));
  });

  it('does not form at a gap of two places when 19 are ranked', () => {
    const book = fold(Array.from({ length: 12 }, (_, i) => trade(i, 19)));
    // The filler between them is within one place of both (they form rivalries with it), but A and B are never close.
    expect(book.rows.has(`${S1}|open|${A}|${B}`)).toBe(false);
  });
});

describe('the limit of two active rivalries per agent, and the order of candidates', () => {
  const base = (over: Partial<Rivalry>): Rivalry => ({
    seasonId: S1,
    division: 'open',
    agentA: A,
    agentB: B,
    status: 'active',
    formedDay: day(0),
    endedDay: null,
    endReason: null,
    leader: A,
    leadChanges: 0,
    lastDay: day(8),
    series: [],
    ...over,
  });

  it('keeps rivalries first: an agent with two active rivalries forms no third', () => {
    // A sits at 2 all ten days. B at 1 all days; C beside A on days 0-4 (3), far later; D joins at 3
    // on days 5-9 and flips with A on day 7. A-B and A-C are active; A-D would be a third: refused.
    const days = [
      ...[0, 1, 2, 3, 4].map((i) =>
        tape(i, [
          [B, 1],
          [A, 2],
          [C, 3],
          [D, 6],
        ]),
      ),
      tape(5, [
        [B, 1],
        [A, 2],
        [D, 3],
        [C, 6],
      ]),
      tape(6, [
        [B, 1],
        [A, 2],
        [D, 3],
        [C, 6],
      ]),
      tape(7, [
        [B, 1],
        [D, 2],
        [A, 3],
        [C, 6],
      ]),
      tape(8, [
        [B, 1],
        [A, 2],
        [D, 3],
        [C, 6],
      ]),
      tape(9, [
        [B, 1],
        [A, 2],
        [D, 3],
        [C, 6],
      ]),
    ];
    const active = [base({ agentA: A, agentB: B }), base({ agentA: A, agentB: C })];
    const result = rivalryEngine.matchDay({ seasonId: S1, division: 'open', tape: days, active });
    // Both kept rivalries are updated with the day, and no rivalry forms.
    expect(result.upserts.map((r) => `${r.agentA}-${r.agentB}`).sort()).toEqual([`${A}-${B}`, `${A}-${C}`]);
    for (const row of result.upserts) {
      expect(row.status).toBe('active');
      expect(row.lastDay).toBe(day(9));
      expect(row.series.at(-1)?.[0]).toBe(day(9));
    }
    expect(result.events.filter((e) => e.kind === 'formed')).toEqual([]);
    // The pair itself would have qualified: with a free slot A-D forms.
    const free = rivalryEngine.matchDay({ seasonId: S1, division: 'open', tape: days, active: [base({})] });
    expect(free.events.filter((e) => e.kind === 'formed').map((e) => `${e.agentA}-${e.agentB}`)).toEqual([`${A}-${D}`]);
  });

  it('gives a free slot to the candidate with more close days when swaps are equal', () => {
    // A has one active rivalry (with E, close on days 0-4) and one slot left. B and C both flip with A
    // twice; B was close on nine days and C on five: B takes the slot.
    const days = [
      tape(0, [
        [B, 1],
        [A, 2],
        [E, 3],
        [C, 7],
      ]),
      tape(1, [
        [A, 1],
        [B, 2],
        [E, 3],
        [C, 7],
      ]),
      tape(2, [
        [B, 1],
        [A, 2],
        [E, 3],
        [C, 7],
      ]),
      tape(3, [
        [B, 1],
        [A, 2],
        [E, 3],
        [C, 7],
      ]),
      tape(4, [
        [B, 1],
        [A, 2],
        [E, 3],
        [C, 7],
      ]),
      tape(5, [
        [B, 1],
        [A, 2],
        [C, 3],
        [E, 8],
      ]),
      tape(6, [
        [B, 1],
        [C, 2],
        [A, 3],
        [E, 8],
      ]),
      tape(7, [
        [B, 1],
        [A, 2],
        [C, 3],
        [E, 8],
      ]),
      tape(8, [
        [B, 1],
        [A, 2],
        [C, 3],
        [E, 8],
      ]),
      tape(9, [
        [B, 1],
        [A, 2],
        [C, 3],
        [E, 8],
      ]),
    ];
    const ab = measure(days, A, B, 1);
    const ac = measure(days, A, C, 1);
    expect(ab).toEqual({ close: 9, swaps: 2 });
    expect(ac).toEqual({ close: 5, swaps: 2 });
    const result = rivalryEngine.matchDay({
      seasonId: S1,
      division: 'open',
      tape: days,
      active: [base({ agentA: A, agentB: E, lastDay: day(8) })],
    });
    const formed = result.events.filter((e) => e.kind === 'formed');
    expect(formed.map((e) => `${e.agentA}-${e.agentB}`)).toEqual([`${A}-${B}`]);
  });
});

describe('overtakes are measured between the last two days on which both were ranked', () => {
  it('sees an overtake across a day on which one of them was unranked', () => {
    const days = [
      tape(0, [
        [A, 1],
        [B, 2],
      ]),
      tape(1, [
        [B, 1],
        [A, 2],
      ]),
      tape(2, [
        [A, 1],
        [B, 2],
      ]),
      tape(3, [
        [A, 1],
        [B, 2],
      ]),
      tape(4, [
        [A, 1],
        [B, 2],
      ]),
      // B has no rank on day 5.
      tape(5, [
        [A, 1],
        [E, 2],
      ]),
      tape(6, [
        [B, 1],
        [A, 2],
      ]),
    ];
    const book = fold(days);
    const overtakes = book.events.filter((e) => e.kind === 'overtake');
    expect(overtakes).toHaveLength(1);
    expect(overtakes[0]).toMatchObject({ day: day(6), subject: B });
    const row = book.rows.get(`${S1}|open|${A}|${B}`) as Rivalry;
    // The unranked day is in the series, with a null rank.
    expect(row.series.find((p) => p[0] === day(5))).toEqual([day(5), 1, null]);
  });
});

describe('the end of a season', () => {
  it('ends every active rivalry of the earlier season on its last tape day, with season_end', () => {
    const first = [0, 1, 2, 3, 4, 5].map((i) =>
      tape(
        i,
        i % 2 === 1
          ? [
              [B, 1],
              [A, 2],
            ]
          : [
              [A, 1],
              [B, 2],
            ],
      ),
    );
    const second = [6, 7].map((i) =>
      tape(
        i,
        [
          [A, 1],
          [B, 2],
        ],
        { season: S2 },
      ),
    );
    const book = fold([...first, ...second]);
    const old = book.rows.get(`${S1}|open|${A}|${B}`) as Rivalry;
    expect(old).toMatchObject({ status: 'ended', endReason: 'season_end', endedDay: day(5) });
    const ended = book.events.filter((e) => e.kind === 'ended' && e.seasonId === S1);
    expect(ended).toHaveLength(1);
    // The last tape day already holds the overtake at seq 0, so the end is seq 1.
    expect(ended[0]).toMatchObject({ day: day(5), seq: 1, rankA: 2, rankB: 1 });
    expect(ended[0]?.detail).toMatchObject({ seasonEnd: 1, leadChanges: old.leadChanges });
    // A new season starts with nothing: no row of season two yet.
    expect([...book.rows.values()].filter((r) => r.seasonId === S2)).toEqual([]);
    // Replay agrees.
    const replayed = rivalryEngine.replay({ tapes: [...first, ...second] });
    expect(replayed.events).toEqual(book.events);
    expect(replayed.rivalries).toEqual([...book.rows.values()]);
  });

  it('ends nothing when no rivalry is active', () => {
    expect(rivalryEngine.endSeason({ active: [], lastTape: tape(3, [[A, 1]]), day: day(9) })).toEqual({
      upserts: [],
      events: [],
    });
  });
});

describe('properties on random tapes', () => {
  function randomTapes(seed: number) {
    const rng = createRng(seed);
    const agents = Array.from({ length: rng.int(4, 26) }, (_, n) => filler(100 + n));
    let order = rng.shuffle(agents);
    const out: RankTapeDay[] = [];
    const days = rng.int(14, 40);
    const switchAt = rng.int(Math.floor(days / 3), Math.floor((2 * days) / 3));
    for (let i = 0; i < days; i++) {
      // Neighbours swap places now and then, which is what makes rivalries.
      for (let k = 0; k < order.length - 1; k++) {
        if (rng.chance(0.18)) {
          const x = order[k] as string;
          order[k] = order[k + 1] as string;
          order[k + 1] = x;
        }
      }
      if (rng.chance(0.05)) order = rng.shuffle(order);
      const ranked = order.filter(() => !rng.chance(0.08));
      out.push(
        tape(
          i,
          ranked.map((id, rank) => [id, rank + 1] as const),
          { season: i < switchAt ? S1 : S2 },
        ),
      );
    }
    return out;
  }

  const seeds = Array.from({ length: 80 }, (_, k) => 1000 + k * 37);

  it('keeps every rule at every step of 80 random tapes', () => {
    let formedTotal = 0;
    let overtakeTotal = 0;
    for (const seed of seeds) {
      const tapes = randomTapes(seed);
      const history: RankTapeDay[] = [];
      const book = fold(tapes, (b, t) => {
        history.push(t);
        // Two active rivalries at most per agent, at every step.
        const counts = new Map<string, number>();
        for (const r of b.rows.values()) {
          if (r.status !== 'active') continue;
          counts.set(r.agentA, (counts.get(r.agentA) ?? 0) + 1);
          counts.set(r.agentB, (counts.get(r.agentB) ?? 0) + 1);
        }
        for (const [agent, count] of counts) {
          expect(count, `seed ${seed} ${agent} on ${t.day}`).toBeLessThanOrEqual(RIVALRY_MAX_ACTIVE_PER_AGENT);
        }
        // Every active rivalry of the season has at least 3 close days in the last 10, as of its last day.
        const season = history.filter((h) => h.seasonId === t.seasonId).slice(-10);
        const g = rivalryGap(t.ranks.length);
        for (const r of b.active(t.seasonId, t.division)) {
          if (r.lastDay !== t.day) continue;
          expect(measure(season, r.agentA, r.agentB, g).close, `seed ${seed} keep ${r.agentA}`).toBeGreaterThanOrEqual(
            RIVALRY_KEEP_CLOSE_DAYS,
          );
        }
      });

      // The order of every pair, and one row per pair and season.
      const keys = new Set<string>();
      for (const row of book.rows.values()) {
        expect(row.agentA < row.agentB).toBe(true);
        const key = rivalryId(row.seasonId, row.agentA, row.agentB);
        expect(keys.has(key), `duplicate row ${key}`).toBe(false);
        keys.add(key);
        expect(row.leadChanges).toBeGreaterThanOrEqual(0);
      }
      // Event keys are unique: events are insert-only under (season, pair, day, seq).
      const eventKeys = new Set<string>();
      for (const e of book.events) {
        const key = `${e.seasonId}|${e.agentA}|${e.agentB}|${e.day}|${e.seq}`;
        expect(eventKeys.has(key), `duplicate event ${key}`).toBe(false);
        eventKeys.add(key);
      }

      // Every formed and ended-apart event states facts that the tape confirms.
      for (const e of book.events) {
        const window = tapes.filter((t) => t.seasonId === e.seasonId && t.day <= e.day).slice(-10);
        const today = window[window.length - 1] as RankTapeDay;
        const g = rivalryGap(today.ranks.length);
        const m = measure(window, e.agentA, e.agentB, g);
        if (e.kind === 'formed') {
          formedTotal += 1;
          expect(m.close, `seed ${seed}`).toBeGreaterThanOrEqual(RIVALRY_FORM_CLOSE_DAYS);
          expect(m.swaps).toBeGreaterThanOrEqual(1);
          expect(e.detail).toMatchObject({ closeDays: m.close, swaps: m.swaps, windowDays: window.length });
          expect(Math.abs((e.rankA as number) - (e.rankB as number))).toBeLessThanOrEqual(g);
        }
        if (e.kind === 'ended' && e.detail.seasonEnd === undefined) {
          expect(m.close, `seed ${seed}`).toBeLessThan(RIVALRY_KEEP_CLOSE_DAYS);
        }
        if (e.kind === 'overtake') {
          overtakeTotal += 1;
          const better = (e.rankA as number) < (e.rankB as number) ? e.agentA : e.agentB;
          expect(e.subject).toBe(better);
        }
      }

      // The lead changes of a row are its overtake events.
      for (const row of book.rows.values()) {
        const overtakes = book.events.filter(
          (e) =>
            e.kind === 'overtake' && e.seasonId === row.seasonId && e.agentA === row.agentA && e.agentB === row.agentB,
        );
        expect(row.leadChanges).toBeGreaterThanOrEqual(0);
        // A pair that formed again after ending has a fresh row; its count never passes its events.
        expect(row.leadChanges).toBeLessThanOrEqual(overtakes.length);
      }

      // Replay reproduces the record, and does so twice the same way.
      const replayed = rivalryEngine.replay({ tapes });
      expect(replayed.rivalries, `seed ${seed}`).toEqual([...book.rows.values()].sort(sortRows));
      expect(replayed.events).toEqual(book.events);
      expect(JSON.stringify(rivalryEngine.replay({ tapes }))).toBe(JSON.stringify(replayed));
    }
    // The tapes are rich enough to prove something.
    expect(formedTotal).toBeGreaterThan(20);
    expect(overtakeTotal).toBeGreaterThan(10);
  });

  it('is idempotent for a day already in the row, and changes nothing without a candidate or an active rivalry', () => {
    const days = [
      tape(0, [
        [A, 1],
        [B, 2],
      ]),
      tape(1, [
        [B, 1],
        [A, 2],
      ]),
      tape(2, [
        [A, 1],
        [B, 2],
      ]),
      tape(3, [
        [A, 1],
        [B, 2],
      ]),
      tape(4, [
        [A, 1],
        [B, 2],
      ]),
    ];
    const book = fold(days);
    const again = rivalryEngine.matchDay({
      seasonId: S1,
      division: 'open',
      tape: days,
      active: book.active(S1, 'open'),
    });
    expect(again).toEqual({ upserts: [], events: [] });
    const quiet = rivalryEngine.matchDay({
      seasonId: S1,
      division: 'open',
      tape: [
        tape(0, [
          [A, 1],
          [B, 5],
          [C, 9],
        ]),
      ],
      active: [],
    });
    expect(quiet).toEqual({ upserts: [], events: [] });
    expect(rivalryEngine.matchDay({ seasonId: S1, division: 'open', tape: [], active: [] })).toEqual({
      upserts: [],
      events: [],
    });
  });

  it('does not change its input', () => {
    const tapes = randomTapes(5);
    const before = JSON.stringify(tapes);
    rivalryEngine.replay({ tapes });
    expect(JSON.stringify(tapes)).toBe(before);
  });
});

function sortRows(x: Rivalry, y: Rivalry): number {
  const a = `${x.seasonId}|${x.division}|${x.agentA}|${x.agentB}`;
  const b = `${y.seasonId}|${y.division}|${y.agentA}|${y.agentB}`;
  return a < b ? -1 : a > b ? 1 : 0;
}
