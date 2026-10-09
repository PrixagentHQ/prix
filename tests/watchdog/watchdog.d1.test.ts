import { env as baseEnv } from 'cloudflare:workers';
import { CRON_PLAN, stepsFor } from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../apps/api/src/index.ts';

/**
 * The watchdog of the clocks (security review, finding 17b). Every schedule is a Durable Object
 * clock (D-073), and an ordinary request restarts a stopped one (`ensureClocks`). If every clock
 * stopped at once, nothing would start them until somebody visits. A Cron Trigger with an
 * expression outside `CRON_PLAN` closes that gap: its `scheduled()` starts every clock and runs no
 * step, because `stepsFor` gives an expression it does not know no step.
 *
 * Runs in the Workers runtime against the local D1 of the other Workers tests. The Workers test
 * config declares no Durable Object binding, so `CLOCK` is a stand-in that records each start.
 */

/** A watchdog expression: twice an hour, off the minutes of `CRON_PLAN`. */
const WATCHDOG = '13,43 * * * *';
const KNOWN_CRONS = Object.keys(CRON_PLAN);
const db = (baseEnv as unknown as { DB: D1Database }).DB;

function setup() {
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
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
    props: {},
  };
  const run = async (cron: string): Promise<void> => {
    const controller = { cron, scheduledTime: Date.now(), noRetry: () => undefined };
    const scheduled = worker.scheduled as unknown as (c: unknown, e: unknown, x: unknown) => Promise<void>;
    await scheduled(controller, env, ctx);
    await Promise.all(pending.splice(0));
  };
  return { started, run };
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the watchdog trigger', () => {
  it('uses an expression that is not a schedule of CRON_PLAN and has no step', () => {
    expect(KNOWN_CRONS).not.toContain(WATCHDOG);
    expect(stepsFor(WATCHDOG)).toEqual([]);
  });

  it('starts every clock and runs no step', async () => {
    const log = vi.spyOn(console, 'log');
    const { started, run } = setup();
    const ticks = await count('ticks');
    const leagueState = await count('league_state');

    await run(WATCHDOG);

    expect([...started].sort()).toEqual([...KNOWN_CRONS].sort());
    expect(await count('ticks')).toBe(ticks);
    expect(await count('league_state')).toBe(leagueState);
    const stepEvents = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => /_step"|step_failed|step_not_configured/.test(line));
    expect(stepEvents).toEqual([]);
  });

  it('starts every clock on every run, even right after a request or a run checked them', async () => {
    const { started, run } = setup();
    await run(WATCHDOG);
    await run(WATCHDOG);
    expect(started).toHaveLength(2 * KNOWN_CRONS.length);
  });
});
