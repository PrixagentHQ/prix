import { ADVICE_WORDS, SOCIAL_FORBIDDEN_WORDS } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from './deck.ts';
import { foreheadFacts, grouped } from './facts.ts';

/**
 * The block of the token page on what $PRIX unlocks in FOREHEAD, the founder's game (D-146).
 * Every sentence is read from the deck: a test here pins a rule of the brief, not a wording.
 */

const KEYS = [
  'token.foreheadTitle',
  'token.foreheadBody',
  'token.foreheadUnlockLower',
  'token.foreheadUnlockHigher',
  'token.foreheadOwnAmounts',
  'token.foreheadCosmetic',
  'token.foreheadLink',
] as const;

const strings = KEYS.map((key) => [key, deck[key]] as const);

describe('the FOREHEAD block of the token page', () => {
  it('has a final string for every key', () => {
    for (const [key, value] of strings) expect(value, key).toBeTypeOf('string');
  });

  it('holds the thresholds as whole tokens, as the game answered on the day they were read', () => {
    expect(foreheadFacts.lowerTokens).toBe(10_000);
    expect(foreheadFacts.higherTokens).toBe(1_000_000);
    expect(foreheadFacts.readFrom).toBe('https://forehead.prixagent.com/api/token/status');
    expect(foreheadFacts.readOn).toBe('2026-10-14');
  });

  it('takes the numbers from facts.ts through one slot, so no figure is typed into the deck', () => {
    for (const key of ['token.foreheadUnlockLower', 'token.foreheadUnlockHigher']) {
      expect(
        [...(deck[key] ?? '').matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
        key,
      ).toEqual(['amount']);
    }
    // Filled as the page fills them. Not through `text`: the copy gate reads every call of it under apps/web/src.
    const fill = (key: string, amount: number): string => (deck[key] ?? '').replace('{amount}', grouped(amount));
    const lower = fill('token.foreheadUnlockLower', foreheadFacts.lowerTokens);
    const higher = fill('token.foreheadUnlockHigher', foreheadFacts.higherTokens);
    expect(lower).toContain('10,000 $PRIX');
    expect(higher).toContain('1,000,000 $PRIX');
    for (const [key, value] of strings) {
      if (key === 'token.foreheadUnlockLower' || key === 'token.foreheadUnlockHigher') continue;
      expect(value, key).not.toMatch(/\d/);
    }
  });

  it('names the token by its ticker only, and never by a Prix tier name', () => {
    for (const [key, value] of strings) {
      expect(value, key).not.toMatch(/\btier \d|\bwhale|\bholder tier|\$PRIZE/i);
      expect(value, key).not.toMatch(/\$(?!PRIX\b)[A-Z]/);
    }
  });

  it('says nothing of price, value, return or advice, and gives no reason to buy', () => {
    const money = /\b(price|value|worth|return|profit|gain|earn|invest\w*|buy|sell|moon|pump|rare|scarce|limited)\b/i;
    for (const [key, value] of strings) {
      expect(value, key).not.toMatch(money);
      expect(SOCIAL_FORBIDDEN_WORDS.exec(value ?? ''), key).toBeNull();
      expect(ADVICE_WORDS.exec(value ?? ''), key).toBeNull();
    }
  });

  it('says the unlocks are cosmetic, points at the address the page already shows, and names the link as the footer does', () => {
    expect(deck['token.foreheadCosmetic']).toMatch(/^Cosmetic only/);
    expect(deck['token.foreheadBody']).toContain('at the address above');
    expect(deck['token.foreheadLink']).toBe(deck['nav.forehead']);
  });
});
