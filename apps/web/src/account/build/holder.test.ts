import type { TokenMeResponse, UniverseToken } from '@prix/contracts';
import { entitlementsOfTier, MAX_WEIGHT_BPS, promptSchema } from '@prix/contracts';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// `@prix/web` does not depend on `@prix/market`: the universe is read from its source, as
// apps/web/src/content/pages/methodology.ts does.
import { UNIVERSE } from '../../../../../packages/market/src/universe.ts';
import type { ApiResult } from '../../lib/api.ts';
import { holderTemplates, holderTemplateWords, strategyTemplates, templateWords } from './templates.ts';

/**
 * The holder templates of the Build page (D-161): eight more starting texts for a signed-in wallet
 * that the SERVER read at tier 1 or above. The page renders them only from its own read of the
 * session's entitlements (`fetchTokenMe`, mocked here so that the test, not a fixture of the
 * request, says what the API answered). A page under tier 1, or one whose read failed, holds one
 * quiet line and a link to the token page, and neither the title nor the text of any holder
 * template. Nothing the request carries, in its query, its cookies or its headers, changes that.
 */

const read = vi.hoisted(() => ({
  answer: null as unknown,
  calls: [] as unknown[],
}));

vi.mock('../token/token-client.ts', async (original) => {
  const actual = await original<typeof import('../token/token-client.ts')>();
  return {
    ...actual,
    fetchTokenMe: async (context: unknown) => {
      read.calls.push(context);
      return read.answer;
    },
  };
});

function me(tier: 0 | 1 | 2 | 3, entitlementsTier: 0 | 1 | 2 | 3 = tier): ApiResult<TokenMeResponse> {
  return {
    ok: true,
    status: 200,
    data: {
      gatingOn: true,
      tokenAddress: '0xa74ac6e9f2f8493344923c23972d496364241044',
      tier,
      entitlements: entitlementsOfTier(entitlementsTier),
      balance: '0',
      totalSupply: '1000000000000000000000000000',
      decimals: 18,
      holdingPpm: 0,
      nextTier: null,
      slots: { used: 0, max: entitlementsOfTier(entitlementsTier).maxAgents, pausedForSlots: 0 },
      checkedAt: '2026-10-16T06:00:00.000Z',
      stale: false,
    },
  };
}

const FAILED: ApiResult<TokenMeResponse> = {
  ok: false,
  status: 503,
  error: { code: 'internal', message: 'The fixture is set to fail.', field: null },
};

const HOLDER = holderTemplates();
const FIRST = strategyTemplates();
const HOLDER_WORDS = holderTemplateWords();

/** Every string of a holder template that must never reach a page under tier 1. */
const HOLDER_STRINGS = HOLDER.flatMap((template) => [template.title, template.line, template.prompt]);

/** Astro escapes text and attributes: compare against the HTML's own spelling of each string. */
function escaped(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function holds(html: string, value: string): boolean {
  return html.includes(value) || html.includes(escaped(value)) || html.includes(value.replaceAll('"', '&#34;'));
}

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});
beforeEach(() => {
  read.calls = [];
});

async function render(
  answer: ApiResult<TokenMeResponse> | null,
  options: { query?: string; cookie?: string; headers?: Record<string, string>; fixture?: string } = {},
): Promise<string> {
  read.answer = answer;
  const { default: BuildPage } = await import('../BuildPage.astro');
  const query = options.query ? `&${options.query}` : '';
  return container.renderToString(BuildPage, {
    request: new Request(`http://127.0.0.1/build?fixture=${options.fixture ?? 'signed-in'}${query}`, {
      headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.headers ?? {}) },
    }),
  });
}

function expectLocked(html: string): void {
  for (const value of HOLDER_STRINGS) expect(holds(html, value), value).toBe(false);
  expect(html).not.toContain(HOLDER_WORDS.title);
  expect(html).not.toContain('data-templates-holder');
  expect(html).toMatch(/<p class="tpl-locked"[^>]*data-templates-locked[^>]*>/);
  expect(html.split(escaped(HOLDER_WORDS.locked))).toHaveLength(2);
  expect(html).toMatch(/data-templates-locked[^>]*>[^<]*<a href="\/token"[^>]*>/);
  // The first eight stay, with the note once.
  expect(html.match(/<button class="tpl-item[^"]*" type="button"/g)).toHaveLength(FIRST.length);
  expect(html.split(templateWords().note)).toHaveLength(2);
}

function expectHolder(html: string): void {
  for (const value of HOLDER_STRINGS) expect(holds(html, value), value).toBe(true);
  expect(html).not.toContain('data-templates-locked');
  expect(html).toMatch(/<ul class="tpl-list tpl-list-holder"[^>]*aria-labelledby="templates-holder-title"/);
  expect(html.match(/<button class="tpl-item[^"]*" type="button"/g)).toHaveLength(FIRST.length + HOLDER.length);
  // Each holder template is a button as the first eight are, in the same section, with its text
  // in an escaped attribute that the same script reads.
  for (const template of HOLDER) {
    expect(html).toContain(`data-template-id="${template.id}"`);
    expect(html).toContain(`id="templates-line-${template.id}"`);
  }
  expect(html.split(templateWords().note)).toHaveLength(2);
  expect(html.split(/data-templates(?=[\s>=])/)).toHaveLength(2);
}

describe('the eight holder templates', () => {
  const symbols = new Set(UNIVERSE.map((token: UniverseToken) => token.symbol));

  it('are eight, each with its own id, title, line and prompt, none shared with the first eight', () => {
    expect(HOLDER).toHaveLength(8);
    for (const key of ['id', 'title', 'line', 'prompt'] as const) {
      const all = [...FIRST, ...HOLDER].map((template) => template[key]);
      expect(new Set(all).size).toBe(16);
    }
  });

  it.each(HOLDER.map((template) => [template.id, template] as const))(
    '%s names only symbols of the league’s universe, and no weight above the cap',
    (_id, template) => {
      const named = [...`${template.title} ${template.line} ${template.prompt}`.matchAll(/\b[A-Z]{2,5}\b/g)].map(
        (match) => match[0],
      );
      expect(named.length).toBeGreaterThan(0);
      for (const symbol of named) expect(symbols.has(symbol), symbol).toBe(true);
      for (const match of template.prompt.matchAll(/(\d+)%/g)) {
        expect(Number(match[1])).toBeLessThanOrEqual(MAX_WEIGHT_BPS / 100);
      }
    },
  );

  it.each(HOLDER.map((template) => [template.id, template] as const))(
    '%s passes the contract’s prompt rules',
    (_id, template) => {
      expect(promptSchema.safeParse(template.prompt).success).toBe(true);
      expect(template.prompt).toBe(template.prompt.trim());
    },
  );

  it.each(HOLDER.map((template) => [template.id, template] as const))(
    '%s reads only what an agent’s decision call is given',
    (_id, template) => {
      // The call gives each symbol's returns over 1, 5 and 20 trading days, the halted symbols and
      // the portfolio's cash and weights (packages/runtime/src/prompts.ts). Nothing else.
      expect(template.prompt).not.toMatch(
        /moving average|volatil\w*|standard deviation|drawdown|\bhighs?\b|\blows?\b|volume|earnings|news|sentiment|\bRSI\b|\bMACD\b|\b(?:10|50|100|200)-day|over the last (?!(?:1|5|20|five|twenty)\b|trading day\b)/i,
      );
      for (const match of template.prompt.matchAll(/(\d+)-day/g)) expect(['1', '5', '20']).toContain(match[1]);
      // Never "buy" or "sell": a template holds, adds, raises or moves to cash.
      expect(template.prompt).not.toMatch(/\b(?:buy|sell)\w*/i);
    },
  );

  it('say in the locked line what a holder gets, and no holder template', () => {
    expect(HOLDER_WORDS.locked).toBe('Eight more templates for wallets holding 10,000 $PRIX.');
    for (const template of HOLDER) {
      expect(HOLDER_WORDS.locked).not.toContain(template.title);
      expect(HOLDER_WORDS.lockedLink).not.toContain(template.title);
    }
  });
});

describe('the Build page, as the server renders it', () => {
  it('holds no holder template at tier 0, only the locked line and its link', async () => {
    const html = await render(me(0));
    expectLocked(html);
    expect(read.calls).toHaveLength(1);
  });

  it('holds all eight at tier 1, and at tiers 2 and 3', async () => {
    expectHolder(await render(me(1)));
    expectHolder(await render(me(2)));
    expectHolder(await render(me(3)));
  });

  it('follows the entitlements the server read, not the tier beside them', async () => {
    expectLocked(await render(me(1, 0)));
    expectHolder(await render(me(0, 1)));
  });

  it('shows the locked line when the read failed', async () => {
    expectLocked(await render(FAILED));
  });

  it('changes nothing for a forged flag in the query, a cookie or a header', async () => {
    const html = await render(me(0), {
      query: 'tier=1&holder=1&holders=true&entitlements=1&tokenfixture=tier1',
      cookie: 'prix_tier=1; holder=1; prix_holder=true',
      headers: { 'x-prix-tier': '1', 'x-prix-holder': 'true', 'x-entitlements-tier': '3' },
    });
    expectLocked(html);
    // The page asked the server once, with the request's own context, and read nothing else.
    expect(read.calls).toHaveLength(1);
  });

  it('shows the locked line signed out, asks the server nothing about a tier, and holds no holder template', async () => {
    const html = await render(me(3), { fixture: 'signed-out', query: 'tier=1&holder=1' });
    expect(read.calls).toHaveLength(0);
    for (const value of HOLDER_STRINGS) expect(holds(html, value), value).toBe(false);
    expect(html).toContain('data-templates-locked');
    expect(html).toContain('data-templates-keep');
  });
});
