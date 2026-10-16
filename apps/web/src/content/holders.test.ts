import { readFileSync } from 'node:fs';
import {
  ADVICE_WORDS,
  HOLDERS_COPY,
  HOLDERS_FORBIDDEN_WORDS,
  HOLDERS_PRIVACY_SENTENCE,
  HOLDERS_VERIFIED_BADGE_KEY,
  isSocialSafeText,
  POLL_TALLY_FAIL_STEPS,
  pollTallyOutcomeSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { checkDeck } from '../../../../tests/support/text-calls.ts';
import { deck } from './deck.ts';
import { ADMIN_HOLDERS_KEYS, holdersStrings } from './deck-holders.ts';
import privacy from './pages/privacy.ts';

/**
 * The words of the holders round (docs/contracts/phase-6-holders.md section 8, D-158). The contract fixes
 * every `token.*`, `agent.*` and `polls.*` string of the round word for word in HOLDERS_COPY, so this file
 * pins each deck entry to it. The words of /admin/holders are the editor's own and are pinned here only by
 * the rules section 8 gives them: no amount, no price, and `isSocialSafeText`.
 */

const copy = Object.entries(HOLDERS_COPY) as [string, string][];
const adminEntries = ADMIN_HOLDERS_KEYS.map((key) => [key, deck[key] ?? ''] as const);
const MIDDLE_DOT = /[·•∙⋅]/;
const ARROW = /(?:[→←↑↓↗↘↙↖⇒⇢➔➜➝➞›»]|->|=>)/;
const APOLOGY = /\b(?:sorry|apolog\w*|unfortunately|oops|please)\b/i;

function tableRows(): string[][] {
  return privacy.sections
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.kind === 'table' ? block.rows : []));
}

describe('the deck carries every word of HOLDERS_COPY as written', () => {
  it.each(copy)('%s', (key, words) => {
    expect(deck[key]).toBe(words);
  });

  it('keeps polls.* in deck-holders.ts and token.* and agent.* in deck.ts', () => {
    const holderKeys = Object.keys(holdersStrings);
    const pollKeys = copy.map(([key]) => key).filter((key) => key.startsWith('polls.'));
    expect(holderKeys.sort()).toEqual(pollKeys.sort());
    const source = readFileSync(new URL('./deck.ts', import.meta.url), 'utf8');
    for (const [key] of copy.filter(([key]) => !key.startsWith('polls.'))) {
      expect(source, key).toContain(`'${key}':`);
    }
    expect(source).toMatch(/\.\.\.holdersStrings,/);
  });

  it('no longer carries token.holdersBadgeLabel, which revision 5 removed (D5)', () => {
    expect(Object.hasOwn(deck, 'token.holdersBadgeLabel')).toBe(false);
  });

  it('says "verified" only in the badge row, and there only as "verified badge" (D1)', () => {
    const saying = copy.filter(([, words]) => /verified/i.test(words)).map(([key]) => key);
    expect(saying).toEqual([HOLDERS_VERIFIED_BADGE_KEY]);
    expect(deck[HOLDERS_VERIFIED_BADGE_KEY]?.replace(/\bverified badge\b/, 'badge')).not.toMatch(/verified/i);
  });

  it('has no polls.* key that the contract does not name', () => {
    const extra = Object.keys(deck).filter((key) => key.startsWith('polls.') && !Object.hasOwn(HOLDERS_COPY, key));
    expect(extra).toEqual([]);
  });
});

describe('the words of the round keep to the contract rules', () => {
  const round = [...copy, ...adminEntries];

  it.each(round)('%s passes isSocialSafeText, ADVICE_WORDS and HOLDERS_FORBIDDEN_WORDS', (key, words) => {
    // Revision 5 (D1): the badge row alone may name the existing "verified badge", and nothing else of it.
    const judged = key === HOLDERS_VERIFIED_BADGE_KEY ? words.replace(/\bverified badge\b/, 'badge') : words;
    expect(isSocialSafeText(words), `${key}: ${words}`).toBe(true);
    expect(ADVICE_WORDS.test(words), `${key}: ${words}`).toBe(false);
    expect(HOLDERS_FORBIDDEN_WORDS.test(judged), `${key}: ${words}`).toBe(false);
    expect(MIDDLE_DOT.test(words), `${key}: ${words}`).toBe(false);
    expect(ARROW.test(words), `${key}: ${words}`).toBe(false);
    expect(APOLOGY.test(words), `${key}: ${words}`).toBe(false);
  });

  it('passes the deck checks of the copy gate, but for the area of polls.* that the gate does not list yet', () => {
    const entries = Object.fromEntries(round);
    const found = checkDeck(entries).filter(
      (violation) => !(violation.rule === 'key-area' && violation.detail.startsWith('"polls.')),
    );
    expect(found).toEqual([]);
  });
});

describe('the words of /admin/holders', () => {
  it('are all in the admin area of the deck, each with a string', () => {
    expect(ADMIN_HOLDERS_KEYS.length).toBeGreaterThan(0);
    for (const [key, words] of adminEntries) {
      expect(key.startsWith('admin.holders'), key).toBe(true);
      expect(words.length, key).toBeGreaterThan(0);
    }
  });

  it('name no amount and no price: no figure, no currency, no slot that could carry one', () => {
    for (const [key, words] of adminEntries) {
      expect(words, key).not.toMatch(/\d/);
      // The ticker names the token; any other currency sign would name money.
      expect(words.replaceAll('$PRIX', ''), key).not.toMatch(/[$€£¥]/);
      expect(words, key).not.toMatch(/\b(?:usd|usdg|eth|dollars?|amount|balance)\b/i);
      expect(words, key).not.toMatch(/\{(?:amount|balance|share|value)\}/);
    }
  });

  it('have one line for each outcome of a tally and each step a tally can fail at', () => {
    const name = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
    for (const outcome of pollTallyOutcomeSchema.shape.outcome.options) {
      expect(deck[`admin.holdersTally${name(outcome)}`], outcome).toBeTruthy();
    }
    for (const step of POLL_TALLY_FAIL_STEPS) {
      expect(deck[`admin.holdersTallyStep${name(step)}`], step).toBeTruthy();
    }
    expect(deck['admin.holdersTallyFailed']).toContain('{step}');
  });

  it('have the webhook control with its three fields and None for an empty error', () => {
    for (const key of [
      'admin.holdersWebhookSet',
      'admin.holdersWebhookUrl',
      'admin.holdersWebhookPending',
      'admin.holdersWebhookLastError',
    ]) {
      expect(deck[key], key).toBeTruthy();
    }
    expect(deck['admin.holdersWebhookNone']).toBe('None');
    expect(deck['admin.holdersWatchMoved']).toContain('{time}');
  });
});

describe('the privacy page', () => {
  const rows = tableRows();
  const names = rows.map((cells) => cells[0] ?? '');

  it('says, word for word, what a vote in a holders’ poll keeps and for how long', () => {
    const row = rows.find((cells) => /\bholders['’] poll\b/i.test(cells[0] ?? ''));
    expect(row, 'a row whose first cell names a vote in the holders’ poll').toBeDefined();
    const [, kept = '', seen = ''] = row ?? [];
    expect(kept).toContain(HOLDERS_PRIVACY_SENTENCE);
    expect(seen).toMatch(/\bcounts?\b/i);
  });

  it('says what the owner’s mark shows, and that it is off unless the owner turns it on', () => {
    const row = rows.find((cells) => (cells[0] ?? '').includes('Owner holds $PRIX'));
    expect(row, 'a row for the choice to show the mark').toBeDefined();
    const said = (row ?? []).join(' ');
    expect(said).toMatch(/\boff\b/i);
    expect(said).toMatch(/\bat least\b/i);
    expect(said).toMatch(/\banyone\b/i);
  });

  it('puts both rows after the rows of the Community chat, which other tests find first', () => {
    const chat = names.findIndex((name) => /\bpicture\b/i.test(name));
    for (const name of names.filter((n) => /holders['’] poll|Owner holds/.test(n))) {
      expect(names.indexOf(name)).toBeGreaterThan(chat);
      expect(name).not.toMatch(/Community chat|\bpicture\b/i);
    }
  });

  it('is dated on the day of this change or later', () => {
    expect(privacy.updated >= '2026-10-16').toBe(true);
  });
});

describe('the token page does not contradict the holders’ poll', () => {
  it('no longer says flatly that the token gives no vote', () => {
    const rights = deck['token.notRights'] ?? '';
    expect(rights).not.toMatch(/\bno vote,/i);
    expect(rights).toMatch(/\bno ownership\b/i);
    expect(rights).toMatch(/holders['’] poll\b/i);
    expect(HOLDERS_FORBIDDEN_WORDS.test(rights), rights).toBe(false);
    expect(isSocialSafeText(rights), rights).toBe(true);
  });
});
