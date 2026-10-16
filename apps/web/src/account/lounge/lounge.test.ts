import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOLDERS2_PAGE_WORDS, loungeResponseSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { LOUNGE_FIXTURES, loungeFixture } from './fixtures.ts';
import type { LoungeRead } from './read.ts';
import { loungeReadOf, loungeViewOf } from './read.ts';
import { loungeWords } from './words.ts';

/**
 * The lounge's block on /following (docs/contracts/phase-6-holders-2.md sections 4.5 and 4.7): shown only
 * when GET /api/lounge answers 200 with an answer the contract's schema takes, absent on any other answer,
 * the invite link only in state `open`, and every sentence the contract's own.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string): string => readFileSync(`${here}${name}`, 'utf8');
const code = (name: string): string =>
  read(name)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const URL_OPEN = 'https://t.me/+AbCdEfGh12345678';
const ok = (body: unknown, status = 200): LoungeRead => loungeReadOf(status, body);

describe('loungeReadOf: what an answer of GET /api/lounge is', () => {
  it('takes a 200 the contract’s schema takes, in each of the three states', () => {
    expect(ok({ state: 'open', url: URL_OPEN })).toEqual({ ok: true, data: { state: 'open', url: URL_OPEN } });
    expect(ok({ state: 'not_holder', url: null })).toEqual({ ok: true, data: { state: 'not_holder', url: null } });
    expect(ok({ state: 'link_telegram', url: null })).toEqual({
      ok: true,
      data: { state: 'link_telegram', url: null },
    });
  });

  it('refuses any other status, whatever the body says', () => {
    for (const status of [201, 204, 301, 400, 401, 403, 404, 429, 500, 502, 503]) {
      expect(ok({ state: 'open', url: URL_OPEN }, status), String(status)).toEqual({ ok: false, status });
    }
  });

  it('refuses a body the schema does not take: a link outside open, open without one, a link that is not Telegram’s', () => {
    for (const body of [
      { state: 'not_holder', url: URL_OPEN },
      { state: 'link_telegram', url: URL_OPEN },
      { state: 'open', url: null },
      { state: 'open', url: 'https://evil.example/+AbCdEfGh12345678' },
      { state: 'open', url: 'javascript:alert(1)' },
      { state: 'open', url: 'http://t.me/+AbCdEfGh12345678' },
      { state: 'open', url: URL_OPEN, extra: true },
      { state: 'member', url: null },
      null,
      'open',
    ]) {
      expect(ok(body), JSON.stringify(body)).toEqual({ ok: false, status: 502 });
    }
  });
});

describe('loungeViewOf: what the block shows', () => {
  it('is nothing on any answer but a usable 200', () => {
    expect(loungeViewOf({ ok: false, status: 404 })).toBeNull();
    expect(loungeViewOf({ ok: false, status: 401 })).toBeNull();
    expect(loungeViewOf({ ok: false, status: 500 })).toBeNull();
    expect(loungeViewOf({ ok: false, status: 502 })).toBeNull();
  });

  it('is the state, with the link only in open', () => {
    expect(loungeViewOf(ok({ state: 'not_holder', url: null }))).toEqual({ state: 'not_holder' });
    expect(loungeViewOf(ok({ state: 'link_telegram', url: null }))).toEqual({ state: 'link_telegram' });
    expect(loungeViewOf(ok({ state: 'open', url: URL_OPEN }))).toEqual({ state: 'open', url: URL_OPEN });
  });
});

describe('the words of the block', () => {
  it('are the contract’s sentences, word for word', () => {
    const words = loungeWords();
    expect(words).toEqual({
      title: HOLDERS2_PAGE_WORDS['lounge.title'],
      description: HOLDERS2_PAGE_WORDS['lounge.description'],
      join: HOLDERS2_PAGE_WORDS['lounge.join'],
      joinNote: HOLDERS2_PAGE_WORDS['lounge.joinNote'],
      linkFirst: HOLDERS2_PAGE_WORDS['lounge.linkFirst'],
      notHolder: HOLDERS2_PAGE_WORDS['lounge.notHolder'],
      leaving: HOLDERS2_PAGE_WORDS['lounge.leaving'],
    });
  });
});

describe('the block as the server renders it', () => {
  const block = code('LoungeBlock.astro');
  const part = (state: string): string => {
    const from = block.indexOf(`view.state === '${state}'`);
    expect(from, state).toBeGreaterThan(0);
    const next = block.slice(from + 1).search(/view\.state === '/);
    return next === -1 ? block.slice(from) : block.slice(from, from + 1 + next);
  };

  it('reads GET /api/lounge once, on the server, and renders nothing unless it answered', () => {
    expect(block.match(/\bfetchLounge\(Astro\)/g)).toHaveLength(1);
    expect(block).toMatch(/\bloungeViewOf\(/);
    expect(block).toMatch(/\{\s*view && \(/);
  });

  it('has no script: nothing in the browser asks the API, and the link is a plain link', () => {
    for (const name of readdirSync(here).filter((file) => /\.astro$/.test(file))) {
      expect(code(name)).not.toMatch(/<script\b/);
    }
  });

  it('says the title and the description in every state', () => {
    expect(block).toMatch(/\{words\.title\}/);
    expect(block).toMatch(/\{words\.description\}/);
  });

  it('says each state’s sentence, and the link only in open', () => {
    expect(part('not_holder')).toMatch(/\{words\.notHolder\}/);
    expect(part('link_telegram')).toMatch(/\{words\.linkFirst\}/);
    const open = part('open');
    expect(open).toMatch(/href=\{view\.url\}/);
    expect(open).toMatch(/label=\{words\.join\}/);
    expect(open.indexOf('words.joinNote')).toBeGreaterThan(open.indexOf('href={view.url}'));
    expect(open.indexOf('words.leaving')).toBeGreaterThan(open.indexOf('words.joinNote'));
    expect(block.match(/href=/g)).toHaveLength(1);
    expect(part('not_holder')).not.toMatch(/words\.(join|joinNote|leaving|linkFirst)\b/);
    expect(part('link_telegram')).not.toMatch(/words\.(join|joinNote|leaving|notHolder)\b/);
  });

  it('never builds markup from a string, and keeps nothing in the browser', () => {
    for (const name of readdirSync(here).filter((file) => /\.(ts|astro)$/.test(file) && !file.endsWith('.test.ts'))) {
      expect(code(name), name).not.toMatch(/innerHTML|set:html|localStorage|sessionStorage|document\.cookie/);
    }
  });
});

describe('the read of GET /api/lounge', () => {
  const source = code('read.ts');

  it('is a GET of /api/lounge through the API binding, with the contract’s schema', () => {
    expect(source).toMatch(/method: 'GET', path: '\/api\/lounge'/);
    expect(source).toMatch(/createServerTransport/);
    expect(source).toMatch(/loungeResponseSchema\.safeParse/);
  });

  it('logs a failure by name only: never the answer, never the link', () => {
    const logs = source.match(/console\.\w+\([^)]*\)/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toMatch(/body|url|data|response\b/i);
  });
});

describe('the page /following', () => {
  const page = code('../follow/FollowingPage.astro');

  it('includes the block once, directly below the Telegram settings of the follow alerts', () => {
    expect(page.match(/<LoungeBlock\s*\/>/g)).toHaveLength(1);
    expect(page).toMatch(/import LoungeBlock from '\.\.\/lounge\/LoungeBlock\.astro';/);
    const notify = page.indexOf('<NotifySettings');
    const lounge = page.indexOf('<LoungeBlock');
    expect(notify).toBeGreaterThan(0);
    expect(lounge).toBeGreaterThan(notify);
    // Nothing else is drawn between the two: only the ends of the Notes part.
    const between = page.slice(page.indexOf('/>', notify) + 2, lounge);
    expect(between).not.toMatch(/<[A-Za-z]/);
  });

  it('includes it in the signed-in branch only, inside the panel, before the feed', () => {
    const lounge = page.indexOf('<LoungeBlock');
    expect(lounge).toBeGreaterThan(page.indexOf('<Panel'));
    expect(lounge).toBeLessThan(page.indexOf('</Panel>'));
    expect(lounge).toBeGreaterThan(page.indexOf('<SessionGate session={gate} steps />'));
  });
});

describe('the fixtures of the block', () => {
  it('are absent by default, as the API answers while the lounge is off', () => {
    expect(loungeViewOf(loungeFixture(null))).toBeNull();
    expect(loungeViewOf(loungeFixture('signed-in'))).toBeNull();
    expect(loungeViewOf(loungeFixture('toString'))).toBeNull();
  });

  it('are chosen by their own parameter, never by a name of ?fixture=, which the other transports refuse', () => {
    expect(code('read.ts')).toMatch(/loungeFixture\(context\.url\.searchParams\.get\('lounge'\)\)/);
  });

  it('give each state an answer the schema takes, and each failure its status', () => {
    for (const [name, sample] of Object.entries(LOUNGE_FIXTURES)) {
      if (sample.status === 200) expect(loungeResponseSchema.safeParse(sample.body).success, name).toBe(true);
    }
    expect(loungeViewOf(loungeFixture('open'))).toEqual({ state: 'open', url: 'https://t.me/+SampleInviteLink01' });
    expect(loungeViewOf(loungeFixture('link'))).toEqual({ state: 'link_telegram' });
    expect(loungeViewOf(loungeFixture('not-holder'))).toEqual({ state: 'not_holder' });
    expect(loungeFixture('ended')).toEqual({ ok: false, status: 401 });
    expect(loungeFixture('fails')).toEqual({ ok: false, status: 500 });
  });
});
