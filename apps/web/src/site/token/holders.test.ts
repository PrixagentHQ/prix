import { readFileSync } from 'node:fs';
import {
  HOLDER_BADGE_MIN_TIER,
  HOLDER_PERKS,
  HOLDERS_COPY,
  HOLDERS_FORBIDDEN_WORDS,
  HOLDERS_VERIFIED_BADGE_KEY,
  holderPerksShown,
  holdersBadgeValueShown,
  tierTable,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { foreheadFacts } from '../../content/facts.ts';
import { formatFeedDelay } from './feed-delay.ts';
import {
  amountColumnLabels,
  amountColumns,
  badgeValueShown,
  holderAmounts,
  openColumn,
  perkCells,
  perkLabel,
  pollOpenNow,
} from './holders.ts';
import { keptAnswer } from './holders-reads.ts';

/**
 * "Open to holders now" and "Next for holders" on /token (docs/contracts/phase-6-holders.md section 2).
 * The helpers on the contract's own figures, and the page and the table read from their source, as the
 * FOREHEAD block's test reads it.
 */

const page = readFileSync(new URL('./TokenPage.astro', import.meta.url), 'utf8');
const table = readFileSync(new URL('./HoldersTable.astro', import.meta.url), 'utf8');
const helpers = readFileSync(new URL('./holders.ts', import.meta.url), 'utf8');

/** Every `text('key', 'draft'` call in a piece of source, with escapes undone. */
function calls(piece: string): { key: string; draft: string }[] {
  const found: { key: string; draft: string }[] = [];
  const pattern = /\btext\(\s*'([^']+)',\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  for (const match of piece.matchAll(pattern)) {
    const raw = match[2] ?? match[3] ?? '';
    found.push({ key: match[1] as string, draft: raw.replace(/\\(.)/g, '$1') });
  }
  return found;
}

function holdersBlock(): string {
  const start = page.indexOf('aria-labelledby="token-holders-title"');
  const end = page.indexOf('aria-labelledby="token-forehead-title"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe('the amounts', () => {
  it('are whole tokens from the API’s thresholds: 10,000, 100,000 and 1,000,000 at the configured ones', () => {
    expect(holderAmounts(tierTable([10, 100, 1000]))).toEqual([10_000, 100_000, 1_000_000]);
    expect(amountColumnLabels([10_000, 100_000, 1_000_000])).toEqual([
      'Below 10,000',
      'From 10,000',
      'From 100,000',
      'From 1,000,000',
    ]);
  });

  it('follow a lowered threshold: 7 ppm is 7,000', () => {
    const amounts = holderAmounts(tierTable([7, 100, 1000]));
    expect(amounts?.[0]).toBe(7_000);
    expect(amountColumnLabels(amounts ?? [0, 0, 0])[0]).toBe('Below 7,000');
  });

  it('are none when the API’s table lacks a tier', () => {
    expect(holderAmounts(tierTable([10, 100, 1000]).filter((rule) => rule.tier !== 2))).toBeNull();
    expect(holderAmounts([])).toBeNull();
  });
});

describe('the rows', () => {
  const byKey = (key: string) => {
    const perk = HOLDER_PERKS.find((entry) => entry.key === key);
    if (!perk) throw new Error(key);
    return perk;
  };

  it('fold the tier table’s badge column in as the badge row, from tier 2 as the rules give it (D1)', () => {
    expect(HOLDER_BADGE_MIN_TIER).toBe(2);
    expect(perkCells(byKey('badge'))).toEqual(['No', 'No', 'Yes', 'Yes']);
    expect(perkLabel(byKey('badge'), 86_400)).toBe(HOLDERS_COPY['token.perkBadge']);
  });

  it('fill the realtime row’s {delay} from the API’s feedDelaySeconds, never a typed figure (D4, R2)', () => {
    expect(perkLabel(byKey('realtime'), 86_400)).toBe(
      `Agents' fills and reasons as they are made, not ${formatFeedDelay(86_400)} later`,
    );
    expect(perkLabel(byKey('realtime'), 86_400)).toBe("Agents' fills and reasons as they are made, not 24 hours later");
    expect(perkLabel(byKey('realtime'), 3_600)).toBe("Agents' fills and reasons as they are made, not 1 hour later");
    expect(perkLabel(byKey('realtime'), 86_400)).not.toMatch(/without the/);
    for (const piece of [table, helpers]) expect(piece).not.toMatch(/24-hour/);
    expect(table).toMatch(/perkLabel\(perk, feedDelaySeconds\)/);
  });

  it('carry the contract’s figures and yeses', () => {
    expect(perkCells(byKey('agents'))).toEqual(['1', '3', '10', '25']);
    expect(perkCells(byKey('apiCalls'))).toEqual(['50', '500', '2,000', '5,000']);
    expect(perkCells(byKey('managers'))).toEqual(['1', '2', '3', '5']);
    expect(perkCells(byKey('realtime'))).toEqual(['No', 'Yes', 'Yes', 'Yes']);
    expect(perkCells(byKey('templates'))).toEqual(['No', 'Yes', 'Yes', 'Yes']);
    expect(perkCells(byKey('ownerHolds'))).toEqual(['No', 'No', 'Yes', 'Yes']);
  });

  it('make a row of whole tokens or of FOREHEAD one sentence, with its amounts filled', () => {
    expect(perkCells(byKey('chat'))).toBeNull();
    expect(perkCells(byKey('pictures'))).toBeNull();
    expect(perkCells(byKey('forehead'))).toBeNull();
    expect(perkLabel(byKey('chat'), 86_400)).toBe('Writing in the Community chat, from 1 $PRIX');
    expect(perkLabel(byKey('forehead'), 86_400)).toBe(
      `Cosmetics in FOREHEAD, from ${foreheadFacts.lowerTokens.toLocaleString('en-US')} and from ${foreheadFacts.higherTokens.toLocaleString('en-US')} $PRIX`,
    );
  });

  it('are the contract’s rows in order, through holderPerksShown, with no row of its own', () => {
    expect(table).toContain('holderPerksShown(picturesOn, ownerHoldsOn)');
    expect(holderPerksShown(true, true).map((perk) => perk.key)).toEqual([
      'agents',
      'realtime',
      'badge',
      'apiCalls',
      'managers',
      'templates',
      'chat',
      'pictures',
      'forehead',
      'ownerHolds',
    ]);
    for (const perk of HOLDER_PERKS) expect(perkLabel(perk, 86_400).length).toBeGreaterThan(0);
  });

  it('say no percent, no price and no amount typed into the table or the helpers', () => {
    for (const piece of [table, helpers]) {
      expect(piece).not.toMatch(/%/);
      expect(piece).not.toMatch(/\d[\d,_]{3,}/);
    }
  });
});

describe('the badge line', () => {
  it('drops its second sentence while the owner-holds route is not there, as the contract’s rule does', () => {
    const whole = HOLDERS_COPY['token.holdersBadgeValue'];
    expect(badgeValueShown(whole, true)).toBe(holdersBadgeValueShown(true));
    expect(badgeValueShown(whole, false)).toBe(holdersBadgeValueShown(false));
    expect(badgeValueShown(whole, false)).not.toContain('Owner holds');
  });
});

describe('the token page', () => {
  it('stands the holders’ blocks after the tier table and before FOREHEAD and the risks', () => {
    const tiers = page.indexOf('id="token-tiers-title"');
    const holders = page.indexOf('id="token-holders-title"');
    const next = page.indexOf('id="token-next-title"');
    const forehead = page.indexOf('id="token-forehead-title"');
    const risks = page.indexOf('id="token-risk-title"');
    expect(tiers).toBeGreaterThan(-1);
    expect(holders).toBeGreaterThan(tiers);
    expect(next).toBeGreaterThan(holders);
    expect(forehead).toBeGreaterThan(next);
    expect(risks).toBeGreaterThan(forehead);
  });

  it('says the statements beneath the table in the contract’s order, then the access line', () => {
    const keys = calls(holdersBlock()).map((call) => call.key);
    const order = ['token.holdersRiseNote', 'token.holdersLiveHeld', 'token.holdersLiveNothing', 'token.holdersAccess'];
    const at = order.map((key) => keys.indexOf(key));
    for (const index of at) expect(index).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The badge line is one plain sentence after the Live lines and before the access line, with no label (D5).
    const block = holdersBlock();
    const badge = block.indexOf('badgeValue(ownerHoldsOn)');
    expect(badge).toBeGreaterThan(block.indexOf("'token.holdersLiveNothing'"));
    expect(badge).toBeLessThan(block.indexOf("'token.holdersAccess'"));
    expect(page).not.toContain('token.holdersBadgeLabel');
    expect(page).not.toContain('holders-badge-label');
  });

  it('links to /polls only while the probe answers on', () => {
    expect(page).toMatch(/const pollLink = pollsSwitch === 'on';/);
    const next = page.slice(
      page.indexOf('id="token-next-title"'),
      page.indexOf('aria-labelledby="token-forehead-title"'),
    );
    expect(next).toMatch(/\{pollLink && \(\s*<>\s*\{' '\}\s*<a href="\/polls">\{pollLinkLabel\}<\/a>/);
    expect(next.match(/href="\/polls"/g)?.length).toBe(1);
    expect(page).toMatch(/const pollLinkLabel = text\('token\.holdersNextPollLink', "See the holders' poll"\);/);
  });

  it('stands the open poll under "The holders\' poll is open" and keeps the Coach alone under "Next" (POLL-DC-3, H6)', () => {
    const now = page.indexOf('id="token-now-title"');
    const next = page.indexOf('id="token-next-title"');
    expect(now).toBeGreaterThan(page.indexOf('id="token-holders-title"'));
    expect(next).toBeGreaterThan(now);
    const nowBlock = page.slice(now, page.indexOf('</section>', now));
    expect(nowBlock).toContain("text('token.holdersNowTitle', \"The holders' poll is open\")");
    expect(nowBlock).toContain('{pollLine}');
    expect(nowBlock.match(/href="\/polls"/g)?.length).toBe(1);
    expect(nowBlock).not.toContain('holdersNextCoach');
    // The section stands only while the API lists an open poll; upcoming or none, the page is as before.
    expect(page).toMatch(
      /\{\s*showHolders && amounts && pollNow && \(\s*<section[^>]*aria-labelledby="token-now-title"/,
    );
    expect(page).toMatch(/const pollNow = pollOpenNow\(pollsSwitch, pollsRead\);/);
    const nextBlock = page.slice(next, page.indexOf('</section>', next));
    expect(nextBlock).toContain("'token.holdersNextCoach'");
    expect(nextBlock).toMatch(/\{\s*!pollNow && \(\s*<li>\s*\{pollLine\}/);
  });

  it('reads the poll as open only from the API’s own state, and never while the switch is off', () => {
    const open = { ok: true as const, data: { minTokens: 10_000, polls: [{ state: 'open' }] } };
    const closed = { ok: true as const, data: { minTokens: 10_000, polls: [{ state: 'closed' }] } };
    const none = { ok: true as const, data: { minTokens: 10_000, polls: [] } };
    expect(pollOpenNow('on', open as never)).toBe(true);
    expect(pollOpenNow('on', closed as never)).toBe(false);
    expect(pollOpenNow('on', none as never)).toBe(false);
    expect(pollOpenNow('on', { ok: false, status: 502 })).toBe(false);
    expect(pollOpenNow('on', null)).toBe(false);
    expect(pollOpenNow('off', open as never)).toBe(false);
    expect(pollOpenNow('failed', open as never)).toBe(false);
  });

  it('shows the holders’ blocks only while the tiers are on and the API names all three amounts', () => {
    expect(page).toMatch(/const showHolders = Boolean\(info\?\.gatingOn && amounts\);/);
    expect(page).toMatch(/\{\s*showHolders && info && amounts && \(/);
    expect(page).toMatch(/\{\s*showHolders && amounts && \(/);
  });
});

describe('the words', () => {
  it('use the contract’s keys with its words as their drafts, and none it forbids', () => {
    const found = [...calls(page), ...calls(table), ...calls(helpers)].filter((call) =>
      Object.hasOwn(HOLDERS_COPY, call.key),
    );
    expect(found.length).toBeGreaterThan(20);
    for (const { key, draft } of found) {
      expect(draft, key).toBe(HOLDERS_COPY[key as keyof typeof HOLDERS_COPY]);
      // The badge row alone names the listed on-chain agents' existing verified badge (revision 5, D1).
      const judged = key === HOLDERS_VERIFIED_BADGE_KEY ? draft.replace(/verified badge/gi, '') : draft;
      expect(judged, key).not.toMatch(HOLDERS_FORBIDDEN_WORDS);
    }
    expect(found.map((call) => call.key)).toContain(HOLDERS_VERIFIED_BADGE_KEY);
  });
});

describe('a kept answer of the two reads', () => {
  it('is kept a minute, ten seconds when the read failed, and a failed read is "no"', async () => {
    const slot = {};
    let asked = 0;
    const yes = async () => {
      asked += 1;
      return true;
    };
    expect(await keptAnswer(slot, 0, yes)).toBe(true);
    expect(await keptAnswer(slot, 59_999, yes)).toBe(true);
    expect(asked).toBe(1);
    expect(await keptAnswer(slot, 60_000, async () => null)).toBe(false);
    expect(await keptAnswer(slot, 69_999, yes)).toBe(false);
    expect(await keptAnswer(slot, 70_000, yes)).toBe(true);
    expect(await keptAnswer({}, 0, async () => Promise.reject(new Error('down')))).toBe(false);
  });
});

describe('the tier names in the headers (D1)', () => {
  const labels = amountColumnLabels([10_000, 100_000, 1_000_000]);

  it('heads each amount column with its tier, its amount on the note line', () => {
    const columns = amountColumns(labels, null, 'your wallet');
    expect(columns.map((column) => column.label)).toEqual(['Tier 0', 'Tier 1', 'Tier 2', 'Tier 3']);
    expect(columns.map((column) => column.note)).toEqual(labels);
    expect(columns.map((column) => column.key)).toEqual(['t0', 't1', 't2', 't3']);
  });

  it("names the marked column the wallet's on its note line, the header as short as the others", () => {
    const columns = amountColumns(labels, 2, 'your wallet');
    expect(columns[2]?.label).toBe('Tier 2');
    expect(columns[2]?.note).toContain('From 100,000');
    expect(columns[2]?.note).toContain('your wallet');
    for (const index of [0, 1, 3]) expect(columns[index]?.note).not.toContain('your wallet');
    expect(table).not.toMatch(/\(\$\{markLabel\}\)/);
  });
});

describe('the tier table folded into the holders table (D1)', () => {
  it('stands the tier table only where the holders table does not show, and then as before', () => {
    expect(page).toMatch(/\{\s*!showHolders && info && tiers\.length > 0 && \(/);
    expect(page).not.toContain('tierHoldingLabels');
    // The tier table keeps its whole set of columns where it shows.
    const start = page.indexOf('const columns = [');
    expect(start).toBeGreaterThan(-1);
    const whole = page.slice(start, page.indexOf('];', start));
    for (const key of ["'tier'", "'hold'", "'agents'", "'feed'", "'badge'", "'api'"]) expect(whole).toContain(key);
  });
});

describe('the opening scroll and the swipe cue (D2)', () => {
  it('opens at the wallet’s own column for tiers 1 to 3, and at the start at tier 0 or signed out', () => {
    expect(openColumn(1)).toBe('t1');
    expect(openColumn(2)).toBe('t2');
    expect(openColumn(3)).toBe('t3');
    expect(openColumn(0)).toBeUndefined();
    expect(openColumn(null)).toBeUndefined();
  });

  it('hands the column and the cue to the Table primitive, which does the layout step', () => {
    expect(table).toMatch(/const openAt = openColumn\(markTier\);/);
    expect(table).toMatch(/openAt=\{openAt\}/);
    expect(table).toMatch(/cue=\{text\('token\.holdersSwipe', 'Swipe to see every tier'\)\}/);
    // The page's own code never scrolls the box: no script and no smooth scroll of its own.
    expect(table).not.toMatch(/<script/);
    expect(table).not.toMatch(/scroll-behavior|scrollTo|scrollLeft/);
  });
});

describe('the rows on a phone (revision 6, DC6-1, DC6-4)', () => {
  /** The rules under 40em, where the table scrolls inside its own box. */
  const narrow = table.slice(table.indexOf('@media (max-width: 40em)'));

  it('sizes a sentence row to the scroller it sits in, never to the window (DC6-1)', () => {
    expect(table).toMatch(/@media \(max-width: 40em\)/);
    // The wrapper around the Table is the box the scroller fills, so `cqi` is the scroller's width.
    expect(narrow).toMatch(/\.holders-table\s*\{\s*container-type: inline-size;\s*\}/);
    expect(narrow).toMatch(/\.holders-sentence-text\s*\{[^}]*max-width: 100cqi;[^}]*\}/);
    // The sentence's cell has no inline padding, so 100cqi less it is 100cqi.
    expect(narrow).toMatch(/:global\(\.holders-sentence th\)\s*\{\s*padding-inline: 0;\s*\}/);
    // The window's width is never the measure: inside the account card it is wider than the scroller.
    expect(table).not.toMatch(/\d+vw/);
  });

  it('keeps --space-12 at the end of the sticky row names (DC6-4)', () => {
    expect(narrow).toMatch(
      /tbody th\[scope='row'\]:not\(\[colspan\]\)\)\s*\{[^}]*position: sticky;[^}]*padding-inline-end: var\(--space-12\);[^}]*\}/,
    );
  });
});

describe('the column notes at every width (POLL-DC-4)', () => {
  const labels = amountColumnLabels([10_000, 100_000, 1_000_000]);

  it('puts the wallet’s words on a line of their own beneath the amount, with no middle dot', () => {
    for (const tier of [0, 1, 2, 3] as const) {
      const note = amountColumns(labels, tier, 'your wallet')[tier]?.note ?? '';
      expect(note).toBe(`${labels[tier]}\nyour wallet`);
      expect(note).not.toContain('·');
    }
    // The columns that are not marked carry their amount alone.
    expect(amountColumns(labels, 2, 'your wallet')[1]?.note).toBe(labels[1]);
  });

  it('never wraps a note line, at any width: "From {amount}" and the wallet’s words each stay whole', () => {
    // One rule for every width, outside any media query: the note keeps its line feed and wraps nowhere else.
    expect(table).toMatch(/\n {2}\.holders-table :global\(th \.table-note\)\s*\{\s*white-space: pre;\s*\}/);
    expect(table).not.toMatch(/pre-line/);
  });
});

describe('the amount cells’ end padding (D3)', () => {
  it('keeps the column gap as padding at the end of every amount cell', () => {
    expect(table).toMatch(
      /:is\(th, td\):is\(\.c-t0, \.c-t1, \.c-t2, \.c-t3\)\)\s*\{\s*padding-inline-end: var\(--space-16\);/,
    );
  });
});
