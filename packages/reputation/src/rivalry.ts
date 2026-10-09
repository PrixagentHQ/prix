import type {
  AgentId,
  RankTapeDay,
  Rivalry,
  RivalryDayInput,
  RivalryDayResult,
  RivalryEngine,
  RivalryEvent,
  SeasonId,
  UtcDay,
} from '@prix/contracts';
import {
  RIVALRY_FORM_CLOSE_DAYS,
  RIVALRY_FORM_MIN_SWAPS,
  RIVALRY_KEEP_CLOSE_DAYS,
  RIVALRY_MAX_ACTIVE_PER_AGENT,
  RIVALRY_WINDOW_TAPE_DAYS,
  rivalryGap,
  rivalryId,
} from '@prix/contracts';

/**
 * Rivalries: facts from a daily rank tape. Two agents that sit close in the table and changed places.
 * docs/contracts/phase-6-social.md section 5.4. This module reads only the tape (the official rank of
 * each visible, ranked agent on each final day). It reads no score and no stat, and nothing in scoring,
 * ranking or replay imports it. A rivalry is not a prediction, a score or advice.
 *
 * Rules, per season and division, for each taped day D over the last RIVALRY_WINDOW_TAPE_DAYS tape
 * days up to D:
 *   gap g: 1 place when D has fewer than 20 ranked agents, else 2 (one g for the whole window).
 *   close: window days on which both agents were ranked within g places of each other.
 *   swaps: consecutive window days, both ranked on each, on which the order of the two flips.
 *   candidates: only pairs within g places on D (at most 2g partners per agent; no all-pairs loop).
 *   keep: an active pair stays while close >= 3, and ends `apart` when it falls below.
 *   form: not active, close >= 5, swaps >= 1, and both agents have fewer than 2 active rivalries.
 *     Assignment order: kept rivalries first (they hold their places), then candidates by swaps desc,
 *     close desc, sum of gaps asc, pair id asc. "Sum of gaps" is the sum of the absolute rank
 *     differences over the window days on which both were ranked.
 *   overtake: an active pair whose order flips between the previous tape day both were ranked and D.
 *   series: each active rivalry appends [D, rankA, rankB] every tape day; a new one starts with the
 *     window that formed it.
 *
 * Hand-computed example (the throwaway check in .artifacts and qa's tests use it). Agents x, y, z with
 * fewer than 20 ranked (g = 1). Tape: T0 x1 y2 z3; T1 y1 x2 z3; T2 x1 y2 z3; T3 same; T4 same; T5 y1 x2 z3,
 * then y1 z2 x3 for T6 to T13. On T4 the pair x-y has close 5 and swaps 2 (T0 to T1, T1 to T2): it forms.
 * On T5 the order flips: an overtake by y, one lead change. The close days are T0 to T5 (six). A window
 * of ten days ending at T13 keeps only T4 and T5 of them (close 2 < 3): it ends `apart` on T13.
 *
 * What it does not defend against: accounts made to sit beside each other, agents that copy each
 * other's prompts, and a tape built from luck. A rivalry says two ranks were near and crossed, not that
 * either agent is skilled. A pair that ended can form again in the same season (the stored row is then
 * replaced), because the engine sees only the active rivalries.
 */

type Tape = readonly RankTapeDay[];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const pairOf = (a: AgentId, b: AgentId): [AgentId, AgentId] => (a < b ? [a, b] : [b, a]);

interface PairStats {
  close: number;
  swaps: number;
  gapSum: number;
}

function pairStats(maps: ReadonlyArray<ReadonlyMap<AgentId, number>>, a: AgentId, b: AgentId, g: number): PairStats {
  let close = 0;
  let swaps = 0;
  let gapSum = 0;
  let previous = 0;
  for (const m of maps) {
    const ra = m.get(a);
    const rb = m.get(b);
    if (ra === undefined || rb === undefined) {
      previous = 0;
      continue;
    }
    const diff = ra - rb;
    const gap = Math.abs(diff);
    gapSum += gap;
    if (gap <= g) close += 1;
    const sign = diff < 0 ? -1 : 1;
    if (previous !== 0 && sign !== previous) swaps += 1;
    previous = sign;
  }
  return { close, swaps, gapSum };
}

function mapsOf(tape: Tape): Array<Map<AgentId, number>> {
  return tape.map((t) => new Map<AgentId, number>(t.ranks.map(([id, rank]): [AgentId, number] => [id, rank])));
}

function matchDay(input: RivalryDayInput): RivalryDayResult {
  const upserts: Rivalry[] = [];
  const events: RivalryEvent[] = [];
  const tape = input.tape.slice(-RIVALRY_WINDOW_TAPE_DAYS);
  const today = tape[tape.length - 1];
  if (!today) return { upserts, events };
  const maps = mapsOf(tape);
  const todayMap = maps[maps.length - 1] as Map<AgentId, number>;
  const g = rivalryGap(today.ranks.length);
  const day = today.day;
  const seasonId = input.seasonId;
  const windowDays = tape.length;

  const detailOf = (s: PairStats, ra: number | null, rb: number | null): Record<string, number> => {
    const detail: Record<string, number> = {};
    if (ra !== null && rb !== null) detail.gap = Math.abs(ra - rb);
    detail.closeDays = s.close;
    detail.swaps = s.swaps;
    detail.windowDays = windowDays;
    return detail;
  };

  const counts = new Map<AgentId, number>();
  const bump = (id: AgentId): void => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  const activeKeys = new Set<string>();

  // Rivalries already active: append the day, flag an overtake, keep or end them.
  const actives = [...input.active]
    .filter((r) => r.status === 'active' && r.seasonId === seasonId && r.division === input.division)
    .sort((x, y) => cmp(rivalryId(seasonId, x.agentA, x.agentB), rivalryId(seasonId, y.agentA, y.agentB)));
  for (const r of actives) {
    activeKeys.add(`${r.agentA}|${r.agentB}`);
    if (r.lastDay >= day) {
      bump(r.agentA);
      bump(r.agentB);
      continue; // this day is already in the row
    }
    const ra = todayMap.get(r.agentA) ?? null;
    const rb = todayMap.get(r.agentB) ?? null;
    const stats = pairStats(maps, r.agentA, r.agentB, g);
    let leader = r.leader;
    let leadChanges = r.leadChanges;
    let seq = 0;
    if (ra !== null && rb !== null) {
      const higher = ra < rb ? r.agentA : r.agentB;
      // The previous tape day, inside the window, on which both were ranked.
      let before: number | null = null;
      for (let i = maps.length - 2; i >= 0; i--) {
        const m = maps[i] as Map<AgentId, number>;
        const pa = m.get(r.agentA);
        const pb = m.get(r.agentB);
        if (pa !== undefined && pb !== undefined) {
          before = pa < pb ? -1 : 1;
          break;
        }
      }
      if (before !== null && before !== (ra < rb ? -1 : 1)) {
        events.push({
          seasonId,
          agentA: r.agentA,
          agentB: r.agentB,
          day,
          seq,
          kind: 'overtake',
          subject: higher,
          rankA: ra,
          rankB: rb,
          detail: detailOf(stats, ra, rb),
        });
        seq += 1;
        leadChanges += 1;
      }
      leader = higher;
    }
    const keep = stats.close >= RIVALRY_KEEP_CLOSE_DAYS;
    const next: Rivalry = {
      ...r,
      status: keep ? 'active' : 'ended',
      endedDay: keep ? null : day,
      endReason: keep ? null : 'apart',
      leader,
      leadChanges,
      lastDay: day,
      series: [...r.series, [day, ra, rb]],
    };
    if (keep) {
      bump(r.agentA);
      bump(r.agentB);
    } else {
      events.push({
        seasonId,
        agentA: r.agentA,
        agentB: r.agentB,
        day,
        seq,
        kind: 'ended',
        subject: null,
        rankA: ra,
        rankB: rb,
        detail: detailOf(stats, ra, rb),
      });
    }
    upserts.push(next);
  }

  // Candidates: only pairs within g places on D.
  const ordered = [...today.ranks].sort((x, y) => x[1] - y[1] || cmp(x[0], y[0]));
  interface Candidate {
    a: AgentId;
    b: AgentId;
    id: string;
    stats: PairStats;
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const first = ordered[i] as readonly [AgentId, number];
    for (let j = i + 1; j < ordered.length; j++) {
      const second = ordered[j] as readonly [AgentId, number];
      if (second[1] - first[1] > g) break;
      const [a, b] = pairOf(first[0], second[0]);
      if (activeKeys.has(`${a}|${b}`)) continue;
      const stats = pairStats(maps, a, b, g);
      if (stats.close >= RIVALRY_FORM_CLOSE_DAYS && stats.swaps >= RIVALRY_FORM_MIN_SWAPS) {
        candidates.push({ a, b, id: rivalryId(seasonId, a, b), stats });
      }
    }
  }
  candidates.sort(
    (x, y) =>
      y.stats.swaps - x.stats.swaps ||
      y.stats.close - x.stats.close ||
      x.stats.gapSum - y.stats.gapSum ||
      cmp(x.id, y.id),
  );
  for (const c of candidates) {
    if ((counts.get(c.a) ?? 0) >= RIVALRY_MAX_ACTIVE_PER_AGENT) continue;
    if ((counts.get(c.b) ?? 0) >= RIVALRY_MAX_ACTIVE_PER_AGENT) continue;
    bump(c.a);
    bump(c.b);
    const ra = todayMap.get(c.a) as number;
    const rb = todayMap.get(c.b) as number;
    upserts.push({
      seasonId,
      division: input.division,
      agentA: c.a,
      agentB: c.b,
      status: 'active',
      formedDay: day,
      endedDay: null,
      endReason: null,
      leader: ra < rb ? c.a : c.b,
      leadChanges: 0,
      lastDay: day,
      series: tape.map((t, i): Rivalry['series'][number] => {
        const m = maps[i] as Map<AgentId, number>;
        return [t.day, m.get(c.a) ?? null, m.get(c.b) ?? null];
      }),
    });
    events.push({
      seasonId,
      agentA: c.a,
      agentB: c.b,
      day,
      seq: 0,
      kind: 'formed',
      subject: null,
      rankA: ra,
      rankB: rb,
      detail: detailOf(c.stats, ra, rb),
    });
  }
  return { upserts, events };
}

function endSeason(input: { active: readonly Rivalry[]; lastTape: RankTapeDay | null; day: UtcDay }): RivalryDayResult {
  const upserts: Rivalry[] = [];
  const events: RivalryEvent[] = [];
  const ranks = new Map<AgentId, number>(
    input.lastTape ? input.lastTape.ranks.map(([id, r]): [AgentId, number] => [id, r]) : [],
  );
  const list = input.active
    .filter((r) => r.status === 'active')
    .sort((x, y) => cmp(rivalryId(x.seasonId, x.agentA, x.agentB), rivalryId(y.seasonId, y.agentA, y.agentB)));
  for (const r of list) {
    const endedDay = input.lastTape ? input.lastTape.day : r.lastDay;
    const ra = ranks.get(r.agentA) ?? null;
    const rb = ranks.get(r.agentB) ?? null;
    const detail: Record<string, number> = {};
    if (ra !== null && rb !== null) detail.gap = Math.abs(ra - rb);
    detail.leadChanges = r.leadChanges;
    detail.seasonEnd = 1;
    upserts.push({ ...r, status: 'ended', endedDay, endReason: 'season_end' });
    events.push({
      seasonId: r.seasonId,
      agentA: r.agentA,
      agentB: r.agentB,
      day: endedDay,
      // The last tape day may already hold an overtake of this pair at seq 0.
      seq: endedDay === r.lastDay ? 1 : 0,
      kind: 'ended',
      subject: null,
      rankA: ra,
      rankB: rb,
      detail,
    });
  }
  return { upserts, events };
}

function replay(input: { tapes: Tape }): { rivalries: Rivalry[]; events: RivalryEvent[] } {
  const rows = new Map<string, Rivalry>();
  const events: RivalryEvent[] = [];
  const history = new Map<string, RankTapeDay[]>();
  const lastSeason = new Map<string, SeasonId>();
  const active = new Map<string, Map<string, Rivalry>>();

  const apply = (result: RivalryDayResult, live: Map<string, Rivalry>): void => {
    for (const u of result.upserts) {
      const pair = `${u.agentA}|${u.agentB}`;
      rows.set(`${u.seasonId}|${u.division}|${pair}`, u);
      if (u.status === 'active') live.set(pair, u);
      else live.delete(pair);
    }
    events.push(...result.events);
  };

  for (const t of input.tapes) {
    const live = active.get(t.division) ?? new Map<string, Rivalry>();
    active.set(t.division, live);
    const previous = lastSeason.get(t.division);
    if (previous !== undefined && previous !== t.seasonId) {
      const old = history.get(`${previous}|${t.division}`) ?? [];
      apply(endSeason({ active: [...live.values()], lastTape: old[old.length - 1] ?? null, day: t.day }), live);
    }
    lastSeason.set(t.division, t.seasonId);
    const key = `${t.seasonId}|${t.division}`;
    const days = history.get(key) ?? [];
    days.push(t);
    history.set(key, days);
    apply(
      matchDay({
        seasonId: t.seasonId,
        division: t.division,
        tape: days.slice(-RIVALRY_WINDOW_TAPE_DAYS),
        active: [...live.values()],
      }),
      live,
    );
  }
  const rivalries = [...rows.values()].sort(
    (x, y) =>
      cmp(x.seasonId, y.seasonId) || cmp(x.division, y.division) || cmp(x.agentA, y.agentA) || cmp(x.agentB, y.agentB),
  );
  return { rivalries, events };
}

export const rivalryEngine: RivalryEngine = { matchDay, endSeason, replay };
