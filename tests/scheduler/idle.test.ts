import type { AgentRecord, ModelResponse } from '@prix/contracts';
import { HOUSE_NEURONS_PER_DAY, HOUSE_SUMMARY_NEURONS_PER_DAY, SUMMARY_MAX } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { modelText } from '../support/fakes.ts';
import { testAddress } from '../support/fixtures.ts';
import type { World } from '../support/scheduler.ts';
import { agentNumber, createWorld, DEFAULT_SUMMARY } from '../support/scheduler.ts';

/**
 * What an idle step does (docs/CONTRACTS.md section 10, step 3): it writes pending strategy
 * summaries with the house model, inside the daily budget, and deletes expired nonces and
 * sessions.
 */

const IDLE = '2026-10-06T14:00:05.000Z';
const pending = { summary: null, summaryStatus: 'pending' as const };

describe('strategy summaries', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  const agentNow = async (agent: AgentRecord) => {
    const stored = await world.store.getAgent(agent.id);
    if (!stored) throw new Error('the agent is gone');
    return stored;
  };

  it('writes a pending summary with the house model and marks it ready', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    const report = await world.step(IDLE);
    expect(report).toMatchObject({ action: 'idle', summaries: 1, decided: 0 });
    expect(await agentNow(agent)).toMatchObject({ summary: DEFAULT_SUMMARY, summaryStatus: 'ready' });
    expect(world.summaryCalls).toHaveLength(1);
    expect(world.house.requests).toHaveLength(1);
    // The summary is asked for the strategy of this agent.
    expect(agentNumber(world.summaryCalls[0] as (typeof world.summaryCalls)[number])).toBe(1);
  });

  it('writes summaries for Pro agents too, with the house model and never with the key of the owner', async () => {
    const agent = await world.addPro(1, { overrides: pending });
    await world.step(IDLE);
    expect(await agentNow(agent)).toMatchObject({ summary: DEFAULT_SUMMARY, summaryStatus: 'ready' });
    expect(world.own.built).toHaveLength(0);
    expect(world.vault.opened).toHaveLength(0);
  });

  it('writes at most two summaries in one step, oldest agent first', async () => {
    const third = await world.addOpen(3, { overrides: pending, createdAt: '2026-10-05T10:00:00.000Z' });
    const first = await world.addOpen(1, { overrides: pending, createdAt: '2026-10-05T08:00:00.000Z' });
    const second = await world.addOpen(2, { overrides: pending, createdAt: '2026-10-05T09:00:00.000Z' });
    expect((await world.step(IDLE)).summaries).toBe(2);
    expect((await agentNow(first)).summaryStatus).toBe('ready');
    expect((await agentNow(second)).summaryStatus).toBe('ready');
    expect((await agentNow(third)).summaryStatus).toBe('pending');
    expect((await world.step('2026-10-06T14:01:05.000Z')).summaries).toBe(1);
    expect((await agentNow(third)).summaryStatus).toBe('ready');
    expect((await world.step('2026-10-06T14:02:05.000Z')).summaries).toBe(0);
    expect(world.summaryCalls).toHaveLength(3);
  });

  it.each<[string, string | ModelResponse]>([
    ['an empty answer', ''],
    ['an answer of spaces', '   \n '],
    ['an answer that is too long', 'a'.repeat(SUMMARY_MAX + 1)],
    ['a failed call', { ok: false, code: 'provider_error', httpStatus: 500 }],
    ['a timeout', { ok: false, code: 'provider_timeout', httpStatus: null }],
  ])('marks the summary as failed for %s, and does not ask again every minute', async (_name, answer) => {
    const agent = await world.addOpen(1, { overrides: pending });
    world.summaryAnswer = answer;
    await world.step(IDLE);
    expect(await agentNow(agent)).toMatchObject({ summary: null, summaryStatus: 'failed' });
    await world.step('2026-10-06T14:01:05.000Z');
    expect(world.summaryCalls).toHaveLength(1);
  });

  it('accepts a summary of exactly the largest size', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    world.summaryAnswer = 'b'.repeat(SUMMARY_MAX);
    await world.step(IDLE);
    expect(await agentNow(agent)).toMatchObject({ summary: 'b'.repeat(SUMMARY_MAX), summaryStatus: 'ready' });
  });

  it('stores a summary as plain text, exactly as the model wrote it', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    world.summaryAnswer = 'Buys <b>leaders</b> & holds them.';
    await world.step(IDLE);
    expect((await agentNow(agent)).summary).toBe('Buys <b>leaders</b> & holds them.');
  });

  it('asks for no summary once the daily budget of the house model is used up', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    await world.store.addAiNeurons('2026-10-06', 'summary', HOUSE_NEURONS_PER_DAY);
    const report = await world.step(IDLE);
    expect(report.summaries).toBe(0);
    expect(world.house.requests).toHaveLength(0);
    // It stays pending and is written when there is budget again.
    expect((await agentNow(agent)).summaryStatus).toBe('pending');
    await world.step('2026-10-07T14:00:05.000Z');
    expect((await agentNow(agent)).summaryStatus).toBe('ready');
  });

  it('writes no summary once the day has counted the neurons that summaries may use', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    await world.store.addAiNeurons('2026-10-06', 'summary', HOUSE_SUMMARY_NEURONS_PER_DAY);
    const report = await world.step(IDLE);
    expect(report.summaries).toBe(0);
    expect(world.house.requests).toHaveLength(0);
    expect((await agentNow(agent)).summaryStatus).toBe('pending');
  });

  it.each([
    ['a link', 'Holds large companies, see https://example.com for more.'],
    ['a bare site name', 'Holds large companies, as described at prixagent.com today.'],
    ['a wallet address', 'Holds large companies and sends to 0x1234567890abcdef1234567890abcdef12345678.'],
    ['only whitespace', '   \n  '],
    ['a promise of a return', 'Guaranteed 40% a month, risk-free.'],
    ['abuse', 'Holds large companies, and the rest of the market is shitty.'],
  ])('fails a summary that holds %s and never shows it', async (_name, text) => {
    const agent = await world.addOpen(1, { overrides: pending });
    world.summaryAnswer = text;
    await world.step(IDLE);
    const stored = await agentNow(agent);
    expect(stored.summaryStatus).toBe('failed');
    expect(stored.summary).toBeNull();
  });

  it('keeps an ordinary summary that names Chainlink and Robinhood Chain', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    const text = 'Holds large companies at Chainlink reference prices on Robinhood Chain.';
    world.summaryAnswer = text;
    await world.step(IDLE);
    expect(await agentNow(agent)).toMatchObject({ summary: text, summaryStatus: 'ready' });
  });

  it('removes control and format characters from a summary, as from a reason', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    world.summaryAnswer = [
      'Holds',
      String.fromCharCode(7),
      ' large',
      String.fromCharCode(0x202e),
      ' companies',
      String.fromCharCode(0x200b),
      ' today.',
    ].join('');
    await world.step(IDLE);
    const stored = await agentNow(agent);
    expect(stored.summaryStatus).toBe('ready');
    expect(stored.summary).toBe('Holds large companies today.');
  });

  it('counts the neurons of a summary toward the day', async () => {
    await world.addOpen(1, { overrides: pending });
    world.summaryAnswer = modelText(DEFAULT_SUMMARY, 400_000, 0);
    await world.step(IDLE);
    // 400,000 input tokens at 26,668 neurons per million, rounded up.
    expect(await world.store.getAiNeurons('2026-10-06', 'summary')).toBe(10_668);
  });

  it('writes no summary for a paused or hidden agent', async () => {
    const paused = await world.addOpen(1, { overrides: { ...pending, status: 'paused', pausedReason: 'owner' } });
    const hidden = await world.addOpen(2, {
      overrides: { ...pending, hidden: true, status: 'paused', pausedReason: 'admin' },
    });
    expect((await world.step(IDLE)).summaries).toBe(0);
    expect((await agentNow(paused)).summaryStatus).toBe('pending');
    expect((await agentNow(hidden)).summaryStatus).toBe('pending');
    expect(world.house.requests).toHaveLength(0);
  });

  it('writes summaries only in idle steps, never while a tick is being processed', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    await world.addPro(2);
    const created = await world.step('2026-10-06T15:00:05.000Z');
    expect(created).toMatchObject({ action: 'tick_created', summaries: 0 });
    const batch = await world.step('2026-10-06T15:01:05.000Z');
    expect(batch.summaries).toBe(0);
    expect(world.summaryCalls).toHaveLength(0);
    await world.run('2026-10-06T15:02:05.000Z', '2026-10-06T15:15:05.000Z');
    expect((await agentNow(agent)).summaryStatus).toBe('ready');
  });

  it('never logs a prompt or a summary', async () => {
    const agent = await world.addOpen(1, { overrides: pending });
    await world.step(IDLE);
    expect(world.log.text()).not.toContain(agent.prompt);
    expect(world.log.text()).not.toContain(DEFAULT_SUMMARY);
  });
});

describe('cleaning up', () => {
  it('deletes expired nonces and sessions in an idle step, and keeps the live ones', async () => {
    const world = createWorld();
    await world.store.useNonce('expirednonce1234', '2026-10-06T13:00:00.000Z');
    await world.store.useNonce('livenonce1234567', '2026-10-06T14:04:00.000Z');
    const session = (hash: string, expiresAt: string) => ({
      tokenHash: hash.repeat(64),
      address: testAddress(1),
      createdAt: '2026-09-29T12:00:00.000Z',
      expiresAt,
    });
    await world.store.putSession(session('a', '2026-10-06T13:59:59.000Z'));
    await world.store.putSession(session('b', '2026-10-06T14:30:00.000Z'));
    const report = await world.step(IDLE);
    expect(report.action).toBe('idle');
    expect([...world.store.nonces.keys()]).toEqual(['livenonce1234567']);
    expect([...world.store.sessions.keys()]).toEqual(['b'.repeat(64)]);
  });
});
