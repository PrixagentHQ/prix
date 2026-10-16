// "Open to holders now" on a phone (docs/contracts/phase-6-holders.md section 2, revision 6: DC6-1, DC6-4).
// It looks at a SAMPLE build (PRIX_FIXTURES=1). Read-only: it only GETs pages of the origin it is given, and
// it refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4391 --host 127.0.0.1
//   node apps/web/src/site/token/holders-table-check.mjs http://127.0.0.1:4391 [directory for screenshots]
//
// It prints one line for each check and exits 1 when one fails. On /token (signed out, no column marked) and
// on /account/token signed in at tiers 0 to 3, at 360 and 390 pixels, with the table as it opened, scrolled to
// its start and scrolled to its end:
//   - DC6-1: every sentence row (chat, pictures, FOREHEAD) stands wholly inside the scroller's visible box, so
//     no letter and no figure of it is cut by either edge, and its largest width is no wider than that box;
//   - DC6-4: the sticky row names keep at least --space-12 between their last letter and their cell's end
//     edge, where whatever scrolls beside them (the marked column's wash among it) begins;
//   - the page does not scroll sideways.
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = process.argv[2];
const shots = process.argv[3] ?? null;
if (!origin) {
  throw new Error('usage: node holders-table-check.mjs <origin of a sample build> [directory for screenshots]');
}
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('This check reads a local sample build only.');
}

const WIDTHS = [360, 390];
/** The sample build's answers (apps/web/src/site/token/fixtures.ts, apps/web/src/account/token/fixtures.ts). */
const PAGES = [
  { name: '/token signed out', path: '/token?state=flagOn' },
  ...[0, 1, 2, 3].map((tier) => ({
    name: `/account/token at tier ${tier}`,
    path: `/account/token?fixture=signed-in&tokenfixture=tier${tier}`,
  })),
];
/** Half a pixel for sub-pixel layout. */
const SLACK = 0.5;

let failed = 0;
function check(ok, what, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

/** Runs in the page: the scroller's visible box, each sentence's box and each sticky name's clearance. */
function read(position) {
  const table = document.getElementById('holders-table');
  const region = table?.closest('[data-table-scroll]');
  if (!(region instanceof HTMLElement)) return null;
  if (position === 'start') region.scrollLeft = 0;
  if (position === 'end') region.scrollLeft = region.scrollWidth - region.clientWidth;
  const box = region.getBoundingClientRect();
  const left = box.left + region.clientLeft;
  const right = left + region.clientWidth;
  const probe = document.createElement('div');
  probe.style.width = 'var(--space-12)';
  probe.style.position = 'absolute';
  document.body.append(probe);
  const space12 = probe.getBoundingClientRect().width;
  probe.remove();

  const sentences = [...region.querySelectorAll('.holders-sentence')].map((row) => {
    const span = row.querySelector('.holders-sentence-text');
    const rect = (span ?? row).getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(span ?? row);
    const lines = [...range.getClientRects()];
    return {
      perk: row.getAttribute('data-perk'),
      left: rect.left,
      right: rect.right,
      textLeft: Math.min(...lines.map((line) => line.left)),
      textRight: Math.max(...lines.map((line) => line.right)),
      maxWidth: span ? getComputedStyle(span).maxWidth : 'none',
      text: (span ?? row).textContent?.trim() ?? '',
    };
  });

  const names = [...region.querySelectorAll('tbody tr:not(.holders-sentence) > th[scope="row"]')]
    .filter((cell) => getComputedStyle(cell).position === 'sticky')
    .map((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const textRight = Math.max(...[...range.getClientRects()].map((line) => line.right));
      // The amount cells scroll under the sticky name, so whatever stands beside it (the marked column's
      // wash among them) begins at the name cell's own end edge.
      return {
        perk: cell.parentElement?.getAttribute('data-perk'),
        gap: cell.getBoundingClientRect().right - textRight,
      };
    });

  return {
    left,
    right,
    width: region.clientWidth,
    scrollLeft: region.scrollLeft,
    sentences,
    names,
    space12,
    pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
  };
}

const browser = await chromium.launch();
try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    for (const target of PAGES) {
      const response = await page.goto(`${origin}${target.path}`, { waitUntil: 'load' });
      check(response?.status() === 200, `${target.name} at ${width}: answers 200`, String(response?.status()));
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(done))));
      if (shots) {
        await mkdir(shots, { recursive: true });
        const name = `${target.name.replace(/[^a-z0-9]+/gi, '-')}-${width}.png`;
        await page
          .locator('#holders-table')
          .scrollIntoViewIfNeeded()
          .catch(() => {});
        await page.screenshot({ path: `${shots}/${name}` });
      }
      for (const position of ['opened', 'start', 'end']) {
        const seen = await page.evaluate(read, position);
        const label = `${target.name} at ${width}, ${position}`;
        check(seen !== null, `${label}: the table is there`);
        if (!seen) continue;
        check(seen.sentences.length >= 2, `${label}: the sentence rows are there`, String(seen.sentences.length));
        for (const s of seen.sentences) {
          const inside =
            s.left >= seen.left - SLACK &&
            s.right <= seen.right + SLACK &&
            s.textLeft >= seen.left - SLACK &&
            s.textRight <= seen.right + SLACK;
          check(
            inside,
            `${label}: the ${s.perk} sentence stands inside the scroller (DC6-1)`,
            `box ${seen.left.toFixed(1)}..${seen.right.toFixed(1)}, sentence ${s.left.toFixed(1)}..${s.right.toFixed(1)}, max-width ${s.maxWidth}, scrollLeft ${seen.scrollLeft}`,
          );
          const max = Number.parseFloat(s.maxWidth);
          check(
            Number.isFinite(max) && max <= seen.width + SLACK,
            `${label}: the ${s.perk} sentence's max-width is no wider than the scroller (DC6-1)`,
            `${s.maxWidth} against ${seen.width}px`,
          );
        }
        check(seen.names.length > 0, `${label}: the sticky row names are there`, String(seen.names.length));
        const tight = seen.names.filter((n) => n.gap < seen.space12 - SLACK);
        check(
          tight.length === 0,
          `${label}: every sticky row name keeps --space-12 from the cell beside it (DC6-4)`,
          tight.length
            ? tight.map((n) => `${n.perk} ${n.gap.toFixed(1)}px`).join(', ')
            : `least ${Math.min(...seen.names.map((n) => n.gap)).toFixed(1)}px of ${seen.space12}px`,
        );
        check(!seen.pageScrolls, `${label}: the page does not scroll sideways`);
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
