import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADVICE_WORDS,
  containsAdviceWord,
  entitlementsOfTier,
  feedItemSchema,
  formatNotice,
  NOTICE_SIMULATION_LINE,
  TELEGRAM_LINKED_REPLY,
  TELEGRAM_STOPPED_REPLY,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../apps/web/src/content/deck.ts';
import { createRng } from '../support/prng.ts';
import { createHarness, followAgent, wallet } from './support.ts';

const WEB_SRC = join(import.meta.dirname, '..', '..', 'apps', 'web', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(astro|ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

/** The text of every `text(...)` call that names a `follow.` key: the arguments up to the closing parenthesis. */
function followTextCalls(source: string): string[] {
  const calls: string[] = [];
  const open = /\btext\(/g;
  for (let match = open.exec(source); match !== null; match = open.exec(source)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote: string | null = null;
    let end = start;
    for (; end < source.length && depth > 0; end += 1) {
      const char = source[end] as string;
      if (quote !== null) {
        if (char === '\\') end += 1;
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    const args = source.slice(start, end - 1);
    if (/['"`]follow\./.test(args)) calls.push(args);
  }
  return calls;
}

/** The string literals of a call that are copy: every literal except the keys. */
function draftsOf(args: string): string[] {
  // A literal compared with `===` is code (`fill.side === 'buy'`), not copy.
  const copy = args.replace(/[!=]==?\s*(?:'[^']*'|"[^"]*")/g, '');
  const literals = [...copy.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map(
    (found) => found[1] ?? found[2] ?? found[3] ?? '',
  );
  return literals.filter((literal) => !/^follow\.[\w.]+$/.test(literal));
}

describe('every decision a feed shows is labelled as a simulation', () => {
  it('sets simulated: true on every item of every feed response', async () => {
    const viewer = wallet(61);
    const owner = wallet(62);
    for (const base of [entitlementsOfTier(0), entitlementsOfTier(3)]) {
      const h = createHarness({ base });
      const one = await h.seedAgent(1, { owner: owner.address });
      const two = await h.seedAgent(2);
      followAgent(h, viewer.address, one.id);
      followAgent(h, viewer.address, two.id);
      const client = await h.as(viewer);
      const items = [
        ...(await client.get(`/api/agents/${one.id}/feed?limit=30`)).json.items,
        ...(await client.get(`/api/agents/${two.id}/feed?limit=30`)).json.items,
        ...(await client.get('/api/feed?limit=30')).json.items,
        ...(await h.anonymous().get(`/api/agents/${one.id}/feed`)).json.items,
      ];
      expect(items.length).toBeGreaterThan(10);
      for (const item of items) {
        expect(item.simulated).toBe(true);
        expect(feedItemSchema.safeParse(item).success).toBe(true);
      }
    }
  });

  it('rejects an item whose simulated flag is not true', () => {
    const item = {
      agentId: 'agentaaaaaab',
      agentName: 'A',
      division: 'open',
      tickId: '2026-10-06T15:00Z',
      at: '2026-10-06T15:00:01.000Z',
      reason: '',
      fills: [],
      halted: [],
      equityMicro: 0,
      costMicro: 0,
    };
    expect(feedItemSchema.safeParse({ ...item, simulated: true }).success).toBe(true);
    expect(feedItemSchema.safeParse({ ...item, simulated: false }).success).toBe(false);
    expect(feedItemSchema.safeParse(item).success).toBe(false);
  });

  it('keeps the simulation label key in FeedItem.astro', () => {
    const source = readFileSync(join(WEB_SRC, 'account', 'follow', 'FeedItem.astro'), 'utf8');
    expect(source).toContain('follow.simulationLabel');
  });
});

describe('no copy of the follow phase reads as advice', () => {
  it('has a pattern that catches the words of an instruction', () => {
    for (const word of ['Buy NVDA', 'you should', 'a signal', 'we recommend it', 'guaranteed', 'must win', 'a tip']) {
      expect(containsAdviceWord(word), word).toBe(true);
    }
    expect(containsAdviceWord('Added NVDA. Reduced MSFT.')).toBe(false);
  });

  it('has no advice word in a generated notice, and every notice ends with the simulation line', () => {
    const rng = createRng(20_261_006);
    const symbols = ['NVDA', 'MSFT', 'AAPL', 'TSLA', 'SPY', 'USO', 'AMZN', 'META'];
    const names = ['Agent 7', 'Northwind Desk', 'Zed', 'Calm Harbor', 'Quant Seven'];
    for (let n = 0; n < 20; n += 1) {
      const fills = Array.from({ length: rng.int(0, 9) }, () => ({
        symbol: rng.pick(symbols),
        side: rng.pick(['buy', 'sell'] as const),
      }));
      const reason = `Because NVDA is going to rise, so ${rng.pick(['buy', 'sell'])} now (case ${n})`;
      // A reason that a caller smuggles in is not part of the input type and must not reach the text.
      const input = {
        agentName: rng.pick(names),
        tickId: `2026-10-0${rng.int(1, 9)}T${rng.int(10, 23)}:00Z`,
        fills,
        link: 'https://prixagent.com/agents/agentaaaaaab',
        reason,
      };
      const notice = formatNotice(input);
      expect(ADVICE_WORDS.test(notice), notice).toBe(false);
      expect(notice.endsWith(NOTICE_SIMULATION_LINE), notice).toBe(true);
      expect(notice).not.toContain(reason);
      expect(notice).not.toContain('Because');
    }
  });

  it('has no advice word in the two bot replies or the simulation line', () => {
    for (const reply of [TELEGRAM_LINKED_REPLY, TELEGRAM_STOPPED_REPLY, NOTICE_SIMULATION_LINE]) {
      expect(ADVICE_WORDS.test(reply), reply).toBe(false);
    }
    expect(TELEGRAM_LINKED_REPLY).toContain('Not investment advice');
  });

  it("has no advice word in any string passed to text('follow.*') in apps/web/src", () => {
    const drafts: { file: string; draft: string }[] = [];
    let calls = 0;
    for (const file of sourceFiles(WEB_SRC)) {
      for (const args of followTextCalls(readFileSync(file, 'utf8'))) {
        calls += 1;
        for (const draft of draftsOf(args)) drafts.push({ file: file.slice(WEB_SRC.length + 1), draft });
      }
    }
    // The scan must not pass by finding nothing.
    expect(calls).toBeGreaterThan(10);
    expect(drafts.length).toBeGreaterThan(10);
    const offenders = drafts.filter(({ draft }) => ADVICE_WORDS.test(draft));
    expect(offenders).toEqual([]);
  });

  it('has no advice word in a follow.* entry of the copy deck', () => {
    const entries = Object.entries(deck).filter(([key]) => key.startsWith('follow.'));
    const offenders = entries.filter(([, value]) => ADVICE_WORDS.test(value));
    expect(offenders).toEqual([]);
  });
});
