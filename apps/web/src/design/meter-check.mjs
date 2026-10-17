// The Meter's round ends at every width (docs/DESIGN.md section 12.2 and section 36, POLL-DC-2).
// It looks at a SAMPLE build (PRIX_FIXTURES=1). Read-only: it only GETs pages of the origin it is given,
// types into /build's prompt in its own browser, and refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4390 --host 127.0.0.1
//   node apps/web/src/design/meter-check.mjs http://127.0.0.1:4390 [directory for screenshots]
//
// The Meter is an svg drawn on a viewBox of 100 by 6 and stretched to its box, so a radius given to a
// rect in the viewBox's units is stretched with it: an end 3 by 3 became 10 by 3 at 390 and 29 by 3 at
// 1440, a smeared needle and not a pill. At 360, 390, 768 and 1440 pixels, on /polls, an agent's
// holdings, a paper manager's page and /build while a prompt is typed, for every meter drawn:
//   - no rect of it is rounded in the viewBox's units: an `rx` or `ry` above 0, carried to the screen
//     by the rect's own matrix (the viewBox's stretch and /build's scale), is a smeared end;
//   - the svg's own box is clipped round with a radius of at least half its height, so both ends of
//     the track, and the fill's start, are half circles;
//   - the fill stays inside the track.
// It prints one line for each check and exits 1 when one fails.
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = process.argv[2];
const shots = process.argv[3] ?? null;
if (!origin) {
  throw new Error('usage: node meter-check.mjs <origin of a sample build> [directory for screenshots]');
}
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('This check reads a local sample build only.');
}

const WIDTHS = [360, 390, 768, 1440];
/** The pages the Meter draws on in the sample build; `least` is how many meters each must show. */
const PAGES = [
  { name: '/polls', path: '/polls', least: () => 2 },
  { name: 'closed polls', path: '/polls?state=closed', least: () => 2 },
  // Under 35em the holdings show the figure alone (Holdings.astro), so a phone draws no meter there.
  { name: "an agent's holdings", path: '/agents/slowcompound', least: (width) => (width >= 560 ? 1 : 0) },
  { name: "a paper manager's page", path: '/managers/slowmixaaaaa', least: () => 1 },
  { name: '/build while typing', path: '/build?fixture=signed-in', least: () => 1, type: true },
];

let failed = 0;
function check(ok, what, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

/** Runs in the page: the faults of every meter drawn, and a word on each. */
function read() {
  const meters = [...document.querySelectorAll('svg.meter')].filter((svg) => {
    const box = svg.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  const faults = [];
  const sizes = [];
  meters.forEach((svg, index) => {
    const box = svg.getBoundingClientRect();
    const name = `meter ${index + 1} (${[...svg.classList].join(' ')}, ${Math.round(box.width)} by ${box.height})`;
    sizes.push(Math.round(box.width));
    for (const rect of svg.querySelectorAll('rect')) {
      const style = getComputedStyle(rect);
      const rx = Number.parseFloat(style.rx) || 0;
      const ry = style.ry === 'auto' ? rx : Number.parseFloat(style.ry) || 0;
      const matrix = rect.getScreenCTM();
      if (!matrix) continue;
      const across = Math.abs(rx * matrix.a);
      const up = Math.abs(ry * matrix.d);
      if (across > 0.01 || up > 0.01) {
        faults.push(`${name}: .${rect.classList[0]} rounded ${across.toFixed(1)} by ${up.toFixed(1)} on screen`);
      }
    }
    const clip = getComputedStyle(svg).clipPath;
    const round = /round\s+([\d.]+)px/.exec(clip);
    if (!round || Number.parseFloat(round[1]) < box.height / 2 - 0.01) {
      faults.push(`${name}: clip-path ${clip}, not round by half its height`);
    }
    const track = svg.querySelector('.meter-track')?.getBoundingClientRect();
    const fill = svg.querySelector('.meter-fill')?.getBoundingClientRect();
    if (!track || !fill) faults.push(`${name}: no track or no fill`);
    else if (fill.left < track.left - 0.5 || fill.right > track.right + 0.5) {
      faults.push(
        `${name}: fill ${fill.left.toFixed(1)} to ${fill.right.toFixed(1)} outside ${track.left.toFixed(1)} to ${track.right.toFixed(1)}`,
      );
    }
  });
  return { count: meters.length, faults, sizes };
}

if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  for (const target of PAGES) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}${target.path}`, { waitUntil: 'load', timeout: 45_000 });
      await page.evaluate(() => document.fonts.ready.then(() => null));
      if (target.type) {
        await page.locator('#prompt').fill('Hold the five largest stocks at equal weight and rebalance once a week.');
        await page.locator('#prompt').press('End');
        await page.keyboard.type(' Keep ten percent in cash.');
        await page.waitForTimeout(400);
      }
      const facts = await page.evaluate(read);
      const least = target.least(width);
      const found = [...facts.faults];
      if (facts.count < least) found.unshift(`${facts.count} meters drawn, ${least} expected`);
      check(
        found.length === 0,
        `${target.name}, ${width}: ${facts.count} meters, ${facts.sizes.slice(0, 3).join(', ')} wide`,
        found.length > 0 ? `${found.length} faults; ${found.slice(0, 2).join(' | ')}` : '',
      );
      if (shots && facts.count > 0) {
        const file = `${shots}/meter-${target.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}-${width}.png`;
        await page.locator('svg.meter').first().scrollIntoViewIfNeeded();
        const box = await page.locator('svg.meter').first().boundingBox();
        if (box) {
          await page.screenshot({
            path: file,
            clip: {
              x: Math.max(0, box.x - 8),
              y: Math.max(0, box.y - 8),
              width: Math.min(box.width + 16, width),
              height: box.height + 16,
            },
          });
          console.log(`     ${file}`);
        }
      }
    }
  }
} finally {
  await browser.close();
}

console.log(failed === 0 ? 'meter-check: every check passed' : `meter-check: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
