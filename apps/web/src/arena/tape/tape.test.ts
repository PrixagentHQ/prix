// The holders' tape on the site (docs/contracts/phase-6-holders-2.md, section 3.2) and the room's Holder mark
// in the samples (section 2.1): the sample answers, the sentence of the view, the rows and the link from
// /league. Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
import { HOLDERS2_PAGE_WORDS, TAPE_ROWS, tapeResponseSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { socialAnswer } from '../social/fixtures.ts';
import { ROOM_FIXTURES, roomSample } from '../social/room/fixtures.ts';
import { tapeLinkShown } from './client.ts';
import { TAPE_FIXTURES, tapeAnswer, tapeSample } from './fixtures.ts';
import {
  tapeDescription,
  tapeEmpty,
  tapeFromLeague,
  tapeLiveHold,
  tapeNotAdvice,
  tapeRows,
  tapeScale,
  tapeTitle,
  tapeViewSentence,
} from './words.ts';

const HERE = new URL('https://prixagent.com/tape');
const W = HOLDERS2_PAGE_WORDS;

describe('the sample answers of the tape', () => {
  it('answers in the shape of the contract in every state that has a tape', () => {
    for (const name of [null, ...TAPE_FIXTURES]) {
      const sample = tapeSample(name);
      if (name === 'tape-off' || name === 'tape-error') {
        expect(sample, String(name)).toBeNull();
        continue;
      }
      expect(tapeResponseSchema.safeParse(sample).success, String(name)).toBe(true);
    }
  });

  it('answers 404 while the tape is off and 500 for a read that failed', () => {
    expect(tapeAnswer('tape-off')).toMatchObject({ kind: 'error', status: 404 });
    expect(tapeAnswer('tape-error')).toMatchObject({ kind: 'error', status: 500 });
    expect(tapeAnswer(null)).toMatchObject({ kind: 'data' });
  });

  it('is reached through the Phase 6 reads, and goes off with Phase 6', () => {
    expect(socialAnswer(null, '/api/tape')).toMatchObject({ kind: 'data' });
    expect(socialAnswer('tape-off', '/api/tape')).toMatchObject({ kind: 'error', status: 404 });
    expect(socialAnswer('social-off', '/api/tape')).toMatchObject({ kind: 'error', status: 404 });
  });

  it('holds a full answer of TAPE_ROWS decisions and an empty one', () => {
    expect(tapeSample('tape-full')?.items).toHaveLength(TAPE_ROWS);
    expect(tapeSample('tape-empty')?.items).toHaveLength(0);
  });
});

describe('the sentence of the view', () => {
  it('follows the answer: delayed, live with the gate on, live with the gate off', () => {
    expect(tapeViewSentence({ view: 'delayed', delay: { seconds: 86_400, gatingOn: true } })).toBe(
      W['tape.viewDelayed'],
    );
    expect(tapeViewSentence({ view: 'live', delay: { seconds: 0, gatingOn: true } })).toBe(W['tape.viewLive']);
    expect(tapeViewSentence({ view: 'live', delay: { seconds: 0, gatingOn: false } })).toBe(W['tape.viewOpen']);
  });

  it('never tells a delayed view that it sees decisions as they are made', () => {
    const delayed = tapeViewSentence({ view: 'delayed', delay: { seconds: 86_400, gatingOn: false } });
    expect(delayed).toBe(W['tape.viewDelayed']);
  });
});

describe('the words of the page', () => {
  it('are the contract’s sentences, word for word', () => {
    expect(tapeTitle()).toBe(W['tape.title']);
    expect(tapeDescription()).toBe(W['tape.description']);
    expect(tapeLiveHold()).toBe(W['tape.liveHold']);
    expect(tapeNotAdvice()).toBe(W['tape.notAdvice']);
    expect(tapeEmpty()).toBe(W['tape.empty']);
    expect(tapeFromLeague()).toBe(W['tape.fromLeague']);
    expect(tapeScale()).toBe(W['tape.scale'].replace('{count}', String(TAPE_ROWS)));
  });
});

describe('the rows', () => {
  const sample = tapeSample('tape-full');
  if (!sample) throw new Error('no full sample');
  const rows = tapeRows(sample.items, HERE);

  it('keep the API’s order, one row for each item, and add or drop nothing', () => {
    expect(rows.map((row) => row['data-key'])).toEqual(sample.items.map((item) => `${item.tickId}~${item.agentId}`));
  });

  it('link every agent to its own page and carry the agent’s own reason', () => {
    rows.forEach((row, index) => {
      const item = sample.items[index];
      expect(row.agent.href).toBe(`/agents/${item?.agentId}`);
      expect(row.why).toBe(item?.reason);
      expect(row.tag.length).toBeGreaterThan(0);
    });
  });

  it('say a fill in the neutral words of the feeds, with its sign-free virtual amount, and a kept portfolio plainly', () => {
    const changed = rows.find((row) => row.detail !== undefined);
    const kept = rows.find((row) => row.detail === undefined);
    expect(changed?.detail).toMatch(/^(?:Added|Reduced) [A-Z]+, [\d,]+\.\d{2} in virtual USD/);
    expect(kept?.what).toBe('Kept the paper portfolio as it was');
    for (const row of rows)
      expect(`${row.what} ${row.detail ?? ''}`).not.toMatch(/\b(?:good|bad|win|loss|gain|best|worst)\b/i);
  });

  it('are none for an empty tape', () => {
    expect(tapeRows([], HERE)).toEqual([]);
  });
});

describe('the link from /league', () => {
  it('stands unless the tape’s read answered 404', () => {
    expect(tapeLinkShown({ ok: true, status: 200, data: {} })).toBe(true);
    expect(tapeLinkShown({ ok: false, status: 404, error: { code: 'not_found', message: '', field: null } })).toBe(
      false,
    );
    expect(tapeLinkShown({ ok: false, status: 500, error: { code: 'internal', message: '', field: null } })).toBe(true);
  });
});

describe('the room’s Holder mark in the samples', () => {
  it('names its state among the room’s', () => {
    expect(ROOM_FIXTURES).toContain('social-room-pictures-holders');
  });

  it('sends holder on every message, never true for an admin, true for some writers', () => {
    const messages = roomSample('social-room-pictures-holders')?.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(typeof message.holder, String(message.id)).toBe('boolean');
      if (message.admin) expect(message.holder).toBe(false);
    }
    expect(messages.some((message) => message.holder === true)).toBe(true);
    expect(messages.some((message) => message.holder === true && message.picture)).toBe(true);
  });

  it('sends no holder field in the states of a room with ROOM_HOLDERS off', () => {
    for (const name of ROOM_FIXTURES.filter((entry) => entry !== 'social-room-pictures-holders')) {
      for (const message of roomSample(name)?.messages ?? []) expect('holder' in message, name).toBe(false);
    }
  });
});
