// The holders' poll where it shows on the site, on a SAMPLE build (PRIX_FIXTURES=1). Read-only: it only GETs
// pages of the origin it is given, and it refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4391 --host 127.0.0.1
//   node apps/web/src/site/polls/polls-layout-check.mjs http://127.0.0.1:4391
//
// It prints one line for each check and exits 1 when one fails. At 360, 390, 768, 1024 and 1440 pixels:
//   - POLL-DC-3, /token with the tiers and the poll's switch on: while the poll is open its line, with the link
//     to /polls, stands under "The holders' poll is open" (revision 8g, H6) and "Next for holders" holds the
//     Strategy Coach alone;
//     with nothing open (or only a closed poll), there is no such heading and the poll's line, with its link,
//     stands under "Next for holders" as before;
//   - POLL-DC-5, /polls with nothing open: the empty box shares its left and right edges with the polls'
//     column (the closed poll below it, and the open poll of the default state);
//   - no page scrolls sideways.
import { chromium } from '@playwright/test';

const origin = process.argv[2];
if (!origin) throw new Error('usage: node polls-layout-check.mjs <origin of a sample build>');
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('This check reads a local sample build only.');
}

const WIDTHS = [360, 390, 768, 1024, 1440];
/** Half a pixel for sub-pixel layout. */
const SLACK = 0.5;

let failed = 0;
function check(ok, what, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

/** Runs in the page: the two holders' headings on /token and what stands under each. */
function readToken() {
  const section = (id) => {
    const heading = document.getElementById(id);
    const box = heading?.closest('section');
    if (!heading || !box) return null;
    return {
      title: heading.textContent?.trim() ?? '',
      items: [...box.querySelectorAll('li')].map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
      links: [...box.querySelectorAll('a[href="/polls"]')].length,
    };
  };
  return {
    now: section('token-now-title'),
    next: section('token-next-title'),
    pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
  };
}

/** Runs in the page: the edges of the empty box and of each poll on /polls. */
function readPolls() {
  const edges = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  };
  const empty = document.querySelector('.empty');
  return {
    empty: empty ? edges(empty) : null,
    polls: [...document.querySelectorAll('.poll')].map(edges),
    pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
  };
}

const browser = await chromium.launch();
try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const open = async (path) => {
      const response = await page.goto(`${origin}${path}`, { waitUntil: 'load' });
      check(response?.status() === 200, `${path} at ${width}: answers 200`, String(response?.status()));
      await page.evaluate(() => document.fonts.ready);
    };

    // POLL-DC-3: the poll open.
    await open('/token?state=flagOn&polls=on');
    let seen = await page.evaluate(readToken);
    check(
      seen.now?.title === "The holders' poll is open",
      `/token, poll open, at ${width}: "The holders' poll is open" stands`,
    );
    check(
      seen.now?.items.length === 1 && /holders' poll/.test(seen.now.items[0]) && seen.now.links === 1,
      `/token, poll open, at ${width}: the poll's line and its one link stand under it`,
      JSON.stringify(seen.now),
    );
    check(
      seen.next?.items.length === 1 && /Strategy Coach/.test(seen.next.items[0]) && seen.next.links === 0,
      `/token, poll open, at ${width}: "Next for holders" holds the Strategy Coach alone`,
      JSON.stringify(seen.next),
    );
    check(!seen.pageScrolls, `/token, poll open, at ${width}: no sideways scroll`);

    // Nothing open, then only a closed poll: the page as before.
    for (const pollstate of ['noneOpen', 'closed']) {
      await open(`/token?state=flagOn&polls=on&pollstate=${pollstate}`);
      seen = await page.evaluate(readToken);
      check(seen.now === null, `/token, ${pollstate}, at ${width}: no "The holders' poll is open" for the poll`);
      check(
        seen.next?.items.length === 2 && /holders' poll/.test(seen.next.items[1]) && seen.next.links === 1,
        `/token, ${pollstate}, at ${width}: the poll's line and its link stand under "Next for holders"`,
        JSON.stringify(seen.next),
      );
    }

    // POLL-DC-5: the empty box in the polls' column.
    for (const state of ['closed', 'noneOpen']) {
      await open(`/polls?state=${state}`);
      const polls = await page.evaluate(readPolls);
      check(polls.empty !== null, `/polls?state=${state} at ${width}: the empty box is there`);
      await open('/polls');
      const reference = (await page.evaluate(readPolls)).polls[0];
      check(Boolean(reference), `/polls at ${width}: the open poll is there`);
      if (polls.empty && reference) {
        const same =
          Math.abs(polls.empty.left - reference.left) <= SLACK &&
          Math.abs(polls.empty.right - reference.right) <= SLACK;
        check(
          same,
          `/polls?state=${state} at ${width}: the empty box has the open poll's column edges (POLL-DC-5)`,
          `box ${polls.empty.left.toFixed(1)}..${polls.empty.right.toFixed(1)}, poll ${reference.left.toFixed(1)}..${reference.right.toFixed(1)}`,
        );
        for (const poll of polls.polls) {
          check(
            Math.abs(polls.empty.right - poll.right) <= SLACK,
            `/polls?state=${state} at ${width}: the empty box and the closed poll share their right edge (POLL-DC-5)`,
            `box right ${polls.empty.right.toFixed(1)}, poll right ${poll.right.toFixed(1)}`,
          );
        }
      }
      check(!polls.pageScrolls, `/polls?state=${state} at ${width}: no sideways scroll`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
