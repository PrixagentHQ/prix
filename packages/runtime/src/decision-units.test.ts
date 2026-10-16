import type { PortfolioState } from '@prix/contracts';
import { decisionRowSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
// The scheduler world of qa (tests/support): an in-memory store, scripted market and models, and the
// real sim and scoring engines. Only read from here; `runSchedulerStep` is the code under test.
import { decisionJson } from '../../../tests/support/fakes.ts';
import type { World } from '../../../tests/support/scheduler.ts';
import { createWorld } from '../../../tests/support/scheduler.ts';

/**
 * An answer of weights written as fractions (every non-zero weight 1 or less, e.g. {"SPY": 0.6}) is
 * refused by the parser with weights_look_like_fractions, and through the scheduler it is no decision for
 * the round: the agent keeps what it holds.
 */

const T15 = '2026-10-06T15:00Z';
const START = '2026-10-06T15:00:05.000Z';
const T16 = '2026-10-06T16:00Z';
const NEXT = '2026-10-06T16:00:05.000Z';

/** About sixty percent in SPY and the rest in cash: 10.5 SPY at 571.03 is 5,995.815 USD. */
const SIXTY: PortfolioState = { cashMicro: 4_004_185_000, holdings: { SPY: 10_500_000 } };
const SIXTY_EQUITY = 4_004_185_000 + 5_995_815_000;
const REASON = 'Holds SPY at sixty percent of the portfolio and the rest in cash.';

describe('an answer of weights written as fractions is no decision for the round', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  it('an Open agent answering {"SPY": 0.6} keeps its SPY and its cash', async () => {
    const held = await world.addOpen(1, { portfolio: SIXTY });
    const beside = await world.addOpen(2);
    world.answers.set(1, decisionJson({ SPY: 0.6 }, REASON));

    const tick = await world.runTick(START);
    expect(tick.status).toBe('complete');

    const row = world.row(held, T15);
    expect(decisionRowSchema.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({
      status: 'no_decision',
      code: 'weights_look_like_fractions',
      targetsBps: null,
      reason: null,
      fills: [],
      costMicro: 0,
      portfolio: SIXTY,
      equityMicro: SIXTY_EQUITY,
      model: 'house',
    });
    expect(await world.portfolio(held)).toEqual(SIXTY);
    expect(await world.stats(held)).toMatchObject({
      noDecisionCount: 1,
      decidedCount: 0,
      tradeCount: 0,
      tradingDays: 1,
    });

    // The model was asked once; a refused answer is never asked again in the same round.
    expect(world.decisionCalls.filter((call) => call.n === 1)).toHaveLength(1);

    // The agent beside it decided as usual.
    expect(world.row(beside, T15).status).toBe('decided');
    // What the model said is not in the log.
    expect(world.log.text()).not.toContain(REASON);
  });

  it('a Pro agent answering {"SPY": 0.6} keeps its holdings, and decides at the next hour when it writes percents', async () => {
    const held = await world.addPro(1, { portfolio: SIXTY });
    world.answers.set(1, decisionJson({ SPY: 0.6 }, REASON));
    await world.runTick(START);
    expect([world.row(held, T15).status, world.row(held, T15).code]).toEqual([
      'no_decision',
      'weights_look_like_fractions',
    ]);
    expect(await world.portfolio(held)).toEqual(SIXTY);

    // Sixty percent written as 60 is a decision; the position cap cuts it to 40.
    world.answers.set(1, decisionJson({ SPY: 60 }, REASON));
    await world.runTick(NEXT);
    const row = world.row(held, T16);
    expect([row.status, row.code]).toEqual(['decided', null]);
    expect(row.targetsBps).toEqual({ SPY: 4_000 });
  });

  it.each([
    ['two fractions that add up to 0.6', { SPY: 0.3, QQQ: 0.3 }],
    ['a total of exactly 1', { SPY: 1 }],
    ['the smallest weight, 0.01', { SPY: 0.01 }],
    ['fractions spread over four symbols', { SPY: 0.25, QQQ: 0.25, NVDA: 0.25, MSFT: 0.25 }],
  ])('%s is no decision and leaves the portfolio as it was', async (_name, targets) => {
    const agent = await world.addOpen(1, { portfolio: SIXTY });
    world.answers.set(1, decisionJson(targets, REASON));
    await world.runTick(START);
    const row = world.row(agent, T15);
    expect([row.status, row.code, row.fills]).toEqual(['no_decision', 'weights_look_like_fractions', []]);
    expect(await world.portfolio(agent)).toEqual(SIXTY);
  });

  it('fractions that add up to more than one, {"SPY": 0.6, "NVDA": 0.6}, are no decision and move nothing', async () => {
    const agent = await world.addOpen(1, { portfolio: SIXTY });
    world.answers.set(1, decisionJson({ SPY: 0.6, NVDA: 0.6 }, REASON));
    const tick = await world.runTick(START);
    expect(tick.status).toBe('complete');

    const row = world.row(agent, T15);
    expect(decisionRowSchema.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({
      status: 'no_decision',
      code: 'weights_look_like_fractions',
      targetsBps: null,
      reason: null,
      fills: [],
      costMicro: 0,
      portfolio: SIXTY,
      equityMicro: SIXTY_EQUITY,
    });
    expect(await world.portfolio(agent)).toEqual(SIXTY);
    expect(await world.stats(agent)).toMatchObject({ noDecisionCount: 1, decidedCount: 0, tradeCount: 0 });
  });

  it('a total just above 1 percent is a decision, and the scheduler trades it', async () => {
    const agent = await world.addOpen(1, { portfolio: SIXTY });
    world.answers.set(1, decisionJson({ SPY: 1.01 }, REASON));
    await world.runTick(START);
    const row = world.row(agent, T15);
    expect([row.status, row.code]).toEqual(['decided', null]);
    expect(row.targetsBps).toEqual({ SPY: 101 });
  });

  it('every target at zero, everything to cash, stays a decision', async () => {
    const agent = await world.addOpen(1, { portfolio: SIXTY });
    world.answers.set(1, decisionJson({ SPY: 0 }, 'Moves the whole portfolio to cash.'));
    await world.runTick(START);
    const row = world.row(agent, T15);
    expect([row.status, row.code]).toEqual(['decided', null]);
    expect((await world.portfolio(agent)).holdings.SPY ?? 0).toBe(0);
  });
});
