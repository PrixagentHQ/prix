import {
  ADVICE_WORDS,
  HOLDERS2_PAGE_WORDS,
  type Holders2PageWordKey,
  isSocialSafeText,
  LOUNGE_DESCRIPTION,
  LOUNGE_DIRECT_MESSAGES,
  loungeDirectMessage,
  TAPE_ROWS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from './deck.ts';
import { holders2Strings } from './deck-holders2.ts';
import type { Block } from './doc.ts';
import privacy from './pages/privacy.ts';

/**
 * What docs/contracts/phase-6-holders-2.md (revision 3) asks of the words of the holders' second wave:
 * section 7's keys, word for word, in the deck; section 6's direct messages; and the privacy page's
 * paragraph on what the lounge keeps. Every sentence is read from the deck or the contract.
 */

const keys = Object.keys(HOLDERS2_PAGE_WORDS) as Holders2PageWordKey[];
const OWN_FILE_KEYS = keys.filter((key) => key !== 'social.roomRefusalWalletDay');

/** A figure: any digit. `00:00 UTC` is a time and is taken out before the check. */
const FIGURE = /\d/;

function blockStrings(block: Block): string[] {
  if (block.kind === 'list') return block.items;
  if (block.kind === 'table') return [...block.head, ...block.rows.flat()];
  if (block.kind === 'link') return [block.text];
  return [block.text];
}

const privacyText = privacy.sections.flatMap((section) => section.blocks.flatMap(blockStrings));

describe('the holders second wave in the deck', () => {
  it('has every key of section 7 in the deck, word for word', () => {
    for (const key of keys) expect(deck[key], key).toBe(HOLDERS2_PAGE_WORDS[key]);
  });

  it('keeps every key but the room refusal in deck-holders2.ts, and nothing else there', () => {
    expect(Object.keys(holders2Strings).sort()).toEqual([...OWN_FILE_KEYS].sort());
  });

  it('names no figure in the wallet_day refusal, and says when writing opens again', () => {
    const sentence = deck['social.roomRefusalWalletDay'] ?? '';
    expect(sentence).toContain('00:00 UTC');
    expect(FIGURE.test(sentence.replace('00:00 UTC', ''))).toBe(false);
  });

  it('fills the tape scale slot with TAPE_ROWS and nothing else', () => {
    const sentence = deck['tape.scale'] ?? '';
    expect(sentence.match(/\{[a-z]+\}/gi)).toEqual(['{count}']);
    expect(TAPE_ROWS).toBe(40);
  });

  it('passes the social text rule and uses no advice word, on the page, in the messages and the description', () => {
    const all = [
      ...keys.map((key) => deck[key] ?? ''),
      ...Object.values(LOUNGE_DIRECT_MESSAGES).filter((text) => text.length > 0),
      LOUNGE_DESCRIPTION,
    ];
    for (const text of all) {
      expect(isSocialSafeText(text), text).toBe(true);
      expect(ADVICE_WORDS.test(text), text).toBe(false);
    }
  });

  it('fills the following link of a direct message with the site origin', () => {
    const text = loungeDirectMessage('not_linked', 'https://prixagent.com/');
    expect(text).toContain('https://prixagent.com/following');
    expect(text).not.toContain('{following}');
    expect(loungeDirectMessage('bot', 'https://prixagent.com')).toBeNull();
  });
});

describe('the privacy page on the lounge', () => {
  const lounge = privacyText.filter((text) => /Prix Community on Telegram/.test(text));

  it('has one paragraph on the lounge', () => {
    expect(lounge).toHaveLength(1);
  });

  it('says what is kept: the Telegram user id, the wallet and when', () => {
    const text = lounge[0] ?? '';
    expect(text).toMatch(/Telegram user id/);
    expect(text).toMatch(/wallet address/);
    expect(text).toMatch(/the time/);
  });

  it('says when the record is deleted', () => {
    expect(lounge[0] ?? '').toMatch(/deletes/);
  });
});
