import { type ApiErrorCode, POLL_REFUSALS, type PollMeResponse } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../lib/api.ts';
import { castVote, fetchPollMe, looksLikeMe, type PollCall } from './poll-client.ts';
import { controlStateOf, keepsButtons, refusalMessageOf } from './rules.ts';

/**
 * The vote control's rules (docs/contracts/phase-6-holders.md sections 4.3 to 4.5): the control offers a vote
 * exactly when GET /api/polls/me says a vote would pass the holder step, and every refusal of the vote route
 * gets its own sentence, never the API's message.
 */

const POLL = 'model-war-2-strategy';

function me(data: PollMeResponse): ApiResult<PollMeResponse> {
  return { ok: true, status: 200, data };
}
function failed(status: number, code: ApiErrorCode, field: string | null = null) {
  return { ok: false as const, status, error: { code, message: 'x', field } };
}

describe('the state of the control, from GET /api/polls/me', () => {
  it('offers the vote, with the current choice, only when canVote is true', () => {
    expect(controlStateOf(POLL, me({ pollId: POLL, option: 'index-core', canVote: true, refusal: null }))).toEqual({
      kind: 'vote',
      option: 'index-core',
    });
    expect(controlStateOf(POLL, me({ pollId: POLL, option: null, canVote: true, refusal: null }))).toEqual({
      kind: 'vote',
      option: null,
    });
  });

  it('says what it takes when the wallet is below the first amount, and when tiers are off', () => {
    expect(
      controlStateOf(POLL, me({ pollId: POLL, option: null, canVote: false, refusal: 'poll_not_holder' })),
    ).toEqual({ kind: 'needTokens' });
    expect(controlStateOf(POLL, me({ pollId: POLL, option: null, canVote: false, refusal: 'poll_gate_off' }))).toEqual({
      kind: 'gateOff',
    });
  });

  it('keeps a wallet that voted before it lost its holding from voting again', () => {
    expect(
      controlStateOf(POLL, me({ pollId: POLL, option: 'dip-buyer', canVote: false, refusal: 'poll_not_holder' })).kind,
    ).toBe('needTokens');
  });

  it('asks a visitor who is not signed in to sign in, and says a failed read failed', () => {
    expect(controlStateOf(POLL, failed(401, 'unauthorized')).kind).toBe('signIn');
    expect(controlStateOf(POLL, failed(500, 'internal')).kind).toBe('loadFailed');
    expect(controlStateOf(POLL, failed(404, 'not_found')).kind).toBe('loadFailed');
  });

  it('offers nothing for a poll that is no longer the open one', () => {
    expect(controlStateOf(POLL, me({ pollId: null, option: null, canVote: false, refusal: null })).kind).toBe('closed');
    expect(controlStateOf(POLL, me({ pollId: 'another-poll', option: null, canVote: true, refusal: null })).kind).toBe(
      'closed',
    );
  });
});

describe('the sentence of a refused vote', () => {
  it('has one for every refusal of the contract', () => {
    for (const field of Object.keys(POLL_REFUSALS)) {
      const status = POLL_REFUSALS[field as keyof typeof POLL_REFUSALS];
      expect(refusalMessageOf(failed(status, 'invalid_input', field))).not.toBe('failed');
    }
    expect(refusalMessageOf(failed(409, 'invalid_input', 'poll_closed'))).toBe('refusedClosed');
    expect(refusalMessageOf(failed(409, 'invalid_input', 'poll_not_open'))).toBe('refusedNotOpen');
    expect(refusalMessageOf(failed(409, 'invalid_input', 'poll_full'))).toBe('refusedFull');
    expect(refusalMessageOf(failed(400, 'invalid_input', 'poll_unknown_option'))).toBe('refusedUnknownOption');
    expect(refusalMessageOf(failed(403, 'invalid_input', 'poll_not_holder'))).toBe('needTokens');
    expect(refusalMessageOf(failed(403, 'invalid_input', 'poll_gate_off'))).toBe('gateOff');
  });

  it('names an ended session and the limiter, and says "not saved" for anything else', () => {
    expect(refusalMessageOf(failed(401, 'unauthorized'))).toBe('session');
    expect(refusalMessageOf(failed(429, 'rate_limited'))).toBe('refusedRateLimited');
    expect(refusalMessageOf(failed(400, 'invalid_input', 'option'))).toBe('failed');
    expect(refusalMessageOf(failed(400, 'invalid_input', 'toString'))).toBe('failed');
    expect(refusalMessageOf(failed(400, 'invalid_input', '__proto__'))).toBe('failed');
    expect(refusalMessageOf(failed(500, 'internal'))).toBe('failed');
    expect(refusalMessageOf(failed(404, 'not_found'))).toBe('failed');
  });

  it('keeps the buttons only where another press could pass', () => {
    expect(keepsButtons('refusedClosed')).toBe(false);
    expect(keepsButtons('refusedNotOpen')).toBe(false);
    expect(keepsButtons('needTokens')).toBe(false);
    expect(keepsButtons('session')).toBe(false);
    expect(keepsButtons('refusedRateLimited')).toBe(true);
    expect(keepsButtons('failed')).toBe(true);
  });
});

describe('the client', () => {
  it('asks GET /api/polls/me and POSTs the vote with the option only', async () => {
    const calls: PollCall[] = [];
    const send = async (call: PollCall) => {
      calls.push(call);
      return call.method === 'GET'
        ? Response.json({ pollId: POLL, option: null, canVote: true, refusal: null })
        : Response.json({ pollId: POLL, option: 'momentum-five' });
    };
    const read = await fetchPollMe(send);
    const vote = await castVote(POLL, 'momentum-five', send);
    expect(read.ok && vote.ok).toBe(true);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/polls/me' },
      { method: 'POST', path: `/api/polls/${POLL}/vote`, body: { option: 'momentum-five' } },
    ]);
  });

  it('turns an answer of another shape into a failure, and keeps the API error object of a refusal', async () => {
    const odd = await fetchPollMe(async () => Response.json({ pollId: POLL, canVote: 'yes' }));
    expect(odd.ok).toBe(false);
    const refused = await castVote(POLL, 'index-core', async () =>
      Response.json({ error: { code: 'invalid_input', message: 'm', field: 'poll_closed' } }, { status: 409 }),
    );
    expect(refused).toEqual({
      ok: false,
      status: 409,
      error: { code: 'invalid_input', message: 'm', field: 'poll_closed' },
    });
    const thrown = await fetchPollMe(async () => {
      throw new TypeError('offline');
    });
    expect(thrown.ok).toBe(false);
  });

  it('reads only the shape GET /api/polls/me has', () => {
    expect(looksLikeMe({ pollId: POLL, option: null, canVote: false, refusal: 'poll_not_holder' })).toBe(true);
    expect(looksLikeMe({ pollId: POLL, option: null, canVote: false, refusal: 'other' })).toBe(false);
    expect(looksLikeMe({ pollId: 'Not An Id', option: null, canVote: false, refusal: null })).toBe(false);
  });
});
