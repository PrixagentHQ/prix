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
// And at 360, 390, 768, 1024 and 1440 pixels (POLL-DC-4, after DC7-1), on the same pages: every column's note
// keeps "From {amount}" (or "Below {amount}") whole on one line, and on /account/token the marked column's
// note is two lines, the amount and then the wallet's words on a line of their own, with no middle dot.
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

const WIDTHS = [360, 390, 768, 1024, 1440];
/** The widths where the table scrolls inside its own box, which the DC6 checks are about. */
const NARROW = [360, 390];
/** The sample build's answers (apps/web/src/site/token/fixtures.ts, apps/web/src/account/token/fixtures.ts). */
const PAGES = [
  { name: '/token signed out', path: '/token?state=flagOn' },
  ...[0, 1, 2, 3].map((tier) => ({
    name: `/account/token at tier ${tier}`,
    path: `/account/token?fixture=signed-in&tokenfixture=tier${tier}`,
    marked: true,
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

  // POLL-DC-4: each column's header note, line by line as laid out: each character's line is the top of its own
  // box, and a space joins the words of a line. White space at a line's end has no box worth reading.
  const linesOf = (note) => {
    const node = note.firstChild;
    const chars = node?.textContent ?? '';
    const rows = new Map();
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      if (char === '\n') continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const box = range.getClientRects()[0];
      if (!box || (/\s/.test(char) && box.width === 0)) continue;
      const top = Math.round(box.top);
      rows.set(top, `${rows.get(top) ?? ''}${char}`);
    }
    return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line.trim());
  };
  const markTier = region.closest('.holders-table')?.getAttribute('data-mark-tier') ?? null;
  const notes = [...region.querySelectorAll('thead th')]
    .filter((cell) => cell.querySelector('.table-note'))
    .map((cell) => ({
      column: [...cell.classList].find((name) => /^c-t\d$/.test(name)) ?? '',
      lines: linesOf(cell.querySelector('.table-note')),
    }));
  const markedLines = markTier === null ? null : (notes.find((note) => note.column === `c-t${markTier}`)?.lines ?? []);

  return {
    left,
    right,
    width: region.clientWidth,
    notes,
    markedLines,
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
        if (position === 'opened') {
          // POLL-DC-4 at every width.
          check(seen.notes.length === 4, `${label}: four amount columns carry a note`, String(seen.notes.length));
          for (const note of seen.notes) {
            check(
              /^(From|Below) [\d,]+$/.test(note.lines[0] ?? ''),
              `${label}: ${note.column}'s "From {amount}" stays whole on its first line (POLL-DC-4)`,
              note.lines.join(' / '),
            );
          }
          if (target.marked) {
            const lines = seen.markedLines ?? [];
            check(
              lines.length === 2 && /^(From|Below) [\d,]+$/.test(lines[0] ?? '') && lines[1] === 'your wallet',
              `${label}: the wallet's words stand whole on a line of their own beneath the amount (POLL-DC-4)`,
              lines.join(' / '),
            );
            check(!lines.join('').includes('·'), `${label}: the marked note has no middle dot (POLL-DC-4)`);
          }
          check(!seen.pageScrolls, `${label}: the page does not scroll sideways`);
        }
        if (!NARROW.includes(width)) continue;
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
