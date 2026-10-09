import { env as baseEnv } from 'cloudflare:workers';
import { CRON_PLAN } from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../apps/api/src/index.ts';

/**
 * The clock of the API Worker (D-073): one Durable Object per schedule, named by its cron
 * expression. A clock this release does not know, left behind by a rollback or a changed
 * expression, must stop and run nothing (Phase 6 security review, finding 1).
 *
 * The Workers test config declares no Durable Object binding and no `main`, so the helpers
 * `runDurableObjectAlarm` and `runInDurableObject` cannot reach `Clock`. The real methods of the
 * class run here, in the Workers runtime against the local D1 of the other tests, with a storage
 * that keeps the methods the clock uses, as the Durable Objects Storage API documents them. Its `deleteAll` keeps the alarm, as it does before compatibility date
 * 2026-02-24, so the test holds whatever date the Worker runs on.
 */

class MemoryStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number | Date): Promise<void> {
    this.alarm = typeof at === 'number' ? at : at.getTime();
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
}

const KNOWN = '7,37 * * * *';
const UNKNOWN = '4-59/5 * * * *';
const KNOWN_CRONS = Object.keys(CRON_PLAN);

const db = (baseEnv as unknown as { DB: D1Database }).DB;

function makeClock() {
  const storage = new MemoryStorage();
  const started: string[] = [];
  const CLOCK = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      start: async (cron: string) => {
        expect(cron).toBe(id.name);
        started.push(cron);
      },
    }),
  };
  const env = { ...(baseEnv as unknown as Record<string, unknown>), CLOCK };
  const state = { storage, id: { name: 'test-clock' }, waitUntil: () => undefined };
  // The runtime builds the base class only around a real DurableObjectState, so the instance is
  // made from the prototype of `Clock` with the two fields the base class would have set.
  const clock = Object.create(Clock.prototype, {
    ctx: { value: state },
    env: { value: env },
  }) as Clock;
  /** Like `runDurableObjectAlarm`: removes the due alarm, then runs the handler. */
  const runAlarm = async (): Promise<boolean> => {
    if (storage.alarm === null) return false;
    storage.alarm = null;
    await clock.alarm();
    return true;
  };
  return { clock, storage, started, runAlarm };
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

function events(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([line]) => {
    try {
      return (JSON.parse(String(line)) as { event?: string }).event ?? '';
    } catch {
      return '';
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a clock of a known schedule', () => {
  it('has an alarm once started, at the next minute its expression names', async () => {
    const { clock, storage } = makeClock();
    const before = Date.now();
    await clock.start(KNOWN);
    expect(storage.data.get('cron')).toBe(KNOWN);
    expect(storage.alarm).not.toBeNull();
    const at = new Date(storage.alarm ?? 0);
    expect(at.getTime()).toBeGreaterThan(before);
    expect(at.getTime() - before).toBeLessThanOrEqual(60 * 60_000);
    expect(at.getUTCSeconds()).toBe(0);
    expect([7, 37]).toContain(at.getUTCMinutes());
  });

  it('sets the next alarm when its alarm runs, and starts the other clocks', async () => {
    const { clock, storage, started, runAlarm } = makeClock();
    await clock.start(KNOWN);
    expect(await runAlarm()).toBe(true);
    expect(storage.alarm).not.toBeNull();
    const at = new Date(storage.alarm ?? 0);
    expect(at.getTime()).toBeGreaterThan(Date.now());
    expect([7, 37]).toContain(at.getUTCMinutes());
    expect(storage.data.get('cron')).toBe(KNOWN);
    expect(started.sort()).toEqual(KNOWN_CRONS.filter((cron) => cron !== KNOWN).sort());
  });
});

describe('a clock of a schedule this release does not know', () => {
  it('deletes its alarm and its storage, starts nothing and runs no step', async () => {
    const log = vi.spyOn(console, 'log');
    const { storage, started, runAlarm } = makeClock();
    // What a release with the fifth clock leaves behind after a rollback.
    storage.data.set('cron', UNKNOWN);
    storage.alarm = Date.now() + 60_000;
    const ticks = await count('ticks');
    const leagueState = await count('league_state');

    expect(await runAlarm()).toBe(true);

    expect(storage.alarm).toBeNull();
    expect(storage.data.size).toBe(0);
    expect(started).toEqual([]);
    expect(await count('ticks')).toBe(ticks);
    expect(await count('league_state')).toBe(leagueState);
    expect(events(log).filter((event) => event === 'clock_unknown')).toHaveLength(1);
    const line = log.mock.calls.find(([text]) => String(text).includes('clock_unknown'))?.[0];
    expect(JSON.parse(String(line))).toEqual({ event: 'clock_unknown', cron: UNKNOWN });
  });

  it('does nothing more if its alarm runs again', async () => {
    const { storage, started, runAlarm } = makeClock();
    storage.data.set('cron', UNKNOWN);
    storage.alarm = Date.now();
    await runAlarm();
    // An alarm is delivered at least once: a second delivery finds an empty object.
    storage.alarm = Date.now();
    await runAlarm();
    expect(storage.alarm).toBeNull();
    expect(storage.data.size).toBe(0);
    expect(started).toEqual([]);
  });
});
