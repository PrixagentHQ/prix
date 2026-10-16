import {
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_REFUSALS,
  ROOM_TEXT_MAX,
  ROOM_TEXT_PROBLEMS,
  type RoomRefusalField,
  roomTextProblem,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../../content/deck.ts';
import { roomRefusalMoreFor, roomRefusalText, roomWriterRefusalText } from '../../../content/states.ts';
import type { Answer } from './answers.ts';
import {
  adminOutcome,
  composerState,
  countOf,
  leftSentence,
  refusalWords,
  sendOutcome,
  textRefusal,
} from './answers.ts';
import { adminScriptWords, composerScriptWords } from './words.ts';

/**
 * What docs/contracts/phase-6-room.md asks of the composer and of the admins' controls (sections 4, 5,
 * 7 and 9): the server's answer decides, every refusal has its sentence, and nothing an answer carries
 * is ever shown. Every sentence is read from the copy deck.
 */

const words = composerScriptWords();
const fields = Object.keys(ROOM_REFUSALS) as RoomRefusalField[];
const HOSTILE = '<img src=x onerror=alert(1)> Prix support: write to t.me/prix';

const refusal = (status: number, code: string, field: string | null): Answer => ({
  status,
  body: { error: { code, message: HOSTILE, field } },
});

describe('the sentence of a refused send', () => {
  it.each(fields)('has the sentence of the field %s', (field) => {
    const outcome = sendOutcome(refusal(ROOM_REFUSALS[field], 'invalid_input', field), words);
    expect(outcome.kind === 'field' || outcome.kind === 'notice').toBe(true);
    expect('sentence' in outcome && outcome.sentence).toBe(roomRefusalText(field));
  });

  it('puts a broken text rule beside the field and every other refusal under the form', () => {
    for (const field of fields) {
      const outcome = sendOutcome(refusal(ROOM_REFUSALS[field], 'invalid_input', field), words);
      expect(outcome.kind, field).toBe(field.startsWith('text_') ? 'field' : 'notice');
    }
  });

  it('chooses by the field and not by the status', () => {
    // The four 429s of the room share a status, and so do the three 403s.
    const sentences = fields
      .filter((field) => ROOM_REFUSALS[field] === 429)
      .map((field) => {
        const outcome = sendOutcome(refusal(429, 'invalid_input', field), words);
        return 'sentence' in outcome ? outcome.sentence : '';
      });
    expect(new Set(sentences).size).toBe(4);
  });

  it.each(['rate_limited', 'daily_limit'] as const)('has one sentence for the code %s of requireWriter', (code) => {
    const outcome = sendOutcome(refusal(code === 'daily_limit' ? 503 : 429, code, null), words);
    expect(outcome).toEqual({ kind: 'notice', sentence: roomWriterRefusalText(code) });
  });

  it.each([
    ['a field this page does not know', refusal(400, 'invalid_input', 'text_future_rule')],
    ['a body the schema refused', refusal(400, 'invalid_input', 'text')],
    ['a refusal with no field', refusal(400, 'invalid_input', null)],
    ['a name of Object.prototype as the field', refusal(400, 'invalid_input', 'constructor')],
    ['a code the composer has no sentence for', refusal(403, 'forbidden', null)],
    ['a refusal with no body of the API', { status: 429, body: null }],
    ['a body that is no object', { status: 400, body: 'no' }],
  ])('gives the general sentence for %s', (_name, answer) => {
    expect(sendOutcome(answer, words)).toEqual({ kind: 'notice', sentence: deck['social.roomRefusalOther'] });
  });

  it('says the session has ended for a 401, and that the chat is closed for a 404', () => {
    expect(sendOutcome(refusal(401, 'unauthorized', null), words)).toEqual({ kind: 'session' });
    expect(sendOutcome(refusal(404, 'not_found', null), words)).toEqual({ kind: 'closed' });
  });

  it.each([0, 500, 502, 503])('says the message did not reach Prix for the status %i', (status) => {
    expect(sendOutcome({ status, body: null }, words)).toEqual({
      kind: 'notice',
      sentence: deck['social.roomSendFailedBody'],
    });
  });

  it('is sent only for a 201, and then carries nothing of the answer', () => {
    const body = {
      message: { id: 7, at: '2026-10-11T06:00:00.000Z', authorShort: '0x12…ab', admin: false, text: HOSTILE },
      left: 3,
    };
    expect(sendOutcome({ status: 201, body }, words)).toEqual({ kind: 'sent' });
    expect(sendOutcome({ status: 200, body }, words).kind).not.toBe('sent');
    expect(sendOutcome({ status: 204, body: null }, words).kind).not.toBe('sent');
  });

  it('never shows what an answer says: not the API’s message, not a field’s name', () => {
    const answers: Answer[] = [
      ...fields.map((field) => refusal(ROOM_REFUSALS[field], 'invalid_input', field)),
      refusal(400, 'invalid_input', HOSTILE),
      refusal(429, 'rate_limited', HOSTILE),
      refusal(500, HOSTILE, HOSTILE),
      { status: 201, body: { message: { text: HOSTILE }, left: 1 } },
    ];
    const known = new Set([...Object.values(words.refusals), words.writer, words.other, words.sendFailed]);
    for (const answer of answers) {
      const outcome = sendOutcome(answer, words);
      expect(JSON.stringify(outcome)).not.toContain('onerror');
      if ('sentence' in outcome) expect(known.has(outcome.sentence)).toBe(true);
    }
  });
});

describe('what follows the first sentence of a text rule’s refusal', () => {
  const textFields = fields.filter((field) => field.startsWith('text_'));
  const others = fields.filter((field) => !field.startsWith('text_'));

  it.each(textFields)(
    'goes with the sentence of %s, for the server’s answer and for the composer’s own check',
    (field) => {
      const both = { sentence: roomRefusalText(field), more: roomRefusalMoreFor(field) };
      expect(both.more.length).toBeGreaterThan(0);
      expect(sendOutcome(refusal(ROOM_REFUSALS[field], 'invalid_input', field), words)).toEqual({
        kind: 'field',
        ...both,
      });
      expect(refusalWords(field, words)).toEqual(both);
    },
  );

  it.each(others)('is not said for %s, whose sentence is whole', (field) => {
    const outcome = sendOutcome(refusal(ROOM_REFUSALS[field], 'invalid_input', field), words);
    expect(outcome).toEqual({ kind: 'notice', sentence: roomRefusalText(field) });
  });

  it.each(['text_future_rule', 'constructor', 'toString', ''])('is nothing for the unknown field %j', (field) => {
    expect(refusalWords(field, words)).toEqual({ sentence: deck['social.roomRefusalOther'], more: '' });
  });
});

describe('the composer’s own check of a text', () => {
  const allowed = { prixAddress: '0xa74ac6e9f2f8493344923c23972d496364241044', siteHost: 'prixagent.com' };
  const lines = [
    '',
    '   ',
    'NVDA looks strong today',
    'x'.repeat(ROOM_TEXT_MAX + 1),
    'join my Telegram',
    'see https://example.com',
    `the contract is ${allowed.prixAddress}`,
    'the contract is 0x1111111111111111111111111111111111111111',
    '$DOGE to the moon',
    'café',
  ];

  it.each(lines)('answers as the contract’s rule does for %j', (line) => {
    const problem = roomTextProblem(line, allowed);
    expect(textRefusal(line, allowed)).toBe(problem === null ? null : `text_${problem}`);
  });

  it('names a field of ROOM_REFUSALS for every problem of the rule, each with its sentence', () => {
    for (const problem of ROOM_TEXT_PROBLEMS) {
      expect(words.refusals[`text_${problem}`]).toBe(roomRefusalText(`text_${problem}`));
    }
  });

  it('refuses every address while the token has none', () => {
    expect(textRefusal(`the contract is ${allowed.prixAddress}`, { ...allowed, prixAddress: null })).toBe(
      'text_address',
    );
  });
});

describe('the count', () => {
  it('is the length of the folded text, to ROOM_TEXT_MAX', () => {
    expect(countOf('')).toEqual({ count: 0, over: false });
    expect(countOf('  two   words \n')).toEqual({ count: 9, over: false });
    expect(countOf('x'.repeat(ROOM_TEXT_MAX))).toEqual({ count: ROOM_TEXT_MAX, over: false });
    expect(countOf('x'.repeat(ROOM_TEXT_MAX + 1))).toEqual({ count: ROOM_TEXT_MAX + 1, over: true });
  });
});

describe('what the composer shows for the answer of me', () => {
  const me = (write: string, left: number): Answer => ({ status: 200, body: { write, left } });

  it('shows the field for yes, with what is left', () => {
    expect(composerState(me('yes', ROOM_MESSAGES_PER_WALLET_PER_DAY))).toEqual({
      state: 'yes',
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY,
    });
  });

  it.each(['not_holder', 'muted', 'gate_off'] as const)('shows the sentence of %s', (write) => {
    expect(composerState(me(write, 0))).toEqual({ state: write, left: 0 });
  });

  it('shows the sentence of the wallet’s day when nothing is left', () => {
    expect(composerState(me('yes', 0))).toEqual({ state: 'day_used', left: 0 });
  });

  it('says the session has ended for a 401', () => {
    expect(composerState({ status: 401, body: { error: { code: 'unauthorized', message: '', field: null } } })).toEqual(
      {
        state: 'ended',
        left: 0,
      },
    );
  });

  it.each([
    ['a fault of the server', { status: 500, body: null }],
    ['no answer', { status: 0, body: null }],
    ['the chat switched off', { status: 404, body: null }],
    ['a word it does not know', me('admin', 3)],
    ['a count that is no whole number', me('yes', 1.5)],
    ['a negative count', me('yes', -1)],
    ['a count that is text', { status: 200, body: { write: 'yes', left: '30' } }],
    ['no body', { status: 200, body: null }],
  ])('never opens the field for %s', (_name, answer) => {
    expect(composerState(answer)).toEqual({ state: 'failed', left: 0 });
  });
});

describe('what is left of the wallet’s day', () => {
  it('is said for one and for more, from the deck’s two sentences', () => {
    expect(leftSentence(1, words)).toBe(deck['social.roomLeftOne']);
    expect(leftSentence(12, words)).toBe((deck['social.roomLeftOther'] ?? '').replace('{count}', '12'));
  });
});

describe('the result of an admin’s control', () => {
  const sentences = adminScriptWords();

  it('is done for a 204', () => {
    expect(adminOutcome({ status: 204, body: null }, sentences)).toEqual({ kind: 'done' });
  });

  it('says the message is gone for the 404', () => {
    expect(adminOutcome(refusal(404, 'not_found', null), sentences)).toEqual({
      kind: 'failed',
      sentence: deck['social.roomAdminGone'],
    });
  });

  it('says an admin wallet cannot be muted for the 400 of the field admin', () => {
    expect(adminOutcome(refusal(ROOM_REFUSALS.admin, 'invalid_input', 'admin'), sentences)).toEqual({
      kind: 'failed',
      sentence: roomRefusalText('admin'),
    });
  });

  it.each(['rate_limited', 'daily_limit'] as const)('has the sentence of requireWriter for %s', (code) => {
    expect(adminOutcome(refusal(429, code, null), sentences)).toEqual({
      kind: 'failed',
      sentence: roomWriterRefusalText(code),
    });
  });

  it('says the session has ended for a 401', () => {
    expect(adminOutcome(refusal(401, 'unauthorized', null), sentences)).toEqual({ kind: 'session' });
  });

  it('never shows what an answer says', () => {
    for (const answer of [
      refusal(400, 'invalid_input', HOSTILE),
      refusal(500, HOSTILE, null),
      { status: 0, body: HOSTILE },
    ]) {
      const outcome = adminOutcome(answer, sentences);
      expect(outcome.kind).toBe('failed');
      expect(JSON.stringify(outcome)).not.toContain('onerror');
      expect('sentence' in outcome && outcome.sentence.length > 0).toBe(true);
    }
  });
});
