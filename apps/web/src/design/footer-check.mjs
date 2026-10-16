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
//   - the same at every eighth pixel from 320 to 1920, the window resized in place (the height from 360 up).
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
  };
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

const urlOf = (path, state, theme = 'dark') => `${origin}${path}?state=${state}&theme=${theme}`;

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
      const heights = [];
      for (const width of SWEEP) {
        await page.setViewportSize({ width, height: 900 });
        const facts = await page.evaluate(read);
        const found = faults(facts, width, phoneHeight);
        if (found.length > 0) wrong.push(`${width}: ${found.join('; ')}`);
        if ([320, 360, 480, 600, 704, 720, 768, 840, 904, 1024, 1112, 1120, 1280, 1440, 1920].includes(width)) {
          heights.push(`${width} ${facts?.height}`);
        }
      }
      check(
        wrong.length === 0,
        `${path}, ${footer.name}, 320 to 1920 by 8: heights ${heights.join(', ')}`,
        wrong.length > 0 ? `${wrong.length} of ${SWEEP.length} widths; ${wrong.slice(0, 3).join(' | ')}` : '',
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
