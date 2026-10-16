import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deck } from '../../../content/deck.ts';

/**
 * The admins' page links to the admins' page of the Community chat (docs/contracts/phase-6-room.md,
 * revision 5): a moderator reaches `/admin/chat` from `/admin` and never has to know its address.
 * Read from the page's source, as the other rules of this folder are.
 */

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
/** Comments say what the page does, so they are taken out before a rule is read. */
const page = readFileSync(source('../../AdminPage.astro'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const HREF = 'href="/admin/chat"';
/** The page has two branches: what a wallet that is no administrator sees ends at the first `</>`. */
const edge = page.indexOf('</>');
const stranger = page.slice(0, edge);
const admin = page.slice(edge);

describe('the admins’ page', () => {
  it('has two branches, the first for a wallet that is no administrator', () => {
    expect(edge).toBeGreaterThan(0);
    expect(stranger).toMatch(/!me\?\.isAdmin \? \(/);
  });

  it('links an administrator to /admin/chat, once', () => {
    expect(admin.split(HREF)).toHaveLength(2);
  });

  it('shows that link to nobody else', () => {
    expect(stranger).not.toContain('/admin/chat');
  });

  it('leads to a route the site has', () => {
    expect(existsSync(source('../../../pages/admin/chat.astro'))).toBe(true);
  });

  it('labels the link with the deck’s title of that page', () => {
    const link = admin.match(/<Button\s[^>]*href="\/admin\/chat"[^>]*\/>/)?.[0] ?? '';
    const label = link.match(/label=\{text\('([^']+)', '([^']+)'\)\}/);
    expect(label?.[1]).toBe('social.roomAdminTitle');
    expect(deck['social.roomAdminTitle']).toBe('Community chat');
    expect(label?.[2]).toBe(deck['social.roomAdminTitle']);
  });
});
