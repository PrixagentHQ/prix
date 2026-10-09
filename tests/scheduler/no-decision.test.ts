import type { AgentRecord, ModelResponse, NoDecisionCode } from '@prix/contracts';
import { decisionRowSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectNoSecret } from '../support/api.ts';
import { decisionJson } from '../support/fakes.ts';
import { startingPortfolio, startingStats, TEST_PRICES } from '../support/fixtures.ts';
import type { Answer, World } from '../support/scheduler.ts';
import { createWorld, expectReplayMatches, proApiKey } from '../support/scheduler.ts';

/**
 * Acceptance, docs/SPEC.md section 8: "Invalid model output produces 'no decision', never a
 * crash or a corrupt portfolio." Every way an answer can fail (docs/CONTRACTS.md section 6)
 * must leave the portfolio exactly as it was and must not stop the other agents.
 */

const T15 = '2026-10-06T15:00Z';
const START = '2026-10-06T15:00:05.000Z';
const fail = (
  code: 'provider_rejected' | 'provider_error' | 'provider_timeout',
  httpStatus: number | null,
): ModelResponse => ({
  ok: false,
  code,
  httpStatus,
});

const BAD_OUTPUT: [string, string, NoDecisionCode][] = [
  ['prose instead of JSON', 'I would put a fifth of the portfolio into NVDA.', 'invalid_json'],
  ['JSON inside a code fence', `\`\`\`json\n${decisionJson({ NVDA: 20 })}\n\`\`\``, 'invalid_json'],
  ['JSON with reasoning in front', `<think>NVDA is strong.</think>${decisionJson({ NVDA: 20 })}`, 'invalid_json'],
  ['an empty answer', '', 'invalid_json'],
  ['an object without a reason', '{"targets":{"NVDA":20}}', 'schema_mismatch'],
  [
    'an object with an extra field',
    '{"targets":{"NVDA":20},"reason":"Buys.","orders":[{"buy":"NVDA"}]}',
    'schema_mismatch',
  ],
  ['a symbol outside the universe', decisionJson({ XXXX: 20 }), 'unknown_symbol'],
  ['an unknown symbol beside a bad weight', decisionJson({ NVDA: 99.999, XXXX: 1 }), 'unknown_symbol'],
  ['a weight of 100.01%', decisionJson({ NVDA: 100.01 }), 'weight_out_of_range'],
  ['a weight with three decimals', decisionJson({ NVDA: 20.005 }), 'weight_out_of_range'],
  ['a negative weight: a short', decisionJson({ NVDA: -20 }), 'weight_out_of_range'],
  ['a weight of 400%: leverage', decisionJson({ NVDA: 400 }), 'weight_out_of_range'],
  ['weights that add up to 120%', decisionJson({ NVDA: 40, MSFT: 40, AAPL: 40 }), 'weights_exceed_100'],
  ['weights of 60 and 60', decisionJson({ NVDA: 60, MSFT: 60 }), 'weights_exceed_100'],
  ['an empty reason', decisionJson({ NVDA: 20 }, '   '), 'reason_invalid'],
  ['a reason with a link', decisionJson({ NVDA: 20 }, 'Buy now at https://example.com/pump'), 'reason_invalid'],
  ['a reason that promises a return', decisionJson({ NVDA: 20 }, 'Guaranteed gains, risk-free.'), 'reason_invalid'],
  ['a reason with abuse', decisionJson({ NVDA: 20 }, 'The market is shitty today.'), 'reason_invalid'],
];

describe('invalid model output is "no decision"', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  it.each(BAD_OUTPUT)('%s', async (_name, output, code) => {
    // The agent already holds something, so a corrupted portfolio would show.
    const portfolio = { cashMicro: 5_000_000_000, holdings: { NVDA: 10_000_000, TSLA: 4_000_000 } };
    const bad = await world.addOpen(1, { portfolio });
    const good = await world.addOpen(2);
    world.answers.set(1, output);

    const tick = await world.runTick(START);
    expect(tick.status).toBe('complete');

    const row = world.row(bad, T15);
    expect(decisionRowSchema.safeParse(row).success).toBe(true);
    // 10 NVDA at 182.41 + 4 TSLA at 248.76 + 5,000 USD cash = 1,824.10 + 995.04 + 5,000.
    expect(row).toMatchObject({
      status: 'no_decision',
      code,
      targetsBps: null,
      reason: null,
      fills: [],
      costMicro: 0,
      portfolio,
      equityMicro: 5_000_000_000 + 1_824_100_000 + 995_040_000,
      model: 'house',
    });
    expect(row.strategyAt).toBe(bad.strategyChangedAt);
    expect(await world.portfolio(bad)).toEqual(portfolio);
    expect(await world.stats(bad)).toMatchObject({
      noDecisionCount: 1,
      decidedCount: 0,
      skippedCount: 0,
      tradeCount: 0,
      tradingDays: 1,
    });

    // The agent beside it decided as usual.
    expect(world.row(good, T15).status).toBe('decided');
    expect((await world.portfolio(good)).holdings.NVDA).toBeGreaterThan(0);
    // What the model said is not in the log.
    if (output.trim().length > 12) expect(world.log.text()).not.toContain(output.trim().slice(0, 40));
  });

  it('handles a tick in which every agent answers badly', async () => {
    const agents: AgentRecord[] = [];
    for (const [index, [, output]] of BAD_OUTPUT.entries()) {
      agents.push(await world.addOpen(index + 1));
      world.answers.set(index + 1, output);
    }
    const tick = await world.runTick(START);
    expect(tick.status).toBe('complete');
    for (const [index, agent] of agents.entries()) {
      const row = world.row(agent, T15);
      expect([row.status, row.code]).toEqual(['no_decision', BAD_OUTPUT[index]?.[2]]);
      expect(row.portfolio).toEqual(startingPortfolio());
      expect(row.equityMicro).toBe(10_000_000_000);
      expect(await world.stats(agent)).toEqual({
        ...startingStats(),
        noDecisionCount: 1,
        tradingDays: 1,
        lastDay: '2026-10-06',
        daily: [{ day: '2026-10-06', equityMicro: 10_000_000_000 }],
      });
    }
    const total = world.reports.reduce((sum, entry) => sum + entry.report.noDecision, 0);
    expect(total).toBe(BAD_OUTPUT.length);
    expect(world.reports.reduce((sum, entry) => sum + entry.report.decided, 0)).toBe(0);
  });

  it('counts a failed answer as being asked: the agent is not asked again at that tick', async () => {
    await world.addOpen(1);
    world.answers.set(1, 'not json');
    await world.runTick(START);
    expect(world.decisionCalls.filter((call) => call.n === 1)).toHaveLength(1);
  });

  it('lets an agent decide again at the next tick after a bad answer', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, 'not json');
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.answers.delete(1);
    await world.runTick('2026-10-06T16:00:05.000Z');
    expect((await world.rows(agent)).map((row) => [row.status, row.code])).toEqual([
      ['no_decision', 'invalid_json'],
      ['decided', null],
    ]);
    await expectReplayMatches(world, agent);
  });

  it('accepts a valid answer with surrounding whitespace, and records targets in basis points', async () => {
    const agent = await world.addOpen(1);
    world.answers.set(1, `\n  ${decisionJson({ NVDA: 21.5, MSFT: 0 }, 'Adds\n to   NVDA.')}  \n`);
    await world.runTick(START);
    expect(world.row(agent, T15)).toMatchObject({
      status: 'decided',
      targetsBps: { NVDA: 2_150 },
      reason: 'Adds to NVDA.',
    });
  });

  it('keeps an ordinary reason that names Chainlink and Robinhood Chain', async () => {
    const agent = await world.addOpen(1);
    const reason = 'Chainlink prices on Robinhood Chain show NVDA leading.';
    world.answers.set(1, decisionJson({ NVDA: 10 }, reason));
    await world.runTick(START);
    expect(world.row(agent, T15)).toMatchObject({ status: 'decided', reason });
  });

  it('stores a reason as plain text, markup and all, and never longer than 240 characters', async () => {
    const agent = await world.addOpen(1);
    world.answers.set(1, decisionJson({ NVDA: 10 }, `<script>alert(1)</script> ${'long '.repeat(100)}`));
    await world.runTick(START);
    const reason = world.row(agent, T15).reason as string;
    expect(reason.startsWith('<script>alert(1)</script>')).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(240);
  });
});

describe('a provider that fails is "no decision" with the code of the failure', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  const cases: [string, Answer, NoDecisionCode][] = [
    ['HTTP 401: the key is wrong', fail('provider_rejected', 401), 'provider_rejected'],
    ['HTTP 403', fail('provider_rejected', 403), 'provider_rejected'],
    ['HTTP 404: the model name is wrong', fail('provider_rejected', 404), 'provider_rejected'],
    ['HTTP 500', fail('provider_error', 500), 'provider_error'],
    ['HTTP 429', fail('provider_error', 429), 'provider_error'],
    ['a network failure', fail('provider_error', null), 'provider_error'],
    ['a timeout', fail('provider_timeout', null), 'provider_timeout'],
  ];

  it.each(cases)('%s', async (_name, answer, code) => {
    const agent = await world.addPro(1);
    const other = await world.addPro(2);
    world.answers.set(1, answer);
    await world.runTick('2026-10-06T15:00:05.000Z');
    const row = world.row(agent, '2026-10-06T15:00Z');
    expect(row).toMatchObject({
      status: 'no_decision',
      code,
      fills: [],
      costMicro: 0,
      portfolio: startingPortfolio(),
      model: 'openai:model-1',
    });
    expect(world.row(other, '2026-10-06T15:00Z').status).toBe('decided');
    await expectReplayMatches(world, agent);
  });

  it('writes key_unavailable, and calls no model, when a key cannot be opened', async () => {
    const agent = await world.addPro(1);
    const other = await world.addPro(2);
    const record = world.store.modelKeys.get(agent.modelKeyId as string);
    if (!record) throw new Error('no key');
    // The ciphertext of another row: it does not open under this row's id and owner.
    record.ciphertext = (world.store.modelKeys.get(other.modelKeyId as string) as typeof record).ciphertext;

    await world.runTick('2026-10-06T15:00:05.000Z');
    const row = world.row(agent, '2026-10-06T15:00Z');
    expect(row).toMatchObject({
      status: 'no_decision',
      code: 'key_unavailable',
      fills: [],
      portfolio: startingPortfolio(),
    });
    expect(world.decisionCalls.some((call) => call.n === 1)).toBe(false);
    expect(world.own.built.some((built) => built.keyId === agent.modelKeyId)).toBe(false);
    expect(world.row(other, '2026-10-06T15:00Z').status).toBe('decided');
  });

  it('writes key_unavailable when the key of an agent is gone', async () => {
    const agent = await world.addPro(1);
    world.store.modelKeys.delete(agent.modelKeyId as string);
    await world.runTick('2026-10-06T15:00:05.000Z');
    expect(world.row(agent, '2026-10-06T15:00Z')).toMatchObject({ status: 'no_decision', code: 'key_unavailable' });
    expect(world.decisionCalls).toHaveLength(0);
  });

  it('writes provider_error for an Open agent when the house model fails', async () => {
    const agent = await world.addOpen(1);
    world.answers.set(1, fail('provider_error', 500));
    await world.runTick(START);
    expect(world.row(agent, T15)).toMatchObject({
      status: 'no_decision',
      code: 'provider_error',
      model: 'house',
      portfolio: startingPortfolio(),
    });
  });

  it('never puts a key into a row, a log line or the database, whatever fails', async () => {
    const agents = [await world.addPro(1), await world.addPro(2), await world.addPro(3)];
    world.answers.set(1, fail('provider_rejected', 401));
    world.answers.set(2, 'not json');
    await world.runTick('2026-10-06T15:00:05.000Z');
    const keys = [1, 2, 3].map(proApiKey);
    expectNoSecret(world.log.text(), keys, 'the log');
    expectNoSecret(world.store.dump(), keys, 'the database');
    for (const agent of agents)
      expect(JSON.stringify(world.row(agent, '2026-10-06T15:00Z'))).not.toContain('fixture-own-key');
    // Nor a prompt: the row keeps a hash of it.
    for (const agent of agents)
      expect(JSON.stringify(world.row(agent, '2026-10-06T15:00Z'))).not.toContain(agent.prompt);
  });

  it('values an untouched portfolio at the prices of the tick', async () => {
    const portfolio = { cashMicro: 1_000_000_000, holdings: { AAPL: 20_000_000 } };
    const agent = await world.addOpen(1, { portfolio });
    world.answers.set(1, 'not json');
    world.feed.prices = { ...TEST_PRICES, AAPL: 200_000_000 };
    await world.runTick(START);
    // 20 AAPL at 200 USD + 1,000 USD cash.
    expect(world.row(agent, T15).equityMicro).toBe(5_000_000_000);
    expect(await world.stats(agent)).toMatchObject({
      equityMicro: 5_000_000_000,
      seasonReturnBps: -5_000,
      maxDrawdownBps: 5_000,
    });
  });
});
