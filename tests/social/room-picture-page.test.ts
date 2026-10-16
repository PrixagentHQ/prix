import type { ChildProcess } from 'node:child_process';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Locator, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { roomPictureRefusalKey } from '@prix/contracts';
import {
  ROOM_PICTURE_DOM,
  ROOM_PICTURES_PATH,
  roomPictureCheck,
  roomPictureIdOf,
  roomPicturePath,
} from '@prix/contracts/room-picture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deck } from '../../apps/web/src/content/deck.ts';
import { repoRoot } from '../support/repo.ts';
import { PNG_END, png, pngGreyData, pngHeader } from './support/picture-files.ts';

/**
 * The built chat page with a full page of pictures (docs/contracts/phase-6-pictures.md sections 7, 11
 * and 17): before a click the page holds no `<img>` and no address of a picture, and no script asks for
 * one by itself. A page with 50 picture messages sends 0 picture requests; one click sends one.
 *
 * Revision 6 adds, on the same build, what the reviews of the first round's pages found: no Prix mark on
 * a picture's row (D3), a report that asks first and sends one call only from the yes (P2), the focus
 * after a report (D8), a file the browser cannot draw (D14), and on the admins' page no double press that
 * unblurs (P1, D1).
 *
 * It builds the SAMPLE site (PRIX_FIXTURES=1) into a folder of its own, never the site's `dist`, serves
 * it on a port of its own on this machine only, and stops that server when it is done. The sample build
 * has no bytes route: the one request of a click is answered here, with a 404, and nothing leaves the
 * machine.
 *
 * Revision 7 adds the rule that closed the second look's P2: a report's question takes no answer from a
 * pointer until it has stood for REPORT_ANSWER_AFTER_MS, so that two presses at one point never report a
 * picture, whatever the width. A key's press on the yes is an answer at once.
 */

const FULL = 'signed-out,social-room-pictures-full';
const PICTURES = 50;

/**
 * What the callbacks that run inside the page use of it. The tests are type-checked without the DOM
 * library (tests/tsconfig.json: ES2022 and the Workers types; the DOM's would change the types of every
 * other test), so a callback takes this small view of the page's globals from `globalThis`, and names
 * nothing else of the page. A cast is a type's alone: what reaches the page is `globalThis`.
 */
interface InPageElement {
  hasAttribute(name: string): boolean;
  querySelector(selector: string): InPageElement | null;
  closest(selector: string): InPageElement | null;
}
/** A click as the page's document hears it. */
interface InPageClick {
  /** The click count: 1 or more for a pointer, 0 for a key. */
  detail: number;
  /** The kind of pointer: the empty string for a key. */
  pointerType?: string;
  target: InPageElement | null;
}
interface InPage {
  document: {
    readonly activeElement: InPageElement | null;
    readonly body: InPageElement;
    querySelectorAll(selector: string): Iterable<InPageElement>;
    addEventListener(type: 'click', heard: (event: InPageClick) => void, capture: true): void;
  };
  getComputedStyle(element: InPageElement): { filter: string };
  MutationObserver: new (
    seen: () => void,
  ) => {
    observe(target: InPageElement, what: { subtree: boolean; childList: boolean; attributes: boolean }): void;
  };
  scrollBy(x: number, y: number): void;
}

/**
 * How long a question stands before a pointer's press on its yes is an answer: the constant of the
 * page's own script, never a figure typed here. That script is the browser's and names the DOM's types,
 * so it is imported by its path when the file runs, as tests/unit/web-fixtures-prices.test.ts imports
 * the page client, and the type check of the tests does not read it.
 */
const reportScript: { REPORT_ANSWER_AFTER_MS?: unknown } = await import(
  /* @vite-ignore */ pathToFileURL(join(repoRoot(), 'apps/web/src/account/social/room/report.ts')).href
);
function milliseconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`report.ts exports no REPORT_ANSWER_AFTER_MS that is a time: ${String(value)}`);
  }
  return value;
}
const REPORT_ANSWER_AFTER_MS = milliseconds(reportScript.REPORT_ANSWER_AFTER_MS);

let outDir = '';
let origin = '';
let preview: ChildProcess | null = null;
let browser: Browser | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Stops the preview server this file started, with the processes it started itself, and no other. */
function stopPreview(): void {
  if (preview === null || preview.pid === undefined) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { stdio: 'ignore' });
  else preview.kill('SIGTERM');
  preview = null;
}

const pageUrl = (fixture: string): string => `${origin}/chat?fixture=${encodeURIComponent(fixture)}&theme=dark`;

/**
 * Builds the sample site into `folder` and serves it, and says whether /chat then answers with the page
 * of this build. The site's preview does not take its build from `--outDir` alone: it follows a pointer
 * that the LAST build of the site wrote (apps/web/.wrangler/deploy/config.json). Another test of the
 * suite builds the same site, without samples, into the site's own `dist` (tests/data/first-call.test.ts);
 * when its build ends after this one, the preview serves that build, whose /chat is a 503 with no API
 * behind it. So the pointer is read before the preview starts, and a preview that does not answer with
 * this build is stopped and the whole step is tried again.
 */
async function buildAndServe(root: string, folder: string): Promise<string | null> {
  execSync(`pnpm --filter @prix/web exec astro build --outDir "${folder}"`, {
    cwd: root,
    stdio: 'pipe',
    timeout: 240_000,
    env: { ...process.env, PRIX_FIXTURES: '1' },
  });
  const pointer = join(root, 'apps', 'web', '.wrangler', 'deploy', 'config.json');
  const name = folder.split('/').at(-1) ?? folder;
  if (existsSync(pointer) && !readFileSync(pointer, 'utf8').includes(name)) {
    return 'another build of the site ended after this one: the preview would serve that build';
  }
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let said = '';
  let ended: number | null = null;
  preview = spawn(`pnpm --filter @prix/web exec astro preview --outDir "${folder}" --port ${port} --host 127.0.0.1`, {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  preview.stdout?.on('data', (chunk: unknown) => {
    said += String(chunk);
  });
  preview.stderr?.on('data', (chunk: unknown) => {
    said += String(chunk);
  });
  preview.on('exit', (code) => {
    ended = code ?? -1;
  });
  let status = 0;
  for (let tries = 0; tries < 45 && status !== 200 && ended === null; tries += 1) {
    try {
      status = (await fetch(pageUrl(FULL), { signal: AbortSignal.timeout(3_000) })).status;
    } catch {
      status = 0;
    }
    // Any other answer of a server that is up is the answer of another build: no use in asking again.
    if (status !== 200 && status !== 0) break;
    if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (status === 200) return null;
  stopPreview();
  return `the preview did not answer /chat with the sample page (status ${status}, ended: ${String(ended)}):\n${said.slice(-800)}`;
}

beforeAll(async () => {
  const root = repoRoot();
  outDir = mkdtempSync(join(tmpdir(), 'prix-qa-room-pictures-'));
  // Forward slashes: the path goes through a shell and through the site's own tooling.
  const folder = outDir.split('\\').join('/');
  let problem: string | null = 'not tried';
  for (let attempt = 0; attempt < 4 && problem !== null; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
    problem = await buildAndServe(root, folder);
  }
  if (problem !== null) throw new Error(problem);
  browser = await chromium.launch();
}, 560_000);

afterAll(async () => {
  await browser?.close();
  stopPreview();
  if (outDir !== '') rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}, 60_000);

describe('the built chat page with 50 picture messages', () => {
  it('holds 50 picture rows and no <img>, no address of a picture and no preload, as it leaves the server', async () => {
    const html = await (await fetch(pageUrl(FULL))).text();

    const ids = [...html.matchAll(new RegExp(`${ROOM_PICTURE_DOM.id}="([^"]*)"`, 'g'))].map((match) => match[1]);
    expect(ids).toHaveLength(PICTURES);
    expect(ids.every((id) => roomPictureIdOf(id) !== null)).toBe(true);
    expect(html).toContain(ROOM_PICTURE_DOM.list);
    expect(html).toMatch(new RegExp(`${ROOM_PICTURE_DOM.state}="on"`));
    // No element that loads a picture, and no address of one in any attribute, script or style.
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<(?:picture|source|object|embed|iframe)\b/i);
    expect(html).not.toMatch(/\bsrcset\s*=/i);
    expect(html).not.toContain(ROOM_PICTURES_PATH);
    expect(html).not.toContain('/pictures/');
    expect(html).not.toMatch(/rel="(?:preload|prefetch)"[^>]*as="image"/i);
    expect(html).not.toMatch(/as="image"/i);
    for (const id of ids.slice(0, 3)) expect(html).not.toContain(roomPicturePath(Number(id)));
  });

  it('asks for 0 pictures when it loads, three seconds later, after a scroll and under the pointer', async () => {
    if (browser === null) throw new Error('no browser');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const pictures: string[] = [];
    const images: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith(ROOM_PICTURES_PATH)) pictures.push(`${request.method()} ${path}`);
      if (request.resourceType() === 'image' && !path.startsWith('/favicon') && !/\.(?:svg|ico|png)$/.test(path)) {
        images.push(path);
      }
    });
    await page.route(`**${ROOM_PICTURES_PATH}/**`, (route) => route.fulfill({ status: 404, body: '' }));

    await page.goto(pageUrl(FULL), { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    // No script shows a picture by itself: not on load, not on scroll, not on hover.
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.mouse.move(195, 400);
    await page.locator(`[${ROOM_PICTURE_DOM.id}]`).nth(10).hover();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1_000);

    expect(await page.locator(`[${ROOM_PICTURE_DOM.id}]`).count()).toBe(PICTURES);
    expect(pictures).toEqual([]);
    expect(images).toEqual([]);
    expect(await page.locator(`[${ROOM_PICTURE_DOM.list}] img`).count()).toBe(0);
    expect(await page.locator(`[${ROOM_PICTURE_DOM.shown}]`).count()).toBe(0);

    // One click is one picture, at the address of the row's own id, as an <img> and never a link.
    const row = page.locator(`[${ROOM_PICTURE_DOM.id}]`).first();
    const id = roomPictureIdOf(await row.getAttribute(ROOM_PICTURE_DOM.id));
    expect(id).not.toBeNull();
    const asked = page.waitForRequest((request) => new URL(request.url()).pathname.startsWith(ROOM_PICTURES_PATH));
    await row.locator('[data-room-picture-toggle]').click();
    const request = await asked;
    await page.waitForTimeout(1_000);

    expect(pictures).toEqual([`GET ${roomPicturePath(id as number)}`]);
    expect(request.resourceType()).toBe('image');
    expect(request.headers().referer).toBeUndefined();
    expect(new URL(request.url()).search).toBe('');
    expect(await page.locator(`[${ROOM_PICTURE_DOM.list}] a img`).count()).toBe(0);
    // The load failed (this build has no bytes route): nothing asks again.
    await page.waitForTimeout(2_000);
    expect(pictures).toHaveLength(1);
    await page.close();
  }, 120_000);
});

// --- revision 6: what the reviews of the first round's pages found ----------------------------------------

/** A picture a browser can draw, for the one request of a click: the sample build has no bytes route. */
const DRAWN = Buffer.from(png(pngHeader(64, 48), pngGreyData(64, 48), PNG_END));
/**
 * A GIF whose blocks are in order, so the rule passes it, and whose pixel data no decoder can read: its
 * first code is one the code table does not hold yet (the design check's D14).
 */
const UNDRAWABLE = Buffer.from([
  ...Buffer.from('GIF89a', 'latin1'),
  ...[64, 0, 64, 0, 0x80, 0, 0],
  ...[20, 30, 40, 255, 255, 255],
  ...[0x2c, 0, 0, 0, 0, 64, 0, 64, 0, 0],
  ...[2, 24, ...new Array<number>(24).fill(0xff), 0],
  0x3b,
]);
const sayOf = (key: string): string => (deck[key] ?? '').replace(/\s+/g, ' ').trim();
const chatUrl = (fixture: string): string => `${origin}/chat?fixture=${encodeURIComponent(fixture)}&theme=dark`;

async function newPage(): Promise<Page> {
  if (browser === null) throw new Error('no browser');
  return browser.newPage({ viewport: { width: 390, height: 900 } });
}

describe('the built chat page: no Prix mark on a row that carries a picture (revision 6, D3)', () => {
  it('keeps the mark on the message of text of an admin wallet, and shows none in any picture row', async () => {
    const page = await newPage();
    await page.goto(chatUrl('signed-out,social-room-pictures'), { waitUntil: 'networkidle' });

    const marks = await page.evaluate(
      ([list, id]) => {
        const { document } = globalThis as unknown as InPage;
        const rows = [...document.querySelectorAll(`[${list}] > li`)];
        const pictures = rows.filter((row) => row.hasAttribute(id as string));
        return {
          pictures: pictures.length,
          // A gone row, a reported row and a shown row alike: the state does not matter.
          onPictures: pictures.filter((row) => row.querySelector('.room-mark') !== null).length,
          onText: rows.filter((row) => !row.hasAttribute(id as string) && row.querySelector('.room-mark') !== null)
            .length,
        };
      },
      [ROOM_PICTURE_DOM.list, ROOM_PICTURE_DOM.id],
    );

    expect(marks.pictures).toBeGreaterThan(0);
    // The selector is the mark's own: the sample page has a message of text from an admin wallet.
    expect(marks.onText).toBeGreaterThan(0);
    expect(marks.onPictures).toBe(0);
    await page.close();
  }, 60_000);
});

/** The reports the sample page has sent: the sample build answers a report itself, and counts it on its window. */
const sent = (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as { prixSampleReports?: number }).prixSampleReports ?? 0);
const focused = (locator: Locator): Promise<boolean> =>
  locator.evaluate((element) => element === (globalThis as unknown as InPage).document.activeElement);
/** The page's own clock, as its scripts read it. */
const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now());

/**
 * Waits, on the page's own clock, until a question that is open now has stood for REPORT_ANSWER_AFTER_MS.
 * The clock is first read after the question opened, so the question has stood at least as long as this
 * waits: a pointer's press on the yes is then an answer.
 */
async function stood(page: Page): Promise<void> {
  await page.waitForFunction(({ since, after }) => performance.now() - since >= after, {
    since: await pageNow(page),
    after: REPORT_ANSWER_AFTER_MS,
  });
}

/**
 * Opens /chat as a holder who may report, and hands back the first row that offers a picture, shown.
 * With `clock` the page's clock is in the test's hand from before the page's first script: it runs on as
 * a clock does until the test stops it (`stopClock`).
 */
async function openRow(how: { viewport?: { width: number; height: number }; clock?: boolean } = {}) {
  if (browser === null) throw new Error('no browser');
  const page = await browser.newPage({ viewport: how.viewport ?? { width: 390, height: 900 } });
  if (how.clock === true) await page.clock.install();
  const posted: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path.startsWith(ROOM_PICTURES_PATH)) posted.push(`${request.method()} ${path}`);
  });
  await page.route(`**${ROOM_PICTURES_PATH}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: DRAWN }),
  );
  await page.goto(chatUrl('signed-in,social-room-pictures'), { waitUntil: 'networkidle' });
  const row = page
    .locator(`[${ROOM_PICTURE_DOM.list}] [${ROOM_PICTURE_DOM.id}]`)
    .filter({ has: page.locator('button[data-room-picture-toggle]') })
    .first();
  await row.locator('button[data-room-picture-toggle]').click();
  await row.locator('img').waitFor({ state: 'visible' });
  const report = row.locator(`[${ROOM_PICTURE_DOM.report}]`);
  await report.waitFor({ state: 'visible' });
  const note = row.locator(`[${ROOM_PICTURE_DOM.reportNote}]`);
  const answers = row.locator(`[${ROOM_PICTURE_DOM.reportYes}], [${ROOM_PICTURE_DOM.reportNo}]`);
  return { page, row, report, note, answers, posted };
}

describe('the built chat page: "Report picture" asks first (revision 6, P2 and D8)', () => {
  it('sends nothing at the first press, nor at any further press on the same spot or key; only the yes sends, once', async () => {
    const { page, row, report, note, answers, posted } = await openRow();
    expect(((await note.textContent()) ?? '').trim()).toBe('');

    await report.click();

    // The question, with its two answers, in the row's own note: the deck's sentence, and nothing sent.
    expect(await sent(page)).toBe(0);
    expect(((await note.textContent()) ?? '').replace(/\s+/g, ' ')).toContain(sayOf('social.roomPictureReportAsk'));
    expect(await answers.count()).toBe(2);
    // The focus is on the note itself, never on one of its two buttons.
    expect(await focused(note)).toBe(true);

    // A second press of the same key or on the same spot reports nothing.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await report.click();
    await report.dblclick();
    await page.waitForTimeout(300);
    expect(await sent(page)).toBe(0);
    expect(await answers.count()).toBe(2);

    // The no puts the row back as it was.
    await row.locator(`[${ROOM_PICTURE_DOM.reportNo}]`).click();
    expect(((await note.textContent()) ?? '').trim()).toBe('');
    expect(await answers.count()).toBe(0);
    expect(await sent(page)).toBe(0);
    expect(await report.isDisabled()).toBe(false);

    // Only the yes makes the call, and it makes one. A pointer's yes is an answer once the question has stood.
    await report.click();
    await stood(page);
    await row.locator(`[${ROOM_PICTURE_DOM.reportYes}]`).click();
    await page.waitForFunction(() => ((globalThis as { prixSampleReports?: number }).prixSampleReports ?? 0) > 0);
    await page.waitForTimeout(300);
    expect(await sent(page)).toBe(1);
    await report.click({ force: true });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(await sent(page)).toBe(1);
    // The sample build answers a report itself: no request left the page for one.
    expect(posted).toEqual([]);
    await page.close();
  }, 90_000);

  it('after a report from the keyboard removes the two buttons of the question and keeps the focus on the note with the answer', async () => {
    const { page, row, report, note, answers } = await openRow();

    await report.focus();
    await page.keyboard.press('Enter');
    expect(await focused(note)).toBe(true);
    // Tab from the question reaches its yes.
    await page.keyboard.press('Tab');
    expect(await focused(row.locator(`[${ROOM_PICTURE_DOM.reportYes}]`))).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => ((globalThis as { prixSampleReports?: number }).prixSampleReports ?? 0) > 0);
    await note.filter({ hasText: sayOf('social.roomPictureReportDone') }).waitFor({ state: 'visible' });

    expect(((await note.textContent()) ?? '').replace(/\s+/g, ' ').trim()).toBe(sayOf('social.roomPictureReportDone'));
    // Removed, not disabled: a disabled button that had the focus drops it to the page.
    expect(await answers.count()).toBe(0);
    expect(await focused(note)).toBe(true);
    expect(
      await page.evaluate(() => {
        const { document } = globalThis as unknown as InPage;
        return document.activeElement === document.body;
      }),
    ).toBe(false);
    expect(await sent(page)).toBe(1);
    await page.close();
  }, 90_000);

  it('gives the focus back to "Report picture" when the no closes the question', async () => {
    const { page, row, report, answers } = await openRow();

    await report.click();
    expect(await answers.count()).toBe(2);
    await row.locator(`[${ROOM_PICTURE_DOM.reportNo}]`).click();

    expect(await answers.count()).toBe(0);
    expect(await focused(report)).toBe(true);
    expect(await sent(page)).toBe(0);
    await page.close();
  }, 90_000);

  it('closes an open question when "Hide picture" is pressed, as the no closes it, and without moving the focus', async () => {
    const { page, row, report, note, answers } = await openRow();
    const toggle = row.locator('button[data-room-picture-toggle]');

    // "Hide picture" while the question is open: the row is no longer shown, and the question is gone.
    await report.click();
    expect(await answers.count()).toBe(2);
    expect(await focused(note)).toBe(true);
    await toggle.click();
    const isShown = (): Promise<boolean> =>
      row.evaluate((element, shown) => element.hasAttribute(shown), ROOM_PICTURE_DOM.shown);
    await expect.poll(isShown, { timeout: 5_000 }).toBe(false);
    // The script that watches the row answers in a microtask: longer than that, so a late close is seen too.
    await page.waitForTimeout(200);
    expect(await answers.count()).toBe(0);
    expect(((await note.textContent()) ?? '').trim()).toBe('');
    // The focus stays where the reader's own press put it, and is not sent to "Report picture".
    expect(await focused(toggle)).toBe(true);
    expect(await focused(report)).toBe(false);
    expect(await sent(page)).toBe(0);

    // Shown again, the row asks again from the start: nothing was reported, and the button is not closed.
    await toggle.click();
    await report.waitFor({ state: 'visible' });
    expect(await answers.count()).toBe(0);
    expect(await report.isDisabled()).toBe(false);
    await report.click();
    expect(await answers.count()).toBe(2);
    expect(await sent(page)).toBe(0);
    await page.close();
  }, 90_000);
});

/** A click the page heard: when, on the page's own clock, with what click count and pointer, and on what. */
interface HeardClick {
  at: number;
  count: number;
  pointer: string;
  on: 'yes' | 'no' | 'report' | 'other';
}

/** Records every click the page hears from now on, before the page's own script hears it. */
const watchClicks = (page: Page): Promise<void> =>
  page.evaluate(
    ({ yes, no, report }) => {
      const view = globalThis as unknown as InPage & { qaClicks?: HeardClick[] };
      const clicks: HeardClick[] = [];
      view.qaClicks = clicks;
      const on = (target: InPageElement | null): HeardClick['on'] => {
        if (target?.closest(`[${yes}]`)) return 'yes';
        if (target?.closest(`[${no}]`)) return 'no';
        return target?.closest(`[${report}]`) ? 'report' : 'other';
      };
      view.document.addEventListener(
        'click',
        (event) => {
          clicks.push({
            at: performance.now(),
            count: event.detail,
            pointer: event.pointerType ?? '',
            on: on(event.target),
          });
        },
        true,
      );
    },
    { yes: ROOM_PICTURE_DOM.reportYes, no: ROOM_PICTURE_DOM.reportNo, report: ROOM_PICTURE_DOM.report },
  );
const clicksOf = (page: Page): Promise<HeardClick[]> =>
  page.evaluate(() => (globalThis as { qaClicks?: HeardClick[] }).qaClicks ?? []);

/**
 * Stops the page's clock where it stands, and sees that it stands while this machine's own clock goes
 * on: from here the test says how long a question has stood, whatever the machine's load. It hands back
 * the clock's reading, which is the time of opening of a question that opens before the clock is moved.
 */
async function stopClock(page: Page): Promise<number> {
  // A clock stops at a time that is still ahead of it: ten seconds, so that no load of this machine
  // between the reading and the stop puts that time behind it. The room's scripts run no timer.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 10_000);
  const at = await pageNow(page);
  await page.waitForTimeout(120);
  expect(await pageNow(page)).toBe(at);
  return at;
}

/**
 * Moves the page's stopped clock on until a question that opened at `opened` has stood for `ms`, by
 * whole milliseconds and no further than it must, and hands back how long the question has then stood.
 */
async function standFor(page: Page, opened: number, ms: number): Promise<number> {
  for (let tries = 0; tries < 3; tries += 1) {
    const left = ms - ((await pageNow(page)) - opened);
    if (left <= 0) break;
    await page.clock.fastForward(Math.ceil(left));
  }
  return (await pageNow(page)) - opened;
}

describe('the built chat page: a question takes no answer from a pointer until it has stood (revision 7, P2)', () => {
  const reported = (page: Page): Promise<unknown> =>
    page.waitForFunction(() => ((globalThis as { prixSampleReports?: number }).prixSampleReports ?? 0) > 0);
  /** Whether the row's note holds the question, with its two answers. */
  const asks = async (note: Locator, answers: Locator): Promise<boolean> =>
    ((await note.textContent()) ?? '').replace(/\s+/g, ' ').includes(sayOf('social.roomPictureReportAsk')) &&
    (await answers.count()) === 2;

  // The case of the review: "Report picture" 10 px above the window's foot. The question's note then lies
  // below the foot, its focus scrolls the page, and where the two answers wrap under "Report picture"
  // (280 px) the yes comes to lie where the pointer is: the second press at that point is on the yes.
  for (const [width, height, wraps] of [
    [280, 640, true],
    [390, 844, false],
  ] as const) {
    it(`never reports at two presses of a pointer at one point, in a window ${width} px wide`, async () => {
      const { page, report, note, answers, posted } = await openRow({ viewport: { width, height }, clock: true });
      await report.evaluate((element) => element.scrollIntoView({ block: 'end' }));
      await page.evaluate(() => (globalThis as unknown as InPage).scrollBy(0, 10));
      const box = await report.boundingBox();
      if (box === null) throw new Error('"Report picture" has no box');
      expect(Math.round(height - box.y - box.height)).toBe(10);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await watchClicks(page);
      const opened = await stopClock(page);

      await page.mouse.click(x, y);
      await page.mouse.click(x, y);
      // Longer than a report takes to be counted, so one that is sent late is seen too.
      await page.waitForTimeout(300);

      const [first, second] = await clicksOf(page);
      expect(first?.on).toBe('report');
      // The second press is a pointer's, and came before the question had stood.
      expect(second?.count).toBeGreaterThan(0);
      expect((second?.at ?? Number.NaN) - opened).toBeLessThan(REPORT_ANSWER_AFTER_MS);
      expect(await sent(page)).toBe(0);
      expect(await report.isDisabled()).toBe(false);
      if (wraps) {
        // Where the answers wrap, it came down on the yes: the test is not empty. The question stays open.
        expect(second?.on).toBe('yes');
        expect(await asks(note, answers)).toBe(true);
      }

      // A further press at that point, one millisecond before the question has stood: no answer either.
      expect(await standFor(page, opened, REPORT_ANSWER_AFTER_MS - 1)).toBeLessThan(REPORT_ANSWER_AFTER_MS);
      await page.mouse.click(x, y);
      await page.waitForTimeout(300);
      expect(await sent(page)).toBe(0);
      expect(await report.isDisabled()).toBe(false);
      if (wraps) {
        expect((await clicksOf(page)).at(-1)?.on).toBe('yes');
        expect(await asks(note, answers)).toBe(true);
      }
      expect(posted).toEqual([]);
      await page.close();
    }, 90_000);
  }

  it('takes a pointer’s press on the yes for no answer before the question has stood: nothing is sent, and the question stays open with its two answers', async () => {
    const { page, row, report, note, answers, posted } = await openRow({ clock: true });
    await watchClicks(page);
    const opened = await stopClock(page);
    await report.click();
    expect(await asks(note, answers)).toBe(true);
    const yes = row.locator(`[${ROOM_PICTURE_DOM.reportYes}]`);

    // At once, half way, and one millisecond before the question has stood.
    for (const after of [0, Math.floor(REPORT_ANSWER_AFTER_MS / 2), REPORT_ANSWER_AFTER_MS - 1]) {
      expect(await standFor(page, opened, after)).toBeLessThan(REPORT_ANSWER_AFTER_MS);
      await yes.click();
      await page.waitForTimeout(300);
      expect(await sent(page)).toBe(0);
      expect(await asks(note, answers)).toBe(true);
      expect(await report.isDisabled()).toBe(false);
    }

    // Each of the three was a pointer's press, and on the yes.
    const clicks = await clicksOf(page);
    expect(clicks.map((click) => click.on)).toEqual(['report', 'yes', 'yes', 'yes']);
    expect(clicks.slice(1).every((click) => click.count > 0)).toBe(true);
    expect(posted).toEqual([]);
    await page.close();
  }, 90_000);

  it('takes the same press for the answer once the question has stood: one report, and no second', async () => {
    const { page, row, report, note, answers, posted } = await openRow({ clock: true });
    await watchClicks(page);
    const opened = await stopClock(page);
    await report.click();
    const yes = row.locator(`[${ROOM_PICTURE_DOM.reportYes}]`);

    // One millisecond too soon: no answer.
    expect(await standFor(page, opened, REPORT_ANSWER_AFTER_MS - 1)).toBeLessThan(REPORT_ANSWER_AFTER_MS);
    await yes.click();
    await page.waitForTimeout(300);
    expect(await sent(page)).toBe(0);
    expect(await asks(note, answers)).toBe(true);
    const box = await yes.boundingBox();
    if (box === null) throw new Error('the yes has no box');

    // The question has stood: the same press is the answer.
    expect(await standFor(page, opened, REPORT_ANSWER_AFTER_MS)).toBeGreaterThanOrEqual(REPORT_ANSWER_AFTER_MS);
    await yes.click();
    await reported(page);
    await note.filter({ hasText: sayOf('social.roomPictureReportDone') }).waitFor({ state: 'visible' });
    expect(await answers.count()).toBe(0);
    expect(await report.isDisabled()).toBe(true);

    // No later press sends a second: not where the yes stood, and not on "Report picture".
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await report.click({ force: true });
    await page.waitForTimeout(300);
    expect(await sent(page)).toBe(1);
    const clicks = await clicksOf(page);
    expect(clicks.slice(0, 3).map((click) => click.on)).toEqual(['report', 'yes', 'yes']);
    expect(clicks.slice(1, 3).every((click) => click.count > 0)).toBe(true);
    expect(posted).toEqual([]);
    await page.close();
  }, 90_000);

  it('takes a key’s Enter on the yes right after Tab for the answer at once', async () => {
    const { page, row, report, note, answers, posted } = await openRow({ clock: true });
    await watchClicks(page);
    await report.focus();
    const opened = await stopClock(page);

    await page.keyboard.press('Enter');
    expect(await focused(note)).toBe(true);
    expect(await asks(note, answers)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await focused(row.locator(`[${ROOM_PICTURE_DOM.reportYes}]`))).toBe(true);
    await page.keyboard.press('Enter');
    await reported(page);

    // The page's clock has not moved since the question opened: the answer did not wait.
    expect((await pageNow(page)) - opened).toBe(0);
    const clicks = await clicksOf(page);
    expect(clicks.map((click) => click.on)).toEqual(['report', 'yes']);
    // A key's click on the yes: no click count, and no pointer named.
    expect(clicks[1]).toEqual({ at: opened, count: 0, pointer: '', on: 'yes' });
    expect(await sent(page)).toBe(1);
    expect(await answers.count()).toBe(0);
    expect(posted).toEqual([]);
    await page.close();
  }, 90_000);
});

describe('the built chat page: a picture the browser cannot draw (revision 6, D14)', () => {
  it('is refused in the composer with the sentence of picture_malformed: nothing is chosen, nothing is sent', async () => {
    // The rule itself passes the file, so the rule alone would have let it through to an empty preview.
    expect(roomPictureCheck(new Uint8Array(UNDRAWABLE)).ok).toBe(true);
    const page = await newPage();
    await page.goto(chatUrl('signed-in,social-room-pictures'), { waitUntil: 'networkidle' });

    await page
      .locator('input[data-room-picture-file]')
      .setInputFiles({ name: 'undrawable.gif', mimeType: 'image/gif', buffer: UNDRAWABLE });
    const problem = page.locator('[data-room-picture-problem]');
    await problem.waitFor({ state: 'visible' });

    const said = ((await problem.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    expect(said.startsWith(sayOf(roomPictureRefusalKey('picture_malformed')))).toBe(true);
    expect(await page.locator('[data-room-picture]').isVisible()).toBe(false);
    expect(await page.locator('canvas[data-room-picture-preview]').isVisible()).toBe(false);
    expect(
      await page.evaluate(() => (globalThis as { prixSampleUpload?: unknown }).prixSampleUpload ?? null),
    ).toBeNull();
    await page.close();
  }, 60_000);
});

describe("the built admins' page: a second press never unblurs (revision 6, P1 and D1)", () => {
  const ADMIN_PAGE = (): string => `${origin}/admin/chat?fixture=signed-in-admin&theme=dark`;
  const BYTES = /\/api\/social\/admin\/room\/pictures\/\d+$/;

  /** The admins' page, with the bytes of a look answered here after `delay` ms, and a recorder of any picture ever seen whole. */
  async function openLook(delay: number) {
    const page = await newPage();
    const asked: string[] = [];
    await page.route(BYTES, async (route) => {
      asked.push(new URL(route.request().url()).pathname);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fulfill({ status: 200, contentType: 'image/png', body: DRAWN }).catch(() => undefined);
    });
    await page.goto(ADMIN_PAGE(), { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const seen = globalThis as { qaEverWhole?: boolean };
      const view = globalThis as unknown as InPage;
      seen.qaEverWhole = false;
      const look = (): void => {
        for (const each of view.document.querySelectorAll('[data-room-look-of] img')) {
          if (view.getComputedStyle(each).filter === 'none') seen.qaEverWhole = true;
        }
      };
      new view.MutationObserver(look).observe(view.document.body, { subtree: true, childList: true, attributes: true });
      setInterval(look, 20);
    });
    const holder = page
      .locator('[data-room-look-of]')
      .filter({ has: page.locator('button[data-room-look="show"]') })
      .first();
    const show = holder.locator('button[data-room-look="show"]');
    await show.scrollIntoViewIfNeeded();
    return {
      page,
      asked,
      holder,
      show,
      hide: holder.locator('button[data-room-look="hide"]'),
      unblur: holder.locator('button[data-room-look="unblur"]'),
    };
  }

  /** What the page ended with: whether any picture of a look was ever whole, and the pictures still in it. */
  const ended = (page: Page): Promise<{ everWhole: boolean; blurred: boolean[] }> =>
    page.evaluate(() => {
      const view = globalThis as unknown as InPage;
      return {
        everWhole: (globalThis as { qaEverWhole?: boolean }).qaEverWhole === true,
        blurred: [...view.document.querySelectorAll('[data-room-look-of] img')].map(
          (each) => view.getComputedStyle(each).filter !== 'none',
        ),
      };
    });

  it('shows a picture blurred, with "Hide picture" in the place and with the focus, and unblurs only by the control that comes with the bytes', async () => {
    const { page, asked, holder, show, hide, unblur } = await openLook(800);
    expect(await page.locator('img').count()).toBe(0);
    expect(await unblur.isVisible()).toBe(false);

    await show.click();
    await holder.locator('img').waitFor({ state: 'attached' });

    // The bytes are on their way: the control in the place is "Hide picture", and it has the focus.
    expect(await focused(hide)).toBe(true);
    expect(await show.isVisible()).toBe(false);
    expect(await unblur.isVisible()).toBe(false);
    await unblur.waitFor({ state: 'visible' });
    // It appeared with the bytes and took no focus.
    expect(await focused(hide)).toBe(true);
    expect((await ended(page)).blurred).toEqual([true]);
    expect((await ended(page)).everWhole).toBe(false);

    // The second, deliberate press: the test is not empty, the picture can be seen whole.
    await unblur.click();
    expect((await ended(page)).blurred).toEqual([false]);
    expect(asked).toHaveLength(1);
    await page.close();
  }, 60_000);

  const presses: [string, (page: Page, at: { x: number; y: number }, show: Locator) => Promise<void>][] = [
    ...[0, 120, 300, 500].map((apart): [string, (page: Page, at: { x: number; y: number }) => Promise<void>] => [
      `two clicks at one point ${apart} ms apart`,
      async (page, at) => {
        await page.mouse.click(at.x, at.y);
        if (apart > 0) await page.waitForTimeout(apart);
        await page.mouse.click(at.x, at.y);
      },
    ]),
    ['a double click', (page, at) => page.mouse.dblclick(at.x, at.y)],
    [
      'Enter twice',
      async (page, _at, show) => {
        await show.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
      },
    ],
    [
      'Space twice',
      async (page, _at, show) => {
        await show.focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('Space');
      },
    ],
    [
      'Enter held',
      async (page, _at, show) => {
        await show.focus();
        await page.keyboard.down('Enter');
        for (let again = 0; again < 25; again += 1) {
          await page.keyboard.down('Enter');
          await page.waitForTimeout(30);
        }
        await page.keyboard.up('Enter');
      },
    ],
  ];
  for (const delay of [1_200, 0]) {
    it(`never shows a picture whole after a second press on the same spot or key, with the bytes ${delay === 0 ? 'at once' : `after ${delay} ms`}`, async () => {
      const whole: string[] = [];
      for (const [name, press] of presses) {
        const { page, show } = await openLook(delay);
        const at = await show.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });

        await press(page, at, show);
        // Longer than the bytes take, so a load that comes late is seen too.
        await page.waitForTimeout(delay + 500);

        const end = await ended(page);
        if (end.everWhole || !end.blurred.every(Boolean)) whole.push(name);
        await page.close();
      }
      expect(whole).toEqual([]);
    }, 180_000);
  }
});
