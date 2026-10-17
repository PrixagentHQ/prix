import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Locator, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { HOLDERS_COPY } from '@prix/contracts';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PollsPage from '../../site/polls/PollsPage.astro';

/**
 * The vote control of /polls in a real browser (POLL-DC-1): a refused vote is said where the holder
 * pressed, inside the window, in a live region, with focus kept on the pressed button while it is still
 * there; the bottom status keeps the steady sentences.
 *
 * How: the page is rendered on the server side by Astro's container from the site's fixtures (the open
 * poll, `?state=open`), inside the site's own layout. A small server on 127.0.0.1 (ports 9050 to 9059)
 * serves that HTML, the site's stylesheets and the control's browser modules with their types stripped by
 * Node, so the browser runs the same source the build bundles. The control answers from its own fixtures
 * (fixtures.ts) by `?pollfixture=`; any other /api request is refused by the test, so nothing leaves the
 * machine.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));
// Pictures of the refusals: set POLL_SHOTS to an existing folder.
const SHOTS = process.env.POLL_SHOTS;
const STYLES = [
  'design/tokens.css',
  'design/base.css',
  'design/primitives.css',
  'design/motion.css',
  'account/account.css',
  'account/polls/polls.css',
];
const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

let html = '';
let server: Server | undefined;
let origin = '';
let browser: Browser;

async function serveTs(file: string): Promise<string> {
  const code = stripTypeScriptTypes(await readFile(file, 'utf8'), { mode: 'strip' });
  return code.replaceAll('import.meta.env.SSR', 'false');
}

function listen(port: number): Promise<Server> {
  return new Promise((done, failed) => {
    const candidate = createServer(async (request, response) => {
      const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
      try {
        if (path === '/polls') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(html);
          return;
        }
        if (path.startsWith('/src/')) {
          const file = resolve(SRC, path.slice('/src/'.length));
          if (!file.startsWith(resolve(SRC) + sep)) throw new Error('outside the source');
          const type = TYPES[extname(file)];
          if (!type) throw new Error('not served');
          response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
          response.end(extname(file) === '.ts' ? await serveTs(file) : await readFile(file));
          return;
        }
        throw new Error('not found');
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      }
    });
    candidate.once('error', failed);
    candidate.listen(port, '127.0.0.1', () => done(candidate));
  });
}

/** The page as the browser gets it: the container's HTML, the site's stylesheets and the control's module. */
function forBrowser(rendered: string, pageStyle: string): string {
  const links = `${STYLES.map((file) => `<link rel="stylesheet" href="/src/${file}">`).join('')}<style>${pageStyle}</style>`;
  // The fixture build's flag, which the control's client reads to answer from fixtures.ts.
  const flag = '<script>globalThis.__PRIX_FIXTURES__ = true;</script>';
  const modules = `<script type="module">
    import { mountPollVotes } from '/src/account/polls/vote.ts';
    mountPollVotes();
    document.documentElement.dataset.mounted = 'true';
  </script>`;
  const cleaned = rendered
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*rel="(?:preload|icon|apple-touch-icon|manifest)"[^>]*>/g, '')
    .replace(/ data-astro-source-(?:file|loc)="[^"]*"/g, '');
  return cleaned.replace('</head>', `${flag}${links}</head>`).replace('</body>', `${modules}</body>`);
}

beforeAll(async () => {
  const container = await AstroContainer.create();
  const rendered = await container.renderToString(PollsPage, {
    request: new Request('http://127.0.0.1/polls?state=open', { headers: { cookie: 'prix_theme=dark' } }),
  });
  // The page's own scoped styles (the ballot's rows and gaps), which the container does not emit: its class
  // selectors match the rendered elements as they are, so the rows stand as tall as on the site.
  const source = await readFile(join(SRC, 'site/polls/PollsPage.astro'), 'utf8');
  const pageStyle = /<style>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? '';
  if (!pageStyle.includes('.ballot-row')) throw new Error("The page's own styles were not found.");
  html = forBrowser(rendered, pageStyle);
  for (let port = 9050; port <= 9059 && !server; port += 1) {
    try {
      server = await listen(port);
      origin = `http://127.0.0.1:${port}`;
    } catch {
      // The port is taken: try the next of the ten.
    }
  }
  if (!server) throw new Error('No port from 9050 to 9059 is free.');
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
});

interface Opened {
  page: Page;
  errors: string[];
  close: () => Promise<void>;
}

async function open(fixture: string, width: number, height: number): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'not_found', message: 'Not found.', field: null } }),
    }),
  );
  await page.goto(`${origin}/polls?pollfixture=${fixture}`);
  await page.waitForSelector('html[data-mounted="true"]');
  await page.locator('button[data-poll-vote-button]').first().waitFor({ state: 'visible' });
  return { page, errors, close: () => context.close() };
}

/** Where the visible element that says `sentence` sits against the window, or null when none is shown. */
async function placeOf(page: Page, sentence: string) {
  return page.evaluate((wanted) => {
    const found = [...document.querySelectorAll<HTMLElement>('body *')].filter(
      (element) =>
        element.children.length === 0 &&
        element.textContent?.trim() === wanted &&
        element.getClientRects().length > 0 &&
        !element.closest('template'),
    );
    const first = found[0];
    if (!first) return null;
    const box = first.getBoundingClientRect();
    const live = first.closest('[role="alert"], [role="status"], [aria-live]');
    return {
      count: found.length,
      top: box.top,
      bottom: box.bottom,
      height: window.innerHeight,
      live: live ? (live.getAttribute('role') ?? live.getAttribute('aria-live')) : null,
      inRow: Boolean(first.closest('li')),
    };
  }, sentence);
}

/**
 * Taps `button` from the worst place a holder can press it: its bottom at the window's bottom edge, so a line
 * written under its row starts below the window. The tap itself scrolls nothing, since the button is in view.
 */
async function tapFromBottomEdge(page: Page, button: Locator): Promise<void> {
  await button.evaluate((element) => {
    window.scrollBy(0, element.getBoundingClientRect().bottom - window.innerHeight + 2);
  });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await button.tap();
}

async function focusedVote(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.pollVoteButton ?? null);
}

describe('a refused vote is said where the holder pressed (POLL-DC-1)', () => {
  // 360x640 (POLL5-DC-1): there the rate-limit sentence wraps to two lines and its second line fell 16 px
  // below the window, so the line is brought fully into view after it is written.
  for (const [width, height] of [
    [390, 664],
    [360, 640],
  ] as const) {
    for (const [fixture, key] of [
      ['full', 'polls.refusedFull'],
      ['rate-limited', 'polls.refusedRateLimited'],
    ] as const) {
      it(`at ${width}x${height}, ${fixture}: the refusal is wholly inside the window, in a live region, and focus stays on the button`, async () => {
        const { page, errors, close } = await open(fixture, width, height);
        try {
          const first = page.locator('button[data-poll-vote-button]').first();
          const option = await first.getAttribute('data-poll-vote-button');
          await tapFromBottomEdge(page, first);
          const sentence = HOLDERS_COPY[key];
          await expect.poll(() => placeOf(page, sentence)).not.toBeNull();
          const place = await placeOf(page, sentence);
          expect(place?.count).toBe(1);
          expect(place?.height).toBe(height);
          expect(place?.top).toBeGreaterThanOrEqual(0);
          expect(place?.bottom).toBeLessThanOrEqual(place?.height ?? 0);
          expect(place?.live).toBe('alert');
          expect(place?.inRow).toBe(true);
          if (SHOTS) await page.screenshot({ path: join(SHOTS, `poll-refused-${fixture}-${width}.png`) });
          // Another press could pass: the button stays, in the window, with focus on it.
          await expect.poll(() => focusedVote(page)).toBe(option);
          expect(await first.isVisible()).toBe(true);
          const button = await first.boundingBox();
          expect(button?.y ?? -1).toBeGreaterThanOrEqual(0);
          expect(errors).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }

  it('at 360x640, refused-closed: the refusal is inside the window and focus moves to it, the bottom says closed', async () => {
    const { page, errors, close } = await open('refused-closed', 360, 640);
    try {
      const first = page.locator('button[data-poll-vote-button]').first();
      await tapFromBottomEdge(page, first);
      const sentence = HOLDERS_COPY['polls.refusedClosed'];
      await expect.poll(async () => (await placeOf(page, sentence))?.count ?? 0).toBe(2);
      const near = await page.evaluate((wanted) => {
        const said = document.querySelector<HTMLElement>('[data-poll-said]');
        const box = said?.getBoundingClientRect();
        return {
          text: said?.textContent?.trim() ?? '',
          top: box?.top ?? -1,
          bottom: box?.bottom ?? Number.POSITIVE_INFINITY,
          focused: said?.contains(document.activeElement) ?? false,
          bottomState: document.querySelector<HTMLElement>('[data-poll-state="closed"]')?.hidden === false,
          buttons: [...document.querySelectorAll<HTMLElement>('button[data-poll-vote-button]')].filter(
            (button) => button.getClientRects().length > 0,
          ).length,
          wanted,
        };
      }, sentence);
      expect(near.text).toBe(sentence);
      expect(near.top).toBeGreaterThanOrEqual(0);
      expect(near.bottom).toBeLessThanOrEqual(640);
      expect(near.focused).toBe(true);
      expect(near.bottomState).toBe(true);
      expect(near.buttons).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  it('at 360x640, refused-not-open: the buttons go, and the refusal is wholly inside the window with focus on it', async () => {
    const { page, errors, close } = await open('refused-not-open', 360, 640);
    try {
      const first = page.locator('button[data-poll-vote-button]').first();
      await tapFromBottomEdge(page, first);
      const sentence = HOLDERS_COPY['polls.refusedNotOpen'];
      await expect.poll(async () => (await placeOf(page, sentence))?.count ?? 0).toBe(1);
      const place = await placeOf(page, sentence);
      expect(place?.top).toBeGreaterThanOrEqual(0);
      expect(place?.bottom).toBeLessThanOrEqual(640);
      expect(place?.live).toBe('alert');
      expect(place?.inRow).toBe(true);
      const after = await page.evaluate(() => ({
        focused: document.querySelector<HTMLElement>('[data-poll-said]')?.contains(document.activeElement) ?? false,
        buttons: [...document.querySelectorAll<HTMLElement>('button[data-poll-vote-button]')].filter(
          (button) => button.getClientRects().length > 0,
        ).length,
      }));
      expect(after.focused).toBe(true);
      expect(after.buttons).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  it('a stored vote still says "Your vote" on the option and "Vote saved." once, and clears an earlier refusal', async () => {
    const { page, errors, close } = await open('can-vote', 390, 664);
    try {
      const first = page.locator('button[data-poll-vote-button]').first();
      const option = await first.getAttribute('data-poll-vote-button');
      await first.tap();
      await expect.poll(async () => (await placeOf(page, HOLDERS_COPY['polls.saved']))?.count ?? 0).toBe(1);
      const yours = page.locator(`[data-poll-option="${option}"] [data-poll-yours]`);
      expect(await yours.isVisible()).toBe(true);
      expect(await page.locator('[data-poll-said]:not(:empty)').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
});
