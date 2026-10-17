import { readFileSync } from 'node:fs';
import { HOLDER_POLLS, HOLDERS_COPY, HOLDERS_FORBIDDEN_WORDS, pollsResponseSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { pollsFixtureRead, pollsFixtureSwitch } from './fixtures.ts';
import { barShare, castLabel, countedLabel, outcomeLine, pollTime, splitPolls } from './polls.ts';
import { probe, switchOfResponse } from './read-polls.ts';

/** The page /polls (docs/contracts/phase-6-holders.md sections 4.4 to 4.6). */

const page = readFileSync(new URL('./PollsPage.astro', import.meta.url), 'utf8');
const helpers = readFileSync(new URL('./polls.ts', import.meta.url), 'utf8');
const poll = HOLDER_POLLS[0];
if (!poll) throw new Error('no poll');

function calls(piece: string): { key: string; draft: string }[] {
  const found: { key: string; draft: string }[] = [];
  const pattern = /\btext\(\s*'([^']+)',\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  for (const match of piece.matchAll(pattern)) {
    const raw = match[2] ?? match[3] ?? '';
    found.push({ key: match[1] as string, draft: raw.replace(/\\(.)/g, '$1') });
  }
  return found;
}

describe('the words a count chooses', () => {
  it('says one vote in the singular and groups larger counts', () => {
    expect(castLabel(1)).toBe('1 vote cast');
    expect(castLabel(0)).toBe('0 votes cast');
    expect(castLabel(1200)).toBe('1,200 votes cast');
    expect(countedLabel(1)).toBe('1 counted');
    expect(countedLabel(38)).toBe('38 counted');
  });

  it('writes a time for a "{time} UTC" slot without a second UTC', () => {
    expect(pollTime(poll.closesAt)).toBe('21 Oct 2026, 20:00');
  });

  it('says the outcome from the API’s leaders: none, one chosen, or a tie, never a winner', () => {
    expect(outcomeLine(poll, [])).toBe('No vote was counted.');
    expect(outcomeLine(poll, ['big-tech-equal'])).toBe('Chosen: Big Tech Equal');
    expect(outcomeLine(poll, ['big-tech-equal', 'index-core'])).toBe(
      'A tie between Big Tech Equal and Index Core. Prix picks one of them and says which in its posts.',
    );
    expect(outcomeLine(poll, ['big-tech-equal', 'index-core', 'dip-buyer'])).toContain(
      'Big Tech Equal, Index Core and Dip Buyer',
    );
  });

  it('draws a bar as the option share of all the votes of the same figure (HB-DC-2)', () => {
    const counts = { a: 41, b: 27, c: 1, d: 12 };
    expect(barShare(counts, 'a')).toBeCloseTo(0.506, 3);
    expect(barShare(counts, 'b')).toBeCloseTo(0.333, 3);
    expect(barShare(counts, 'c')).toBeCloseTo(0.012, 3);
    expect(barShare(counts, 'd')).toBeCloseTo(0.148, 3);
    // The leader is never drawn as the whole bar unless it holds every vote.
    expect(barShare({ a: 40, b: 10 }, 'a')).toBe(0.8);
    expect(barShare({ a: 40 }, 'a')).toBe(1);
    expect(barShare({ a: 0 }, 'a')).toBe(0);
    expect(barShare({ a: 3 }, 'missing')).toBe(0);
    expect(barShare(null, 'a')).toBe(0);
  });
});

describe('the reads', () => {
  it('reads the switch from the status: 404 off, its body on, anything else failed', async () => {
    expect(await switchOfResponse(new Response('{}', { status: 404 }))).toBe('off');
    expect(await switchOfResponse(Response.json({ on: true }))).toBe('on');
    expect(await switchOfResponse(Response.json({ on: false }))).toBe('failed');
    expect(await switchOfResponse(new Response('x', { status: 500 }))).toBe('failed');
    expect(await switchOfResponse(new Response('not json', { status: 200 }))).toBe('failed');
  });

  it('keeps the probe a minute, and a failed one ten seconds', async () => {
    const slot = {};
    let asked = 0;
    const on = async () => {
      asked += 1;
      return 'on' as const;
    };
    expect(await probe(slot, 0, on)).toBe('on');
    expect(await probe(slot, 59_999, on)).toBe('on');
    expect(asked).toBe(1);
    expect(await probe(slot, 60_000, async () => Promise.reject(new Error('down')))).toBe('failed');
    expect(await probe(slot, 69_999, on)).toBe('failed');
    expect(await probe(slot, 70_000, on)).toBe('on');
  });

  it('has sample answers that the contract’s schema takes, for every state of the page', () => {
    for (const state of ['open', 'openEmpty', 'counting', 'uncounted', 'closed', 'tie', 'none', 'noneOpen']) {
      const read = pollsFixtureRead(new URL(`https://prix.test/polls?state=${state}`));
      expect(read.ok, state).toBe(true);
      if (read.ok) expect(pollsResponseSchema.safeParse(read.data).success, state).toBe(true);
    }
    expect(pollsFixtureRead(new URL('https://prix.test/polls?state=error')).ok).toBe(false);
    expect(pollsFixtureSwitch(new URL('https://prix.test/polls?state=off'))).toBe('off');
    expect(pollsFixtureSwitch(new URL('https://prix.test/token'))).toBe('off');
    expect(pollsFixtureSwitch(new URL('https://prix.test/token?polls=on'))).toBe('on');
  });

  it('splits the open poll from the closed ones in the API’s order', () => {
    const read = pollsFixtureRead(new URL('https://prix.test/polls?state=closed'));
    if (!read.ok) throw new Error('fixture');
    expect(splitPolls(read.data.polls).open).toBeNull();
    expect(splitPolls(read.data.polls).closed).toHaveLength(1);
  });
});

describe('the page', () => {
  it('shows each state of a listed poll with its own sentence', () => {
    expect(page).toContain("poll.state === 'closed' && poll.result");
    expect(page).toContain("poll.state === 'uncounted'");
    expect(page).toMatch(/text\('polls\.countFailed'/);
    expect(page).toMatch(/text\('polls\.counting'/);
    expect(page).toMatch(/text\('polls\.noneOpen'/);
    expect(page).toMatch(/text\('polls\.loadFailed'/);
  });

  it('gives the empty box the column width of the polls on the page (POLL-DC-5)', () => {
    expect(page).toMatch(
      /<div class="poll-empty">\s*<EmptyState title=\{text\('polls\.noneOpen'[^}]*\)\} boxed \/>\s*<\/div>/,
    );
    // One width for both, so the box and a poll share their right edge as well as their left.
    expect(page).toMatch(/\.poll,\s*\.poll-empty\s*\{\s*max-width: 44rem;\s*\}/);
    expect(page.match(/max-width: 44rem/g)?.length).toBe(1);
  });

  it('labels votes cast apart from votes counted, and dates the count from the result', () => {
    expect(page).toContain('countedLabel(countOf(poll.result?.counted');
    expect(page).toContain('castLabel(countOf(poll.result?.cast');
    expect(page).toContain('time: pollTime(poll.result.countedAt)');
  });

  it('carries the not-advice line, Prix’s own wallets, and a place for each option’s vote', () => {
    expect(page).toMatch(/text\(\s*'polls\.notAdvice'/);
    // Prix's own wallets are said by web-account's control, which wraps the open poll's ballot.
    expect(page).toContain('<PollVoteControl pollId={open.id} minTokens={data.minTokens}>');
    expect(page).toContain('<PollVoteOption optionId={option.id} optionName={option.name} />');
  });

  it('computes no count, leader or state of its own: they are the API’s', () => {
    expect(helpers).not.toMatch(/pollLeaders|pollStateAt|pollPublicStateAt/);
    expect(page).not.toMatch(/pollLeaders|pollStateAt|pollPublicStateAt|Date\.now/);
  });

  it('uses the contract’s words as drafts, and never says winner, governance or DAO', () => {
    const found = [...calls(page), ...calls(helpers)];
    expect(found.length).toBeGreaterThan(15);
    for (const { key, draft } of found) {
      expect(Object.hasOwn(HOLDERS_COPY, key), key).toBe(true);
      expect(draft, key).toBe(HOLDERS_COPY[key as keyof typeof HOLDERS_COPY]);
      expect(draft, key).not.toMatch(HOLDERS_FORBIDDEN_WORDS);
    }
    const markup = page.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(markup).not.toMatch(/\b(winner|governance|dao)\b/i);
  });
});
