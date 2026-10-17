import { CLOCK_ALARM_FANOUT_CALLS, CRON_PLAN, SOCIAL_CRON } from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Clock } from './index.ts';

/**
 * The clocks' fan-out (docs/contracts/phase-6-holders.md revision 8b, R8-SEC-2; revision 8c, R8C-3, CR8B-6):
 * the social clock's alarm calls start() on no other clock and makes no Durable Object call at all, so that its
 * invocation's subrequests are the social step's (`CLOCK_ALARM_FANOUT_CALLS`, 0, booked in
 * docs/contracts/phase-6-holders-2.md section 8). The league, reputation, deliver and token alarms each keep
 * their four start() calls, so every clock, the social one among them, is still started by the others.
 *
 * As tests/workers/clock.test.ts does, the instance is made from the prototype of `Clock` with the two fields
 * the base class would set, because the runtime builds the base class only around a real DurableObjectState.
 * The env holds the CLOCK namespace alone: every step the alarm then runs fails at its first read of the
 * configuration and logs `step_failed`, so no step reads a database or the network here.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
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

const CRONS = Object.keys(CRON_PLAN);
const OTHER_CRONS = CRONS.filter((cron) => cron !== SOCIAL_CRON);

/** A clock of `cron` whose CLOCK namespace counts every call made on it. */
function clockOf(cron: string) {
  const storage = new MemoryStorage();
  storage.data.set('cron', cron);
  storage.alarm = Date.now();
  const calls: string[] = [];
  const started: string[] = [];
  const CLOCK = {
    idFromName: (name: string) => {
      calls.push(`idFromName ${name}`);
      return { name };
    },
    idFromString: (id: string) => {
      calls.push(`idFromString ${id}`);
      return { name: id };
    },
    newUniqueId: () => {
      calls.push('newUniqueId');
      return { name: 'unique' };
    },
    get: (id: { name: string }) => {
      calls.push(`get ${id.name}`);
      return {
        start: async (name: string) => {
          calls.push(`start ${name}`);
          expect(name).toBe(id.name);
          started.push(name);
        },
      };
    },
    getByName: (name: string) => {
      calls.push(`getByName ${name}`);
      return { start: async () => undefined };
    },
  };
  const env = { CLOCK };
  const state = { storage, id: { name: 'test-clock' }, waitUntil: () => undefined };
  const clock = Object.create(Clock.prototype, { ctx: { value: state }, env: { value: env } }) as Clock;
  /** Like `runDurableObjectAlarm`: removes the due alarm, then runs the handler. */
  const runAlarm = async (): Promise<void> => {
    storage.alarm = null;
    await clock.alarm();
  };
  return { storage, calls, started, runAlarm };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the social clock's alarm (R8-SEC-2, R8C-3)", () => {
  it('names five schedules, the social one among them', () => {
    expect(CRONS).toContain(SOCIAL_CRON);
    expect(OTHER_CRONS).toHaveLength(4);
  });

  it('calls start() on no other clock and makes no Durable Object call (CLOCK_ALARM_FANOUT_CALLS, 0)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { storage, calls, started, runAlarm } = clockOf(SOCIAL_CRON);
    await runAlarm();
    expect(started).toEqual([]);
    expect(calls).toEqual([]);
    expect(calls.length).toBe(CLOCK_ALARM_FANOUT_CALLS);
    // It still keeps its own schedule: the next alarm is set at a minute the social expression names.
    expect(storage.alarm).not.toBeNull();
    const at = new Date(storage.alarm ?? 0);
    expect(at.getTime()).toBeGreaterThan(Date.now());
    expect(at.getUTCMinutes() % 5).toBe(3);
    expect(storage.data.get('cron')).toBe(SOCIAL_CRON);
  });
});

describe('every other alarm keeps its fan-out (CR8B-6)', () => {
  for (const cron of OTHER_CRONS) {
    it(`the clock of "${cron}" starts the four others, the social clock among them`, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { storage, started, runAlarm } = clockOf(cron);
      await runAlarm();
      expect(started.sort()).toEqual(CRONS.filter((other) => other !== cron).sort());
      expect(started).toHaveLength(4);
      expect(started).toContain(SOCIAL_CRON);
      expect(storage.alarm).not.toBeNull();
    });
  }
});
