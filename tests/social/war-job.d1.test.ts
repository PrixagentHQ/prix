import type { ModelResponse, WarRecord } from '@prix/contracts';
import {
  HOUSE_NEURONS_PER_DAY,
  noDecisionCodeSchema,
  SOCIAL_JOB_MAX_MODEL_CALLS,
  SOCIAL_JOB_MAX_STATEMENTS,
  socialFailureCursor,
  WAR_MAX_OUTPUT_TOKENS,
  WAR_NEURONS_PER_DAY,
  WAR_RULES,
  WAR_TIMEOUT_MS,
} from '@prix/contracts';
import { DECISION_SYSTEM_MESSAGE } from '@prix/runtime/prompts';
import { createModelWarJob } from '@prix/runtime/social/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { decisionJson, modelText } from '../support/fakes.ts';
import { SEASON_1, TEST_STOCK_SYMBOLS } from '../support/fixtures.ts';
import type { ModelScript } from './support/d1.ts';
import { db, jobDeps, meteredDb, resetDb, storesOn, warWorld } from './support/d1.ts';
import { createWar, dailyTick, entrantOf, GEMMA, GPT_OSS, LLAMA, MISTRAL, STRATEGY, WAR_ID } from './support/war.ts';

/**
 * The model_war job (docs/contracts/phase-6-social.md section 5.3) on the real database, with scripted
 * models. Every run is counted by a wrapper around the database; the models are fakes that record what
 * they were asked and by whom.
 */

const plain = storesOn(db);

const GOOD = decisionJson({ NVDA: 20, MSFT: 20 }, 'Holds two large companies in equal parts.');
const ok = (neurons: number | null = 12): ModelResponse => ({
  ok: true,
  text: GOOD,
  inputTokens: 1_500,
  outputTokens: 60,
  neurons,
});
const allGood: ModelScript = { [LLAMA]: () => ok(), [GEMMA]: () => ok(), [GPT_OSS]: () => ok(null) };

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Setup {
  script?: ModelScript;
  groqApiKey?: string | null;
}

function setup({ script = allGood, groqApiKey }: Setup = {}) {
  const metered = meteredDb(db);
  const stores = storesOn(metered.db);
  const models = warWorld(script, groqApiKey === undefined ? {} : { groqApiKey });
  const world = jobDeps(stores, { now: '2026-10-12T15:30:00.000Z', war: models.deps });
  const job = createModelWarJob(world.deps);
  return {
    metered,
    models,
    world,
    job,
    /** One run at 15:30 UTC of `day`, counted. */
    async run(day: string) {
      const at = new Date(`${day}T15:30:00.000Z`);
      metered.reset();
      const outcome = await job.run(at);
      return {
        outcome,
        statements: metered.meter.statements,
        writes: metered.meter.writes,
        calls: metered.meter.calls,
      };
    },
  };
}

const war = async (): Promise<WarRecord> => (await plain.social.getWar(WAR_ID)) as WarRecord;
const rows = () => plain.social.listWarRows(WAR_ID);
const entrants = () => plain.social.listWarEntrants(WAR_ID);
const neurons = (day: string) => plain.social.getWarNeurons(day);
const count = async (table: string): Promise<number> =>
  ((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()) as { n: number }).n;

const D1 = '2026-10-12';
const D2 = '2026-10-13';
const D3 = '2026-10-14';

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('a war-day', () => {
  it('asks every entrant once, at once, and writes the rows, the entrants and the war in one batch', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup();
    const result = await t.run(D1);
    expect(result.outcome).toBe('done');

    // At most four model calls, one per entrant, and every entrant got the same request.
    expect(t.models.calls).toHaveLength(3);
    expect(t.models.calls.length).toBeLessThanOrEqual(SOCIAL_JOB_MAX_MODEL_CALLS);
    const [first, ...others] = t.models.calls;
    for (const other of others) {
      expect(other.request).toEqual(first?.request);
    }
    expect(first?.request).toMatchObject({
      maxOutputTokens: WAR_MAX_OUTPUT_TOKENS,
      timeoutMs: WAR_TIMEOUT_MS,
      jsonDecision: true,
    });
    // The strategy of the war is in the prompt, and nothing else decides it.
    expect(JSON.stringify(first?.request.messages)).toContain(STRATEGY.slice(0, 40));

    // One batch inside the limit of statements.
    expect(result.statements).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
    const written = await rows();
    expect(written.map((row) => `${row.slot}:${row.status}`)).toEqual(['A:decided', 'B:decided', 'C:decided']);
    const after = await entrants();
    expect(after.map((e) => e.days)).toEqual([1, 1, 1]);
    for (const e of after) expect(e.lastTickId).toBe(`${D1}T15:00Z`);
    expect(after.map((e) => e.stats.decidedCount)).toEqual([1, 1, 1]);
    // The portfolio of each entrant is the portfolio of its row.
    for (const [index, e] of after.entries()) expect(e.portfolio).toEqual(written[index]?.portfolio);

    const record = await war();
    const sha = await sha256Hex(DECISION_SYSTEM_MESSAGE);
    expect(record).toMatchObject({
      status: 'running',
      firstTickId: `${D1}T15:00Z`,
      lastTickId: `${D1}T15:00Z`,
      systemMessageSha256: sha,
      promptVersion: `decision@${sha.slice(0, 12)}`,
    });
  });

  it('sends the same settings to everyone, adds only the extra of a Workers AI model, and gives Groq no extra', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup();
    await t.run(D1);
    const by = new Map(t.models.calls.map((call) => [call.modelId, call]));
    expect(by.get(LLAMA)?.aiExtra).toEqual({});
    expect(by.get(GEMMA)?.aiExtra).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(by.get(GPT_OSS)?.provider).toBe('groq');
    expect(by.get(GPT_OSS)?.aiExtra).toBeNull();
    // No sampling field is sent to anyone: a request has messages, a limit, a timeout and the JSON mode.
    for (const call of t.models.calls) {
      expect(Object.keys(call.request).sort()).toEqual(['jsonDecision', 'maxOutputTokens', 'messages', 'timeoutMs']);
    }
  });

  it('settles the neurons of the day: the reservation becomes what the provider reported', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup();
    await t.run(D1);
    // Two Workers AI entrants reported 12 neurons each; Groq spends none.
    expect(await neurons(D1)).toBe(24);
    const written = await rows();
    expect(written.map((row) => row.neurons)).toEqual([12, 12, null]);
  });

  it('hands a Groq key only to the one allowlisted Groq model and never writes or logs it', async () => {
    const key = 'gsk_fixture_secret_key_9f8e7d6c5b4a39281716';
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup({ groqApiKey: key });
    await t.run(D1);
    expect(t.models.groqKeysSeen).toEqual([key]);
    expect(JSON.stringify(t.world.logs)).not.toContain(key);
    for (const table of ['wars', 'war_entrants', 'war_rows', 'war_usage', 'job_state', 'counters']) {
      const dump = JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results);
      expect(dump, table).not.toContain(key);
      expect(dump, table).not.toContain('gsk_');
    }
  });

  it('asks nobody a second time on the same day, and writes nothing', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup();
    await t.run(D1);
    const callsBefore = t.models.calls.length;
    const rowsBefore = await count('war_rows');
    const second = await t.run(D1);
    expect(second.outcome).toBe('idle');
    expect(second.writes).toBe(0);
    expect(second.statements).toBeLessThanOrEqual(2);
    expect(t.models.calls).toHaveLength(callsBefore);
    expect(await count('war_rows')).toBe(rowsBefore);
  });

  it('refuses a second batch for a day already written, as a whole', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup();
    await t.run(D1);
    const written = await rows();
    const before = { entrants: await entrants(), war: await war(), rows: await count('war_rows') };
    // The same war-day again: refused, and nothing in it is applied.
    const again = await plain.social.writeWarDay(
      WAR_ID,
      written,
      before.entrants.map((e) => ({ ...e, days: e.days + 1 })),
      { status: 'complete', endedAt: '2026-10-12T16:00:00.000Z' },
      '2026-10-12T16:00:00.000Z',
    );
    expect(again).toBe(false);
    expect(await entrants()).toEqual(before.entrants);
    expect(await war()).toEqual(before.war);
    expect(await count('war_rows')).toBe(before.rows);

    // A batch with one new row and one old row is refused as a whole too.
    const fresh = { ...(written[0] as (typeof written)[number]), tickId: `${D2}T15:00Z` };
    const mixed = await plain.social.writeWarDay(
      WAR_ID,
      [fresh, written[1] as (typeof written)[number]],
      before.entrants,
      {},
      '2026-10-13T16:00:00.000Z',
    );
    expect(mixed).toBe(false);
    expect(await count('war_rows')).toBe(before.rows);
  });
});

describe('the budget, all or nothing', () => {
  it('asks nobody and writes nothing when the war cap of the day cannot cover every entrant', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    await plain.social.adjustWarNeurons(D1, WAR_NEURONS_PER_DAY - 5);
    const t = setup();
    const result = await t.run(D1);
    expect(result.outcome).toBe('idle');
    expect(t.models.calls).toEqual([]);
    expect(await count('war_rows')).toBe(0);
    expect(await neurons(D1)).toBe(WAR_NEURONS_PER_DAY - 5);
    expect((await war()).status).toBe('scheduled');
  });

  it('asks nobody when the league decisions of the day and the war would pass the house ceiling', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    await plain.store.addAiNeurons(D1, 'decision', HOUSE_NEURONS_PER_DAY - 20);
    const t = setup();
    const result = await t.run(D1);
    expect(result.outcome).toBe('idle');
    expect(t.models.calls).toEqual([]);
    expect(await neurons(D1)).toBe(0);
    expect(await count('war_rows')).toBe(0);
  });

  it('runs when the budget covers everyone, and never reserves more than the worst case', async () => {
    await createWar(plain, [LLAMA, GEMMA, MISTRAL]);
    await dailyTick(plain, D1);
    const t = setup({
      script: { [LLAMA]: () => ok(30), [GEMMA]: () => ok(8), [MISTRAL]: () => ok(20) },
    });
    const result = await t.run(D1);
    expect(result.outcome).toBe('done');
    expect(await neurons(D1)).toBe(58);
    expect(await neurons(D1)).toBeLessThanOrEqual(WAR_NEURONS_PER_DAY);
  });
});

describe('an answer that is not a decision, and a model that fails', () => {
  it('makes a row of no decision, keeps the portfolio and never crashes', async () => {
    await createWar(plain, [LLAMA, GEMMA, MISTRAL, GPT_OSS]);
    await dailyTick(plain, D1);
    const t = setup({
      script: {
        [LLAMA]: () => modelText('I think you should buy NVDA now, definitely.'),
        [GEMMA]: () => modelText(decisionJson({ NVDA: 60, MSFT: 60 }, 'More than the whole portfolio.')),
        [MISTRAL]: () => modelText(decisionJson({ NVDA: 20 }, 'See https://evil.example for the plan.')),
        [GPT_OSS]: () => {
          throw new Error('the model blew up; secret-detail-4242');
        },
      },
    });
    const result = await t.run(D1);
    expect(result.outcome).toBe('done');
    const written = await rows();
    expect(written).toHaveLength(4);
    for (const row of written) {
      expect(row.status).toBe('no_decision');
      expect(noDecisionCodeSchema.safeParse(row.code).success, `${row.slot} ${row.code}`).toBe(true);
      expect(row.fills).toEqual([]);
      expect(row.targetsBps).toBeNull();
      expect(row.portfolio).toEqual(entrantOf('A', LLAMA).portfolio);
    }
    expect(written.map((row) => row.code)).toContain('reason_invalid');
    // The portfolios are untouched, the war is running, and nothing of the failure is logged.
    for (const e of await entrants()) {
      expect(e.portfolio).toEqual(entrantOf('A', LLAMA).portfolio);
      expect(e.stats.noDecisionCount).toBe(1);
      expect(e.days).toBe(1);
    }
    expect((await war()).status).toBe('running');
    expect(JSON.stringify(t.world.logs)).not.toContain('secret-detail-4242');
    expect(JSON.stringify(written)).not.toContain('secret-detail-4242');
  });

  it('caps a weight at 40 percent as the league does, and trades at the war prices with the paper engine costs', async () => {
    await createWar(plain, [LLAMA, GEMMA]);
    await dailyTick(plain, D1);
    const t = setup({
      script: {
        [LLAMA]: () => modelText(decisionJson({ TSLA: 90 }, 'Everything in one company.')),
        [GEMMA]: () => ok(),
      },
    });
    await t.run(D1);
    const first = (await rows())[0];
    expect(first).toMatchObject({ slot: 'A', status: 'decided', targetsBps: { TSLA: 4000 } });
    expect(first?.fills).toHaveLength(1);
    expect(first?.fills[0]).toMatchObject({ symbol: 'TSLA', side: 'buy' });
    // Costs are the fee and the slippage of the paper engine: 10 bps each of the notional, rounded up.
    const fill = first?.fills[0] as NonNullable<typeof first>['fills'][number];
    expect(first?.costMicro).toBe(fill.feeMicro + fill.slippageMicro);
    expect(first?.equityMicro).toBeLessThan(10_000_000_000);
  });

  it('keeps the universe a war froze: a war of the 20 Stock Tokens is never offered a coin and never holds one', async () => {
    // Section 21.7: a war created before the coins joined keeps its 20 symbols on a tick that has 22.
    await createWar(plain, [LLAMA, GEMMA], { rules: { ...WAR_RULES, universe: [...TEST_STOCK_SYMBOLS] } });
    await dailyTick(plain, D1);
    const t = setup({
      script: {
        [LLAMA]: () => modelText(decisionJson({ BTC: 30, NVDA: 20 }, 'A coin and one large company.')),
        [GEMMA]: () => modelText(decisionJson({ ETH: 30 }, 'One coin only.')),
      },
    });
    await t.run(D1);
    for (const call of t.models.calls) {
      const asked = call.request.messages.map((message) => message.content).join('\n');
      expect(asked, call.modelId).not.toMatch(/\b(BTC|ETH)\b/);
    }
    const written = await rows();
    expect(written).toHaveLength(2);
    for (const row of written) {
      expect(row.fills.map((fill) => fill.symbol)).not.toContain('BTC');
      expect(row.fills.map((fill) => fill.symbol)).not.toContain('ETH');
      expect(Object.keys(row.targetsBps ?? {})).not.toContain('BTC');
      expect(Object.keys(row.targetsBps ?? {})).not.toContain('ETH');
    }
    for (const e of await entrants()) {
      expect(Object.keys(e.portfolio.holdings), e.slot).not.toContain('BTC');
      expect(Object.keys(e.portfolio.holdings), e.slot).not.toContain('ETH');
    }
    expect((await war()).rules.universe).toEqual([...TEST_STOCK_SYMBOLS]);
  });

  it('records a model that is no longer on the allowlist as provider_rejected and asks nobody for it', async () => {
    await createWar(plain, [LLAMA, GEMMA]);
    // A rogue entrant row with a model the contract does not list.
    await db
      .prepare(
        "UPDATE war_entrants SET model_id = 'evil/model', body = json_set(body, '$.modelId', 'evil/model') WHERE war_id = ?1 AND slot = 'B'",
      )
      .bind(WAR_ID)
      .run();
    await dailyTick(plain, D1);
    const t = setup();
    await t.run(D1);
    expect(t.models.calls.map((call) => call.modelId)).toEqual([LLAMA]);
    const written = await rows();
    expect(written.find((row) => row.slot === 'B')).toMatchObject({ status: 'no_decision', code: 'provider_rejected' });
  });

  it('records a Groq entrant without a key as no decision and asks nobody for it', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup({ groqApiKey: null });
    await t.run(D1);
    expect(t.models.calls.map((call) => call.modelId).sort()).toEqual([GEMMA, LLAMA].sort());
    expect((await rows()).find((row) => row.slot === 'C')?.status).toBe('no_decision');
  });
});

describe('allocation_exhausted', () => {
  it('discards the war-day for everyone: no rows, no change to anyone, neurons counted, nobody asked again', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup({
      script: {
        [LLAMA]: () => ok(),
        [GEMMA]: () => ({ ok: false, code: 'allocation_exhausted', httpStatus: 429 }),
        [GPT_OSS]: () => ok(null),
      },
    });
    const first = await t.run(D1);
    expect(first.outcome).toBe('done');
    expect(await count('war_rows')).toBe(0);
    const record = await war();
    expect(record.status).toBe('scheduled');
    expect(record.lastTickId).toBeNull();
    for (const e of await entrants()) {
      expect(e.days).toBe(0);
      expect(e.lastTickId).toBeNull();
    }
    // The neurons are counted: the day is closed to wars.
    expect(await neurons(D1)).toBeGreaterThan(0);
    const calls = t.models.calls.length;
    const second = await t.run(D1);
    expect(second.outcome).toBe('idle');
    expect(t.models.calls).toHaveLength(calls);

    // Tomorrow is a new day with its own budget, and the war plays.
    await dailyTick(plain, D2);
    const next = setup({ script: allGood });
    const third = await next.run(D2);
    expect(third.outcome).toBe('done');
    expect(await count('war_rows')).toBe(3);
  });
});

describe('the prompt freeze', () => {
  it('stops the war when the decision prompt is not the one it froze, before anybody is asked', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const t = setup();
    await t.run(D1);
    // The freeze now holds a different hash, as if prompts.ts had changed between two war-days.
    await plain.social.updateWar(WAR_ID, { systemMessageSha256: 'f'.repeat(64) }, '2026-10-12T20:00:00.000Z');
    await dailyTick(plain, D2);
    const callsBefore = t.models.calls.length;
    const second = await t.run(D2);
    expect(second.outcome).toBe('done');
    expect(t.models.calls).toHaveLength(callsBefore);
    expect(await war()).toMatchObject({ status: 'stopped', stopReason: 'prompt_changed' });
    expect(await count('war_rows')).toBe(3);
    // A stopped war is not open: the next day is idle.
    await dailyTick(plain, D3);
    expect((await t.run(D3)).outcome).toBe('idle');
  });
});

describe('a model that is turned away', () => {
  const rejected = (): ModelResponse => ({ ok: false, code: 'provider_rejected', httpStatus: 404 });

  it('stops the war after two war-days in a row of provider_rejected for one entrant', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    await dailyTick(plain, D2);
    const t = setup({ script: { ...allGood, [GEMMA]: rejected } });
    expect((await t.run(D1)).outcome).toBe('done');
    expect((await war()).status).toBe('running');
    expect((await entrants()).find((e) => e.slot === 'B')?.rejectedDays).toBe(1);
    expect((await t.run(D2)).outcome).toBe('done');
    expect(await war()).toMatchObject({ status: 'stopped', stopReason: 'model_unavailable' });
    expect((await war()).endedAt).not.toBeNull();
    const written = await rows();
    expect(written.filter((row) => row.slot === 'B').map((row) => row.code)).toEqual([
      'provider_rejected',
      'provider_rejected',
    ]);
    // Both days are in the record, and the other entrants played them.
    expect(written).toHaveLength(6);
  });

  it('does not stop the war when a good day comes between two rejections', async () => {
    await createWar(plain);
    for (const day of [D1, D2, D3]) await dailyTick(plain, day);
    let call = 0;
    const flaky = (): ModelResponse => {
      call += 1;
      return call === 2 ? ok() : rejected();
    };
    const t = setup({ script: { ...allGood, [GEMMA]: flaky } });
    await t.run(D1);
    await t.run(D2);
    await t.run(D3);
    expect((await war()).status).toBe('running');
    expect((await entrants()).find((e) => e.slot === 'B')?.rejectedDays).toBe(1);
  });
});

describe('the shape of a war: completion, the deadline, the start', () => {
  it('completes when every entrant has its war-days, and then there is no open war', async () => {
    await createWar(plain, [LLAMA, GEMMA], { tradingDays: 5, startsOn: D1, deadlineDay: '2026-10-27' });
    const t = setup({ script: { [LLAMA]: () => ok(), [GEMMA]: () => ok() } });
    const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    for (const day of days) {
      await dailyTick(plain, day);
      expect((await t.run(day)).outcome).toBe('done');
    }
    expect(await war()).toMatchObject({ status: 'complete', lastTickId: '2026-10-16T15:00Z' });
    expect((await war()).endedAt).not.toBeNull();
    expect((await entrants()).map((e) => e.days)).toEqual([5, 5]);
    expect(await rows()).toHaveLength(10);
    await dailyTick(plain, '2026-10-19');
    const idle = await t.run('2026-10-19');
    expect(idle.outcome).toBe('idle');
    expect(idle.writes).toBe(0);
  });

  it('stops a scheduled war whose deadline has passed with the reason budget', async () => {
    await createWar(plain, [LLAMA, GEMMA], { startsOn: '2026-10-12', tradingDays: 5, deadlineDay: '2026-10-27' });
    const t = setup();
    const result = await t.run('2026-10-28');
    expect(result.outcome).toBe('done');
    expect(await war()).toMatchObject({ status: 'stopped', stopReason: 'budget' });
    expect(t.models.calls).toEqual([]);
  });

  it('does nothing before the day it starts, while a tick is processing, or without a complete daily tick', async () => {
    await createWar(plain, [LLAMA, GEMMA], { startsOn: '2026-10-14', tradingDays: 5, deadlineDay: '2026-10-29' });
    const t = setup();
    await dailyTick(plain, D1);
    expect((await t.run(D1)).outcome).toBe('idle');

    // On its day with no daily tick at all.
    expect((await t.run('2026-10-14')).outcome).toBe('idle');
    // With a daily tick that has not completed.
    await dailyTick(plain, '2026-10-14', { status: 'processing' });
    expect((await t.run('2026-10-14')).outcome).toBe('idle');
    // With an hourly tick still processing.
    await db.prepare("UPDATE ticks SET status = 'complete' WHERE id = ?1").bind('2026-10-14T15:00Z').run();
    await dailyTick(plain, '2026-10-14', { status: 'processing', daily: false, hour: 17 });
    expect((await t.run('2026-10-14')).outcome).toBe('idle');
    expect(t.models.calls).toEqual([]);
    expect(await count('war_rows')).toBe(0);
    // Once nothing is processing, it plays.
    await db.prepare("UPDATE ticks SET status = 'complete' WHERE status = 'processing'").run();
    expect((await t.run('2026-10-14')).outcome).toBe('done');
  });

  it('treats a day without a daily tick as no war-day for anyone', async () => {
    await createWar(plain, [LLAMA, GEMMA], { startsOn: D1, tradingDays: 5, deadlineDay: '2026-10-27' });
    const t = setup();
    await dailyTick(plain, D1);
    await t.run(D1);
    // D2 has no daily tick at all (a hole in the league's day); D3 plays.
    expect((await t.run(D2)).outcome).toBe('idle');
    await dailyTick(plain, D3);
    await t.run(D3);
    expect((await entrants()).map((e) => e.days)).toEqual([2, 2]);
    expect((await rows()).map((row) => row.tickId)).toEqual([
      `${D1}T15:00Z`,
      `${D1}T15:00Z`,
      `${D3}T15:00Z`,
      `${D3}T15:00Z`,
    ]);
  });
});

describe('idle runs and failures', () => {
  it('costs one read and writes nothing when there is no open war', async () => {
    const t = setup();
    const result = await t.run(D1);
    expect(result.outcome).toBe('idle');
    expect(result.writes).toBe(0);
    expect(result.statements).toBeLessThanOrEqual(2);
  });

  it('answers failed and never throws when the database fails at any statement, logs only the job and the error name', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    // The number of statements a full run sends.
    const probe = setup();
    const full = (await probe.run(D1)).statements;
    expect(full).toBeGreaterThan(8);
    await resetDb([{ season: SEASON_1, method: null }]);
    await createWar(plain);
    await dailyTick(plain, D1);
    for (let after = 0; after < full; after++) {
      const t = setup();
      t.metered.failAfter(after, new Error('database exploded: secret-token-5150'));
      const outcome = await t.job.run(new Date(`${D1}T15:30:00.000Z`));
      // Contract 6.1 (section 18.6): a job that throws answers `failed`, logged with its name, and never throws.
      expect(outcome, `after ${after}`).toBe('failed');
      t.metered.clear();
      const failed = t.world.logs.filter((entry) => entry.event === 'social_job_failed');
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]?.data).toMatchObject({ job: 'model_war' });
      expect(JSON.stringify(t.world.logs)).not.toContain('secret-token-5150');
      // A failure before the last batch leaves no row and no half-played day.
      const rowCount = await count('war_rows');
      expect([0, 3]).toContain(rowCount);
      if (rowCount === 0) expect((await entrants()).every((e) => e.days === 0)).toBe(true);
      // Start again from a clean day for the next failure point.
      await db.prepare('DELETE FROM war_rows').run();
      await db.prepare('DELETE FROM war_usage').run();
      // And a day no run has asked yet, failed for the first time: under contract 6.1 a war-day recorded
      // as asked is marked missed rather than asked again, and three failures in a row wait for the next
      // day. Both rules have their own tests in hardening/jobs; here each failure point starts afresh.
      await db
        .prepare('DELETE FROM job_state WHERE name IN (?1, ?2)')
        .bind('social:war', socialFailureCursor('model_war'))
        .run();
      await db.prepare('UPDATE war_entrants SET days = 0, last_tick_id = NULL').run();
      await db
        .prepare(
          "UPDATE wars SET status = 'scheduled', body = json_set(body, '$.status', 'scheduled', '$.lastTickId', json('null'), '$.firstTickId', json('null'), '$.systemMessageSha256', json('null'), '$.promptVersion', json('null'))",
        )
        .run();
    }
  });
});
