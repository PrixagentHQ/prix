import { HOLDER_POLLS, type HolderPoll, POLL_TALLY_FAIL_STEPS, pollStateAt } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { looksRight, runPollTally, setTelegramWebhook } from './admin-client.ts';
import { closedPollsAt, tallyMessageOf, timeWithoutZone, webhookSlots } from './view.ts';

/** The rules of /admin/holders (docs/contracts/phase-6-holders.md sections 4.4 and 7). */

const POLL = HOLDER_POLLS[0] as HolderPoll;

describe('the polls an administrator may count', () => {
  it('are the closed ones only, newest close first', () => {
    const later: HolderPoll = {
      ...POLL,
      id: 'later-poll',
      opensAt: '2026-11-01T00:00:00.000Z',
      closesAt: '2026-11-05T20:00:00.000Z',
    };
    const polls = [POLL, later];
    expect(closedPollsAt(new Date('2026-10-20T00:00:00.000Z'), polls, pollStateAt)).toEqual([]);
    expect(closedPollsAt(new Date(POLL.closesAt), polls, pollStateAt).map((poll) => poll.id)).toEqual([POLL.id]);
    expect(closedPollsAt(new Date('2026-12-01T00:00:00.000Z'), polls, pollStateAt).map((poll) => poll.id)).toEqual([
      'later-poll',
      POLL.id,
    ]);
  });
});

describe("a tally's answer", () => {
  const steps = Object.fromEntries(POLL_TALLY_FAIL_STEPS.map((step) => [step, `while ${step}`]));

  it('shows its outcome, and names the step of a failure', () => {
    expect(tallyMessageOf({ outcome: 'done', step: null }, steps)).toEqual({ name: 'done', slots: {} });
    expect(tallyMessageOf({ outcome: 'already', step: null }, steps).name).toBe('already');
    expect(tallyMessageOf({ outcome: 'waiting', step: null }, steps).name).toBe('waiting');
    expect(tallyMessageOf({ outcome: 'open', step: null }, steps).name).toBe('open');
    for (const step of POLL_TALLY_FAIL_STEPS) {
      expect(tallyMessageOf({ outcome: 'failed', step }, steps)).toEqual({
        name: 'failed',
        slots: { step: `while ${step}` },
      });
    }
  });
});

describe("the webhook's answer", () => {
  it('shows the three fields, with "None" for an empty error', () => {
    expect(
      webhookSlots(
        { url: 'https://prixagent.com/api/telegram/webhook', pendingUpdateCount: 0, lastErrorMessage: null },
        'None',
      ),
    ).toEqual({
      url: 'https://prixagent.com/api/telegram/webhook',
      pending: '0',
      lastError: 'None',
    });
    expect(webhookSlots({ url: 'u', pendingUpdateCount: 3, lastErrorMessage: ' ' }, 'None').lastError).toBe('None');
    expect(webhookSlots({ url: 'u', pendingUpdateCount: 3, lastErrorMessage: 'Bad Gateway' }, 'None').lastError).toBe(
      'Bad Gateway',
    );
  });

  it('writes a time without its zone, since the sentence names UTC', () => {
    expect(timeWithoutZone('16 October 2026, 13:13 UTC')).toBe('16 October 2026, 13:13');
  });
});

describe('the client', () => {
  it('POSTs to the two admin routes with no body, and reads only their shapes', async () => {
    const calls: unknown[] = [];
    const set = await setTelegramWebhook(async (call) => {
      calls.push(call);
      return Response.json({
        url: 'https://prixagent.com/api/telegram/webhook',
        pendingUpdateCount: 0,
        lastErrorMessage: null,
      });
    });
    const tally = await runPollTally(POLL.id, async (call) => {
      calls.push(call);
      return Response.json({ outcome: 'failed', step: 'block' });
    });
    expect(set.ok && tally.ok).toBe(true);
    expect(calls).toEqual([
      { method: 'POST', path: '/api/admin/telegram/webhook' },
      { method: 'POST', path: `/api/admin/polls/${POLL.id}/tally` },
    ]);
    expect(looksRight('webhook', { url: 'u', pendingUpdateCount: -1, lastErrorMessage: null })).toBe(false);
    expect(looksRight('tally', { outcome: 'failed', step: 'elsewhere' })).toBe(false);
    expect(looksRight('watch', { moved: true, movedAt: '2026-10-16T13:13:02.000Z' })).toBe(true);
  });

  it("keeps the API's 404 for anyone but an administrator, and never throws", async () => {
    const hidden = await runPollTally(POLL.id, async () =>
      Response.json({ error: { code: 'not_found', message: 'Not found.', field: null } }, { status: 404 }),
    );
    expect(hidden.ok ? 0 : hidden.status).toBe(404);
    const thrown = await setTelegramWebhook(async () => {
      throw new TypeError('offline');
    });
    expect(thrown.ok).toBe(false);
  });
});
