// Looks at the home page of a SAMPLE build (PRIX_FIXTURES=1) and says whether it keeps the rules of
// docs/DESIGN.md sections 5.3 and 29 (R17, "the board is the hero") that no type check sees.
// Read-only: it only GETs pages of the origin it is given, and it refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4393 --host 127.0.0.1
//   node apps/web/src/arena/home/home-check.mjs http://127.0.0.1:4393 [directory for screenshots]
//
// It prints one line for each failed check, then a count, and exits 1 when one fails. The checks:
//   - at 320, 360, 390, 768, 800, 1024, 1440 and 1920, dark and light: no sideways scroll, the hero's
//     band from edge to edge, the one sentence as the page's h1;
//   - under 720: the first screen in the order header, sentence, subhead, action, board; the search
//     field and the tape after the board; no search field and no "How it works" in the header; at 360
//     by 780 and 390 by 844 the action, the board's title and its first three rows on the first screen;
//   - from 720: the tape above the hero; the action under the subhead, left-aligned; from 960 the
//     decisions beside the board;
//   - the Prix Live line (D-168) between the subhead and the action, aligned with the subhead: its
//     first sentence the one link to /live, never a button, no underline at rest and the hairline
//     on hover; the risk sentence after it as plain text, on the link's last line when it fits;
//   - "How it works" once on the first screen; one table on the page (no list of prices);
//   - the board's meta line without a middle dot, its link without an arrow, the rank rule with
//     trading days and decisions; the decisions: at most five, no reason, only agents Prix runs;
//   - the board for assistive technology: one "Agent" column head, the animal's cells hidden, no
//     empty cell; every chip inside its name cell, never over the line (also at 320 in two states);
//     no "top five" over unranked rows;
//   - each state of the hero: none ranked, a round running, the market closed, the reads failing,
//     no agent in the division, no league, an agent that made no decision, no decision to show; the
//     state of the league as the key's second sentence, a pause in the meta line above the fold at
//     1440, and a failed read that claims nothing it cannot know.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [origin, shots] = process.argv.slice(2);
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('local only');
if (shots) mkdirSync(shots, { recursive: true });

const WIDTHS = [320, 360, 390, 768, 800, 1024, 1440, 1920];
const SENTENCE = 'AI agents trade paper money at real market prices, ranked in public.';
// The Prix Live line (D-168): the link's sentence, and the risk sentence after it as plain text.
const LIVE_LINK = 'Where it is open, Prix Live can follow your agent with real money, in a Safe of your own.';
const LIVE_RISK = 'You can lose that money.';
// The key's first sentence; the state of the league is its second (DESIGN.md 5.3).
const START = 'Every agent starts with 10,000 virtual USD.';
// The agents Prix runs in the sample feed `feed-league` (apps/web/src/lib/follow-fixtures.ts).
const HOUSE = new Set(['Quiet Index', 'Cash Is A Position']);
let failed = 0;
let checks = 0;
const check = (ok, message) => {
  checks++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${message}`);
  }
};

const browser = await chromium.launch();
const context = await browser.newContext();

async function open(query, width, height, theme = 'dark') {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  const join = query ? `${query}&` : '';
  const response = await page.goto(`${origin}/?${join}theme=${theme}`, { waitUntil: 'load' });
  return { page, status: response?.status() ?? 0 };
}

/** Everything the checks read, in one pass in the page. */
function measure(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const shown = (e) => {
      if (!e) return false;
      const s = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
    };
    const box = (selector) => {
      const e = document.querySelector(selector);
      if (!shown(e)) return null;
      const b = e.getBoundingClientRect();
      return { top: b.top + scrollY, bottom: b.bottom + scrollY, left: b.left, right: b.right };
    };
    const rows = [...document.querySelectorAll('[data-standings] tbody tr')].map((e) => {
      const b = e.getBoundingClientRect();
      const line = e.querySelector('.st-line')?.getBoundingClientRect();
      const name = e.querySelector('.st-name')?.getBoundingClientRect();
      // How far the widest chip of the row reaches past the left edge of the line's cell, and past
      // its own name cell: a chip stays inside the name cell (DESIGN 5.3, a skipped day keeps its line).
      const chipNodes = [...e.querySelectorAll('.standings-chips .chip')];
      const chips = chipNodes.map((c) => c.getBoundingClientRect());
      // How many lines each chip's words take: a chip is one short line, never a two-line box.
      const chipLines = chipNodes.map((c) => {
        // The words only: the house chip's mark is drawn beside them and sits on its own top.
        const tops = new Set();
        const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
        }
        return { text: c.textContent.trim(), lines: tops.size };
      });
      return {
        chipLines,
        bottom: b.bottom + scrollY,
        none: e.querySelector('.standings-rank--none') !== null,
        text: e.textContent,
        chipOverLine: line && chips.length ? Math.max(...chips.map((c) => c.right - line.left)) : null,
        chipOverName: name && chips.length ? Math.max(...chips.map((c) => c.right - name.right)) : null,
        markHidden: e.querySelector('.st-mark')?.getAttribute('aria-hidden') === 'true',
      };
    });
    const decisions = [...document.querySelectorAll('.hero-decisions .feed-row')].map((e) => ({
      name: e.querySelector('.feed-row-name')?.textContent.trim(),
      why: e.querySelector('.feed-row-why') !== null,
    }));
    const how = [...document.querySelectorAll('a')].filter(
      (e) => shown(e) && e.textContent.trim() === 'How it works' && e.getBoundingClientRect().top < innerHeight,
    ).length;
    const hero = document.querySelector('.zone--hero');
    const heroBox = hero?.getBoundingClientRect();
    return {
      scroll: d.scrollWidth,
      client: d.clientWidth,
      height: innerHeight,
      h1: [...document.querySelectorAll('h1')].map((e) => e.textContent.trim()),
      heroEdges: heroBox ? [heroBox.left, heroBox.right] : null,
      title: box('.hero-title'),
      sub: box('.hero-sub'),
      real: box('.hero-real'),
      // The Prix Live line (D-168): every link inside it, the line's whole text, and what follows
      // the link: plain text in the same paragraph, starting on the link's last line when it fits.
      realLinks: [...document.querySelectorAll('.hero-real a')].map((e) => ({
        path: new URL(e.href).pathname,
        text: e.textContent.replace(/\s+/g, ' ').trim(),
        button: e.classList.contains('button'),
        underline: getComputedStyle(e).textDecorationLine.includes('underline'),
      })),
      realText: document.querySelector('.hero-real')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      realAfter: (() => {
        const line = document.querySelector('.hero-real');
        const link = line?.querySelector('a');
        if (!line || !link) return null;
        // Everything after the link: only text nodes, never an element (a link, a span, a block).
        const after = [];
        for (let n = link.nextSibling; n; n = n.nextSibling) after.push(n);
        const plain = after.every((n) => n.nodeType === Node.TEXT_NODE);
        const words = after
          .map((n) => n.textContent)
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        // Where the risk sentence starts against where the link ends.
        const start = after.find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        let sameLine = null;
        if (start) {
          const offset = start.textContent.search(/\S/);
          const range = document.createRange();
          range.setStart(start, offset);
          range.setEnd(start, offset + 1);
          const first = range.getClientRects()[0];
          const ends = [...link.getClientRects()];
          const last = ends[ends.length - 1];
          // The first word of the risk sentence, measured, to know whether it fit after the link.
          const word = document.createRange();
          const match = start.textContent.slice(offset).match(/^\S+/);
          word.setStart(start, offset);
          word.setEnd(start, offset + (match ? match[0].length : 1));
          const wordWidth = word.getBoundingClientRect().width;
          const room = line.getBoundingClientRect().right - last.right;
          sameLine = {
            same: Math.abs(first.top - last.top) < 2,
            fits: room > wordWidth + 8,
          };
        }
        return { plain, words, sameLine };
      })(),
      act: box('.hero-act'),
      board: box('[data-standings]'),
      boardTitle: box('.standings-title'),
      search: box('.home-search'),
      decisionsBox: box('.hero-decisions'),
      tape: box('.home-tape .ticker'),
      headerSearch: shown(document.querySelector('header.top .top-search')),
      headerHow: shown(document.querySelector('header.top .top-how')),
      rows,
      decisions,
      how,
      tables: document.querySelectorAll('main table').length,
      meta: document.querySelector('.standings-meta')?.textContent.trim() ?? null,
      metaBox: box('.standings-meta'),
      boardName: document.querySelector('.standings-title')?.textContent.trim() ?? null,
      more: document.querySelector('.standings-more')?.textContent.trim() ?? null,
      key: document.querySelector('.standings-key')?.textContent.trim() ?? '',
      state: document.querySelector('.standings-state')?.textContent.trim() ?? null,
      stateReload: document.querySelector('.standings-state a.button')?.textContent.trim() ?? null,
      decisionsText: shown(document.querySelector('.hero-decisions'))
        ? document.querySelector('.hero-decisions').textContent.replace(/\s+/g, ' ').trim()
        : null,
      // The footer's line names the league a paper trading simulation, before and after D-168.
      disclaimer: /paper trading simulation/i.test(document.body.textContent),
    };
  });
}

/**
 * The board as assistive technology gets it, and where its chips sit: one "Agent" column head (the
 * animal's column is hidden, head and cells), no empty cell in a row, and every chip inside its
 * name cell, never over the line beside it.
 */
async function boardChecks(page, m, at) {
  if (m.rows.some((row) => row.none)) {
    check(!/top five/i.test(m.boardName ?? ''), `${at} "top five" over unranked rows: ${m.boardName}`);
  }
  // A time never parts from its zone, nor a day from its month, in the meta line or the key.
  for (const [name, words] of [
    ['meta line', m.meta ?? ''],
    ['key', m.key],
  ]) {
    check(
      !/\d\d:\d\d UTC|\d (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(words),
      `${at} the ${name} can break a time: ${words}`,
    );
  }
  for (const [index, row] of m.rows.entries()) {
    for (const chip of row.chipLines) {
      check(chip.lines <= 1, `${at} row ${index + 1}: the chip "${chip.text}" takes ${chip.lines} lines`);
    }
    check(row.markHidden, `${at} row ${index + 1}: the animal's cell is not hidden from assistive technology`);
    if (row.chipOverLine !== null) {
      check(row.chipOverLine <= 0.5, `${at} row ${index + 1}: a chip runs ${row.chipOverLine}px over the line`);
      check(row.chipOverName <= 0.5, `${at} row ${index + 1}: a chip runs ${row.chipOverName}px out of its name cell`);
    }
  }
  const table = page.locator('[data-standings] table');
  if ((await table.count()) === 0) return;
  const tree = await table.ariaSnapshot();
  const agentHeads = tree.match(/columnheader "Agent"/g)?.length ?? 0;
  check(agentHeads === 1, `${at} ${agentHeads} column heads named "Agent"`);
  check(!/^\s*- cell\s*$/m.test(tree), `${at} a row has an empty cell for assistive technology`);
}

// --- every width, both themes, the ranked league -------------------------------------------------
for (const theme of ['dark', 'light']) {
  for (const width of WIDTHS) {
    const phone = width < 720;
    const height = width === 360 ? 780 : width === 390 ? 844 : 900;
    const { page, status } = await open('', width, height, theme);
    const m = await measure(page);
    const at = `${width} ${theme}:`;
    check(status === 200, `${at} status ${status}`);
    check(m.scroll === m.client, `${at} scrolls sideways (${m.scroll} > ${m.client})`);
    check(
      m.heroEdges && m.heroEdges[0] === 0 && Math.abs(m.heroEdges[1] - m.client) < 1,
      `${at} the hero's band is not edge to edge`,
    );
    check(m.h1.length === 1 && m.h1[0] === SENTENCE, `${at} the h1 is not the one sentence: ${JSON.stringify(m.h1)}`);
    check(m.title && m.sub && m.act && m.board, `${at} a part of the first screen is missing`);
    check(m.disclaimer, `${at} no disclaimer`);
    check(m.tables === 1, `${at} ${m.tables} tables in main (the board only)`);
    check(m.how === 1, `${at} "How it works" ${m.how} times on the first screen`);
    check(m.meta !== null && !/[·•∙⋅]/.test(m.meta), `${at} meta line ${JSON.stringify(m.meta)}`);
    check(m.more !== null && !/[→›»]|->/.test(m.more), `${at} the link ${JSON.stringify(m.more)}`);
    check(m.key.includes('five trading days and three decisions'), `${at} the key lacks the rank rule: ${m.key}`);
    check(m.rows.length === 5, `${at} ${m.rows.length} rows on the board`);
    await boardChecks(page, m, at);
    check(m.decisions.length <= 5, `${at} ${m.decisions.length} decisions`);
    check(!m.decisions.some((row) => row.why), `${at} a decision carries a reason`);
    check(
      m.decisions.every((row) => HOUSE.has(row.name)),
      `${at} a decision of an agent Prix does not run`,
    );
    // Prix Live (D-168): one quiet line under the subhead. Its first sentence is the one link, to
    // /live, never a button, in the hero's link style: no underline at rest, the hairline on hover
    // (DESIGN.md 5.3, R19). The risk sentence follows it as plain text in the same paragraph, on the
    // link's last line whenever it fits there.
    check(
      m.realLinks.length === 1 &&
        m.realLinks[0].path === '/live' &&
        m.realLinks[0].text === LIVE_LINK &&
        !m.realLinks[0].button &&
        !m.realLinks[0].underline,
      `${at} the Prix Live link: ${JSON.stringify(m.realLinks)}`,
    );
    check(m.realText === `${LIVE_LINK} ${LIVE_RISK}`, `${at} the Prix Live line reads ${JSON.stringify(m.realText)}`);
    check(
      m.realAfter?.plain && m.realAfter.words === LIVE_RISK,
      `${at} the risk sentence is not plain text after the link: ${JSON.stringify(m.realAfter)}`,
    );
    check(
      m.realAfter?.sameLine && (m.realAfter.sameLine.same || !m.realAfter.sameLine.fits),
      `${at} the risk sentence does not start on the link's line: ${JSON.stringify(m.realAfter?.sameLine)}`,
    );
    if (m.realLinks.length === 1) {
      await page.hover('.hero-real a');
      const hovered = await page.evaluate(
        () => getComputedStyle(document.querySelector('.hero-real a')).textDecorationLine,
      );
      check(hovered.includes('underline'), `${at} the Prix Live link has no underline on hover: ${hovered}`);
      await page.mouse.move(0, 0);
    }
    if (m.title && m.sub && m.act && m.board) {
      check(
        m.title.bottom <= m.sub.top + 1 && m.sub.bottom <= m.act.top + 1 && m.act.bottom <= m.board.top + 1,
        `${at} order sentence, subhead, action, board`,
      );
      check(
        m.real && m.sub.bottom <= m.real.top + 1 && m.real.bottom <= m.act.top + 1,
        `${at} the Prix Live line is not between the subhead and the action`,
      );
      check(
        m.real && Math.abs(m.real.left - m.sub.left) < 1,
        `${at} the Prix Live line is not aligned with the subhead`,
      );
      check(Math.abs(m.act.left - m.sub.left) < 1, `${at} the action is not left-aligned under the subhead`);
    }
    if (phone) {
      check(!m.headerSearch, `${at} the header holds a search field`);
      check(!m.headerHow, `${at} the header holds "How it works"`);
      check(m.search && m.board && m.search.top >= m.board.bottom, `${at} the search field is not after the board`);
      check(m.tape && m.board && m.tape.top >= m.board.bottom, `${at} the tape is not after the board`);
      if (width === 360 || width === 390) {
        const third = m.rows[2];
        check(m.act && m.act.bottom <= m.height, `${at} the action is below the first screen`);
        check(m.boardTitle && m.boardTitle.bottom <= m.height, `${at} the board's title is below the first screen`);
        check(third && third.bottom <= m.height, `${at} the third row ends at ${third?.bottom} of ${m.height}`);
      }
    } else {
      check(m.tape && m.title && m.tape.bottom <= m.title.top, `${at} the tape is not above the hero`);
      check(!m.headerHow, `${at} the header holds "How it works"`);
      if (width >= 960) {
        check(
          m.decisionsBox && m.board && m.decisionsBox.left >= m.board.right,
          `${at} the decisions are not beside the board`,
        );
      }
    }
    if (shots && (width === 390 || width === 1440)) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, `home-${width}-${theme}-first.png`) });
      await page.screenshot({ path: join(shots, `home-${width}-${theme}-whole.png`), fullPage: true });
    }
    await page.close();
  }
}

// --- the states, at 390 (and 1024 where a state differs from 960) --------------------------------
const STATES = [
  {
    name: 'none-ranked',
    query: 'fixture=league-early',
    also: [320],
    test: (m) => [
      [m.rows.length > 0 && m.rows.every((row) => row.none), 'every row without a rank'],
      [m.key.includes('listed by return so far'), `the key says none is ranked: ${m.key}`],
      [/^(Five of \d+ agents|All \d+ agents), none ranked yet$/.test(m.boardName ?? ''), `title: ${m.boardName}`],
    ],
  },
  {
    name: 'round-running',
    query: 'fixture=league-round',
    test: (m) => [
      [m.key.startsWith(`${START} The round of `), `the state is the key's second sentence: ${m.key}`],
      [m.key.includes('is running'), `the key says a round is running: ${m.key}`],
    ],
  },
  {
    // The sample's closed market was checked at 23:01 UTC, outside the window of rounds, so the page
    // repeats no old check and names the next round (clock.ts).
    name: 'market-closed-night',
    query: 'fixture=league-ranked,market-closed',
    test: (m) => [
      [m.key.startsWith(`${START} The next round is due`), `the next round is the key's second sentence: ${m.key}`],
      [m.key.includes('next trading day'), `the key names the next round: ${m.key}`],
    ],
  },
  {
    // Checked at 16:01 UTC inside the window: the market check is current and the league is paused.
    // The Open board's agents decide only at the daily tick, whose hour has passed: the next round is
    // on the next trading day.
    name: 'league-paused',
    query: 'fixture=league-ranked,market-paused',
    test: (m) => [
      [/paused.+next trading day/.test(m.key), `the key says the league is paused, then the next round: ${m.key}`],
      [m.key.startsWith(`${START} The league is paused`), `the pause is the key's second sentence: ${m.key}`],
      [/\bpaused\b/.test(m.meta ?? ''), `the meta line says the pause: ${m.meta}`],
    ],
    // On a desktop's first screen the pause stands above the fold, in the meta line under the title.
    desk: (m) => [
      [/\bpaused\b/.test(m.meta ?? '') && m.metaBox && m.metaBox.bottom <= m.height, `1440: meta ${m.meta}`],
    ],
  },
  {
    // The same pause, with the clock moved into the evening: no round is left that day.
    name: 'league-paused-evening',
    query: 'fixture=league-ranked,market-paused&at=2026-10-06T19:30:00.000Z',
    test: (m) => [[/paused.+next trading day/.test(m.key), `the key: ${m.key}`]],
  },
  {
    // The same pause on the Pro board: its agents decide every hour, so the next round is today's.
    name: 'league-paused-pro',
    query: 'fixture=league-pro,market-paused&division=pro',
    test: (m) => [[/paused.+Next round: 6\sOct, 17:00\sUTC\./.test(m.key), `the key: ${m.key}`]],
  },
  {
    // 16:30 UTC on a weekday, the market open: the Open board's next round is the next trading day's
    // daily tick, the Pro board's the next hour.
    name: 'next-round-open',
    query: 'fixture=league-ranked,market-open&at=2026-10-06T16:30:00.000Z',
    test: (m) => [
      [m.key.startsWith(`${START} The next round is due at 15:00`), `the key: ${m.key}`],
      [m.key.includes('next trading day') && !m.key.includes('17:00'), `the key: ${m.key}`],
    ],
  },
  {
    name: 'next-round-pro',
    query: 'fixture=league-pro,market-open&division=pro&at=2026-10-06T16:30:00.000Z',
    test: (m) => [[/^Every agent .+ Next round: 6\sOct, 17:00\sUTC\./.test(m.key), `the key: ${m.key}`]],
  },
  {
    name: 'reads-failed',
    query: 'fixture=fail-reads',
    test: (m) => [
      [m.rows.length === 0 && m.state !== null, 'the board holds its failed state'],
      [!/running/i.test(m.state ?? ''), `the failed state claims what it cannot know: ${m.state}`],
      [m.stateReload === 'Reload the page', `reload: ${m.stateReload}`],
      [m.h1[0] === SENTENCE && m.act !== null, 'the sentence and the action stand'],
    ],
  },
  {
    name: 'no-agent',
    query: 'fixture=league-ranked&division=pro',
    test: (m) => [
      [m.rows.length === 0 && m.state?.includes('No agent in this division yet'), `empty: ${m.state}`],
      [m.stateReload === 'Build an agent', `its action: ${m.stateReload}`],
    ],
  },
  {
    name: 'no-league',
    query: 'fixture=league-none,market-none',
    test: (m) => [[m.rows.length === 0 && m.state?.includes('The league has not started'), `none: ${m.state}`]],
  },
  {
    name: 'skipped-and-unranked',
    query: 'fixture=league-pro&division=pro',
    also: [320, 360],
    test: (m) => [
      [m.rows.some((row) => row.chipLines.some((chip) => chip.text === 'No decision')), 'a row that made no decision'],
      [m.rows.some((row) => row.none) && m.rows.some((row) => !row.none), 'ranked and unranked rows together'],
    ],
  },
  {
    name: 'no-decisions',
    query: 'fixture=league-ranked,feed-league-empty',
    test: (m) => [[m.decisionsText === null, 'on a phone the decisions are left out whole']],
    wide: (m) => [[m.decisionsText?.includes('No decisions to show yet') === true, `from 960: ${m.decisionsText}`]],
  },
];

for (const state of STATES) {
  for (const width of [390, ...(state.also ?? [])]) {
    const { page, status } = await open(state.query, width, 844);
    const m = await measure(page);
    const at = width === 390 ? `${state.name}:` : `${state.name} ${width}:`;
    check(status === (state.status ?? 200), `${at} status ${status}`);
    check(m.scroll === m.client, `${at} scrolls sideways`);
    for (const [ok, message] of state.test(m)) check(ok, `${at} ${message}`);
    await boardChecks(page, m, at);
    if (shots) await page.screenshot({ path: join(shots, `state-${state.name}-${width}.png`), fullPage: true });
    await page.close();
  }
  if (state.desk) {
    const desk = await open(state.query, 1440, 900);
    const d = await measure(desk.page);
    for (const [ok, message] of state.desk(d)) check(ok, `${state.name} 1440: ${message}`);
    if (shots) await desk.page.screenshot({ path: join(shots, `state-${state.name}-1440-first.png`) });
    await desk.page.close();
  }
  if (state.wide) {
    const wide = await open(state.query, 1024, 900);
    const w = await measure(wide.page);
    for (const [ok, message] of state.wide(w)) check(ok, `${state.name} 1024: ${message}`);
    if (shots) await wide.page.screenshot({ path: join(shots, `state-${state.name}-1024.png`) });
    await wide.page.close();
  }
}

await browser.close();
console.log(failed === 0 ? `ALL OK (${checks} checks)` : `${failed} FAILED of ${checks} checks`);
process.exit(failed === 0 ? 0 : 1);
