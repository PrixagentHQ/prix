import {
  ADVICE_WORDS,
  HOLDER_POLLS,
  HOLDERS_COPY,
  HOLDERS_FORBIDDEN_WORDS,
  HOLDERS_VERIFIED_BADGE_KEY,
  isSocialSafeText,
  leaguePostCaption,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../apps/web/src/content/deck.ts';

/**
 * The words of the holders round (docs/contracts/phase-6-holders.md sections 0.6, 8 and 11 Words): every key of
 * HOLDERS_COPY in the deck as written, and no word of the round, the deck's, a poll's or the league post's, that
 * says "governance", "DAO", "winner", "verified" or anything else HOLDERS_FORBIDDEN_WORDS lists.
 */

const roundKeys = Object.keys(deck).filter((key) =>
  /^(token\.holders|token\.perk|token\.ownerHolds|agent\.ownerHolds|polls\.)/.test(key),
);

describe('the words of the round', () => {
  it('the deck holds every HOLDERS_COPY key with its text', () => {
    for (const [key, words] of Object.entries(HOLDERS_COPY)) expect(deck[key], key).toBe(words);
  });

  it('no deck word of the round says what HOLDERS_FORBIDDEN_WORDS lists, and each is socially safe', () => {
    expect(roundKeys.length).toBeGreaterThan(20);
    for (const key of roundKeys) {
      const words = deck[key] ?? '';
      // Revision 5, D1: the badge row passes with the words "verified badge" taken out, and only that key.
      const judged = key === HOLDERS_VERIFIED_BADGE_KEY ? words.replace(/\bverified badge\b/, 'badge') : words;
      expect(HOLDERS_FORBIDDEN_WORDS.test(judged), `${key}: ${words}`).toBe(false);
      expect(isSocialSafeText(words), key).toBe(true);
      expect(/%/.test(words), key).toBe(false);
    }
  });

  it('no poll option names money, the token or a model, and the question says no forbidden word', () => {
    for (const poll of HOLDER_POLLS) {
      expect(HOLDERS_FORBIDDEN_WORDS.test(poll.question)).toBe(false);
      for (const option of poll.options) {
        expect(/\b(prix|token|fee|price|live|model|supply|list)\w*\b/i.test(option.name), option.name).toBe(false);
      }
    }
  });

  it('the league post carries no percent, no $PRIX and no forbidden or advice word', () => {
    const caption =
      leaguePostCaption({
        tickId: '2026-10-15T15:00Z',
        rows: [
          { rank: 1, name: 'Crowd Favourites', house: true },
          { rank: 2, name: 'Win Big Now', house: false },
        ],
        war: { number: 1, daysDone: 4, tradingDays: 10 },
      }) ?? '';
    expect(caption).not.toContain('%');
    expect(caption).not.toContain('$PRIX');
    expect(caption).not.toContain('Win Big Now');
    expect(HOLDERS_FORBIDDEN_WORDS.test(caption)).toBe(false);
    expect(ADVICE_WORDS.test(caption)).toBe(false);
  });
});
