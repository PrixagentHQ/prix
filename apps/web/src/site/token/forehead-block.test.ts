import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deck } from '../../content/deck.ts';
import { foreheadFacts, grouped, links } from '../../content/facts.ts';

/**
 * The block of the token page on what $PRIX unlocks in FOREHEAD, the founder's game (D-146). Read
 * from the page source, as the token page's own copy test (tests/token/page.test.ts) reads it:
 * every `text(key, draft)` call of the block, resolved through the real deck.
 */

const source = readFileSync(new URL('./TokenPage.astro', import.meta.url), 'utf8');

const KEYS = [
  'token.foreheadTitle',
  'token.foreheadOwnAmounts',
  'token.foreheadBody',
  'token.foreheadUnlockLower',
  'token.foreheadUnlockHigher',
  'token.foreheadCosmetic',
  'token.foreheadLink',
] as const;

/** The markup of the block: from its section's opening tag to its end. */
function block(): string {
  const start = source.indexOf('aria-labelledby="token-forehead-title"');
  expect(start, 'the FOREHEAD block is on the page').toBeGreaterThan(-1);
  const end = source.indexOf('</section>', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every `text('key', 'draft'` call in a piece of source, in order. */
function calls(piece: string): { key: string; draft: string }[] {
  return [...piece.matchAll(/\btext\(\s*'([^']+)',\s*'([^']*)'/g)].map((match) => ({
    key: match[1] as string,
    draft: match[2] as string,
  }));
}

describe('the FOREHEAD block of the token page', () => {
  it('stands after the tier table and before the risks', () => {
    const tiers = source.indexOf('id="token-tiers-title"');
    const forehead = source.indexOf('id="token-forehead-title"');
    const risks = source.indexOf('id="token-risk-title"');
    expect(tiers).toBeGreaterThan(-1);
    expect(forehead).toBeGreaterThan(tiers);
    expect(risks).toBeGreaterThan(forehead);
  });

  it('says every sentence of the editor, in order, with the deck string as its draft', () => {
    const found = calls(block());
    expect(found.map((call) => call.key)).toEqual([...KEYS]);
    for (const { key, draft } of found) expect(draft, key).toBe(deck[key]);
  });

  it('fills the two amounts from the game’s facts, as whole tokens', () => {
    const piece = block();
    expect(piece).toContain('{ amount: grouped(foreheadFacts.lowerTokens) }');
    expect(piece).toContain('{ amount: grouped(foreheadFacts.higherTokens) }');
    // Filled as `text` fills a slot, by hand: the copy gate reads every call of `text` under apps/web/src.
    const fill = (key: string, amount: number): string => (deck[key] ?? '').replace('{amount}', grouped(amount));
    const lower = fill('token.foreheadUnlockLower', foreheadFacts.lowerTokens);
    const higher = fill('token.foreheadUnlockHigher', foreheadFacts.higherTokens);
    expect(lower).toContain('10,000 $PRIX');
    expect(higher).toContain('1,000,000 $PRIX');
    expect(`${lower} ${higher}`).not.toMatch(/\{\w+\}/);
  });

  it('links to the game in the same tab, under the footer’s name for it', () => {
    const piece = block();
    expect(piece).toMatch(/<Button\s+label=\{text\('token\.foreheadLink',[^}]*\)\}\s+href=\{links\.forehead\}/);
    expect(piece).not.toMatch(/target=|rel=/);
    expect(links.forehead).toBe('https://forehead.prixagent.com');
    expect(deck['token.foreheadLink']).toBe(deck['nav.forehead']);
  });

  it('shows only once the token is launched, and names the tiers above only where the table stands', () => {
    expect(source).toMatch(/const showForehead = launched;/);
    expect(source).toMatch(
      /\{\s*showForehead && \(\s*<section class="page section" aria-labelledby="token-forehead-title">/,
    );
    expect(block()).toMatch(/\{tiers\.length > 0 && \(\s*<p class="small">\s*\{text\('token\.foreheadOwnAmounts'/);
  });

  it('types no address, figure or link of its own', () => {
    const piece = block();
    expect(piece).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    expect(piece).not.toMatch(/https?:\/\//);
    // No amount typed into the page: 10000, 10,000 and 1_000_000 are all four or more figures.
    expect(piece).not.toMatch(/\d[\d,_]{3,}/);
  });
});
