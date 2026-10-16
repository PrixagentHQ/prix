// "Owner holds $PRIX" on the agent's own page (docs/contracts/phase-6-holders.md section 3, part B).
// Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLDERS_COPY, HOLDERS_FORBIDDEN_WORDS, type TokenInfoResponse } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { OWNER_HOLDS_NOTE_ID, ownerHoldsMark } from './owner-holds.ts';

const here = dirname(fileURLToPath(import.meta.url));
const arena = join(here, '..');

function info(ppm: [number, number, number]): TokenInfoResponse {
  const tier = (n: 0 | 1 | 2 | 3, thresholdPpm: number) => ({
    tier: n,
    thresholdPpm,
    maxAgents: 1,
    realtimeFeed: false,
    verifiedBadge: false,
    apiDailyQuota: 50,
  });
  return {
    gatingOn: true,
    tokenAddress: '0xa74ac6e9f2f8493344923c23972d496364241044',
    explorerUrl: null,
    buyUrl: null,
    tiers: [tier(0, 0), tier(1, ppm[0]), tier(2, ppm[1]), tier(3, ppm[2])],
    feedDelaySeconds: 86_400,
  };
}

const DEFAULT = info([10, 100, 1_000]);

describe('ownerHoldsMark', () => {
  it('shows nothing while the API does not send the field', () => {
    expect(ownerHoldsMark({}, DEFAULT)).toBeNull();
    expect(ownerHoldsMark({ ownerHolds: undefined }, DEFAULT)).toBeNull();
  });

  it('shows nothing when the API says false', () => {
    expect(ownerHoldsMark({ ownerHolds: false }, DEFAULT)).toBeNull();
  });

  it('shows the contract words and the note with the tier-2 amount from GET /api/token', () => {
    expect(ownerHoldsMark({ ownerHolds: true }, DEFAULT)).toEqual({
      label: HOLDERS_COPY['agent.ownerHolds'],
      note: HOLDERS_COPY['agent.ownerHoldsNote'].replace('{amount}', '100,000'),
      noteId: OWNER_HOLDS_NOTE_ID,
    });
  });

  it('takes the amount from the configured threshold, never a figure of its own', () => {
    const lowered = ownerHoldsMark({ ownerHolds: true }, info([7, 70, 700]));
    expect(lowered?.note).toContain('at least 70,000 $PRIX');
    expect(lowered?.note).not.toContain('100,000');
  });

  it('shows nothing when the threshold cannot be read', () => {
    expect(ownerHoldsMark({ ownerHolds: true }, null)).toBeNull();
    const withoutTwo = DEFAULT.tiers.filter((tier) => tier.tier !== 2);
    expect(ownerHoldsMark({ ownerHolds: true }, { ...DEFAULT, tiers: withoutTwo })).toBeNull();
    expect(ownerHoldsMark({ ownerHolds: true }, info([0, 0, 0]))).toBeNull();
  });

  it('never says a forbidden word, "verified" among them', () => {
    const mark = ownerHoldsMark({ ownerHolds: true }, DEFAULT);
    expect(mark).not.toBeNull();
    expect(`${mark?.label} ${mark?.note}`).not.toMatch(HOLDERS_FORBIDDEN_WORDS);
  });
});

describe('the agent page', () => {
  const page = readFileSync(join(arena, 'AgentPage.astro'), 'utf8');
  const helper = readFileSync(join(here, 'owner-holds.ts'), 'utf8');

  it('gives the two keys the contract words as their drafts', () => {
    expect(helper).toContain(`text('agent.ownerHolds', '${HOLDERS_COPY['agent.ownerHolds']}')`);
    expect(helper).toContain(`"${HOLDERS_COPY['agent.ownerHoldsNote']}"`);
  });

  it('describes the mark by its note, and the mark is no link, no control and no chip', () => {
    const at = page.indexOf('class="agent-holds"');
    expect(at).toBeGreaterThan(0);
    const mark = page.slice(page.lastIndexOf('{holds', at), page.indexOf('</span>', at));
    expect(mark).toMatch(/aria-describedby=\{holds\.noteId\}/);
    expect(mark).not.toMatch(/<a\b|<button\b|href=|<Chip\b|<Medal\b/);
    expect(page).toMatch(/id=\{holds\.noteId\}/);
  });

  it('is the only arena file that reads the field or says the words', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(astro|ts)$/.test(name) && !name.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(arena);
    const readers = files
      .filter((file) => /ownerHolds|Owner holds/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(arena, file).replaceAll('\\', '/'))
      .sort();
    expect(readers).toEqual(['AgentPage.astro', 'agent/owner-holds.ts']);
  });

  it('keeps the mark out of the title, the description and the share tags', () => {
    const description = page.slice(page.indexOf('const description'), page.indexOf('const pageTitle'));
    expect(description).toContain('agent.descriptionLeague');
    expect(description).not.toMatch(/holds/i);
    for (const share of page.match(/<ShareMeta[^>]*>/g) ?? []) expect(share).not.toMatch(/holds/i);
  });
});
