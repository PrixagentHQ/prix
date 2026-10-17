import { describe, expect, it } from 'vitest';
import { deck } from './deck.ts';
import { links } from './facts.ts';

/**
 * The link to the Prix Community group on Telegram, in the header beside X and GitHub and in the
 * footer before X. The address is an invite link the founder gave; a typo would send people to a stranger.
 */

describe('the Telegram link', () => {
  it('is exactly the invite link of the Prix Community group', () => {
    expect(links.telegram).toBe('https://t.me/+Ic9RKLzDMiE1NGFl');
  });

  it('has its two deck strings, named as the other two social links are', () => {
    expect(deck['nav.telegram']).toBe('Telegram');
    expect(deck['nav.telegramLabel']).toBe('The Prix Community on Telegram');
  });
});
