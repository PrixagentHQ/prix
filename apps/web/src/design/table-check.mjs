// The scrolling table's edges on the specimen (docs/DESIGN.md section 12.3, R21; DC6-3 of the holders round).
// Read-only: it only GETs pages of the local origin it is given, and refuses any other.
//
//   node apps/web/src/design/specimen/export.mjs --serve 4391
//   node apps/web/src/design/table-check.mjs http://127.0.0.1:4391 [directory for screenshots]
//
// The specimen's three scrolling tables are sample data that says so: `t-scroll` (no sticky column, opens at
// its start), `t-open-at` (a sticky first column, opens at Tier 2) and `t-open-end` (the same, opens at Tier 3,
// where the box can only scroll to its end). At 320, 360 and 390 in both themes, and at 1280, it checks:
//   - the page never scrolls sideways;
//   - a sticky box: the start fade (the sticky cells' ::before) stands exactly while columns lie out of view
//     before the box's start, beginning at the sticky column's end edge; the end fade (::after) exactly while
//     columns follow, ending within 1 pixel of the box's end edge; a sentence row (colspan) has neither;
//   - the box without a sticky column is masked at the edges it hides columns beyond, and not while it has
//     keyboard focus;
//   - the cue is seen while columns lie out of view on either side (also at the end, Tier 0 and Tier 1 to the
//     left), and the table does not move when it is scrolled from end to end;
//   - at 1280 nothing overflows: no fade, no mask, the cue `display: none`;
//   - forced colours and more contrast: no fade and no mask, the cue still seen.
// It prints one line for each check and exits 1 when one fails.
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = process.argv[2];
const shots = process.argv[3] ?? null;
if (!origin) throw new Error('usage: node table-check.mjs <origin of the specimen> [directory for screenshots]');
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('This check reads a local specimen only.');
}

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

/** Everything a check needs from one box, read in the page. */
async function read(page, id) {
  return page.evaluate((tableId) => {
    const table = document.getElementById(tableId);
    const region = table.closest('[data-table-scroll]');
    const cue = region.previousElementSibling?.hasAttribute('data-table-cue') ? region.previousElementSibling : null;
    const box = region.getBoundingClientRect();
    const sticky = table.querySelector('tbody tr > th:first-child:not([colspan])');
    const sentence = table.querySelector('tbody th[colspan]');
    const pseudo = (el, which) => {
      const s = getComputedStyle(el, which);
      return { content: s.content, left: Number.parseFloat(s.left), width: Number.parseFloat(s.width) };
    };
    const stickyBox = sticky.getBoundingClientRect();
    return {
      over: region.scrollWidth - region.clientWidth > 1,
      scrollLeft: region.scrollLeft,
      max: region.scrollWidth - region.clientWidth,
      top: box.top + window.scrollY,
      boxLeft: box.left + region.clientLeft,
      boxEnd: box.left + region.clientLeft + region.clientWidth,
      stickyFirst: region.hasAttribute('data-sticky-first'),
      hiddenStart: region.hasAttribute('data-hidden-start'),
      hiddenEnd: region.hasAttribute('data-hidden-end'),
      mask: getComputedStyle(region).maskImage,
      stickyLeft: stickyBox.left,
      stickyRight: stickyBox.right,
      before: pseudo(sticky, '::before'),
      after: pseudo(sticky, '::after'),
      sentenceBefore: sentence ? getComputedStyle(sentence, '::before').content : 'none',
      sentenceAfter: sentence ? getComputedStyle(sentence, '::after').content : 'none',
      cueDisplay: cue ? getComputedStyle(cue).display : null,
      cueVisibility: cue ? getComputedStyle(cue).visibility : null,
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, id);
}

async function scrollTo(page, id, where) {
  await page.evaluate(
    ([tableId, to]) => {
      const region = document.getElementById(tableId).closest('[data-table-scroll]');
      region.scrollTo({ left: to === 'end' ? region.scrollWidth : 0, behavior: 'instant' });
    },
    [id, where],
  );
  // The scroll event is handled on the next frame.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

const shown = (p) => p.content !== 'none' && p.content !== 'normal';

function stickyChecks(label, r) {
  check(`${label}: the first column is marked sticky`, r.stickyFirst);
  check(
    `${label}: the start fade stands exactly while columns lie out of view before it`,
    shown(r.before) === r.hiddenStart && r.hiddenStart === r.scrollLeft > 1,
    `scrollLeft ${r.scrollLeft}`,
  );
  check(
    `${label}: the end fade stands exactly while columns follow`,
    shown(r.after) === r.hiddenEnd && r.hiddenEnd === r.max - r.scrollLeft > 1,
    `scrollLeft ${r.scrollLeft} of ${r.max}`,
  );
  if (shown(r.before)) {
    const start = r.stickyLeft + r.before.left;
    check(
      `${label}: the start fade begins at the sticky column's end`,
      Math.abs(start - r.stickyRight) <= 1,
      `${start.toFixed(1)} against ${r.stickyRight.toFixed(1)}`,
    );
  }
  if (shown(r.after)) {
    const end = r.stickyLeft + r.after.left + r.after.width;
    check(
      `${label}: the end fade ends at the box's end edge`,
      Math.abs(end - r.boxEnd) <= 1,
      `${end.toFixed(1)} against ${r.boxEnd.toFixed(1)}`,
    );
  }
  check(
    `${label}: a sentence row has no fade`,
    !shown({ content: r.sentenceBefore }) && !shown({ content: r.sentenceAfter }),
  );
  check(`${label}: no mask on a box with a sticky column`, r.mask === 'none');
  check(
    `${label}: the cue is seen while columns lie out of view on either side`,
    (r.cueVisibility === 'visible') === (r.hiddenStart || r.hiddenEnd) && r.cueDisplay === 'block',
  );
}

const browser = await chromium.launch();
try {
  for (const [file, theme] of [
    ['index.html', 'dark'],
    ['light.html', 'light'],
  ]) {
    for (const width of [320, 360, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${origin}/${file}`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#t-open-at').scrollIntoViewIfNeeded();
      const at = `${theme} ${width}`;

      const openAt = await read(page, 't-open-at');
      check(`${at} t-open-at overflows`, openAt.over);
      stickyChecks(`${at} t-open-at as opened`, openAt);
      check(`${at} the page does not scroll sideways`, !openAt.sideways);

      const openEnd = await read(page, 't-open-end');
      check(
        `${at} t-open-end opens at its end`,
        openEnd.max - openEnd.scrollLeft <= 1,
        `${openEnd.scrollLeft} of ${openEnd.max}`,
      );
      check(
        `${at} t-open-end: Tier 0 and Tier 1 are marked out of view to the left`,
        openEnd.hiddenStart && !openEnd.hiddenEnd,
      );
      stickyChecks(`${at} t-open-end as opened`, openEnd);
      if (shots) {
        await mkdir(shots, { recursive: true });
        await page
          .locator('#t-open-at')
          .locator('xpath=../..')
          .screenshot({ path: `${shots}/tables-${theme}-${width}.png` });
      }

      await scrollTo(page, 't-open-end', 'start');
      const startEnd = await read(page, 't-open-end');
      stickyChecks(`${at} t-open-end scrolled to its start`, startEnd);
      check(`${at} t-open-end does not move when scrolled`, Math.abs(startEnd.top - openEnd.top) < 0.5);

      const plain = await read(page, 't-scroll');
      if (plain.over) {
        check(`${at} t-scroll has no sticky column`, !plain.stickyFirst);
        check(
          `${at} t-scroll at its start is masked at its end only`,
          plain.hiddenEnd && !plain.hiddenStart && plain.mask.includes('linear-gradient'),
        );
        await scrollTo(page, 't-scroll', 'end');
        const plainEnd = await read(page, 't-scroll');
        check(
          `${at} t-scroll at its end is masked at its start only`,
          plainEnd.hiddenStart && !plainEnd.hiddenEnd && plainEnd.mask.includes('linear-gradient'),
        );
        await page.locator('#t-scroll').locator('xpath=..').focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        const focused = await read(page, 't-scroll');
        check(`${at} t-scroll with keyboard focus has no mask`, focused.mask === 'none');
      }

      for (const media of [{ forcedColors: 'active' }, { contrast: 'more' }]) {
        await page.emulateMedia(media);
        const r = await read(page, 't-open-at');
        const name = Object.entries(media)[0].join(' ');
        check(`${at} ${name}: no fade`, !shown(r.before) && !shown(r.after), `${r.before.content} ${r.after.content}`);
        check(`${at} ${name}: the cue is still seen`, r.cueVisibility === 'visible');
        await page.emulateMedia({ forcedColors: 'none', contrast: 'no-preference' });
      }
      await page.close();
    }
  }

  const wide = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await wide.goto(`${origin}/index.html`, { waitUntil: 'load' });
  await wide.evaluate(() => document.fonts.ready);
  for (const id of ['t-open-at', 't-open-end', 't-scroll']) {
    const r = await read(wide, id);
    check(
      `1280 ${id}: nothing overflows, no fade, no mask`,
      !r.over && !r.hiddenStart && !r.hiddenEnd && !shown(r.before) && !shown(r.after) && r.mask === 'none',
    );
    if (r.cueDisplay !== null) check(`1280 ${id}: the cue takes no room`, r.cueDisplay === 'none');
  }
  await wide.close();
} finally {
  await browser.close();
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
