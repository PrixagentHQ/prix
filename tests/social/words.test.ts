import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADVICE_WORDS, isSocialSafeText, SOCIAL_FORBIDDEN_WORDS } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../apps/web/src/content/deck.ts';
import { readSources } from '../support/repo.ts';
import type { Violation } from '../support/text-calls.ts';
import { AREAS, checkDeck, checkTextCalls, findTextCalls, isSocialKey, socialWording } from '../support/text-calls.ts';

/**
 * The words Phase 6 does not use (docs/contracts/phase-6-social.md sections 5.3, 5.5 and 7): nothing in the
 * `social` copy area, and nothing a Phase 6 route says, uses the words of betting, of "the best" or "a
 * winner", of a fund or of advice. A model is never "the best", a manager never "a fund".
 */

const AT_GATE = process.env.PRIX_GATE === '1';
const EXTENSIONS = ['.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
const SKIPPED = (path: string): boolean => path === 'apps/web/src/content/index.ts' || path.includes('/design/studies');

const sources = readSources('apps/web/src', EXTENSIONS, SKIPPED);
const socialCalls = sources
  .flatMap((file) => findTextCalls(file.path, file.source))
  .filter((c) => c.key !== null && isSocialKey(c.key));

const report = (violations: Violation[]): string =>
  violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join('\n');

describe('the social copy area', () => {
  it('is an area of the contract', () => {
    expect(AREAS).toContain('social');
  });

  it('has drafts in the site that use none of the refused words', () => {
    const found = checkTextCalls(socialCalls, { deck, gate: false }).filter((v) => v.rule === 'draft-wording');
    expect(found, report(found)).toEqual([]);
  });

  it('has deck strings that use none of the refused words', () => {
    const entries = Object.fromEntries(Object.entries(deck).filter(([key]) => isSocialKey(key)));
    const found = checkDeck(entries).filter((v) => v.rule === 'deck-wording');
    expect(found, report(found)).toEqual([]);
    for (const [key, value] of Object.entries(entries)) {
      expect(SOCIAL_FORBIDDEN_WORDS.test(value), `${key}: ${value}`).toBe(false);
      expect(ADVICE_WORDS.test(value), `${key}: ${value}`).toBe(false);
    }
  });

  it('has a deck of its own, when the editor has written one, that uses none of the refused words', async () => {
    const path = join(process.cwd(), 'apps/web/src/content/deck-social.ts');
    if (!existsSync(path)) return;
    const module = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
    const entries = Object.values(module).find(
      (value): value is Record<string, string> => typeof value === 'object' && value !== null && !Array.isArray(value),
    );
    expect(entries, 'deck-social.ts exports a record of strings').toBeDefined();
    const found = checkDeck(entries ?? {});
    expect(found, report(found)).toEqual([]);
    for (const key of Object.keys(entries ?? {})) expect(isSocialKey(key), key).toBe(true);
  });

  it.runIf(AT_GATE)('at the gate: the site uses the area', () => {
    expect(socialCalls.length).toBeGreaterThan(0);
  });
});

describe('what a Phase 6 route says', () => {
  const dir = join(process.cwd(), 'apps/api/src/http/social');
  // The top-level route files, and the room's folder (Phase 6.3) without its tests and their support.
  const files = [...readdirSync(dir), ...readdirSync(join(dir, 'room')).map((name) => `room/${name}`)].filter(
    (name) => name.endsWith('.ts') && !/(\.test|test-support|\.config)\.ts$/.test(name),
  );

  /** Quoted strings of a source that read as a sentence: a space in them and 20 characters or more. */
  function sentences(source: string): string[] {
    const found: string[] = [];
    for (const line of source.split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import\b/.test(line)) continue;
      for (const match of line.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n$]|\\.)*)`/g)) {
        const text = match[1] ?? match[2] ?? match[3] ?? '';
        if (text.length >= 20 && text.includes(' ')) found.push(text);
      }
    }
    return found;
  }

  it('reads the route files', () => {
    expect(files).toContain('routes-managers.ts');
    expect(files).toContain('routes-wars.ts');
    expect(files).toContain('room/refusals.ts');
    expect(files).toContain('room/routes-room.ts');
  });

  it('uses none of the refused words in a message, a title or a sentence of its own', () => {
    const bad: string[] = [];
    let total = 0;
    for (const name of files) {
      for (const text of sentences(readFileSync(join(dir, name), 'utf8'))) {
        total += 1;
        if (SOCIAL_FORBIDDEN_WORDS.test(text)) bad.push(`${name}: ${text}`);
      }
    }
    expect(total).toBeGreaterThan(15);
    expect(bad).toEqual([]);
  });
});

describe('the scanner itself', () => {
  it('catches the words of betting, of ranking one above the others, of a fund and of advice', () => {
    const refused = [
      'The best model of the season',
      'Season return and the deepest fall',
      'Seasons never end',
      'A clear winner',
      'Which model won',
      'Who will beat the others',
      'Place your bet',
      'Odds of a win',
      'A prize for the champion',
      'The safest manager',
      'An aggressive allocation',
      'Guaranteed to outperform',
      'A fund of agents',
      'Buy this one',
      'You should follow it',
      'Subscribe to a manager',
      'Invest in a manager',
      'The ETF of agents',
      'Its NAV today',
    ];
    for (const text of refused) expect(socialWording(text), text).not.toBeNull();
    expect(isSocialSafeText('Best')).toBe(false);
  });

  it('lets the words of the paper simulation through', () => {
    const clean = [
      'One run under these conditions',
      'A paper manager is a simulated allocation across public agents',
      'Held recent laggards',
      'Ranked from 10 trading days and 5 decisions',
      'Net turnover per 20 priced days',
      'Two agents close in the table who changed places',
      'Return and the deepest fall',
    ];
    for (const text of clean) expect(socialWording(text), text).toBeNull();
  });
});
