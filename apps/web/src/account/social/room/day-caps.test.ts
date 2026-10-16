import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOLDERS2_PAGE_WORDS, roomMeWithPicturesResponseSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import type { Answer } from './answers.ts';
import { dayCapOf, dayCapsSentence } from './answers.ts';
import { roomFixtureAnswer } from './fixtures.ts';
import { composerScriptWords, composerWords } from './words.ts';

/**
 * The caps of a day by tier under the composer (docs/contracts/phase-6-holders-2.md sections 2.2 and 7):
 * `social.roomDayCaps` stands under the composer exactly when `me` answers `dayCap`, which the API sends
 * while ROOM_HOLDERS is on and leaves out while it is off. The page never computes a cap or a tier: it
 * reads whether the field is there, and says the contract's one sentence, which names every cap.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const code = (name: string): string =>
  readFileSync(`${here}${name}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const SENTENCE = HOLDERS2_PAGE_WORDS['social.roomDayCaps'];
const ok = (body: unknown): Answer => ({ status: 200, body });

describe('dayCapOf: whether me answers dayCap', () => {
  it('reads the cap of an answer that carries it, whatever the wallet may do', () => {
    expect(dayCapOf(ok({ write: 'yes', left: 48, dayCap: 60 }))).toBe(60);
    expect(dayCapOf(ok({ write: 'not_holder', left: 0, dayCap: 30 }))).toBe(30);
    expect(dayCapOf(ok({ write: 'muted', left: 0, dayCap: 120 }))).toBe(120);
    expect(dayCapOf(ok({ write: 'yes', left: 0, dayCap: 0 }))).toBe(0);
  });

  it('is null for an answer without the field: ROOM_HOLDERS off, or an API older than this phase', () => {
    expect(dayCapOf(ok({ write: 'yes', left: 12 }))).toBeNull();
    expect(dayCapOf(ok({ write: 'yes', left: 12, dayCap: null }))).toBeNull();
  });

  it('is null for anything but a 200 with a whole count', () => {
    expect(dayCapOf({ status: 401, body: { dayCap: 60 } })).toBeNull();
    expect(dayCapOf({ status: 500, body: { dayCap: 60 } })).toBeNull();
    expect(dayCapOf({ status: 0, body: null })).toBeNull();
    expect(dayCapOf(ok(null))).toBeNull();
    expect(dayCapOf(ok([60]))).toBeNull();
    for (const dayCap of [-1, 1.5, '60', Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(dayCapOf(ok({ write: 'yes', left: 1, dayCap })), String(dayCap)).toBeNull();
    }
  });
});

describe('dayCapsSentence: what stands under the composer', () => {
  const words = composerScriptWords();

  it('is the deck’s sentence exactly when me answers dayCap', () => {
    expect(dayCapsSentence(ok({ write: 'yes', left: 48, dayCap: 60 }), words)).toBe(SENTENCE);
    expect(dayCapsSentence(ok({ write: 'not_holder', left: 0, dayCap: 30 }), words)).toBe(SENTENCE);
    expect(dayCapsSentence(ok({ write: 'yes', left: 12 }), words)).toBeNull();
    expect(dayCapsSentence({ status: 401, body: null }, words)).toBeNull();
    expect(dayCapsSentence({ status: 500, body: { dayCap: 60 } }, words)).toBeNull();
  });

  it('is never a figure of the answer: the same sentence whatever the cap', () => {
    for (const dayCap of [0, 30, 60, 90, 120, 7]) {
      expect(dayCapsSentence(ok({ write: 'yes', left: 1, dayCap }), words)).toBe(SENTENCE);
    }
  });

  it('is nothing when the page was handed no sentence for it', () => {
    expect(words.dayCaps).toBe(SENTENCE);
    expect(dayCapsSentence(ok({ write: 'yes', left: 1, dayCap: 60 }), {})).toBeNull();
    expect(dayCapsSentence(ok({ write: 'yes', left: 1, dayCap: 60 }), { dayCaps: '' })).toBeNull();
  });
});

describe('the sentence of the caps', () => {
  it('is the contract’s, in the words the server renders and in the words a script is handed', () => {
    expect(composerWords().dayCaps).toBe(SENTENCE);
    expect(composerScriptWords().dayCaps).toBe(SENTENCE);
  });
});

describe('what the server renders for the caps', () => {
  const composer = code('Composer.astro');
  const signedIn = composer.slice(composer.indexOf('data-room-composer'));

  it('is one empty place, hidden, at the end of the signed-in composer: the script fills it', () => {
    const places = composer.match(/<p[^>]*\bdata-room-day-caps\b[^>]*>/g) ?? [];
    expect(places).toHaveLength(1);
    expect(places[0]).toMatch(/\bhidden\b/);
    expect(composer).toMatch(/<p[^>]*\bdata-room-day-caps\b[^>]*><\/p>/);
    // After the form and every part of a state, so it stands under whichever part shows.
    expect(signedIn.indexOf('data-room-day-caps')).toBeGreaterThan(signedIn.indexOf('</form>'));
    expect(signedIn.indexOf('data-room-day-caps')).toBeGreaterThan(signedIn.lastIndexOf('data-room-state='));
  });

  it('is not drawn for a visitor who is signed out: me is never asked there', () => {
    const signedOut = composer.slice(composer.indexOf('!signedIn ?'), composer.indexOf('data-room-composer'));
    expect(signedOut).not.toMatch(/data-room-day-caps/);
  });

  it('is filled by the script from the answer of the one me, as text', () => {
    const script = code('composer.ts');
    expect(script).toMatch(/\bdayCapsSentence\(answer, words\)/);
    expect(script).toMatch(/\[data-room-day-caps\]/);
    expect(script).toMatch(/\.textContent = /);
  });
});

describe('the fixtures of the caps', () => {
  it('carry no dayCap by default, as the API answers while ROOM_HOLDERS is off', () => {
    const answer = roomFixtureAnswer(null, { method: 'GET', path: '/api/social/room/me' });
    expect(dayCapOf(answer)).toBeNull();
  });

  it('carry a dayCap the contract’s schema takes under social-room-me-holders, for every state of me', () => {
    for (const names of ['social-room-me-holders', 'social-room-me-holders,social-room-me-below']) {
      const answer = roomFixtureAnswer(names, { method: 'GET', path: '/api/social/room/me' });
      expect(answer.status).toBe(200);
      expect(roomMeWithPicturesResponseSchema.safeParse(answer.body).success).toBe(true);
      expect(dayCapOf(answer)).not.toBeNull();
    }
  });
});
