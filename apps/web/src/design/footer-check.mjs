// The footer of the shared layout between a phone's width and a desktop's (docs/DESIGN.md section 5.2).
// It looks at a SAMPLE build (PRIX_FIXTURES=1). Read-only: it only GETs pages of the origin it is given,
// and it refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4390 --host 127.0.0.1
//   node apps/web/src/design/footer-check.mjs http://127.0.0.1:4390 [directory for screenshots]
//
// It prints one line for each check and exits 1 when one fails. On `/`, `/league` and `/chat`, with each
// of the two paragraphs the footer can carry about the token (the line with the address, and the
// sentence of a build without a token):
//   - at 720, 768, 800, 820 and 840 pixels, each loaded fresh: no part of the footer that holds more than
//     twenty characters is narrower than 120 pixels, no part is narrower than what stands in it, the page
//     does not scroll sideways, and the footer is not taller than at 360;
//   - the same at every eighth pixel from 320 to 1920, the window resized in place (the height from 360 up);
//   - CR8C-7: at every one of those widths from 1280 to 1920, no line of the link row holds a single link;
//   - every page is read with the holders' poll linked (`polls=on`, the status probe's fixture answering on);
//     on `/` the CR8C-7 rule is also read with the poll off and with Social off, each set of links the
//     switches can give (twelve, ten and nine links);
//   - R22: at most thirteen links, ending Terms, Privacy, Telegram and X, Telegram's address exactly the
//     group's with `rel="noopener noreferrer"`, and no link that opens another tab.
//
// The footer's band takes the rest of a short window (R8), so the height that counts is that of what
// stands in the band, not of the band. The layout keeps its read of the token for 60 seconds, so the
// check waits up to 90 seconds for the build to serve the other paragraph.
// With a directory, it also saves the footer of the first page at 720, 768, 820 and 900 in both themes.
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = process.argv[2];
const shots = process.argv[3] ?? null;
if (!origin) {
  throw new Error('usage: node footer-check.mjs <origin of a sample build> [directory for screenshots]');
}
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('This check reads a local sample build only.');
}

/** The footer is the layout's, the same on every page; these three are a page of each owner. */
const paths = ['/', '/league', '/chat'];
const PHONE = 360;
/** Where the footer broke on 2026-10-12: the widths of a tablet held upright. */
const TABLET = [720, 768, 800, 820, 840];
const SWEEP = Array.from({ length: (1920 - 320) / 8 + 1 }, (_, step) => 320 + step * 8);
const PICTURED = [720, 768, 820, 900];
/** The sample build's two answers about the token (apps/web/src/site/token/fixtures.ts). */
const FOOTERS = [
  { state: 'flagOn', name: 'the address line', token: true },
  { state: 'notLaunched', name: 'the sentence without a token', token: false },
];

let failed = 0;
function check(ok, what, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

/** Runs in the page: the sizes of the footer and of every part of it that is drawn. */
function read() {
  const footer = document.querySelector('body > footer');
  if (!footer?.firstElementChild || !footer.lastElementChild) return null;
  const narrow = [];
  const spills = [];
  let narrowest = Number.POSITIVE_INFINITY;
  for (const part of [footer, ...footer.querySelectorAll('*')]) {
    // No box at all: a line for paper only. A box of no width is a fault and is counted.
    if (part.getClientRects().length === 0) continue;
    const name = `${part.tagName.toLowerCase()}${part.classList[0] ? `.${part.classList[0]}` : ''}`;
    const width = part.getBoundingClientRect().width;
    if ((part.textContent ?? '').trim().length > 20) {
      narrowest = Math.min(narrowest, width);
      if (width < 120) narrow.push(`${name} ${Math.round(width)}`);
    }
    if (getComputedStyle(part).display !== 'inline' && part.scrollWidth > part.clientWidth + 1) {
      spills.push(`${name} ${part.clientWidth} for ${part.scrollWidth}`);
    }
  }
  const root = document.documentElement;
  return {
    height: Math.round(
      footer.lastElementChild.getBoundingClientRect().bottom - footer.firstElementChild.getBoundingClientRect().top,
    ),
    narrowest: Math.round(narrowest),
    narrow,
    spills,
    scroll: root.scrollWidth,
    client: root.clientWidth,
    token: footer.querySelector('.token-line') !== null,
    // The link row's lines, top to bottom: the names of the links that stand on each.
    lines: [...footer.querySelectorAll('.foot-list > li')]
      .filter((item) => item.getClientRects().length > 0)
      .reduce((lines, item) => {
        // The link itself: an item set inline can begin on the line before its link (R25's break).
        const top = Math.round((item.querySelector('a') ?? item).getBoundingClientRect().top);
        const line = lines.find((l) => Math.abs(l.top - top) <= 2);
        const name = (item.textContent ?? '').trim();
        if (line) line.names.push(name);
        else lines.push({ top, names: [name] });
        return lines;
      }, [])
      .sort((a, b) => a.top - b.top)
      .map((l) => l.names),
    links: [...footer.querySelectorAll('.foot-list a')].map((a) => ({
      text: (a.textContent ?? '').trim(),
      href: a.getAttribute('href'),
      rel: a.getAttribute('rel'),
      target: a.getAttribute('target'),
    })),
  };
}

/** R22: the address of the Prix Community group on Telegram, exactly (content/facts.ts, `links.telegram`). */
const TELEGRAM = 'https://t.me/+Ic9RKLzDMiE1NGFl';
/**
 * Section 5.2: the footer's links, thirteen at most (with the holders' poll, the three of Social and
 * Developers all on), end with Terms, Privacy, Telegram (R22) and X.
 */
const MOST_LINKS = 13;
const LAST = ['Terms', 'Privacy', 'Telegram', 'X'];

/** What is wrong with the footer's list of links; nothing when it is right. */
function linkFaults(facts) {
  if (!facts) return ['the page has no footer'];
  const found = [];
  const names = facts.links.map((l) => l.text);
  if (names.length > MOST_LINKS) found.push(`${names.length} links`);
  if (names.slice(-LAST.length).join(', ') !== LAST.join(', ')) found.push(`it ends ${names.slice(-4).join(', ')}`);
  const telegram = facts.links.filter((l) => l.text === 'Telegram');
  if (telegram.length !== 1) found.push(`${telegram.length} Telegram links`);
  else {
    if (telegram[0].href !== TELEGRAM) found.push(`Telegram's address ${telegram[0].href}`);
    if (telegram[0].rel !== 'noopener noreferrer') found.push(`Telegram's rel ${telegram[0].rel}`);
  }
  if (facts.links.some((l) => l.target !== null)) found.push('a link opens another tab');
  return found;
}

/** What is wrong with the footer at one width; nothing when it is right. */
function faults(facts, width, phoneHeight) {
  if (!facts) return ['the page has no footer'];
  const found = [];
  if (facts.narrow.length > 0) found.push(`under 120 wide: ${facts.narrow.join(', ')}`);
  if (facts.spills.length > 0) found.push(`narrower than its words: ${facts.spills.slice(0, 4).join(', ')}`);
  if (facts.scroll !== facts.client) found.push(`the page scrolls sideways, ${facts.scroll} in ${facts.client}`);
  if (width >= PHONE && facts.height > phoneHeight) found.push(`${facts.height} high, ${phoneHeight} at ${PHONE}`);
  return found;
}

/**
 * CR8C-7: on a wide window no link of the row stands alone on a line, with the holders' poll linked
 * (the status probe's fixture answers on for `polls=on`, apps/web/src/site/polls/fixtures.ts).
 */
const ALONE_FROM = 1280;

/** The lines of the link row that hold one link only; nothing when none does. */
function aloneLines(facts) {
  if (!facts) return ['the page has no footer'];
  return facts.lines.filter((names) => names.length === 1).map((names) => `"${names[0]}" alone`);
}

/**
 * The other sets of links the switches give, read for the same rule on the first page: production
 * with the poll's switch off (twelve links), and both with Social off (the fixtures' `social-off`).
 */
const OTHER_SETS = [
  { name: 'the poll off', query: '' },
  { name: 'the poll on, Social off', query: '&polls=on&fixture=social-off' },
  { name: 'the poll off, Social off', query: '&fixture=social-off' },
];

/** Every width from ALONE_FROM to 1920 at which a line of the link row holds one link. */
async function aloneSweep(page) {
  const alone = [];
  let wideLines = '';
  for (const width of SWEEP.filter((w) => w >= ALONE_FROM)) {
    await page.setViewportSize({ width, height: 900 });
    const facts = await page.evaluate(read);
    const single = aloneLines(facts);
    if (single.length > 0) alone.push(`${width}: ${single.join(', ')}`);
    if (width === 1440) wideLines = (facts?.lines ?? []).map((names) => names.length).join(' + ');
  }
  return { alone, wideLines };
}

// Every page is read with the holders' poll linked: the footer's longest row of links.
const urlOf = (path, state, theme = 'dark') => `${origin}${path}?state=${state}&theme=${theme}&polls=on`;

/** Loads a page at a width and reads its footer once its faces are there. */
async function load(page, url, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  await page.evaluate(() => document.fonts.ready.then(() => null));
  return page.evaluate(read);
}

/** Asks for one of the two paragraphs until the layout's kept read of the token has turned over. */
async function served(page, footer, path) {
  const until = Date.now() + 90_000;
  for (;;) {
    const facts = await load(page, urlOf(path, footer.state), PHONE);
    if (facts?.token === footer.token) return true;
    if (Date.now() > until) return false;
    await page.waitForTimeout(5_000);
  }
}

if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: PHONE, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  // The paragraph the build serves now comes first; the other one has to wait for the 60 seconds.
  const now = await load(page, `${origin}${paths[0]}`, PHONE);
  const order = now?.token ? FOOTERS : [...FOOTERS].reverse();

  for (const footer of order) {
    const there = await served(page, footer, paths[0]);
    check(there, `${footer.name}: the sample build serves it`, there ? '' : 'not within 90 seconds');
    if (!there) continue;

    for (const path of paths) {
      const url = urlOf(path, footer.state);
      const phone = await load(page, url, PHONE);
      const phoneHeight = phone?.height ?? 0;
      check(
        linkFaults(phone).length === 0,
        `${path}, ${footer.name}: ${phone?.links.length} links, the last ${phone?.links
          .slice(-2)
          .map((l) => l.text)
          .join(' and ')}`,
        linkFaults(phone).join('; '),
      );
      check(
        faults(phone, PHONE, phoneHeight).length === 0,
        `${path}, ${footer.name}, ${PHONE}: ${phoneHeight} high`,
        faults(phone, PHONE, phoneHeight).join('; '),
      );

      for (const width of TABLET) {
        const facts = await load(page, url, width);
        const found = faults(facts, width, phoneHeight);
        check(
          found.length === 0,
          `${path}, ${footer.name}, ${width}: ${facts?.height} high, its narrowest part with words ${facts?.narrowest} wide`,
          found.join('; '),
        );
      }

      // The sweep resizes the window in place: the footer's layout is CSS and nothing else.
      const wrong = [];
      const alone = [];
      let wideLines = '';
      const heights = [];
      for (const width of SWEEP) {
        await page.setViewportSize({ width, height: 900 });
        const facts = await page.evaluate(read);
        const found = faults(facts, width, phoneHeight);
        if (found.length > 0) wrong.push(`${width}: ${found.join('; ')}`);
        if (width >= ALONE_FROM) {
          const single = aloneLines(facts);
          if (single.length > 0) alone.push(`${width}: ${single.join(', ')}`);
          if (width === 1440) wideLines = (facts?.lines ?? []).map((names) => names.length).join(' + ');
        }
        if ([320, 360, 480, 600, 704, 720, 768, 840, 904, 1024, 1112, 1120, 1280, 1440, 1920].includes(width)) {
          heights.push(`${width} ${facts?.height}`);
        }
      }
      check(
        wrong.length === 0,
        `${path}, ${footer.name}, 320 to 1920 by 8: heights ${heights.join(', ')}`,
        wrong.length > 0 ? `${wrong.length} of ${SWEEP.length} widths; ${wrong.slice(0, 3).join(' | ')}` : '',
      );
      const wide = SWEEP.filter((width) => width >= ALONE_FROM).length;
      check(
        alone.length === 0,
        `${path}, ${footer.name}, ${ALONE_FROM} to 1920 by 8: no link alone on a line (at 1440 the lines hold ${wideLines})`,
        alone.length > 0 ? `${alone.length} of ${wide} widths; ${alone.slice(0, 3).join(' | ')}` : '',
      );
    }

    for (const set of OTHER_SETS) {
      await load(page, `${origin}${paths[0]}?state=${footer.state}&theme=dark${set.query}`, ALONE_FROM);
      const { alone, wideLines } = await aloneSweep(page);
      const wide = SWEEP.filter((width) => width >= ALONE_FROM).length;
      check(
        alone.length === 0,
        `${paths[0]}, ${footer.name}, ${set.name}, ${ALONE_FROM} to 1920 by 8: no link alone on a line (at 1440 the lines hold ${wideLines})`,
        alone.length > 0 ? `${alone.length} of ${wide} widths; ${alone.slice(0, 3).join(' | ')}` : '',
      );
    }

    if (shots) {
      for (const theme of ['dark', 'light']) {
        for (const width of PICTURED) {
          await load(page, urlOf(paths[0], footer.state, theme), width);
          const file = `${shots}/footer-${footer.token ? 'address' : 'sentence'}-${width}-${theme}.png`;
          await page.locator('body > footer').screenshot({ path: file });
          console.log(`     ${file}`);
        }
      }
    }
  }
} finally {
  await browser.close();
}

console.log(failed === 0 ? 'footer-check: every check passed' : `footer-check: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
