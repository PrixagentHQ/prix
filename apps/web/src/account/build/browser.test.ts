import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import BuildPage from '../BuildPage.astro';
import type { StrategyTemplate } from './templates.ts';
import { strategyTemplates, templateWords } from './templates.ts';

/**
 * The Build page's strategy templates (D-155) in a real browser, with the page's own script
 * running: choosing a template fills the prompt field as text with the cursor at its end; a text
 * the person wrote is replaced only after they confirm; the keyboard reaches and answers every
 * control; and the page still builds an agent with one request, as before.
 *
 * How: the page is rendered on the server side by Astro's container from the site's fixtures
 * (`?fixture=signed-in`: a wallet with no agent and no key), inside the site's own layout. A small
 * server on 127.0.0.1 (ports 9040 to 9049) serves that HTML, the site's stylesheets and the
 * browser modules themselves with their types stripped by Node, so the browser runs the same
 * source the build bundles. Chromium (Playwright) opens it. Every /api request is caught in the
 * browser and answered by the test; nothing leaves the machine.
 */

// One hostile template after the eight: markup, quotes and an ampersand must reach the field as
// the characters they are.
const HOSTILE: StrategyTemplate = {
  id: 'hostile',
  title: 'Bold <b>title</b>',
  line: 'A line with <i>markup</i> & "quotes".',
  prompt: 'Hold <b>SPY</b> at 20% & keep "the rest" in cash. <img src=x onerror="window.__owned=1">',
};
vi.mock('./templates.ts', async (original) => {
  const actual = await original<typeof import('./templates.ts')>();
  return { ...actual, strategyTemplates: () => [...actual.strategyTemplates(), HOSTILE] };
});

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACTS = fileURLToPath(new URL('../../../../../packages/contracts/src/', import.meta.url));
const SHOTS = process.env.TEMPLATE_SHOTS;
const STYLES = [
  'design/tokens.css',
  'design/base.css',
  'design/primitives.css',
  'design/board.css',
  'design/ascii/ascii.css',
  'design/ground/ground.css',
  'design/motion.css',
  'account/account.css',
  'account/build/templates.css',
];
const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

const TEMPLATES = strategyTemplates().filter((template) => template.id !== HOSTILE.id);
const [FIRST, SECOND] = TEMPLATES as [StrategyTemplate, StrategyTemplate, ...StrategyTemplate[]];
const OWN_TEXT = 'Hold SPY at 30% and keep the rest in cash. This is my own rule, written by hand.';

const pages = new Map<string, string>();
let server: Server;
let origin = '';
let browser: Browser;

async function serveTs(file: string): Promise<string> {
  // The same source the build bundles, with its types taken off and the build's own
  // `import.meta.env.SSR` set as a browser bundle has it.
  const code = stripTypeScriptTypes(await readFile(file, 'utf8'), { mode: 'strip' });
  return code.replaceAll('import.meta.env.SSR', 'false');
}

function listen(port: number): Promise<Server> {
  return new Promise((done, failed) => {
    const candidate = createServer(async (request, response) => {
      const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
      try {
        if (path.startsWith('/page/')) {
          const html = pages.get(path.slice('/page/'.length));
          if (html === undefined) throw new Error('no such page');
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          response.end(html);
          return;
        }
        if (path === '/contracts/constants.ts') {
          response.writeHead(200, { 'content-type': TYPES['.ts'], 'cache-control': 'no-store' });
          response.end(await serveTs(join(CONTRACTS, 'constants.ts')));
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
        if (path === '/account') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><title>Account</title><p>Account</p>');
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

/** The page as the browser gets it: the container's HTML with the site's stylesheets and the page's own module. */
function forBrowser(html: string): string {
  const links = STYLES.map((file) => `<link rel="stylesheet" href="/src/${file}">`).join('');
  const map = `<script type="importmap">{"imports":{"@prix/contracts/constants":"/contracts/constants.ts"}}</script>`;
  const modules = `<script type="module">
    import { mountBuild } from '/src/account/build.ts';
    mountBuild();
    document.documentElement.dataset.mounted = 'true';
  </script>`;
  const cleaned = html
    // The dev renderer's scripts and source marks: the page's module is loaded below instead.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*rel="(?:preload|icon|apple-touch-icon|manifest)"[^>]*>/g, '')
    .replace(/ data-astro-source-(?:file|loc)="[^"]*"/g, '');
  return cleaned.replace('</head>', `${map}${links}</head>`).replace('</body>', `${modules}</body>`);
}

beforeAll(async () => {
  const container = await AstroContainer.create();
  for (const theme of ['dark', 'light'] as const) {
    for (const [prefix, fixture] of [
      ['', 'signed-in'],
      ['out-', 'signed-out'],
    ] as const) {
      const html = await container.renderToString(BuildPage, {
        request: new Request(`http://127.0.0.1/build?fixture=${fixture}`, {
          headers: { cookie: `prix_theme=${theme}` },
        }),
      });
      pages.set(`${prefix}${theme}`, forBrowser(html));
    }
  }
  for (let port = 9040; port <= 9049 && !server; port += 1) {
    try {
      server = await listen(port);
      origin = `http://127.0.0.1:${port}`;
    } catch {
      // The port is taken: try the next of the ten.
    }
  }
  if (!server) throw new Error('No port from 9040 to 9049 is free.');
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
});

interface Sent {
  method: string;
  path: string;
  body: unknown;
}
interface Opened {
  page: Page;
  context: BrowserContext;
  sent: Sent[];
  dialogs: string[];
  close: () => Promise<void>;
}

async function open(
  options: {
    theme?: 'dark' | 'light';
    width?: number;
    height?: number;
    touch?: boolean;
    signedOut?: boolean;
    init?: string;
    forced?: boolean;
  } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
    hasTouch: options.touch ?? false,
    forcedColors: options.forced ? 'active' : 'none',
  });
  const page = await context.newPage();
  const sent: Sent[] = [];
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw = request.postData();
    const entry: Sent = { method: request.method(), path: url.pathname, body: raw ? JSON.parse(raw) : null };
    sent.push(entry);
    if (entry.method === 'POST' && entry.path === '/api/agents') {
      const body = entry.body as { name: string; prompt: string; division: string };
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ agent: { id: 'newagent0001', name: body.name, division: body.division } }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'not_found', message: 'Not found.', field: null } }),
    });
  });
  page.on('pageerror', (error) => dialogs.push(`pageerror: ${error.message}`));
  if (options.init) await page.addInitScript(options.init);
  await page.goto(`${origin}/page/${options.signedOut ? 'out-' : ''}${options.theme ?? 'dark'}`);
  await page.waitForSelector('html[data-mounted="true"]');
  return { page, context, sent, dialogs, close: () => context.close() };
}

const field = (page: Page) => page.locator('textarea[name="prompt"]');
const templateButton = (page: Page, id: string) => page.locator(`button[data-template-id="${id}"]`);
const panel = (page: Page) => page.locator('[data-template-confirm]');

async function cursor(page: Page): Promise<{ start: number; end: number; length: number; focused: boolean }> {
  return field(page).evaluate((area: HTMLTextAreaElement) => ({
    start: area.selectionStart,
    end: area.selectionEnd,
    length: area.value.length,
    focused: document.activeElement === area,
  }));
}

async function focusedTemplate(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.templateId ?? null);
}

describe('the strategy templates on the Build page', () => {
  it('shows the eight templates above the prompt field, with the note once', async () => {
    const { page, close } = await open();
    try {
      const ids = await page
        .locator('button[data-template-id]')
        .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.templateId));
      expect(ids).toEqual([...TEMPLATES.map((template) => template.id), HOSTILE.id]);
      await expect.poll(() => page.getByText(templateWords().note).count()).toBe(1);
      const above = await page.evaluate(() => {
        const list = document.querySelector('[data-templates]');
        const area = document.querySelector('textarea[name="prompt"]');
        return Boolean(list && area && list.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(above).toBe(true);
      expect(await panel(page).isHidden()).toBe(true);
    } finally {
      await close();
    }
  });

  it('fills an empty field with the template’s text, puts the cursor at its end and sends nothing', async () => {
    const { page, sent, dialogs, close } = await open();
    try {
      await templateButton(page, FIRST.id).click();
      expect(await field(page).inputValue()).toBe(FIRST.prompt);
      expect(await cursor(page)).toEqual({
        start: FIRST.prompt.length,
        end: FIRST.prompt.length,
        length: FIRST.prompt.length,
        focused: true,
      });
      // A starting text is not a pick: no template is marked as chosen.
      expect(await page.locator('[data-templates] [aria-current]').count()).toBe(0);
      expect(await page.locator('[data-template-status]').textContent()).toContain(FIRST.title);
      // Nothing else on the form changed, nothing was asked and nothing was sent.
      expect(await page.locator('input[name="name"]').inputValue()).toBe('');
      expect(await page.locator('input[name="division"]:checked').getAttribute('value')).toBe('open');
      expect(await page.locator('input[name="publish"]').isChecked()).toBe(false);
      expect(await panel(page).isHidden()).toBe(true);
      expect(dialogs).toEqual([]);
      expect(sent).toEqual([]);
    } finally {
      await close();
    }
  });

  it('puts a template holding markup in the field as text, never as markup', async () => {
    const { page, close } = await open();
    try {
      await templateButton(page, HOSTILE.id).click();
      expect(await field(page).inputValue()).toBe(HOSTILE.prompt);
      await imageErrorsSettled(page);
      const inPage = await page.evaluate(() => ({
        bold: document.querySelectorAll('form b, [data-templates] b, [data-templates] i').length,
        images: document.querySelectorAll('form img').length,
        children: document.querySelector('textarea[name="prompt"]')?.children.length ?? -1,
        owned: (window as unknown as { __owned?: number }).__owned ?? 0,
      }));
      expect(inPage).toEqual({ bold: 0, images: 0, children: 0, owned: 0 });
      expect(await templateButton(page, HOSTILE.id).locator('.tpl-item-title').textContent()).toBe(HOSTILE.title);
      expect(await page.locator('[data-template-status]').textContent()).toContain(HOSTILE.title);
    } finally {
      await close();
    }
  });

  it('replaces a template’s own text with another without asking', async () => {
    const { page, close } = await open();
    try {
      await templateButton(page, FIRST.id).click();
      await templateButton(page, SECOND.id).click();
      expect(await panel(page).isHidden()).toBe(true);
      expect(await field(page).inputValue()).toBe(SECOND.prompt);
      expect(await page.locator('[data-templates] [aria-current]').count()).toBe(0);
    } finally {
      await close();
    }
  });

  it('never replaces the person’s own text without a confirm, and keeps it when they say so', async () => {
    const { page, dialogs, close } = await open();
    try {
      await field(page).fill(OWN_TEXT);
      await templateButton(page, FIRST.id).click();
      expect(await field(page).inputValue()).toBe(OWN_TEXT);
      expect(await panel(page).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-template-confirm'))).toBe(true);
      expect(await page.locator('[data-template-consequence]').textContent()).toContain(FIRST.title);
      await page.locator('[data-template-keep]').click();
      expect(await panel(page).isHidden()).toBe(true);
      expect(await field(page).inputValue()).toBe(OWN_TEXT);
      expect(await focusedTemplate(page)).toBe(FIRST.id);
      expect(dialogs).toEqual([]);
    } finally {
      await close();
    }
  });

  it('replaces the person’s own text once they confirm, with the cursor at the end', async () => {
    const { page, close } = await open();
    try {
      await field(page).fill(OWN_TEXT);
      await templateButton(page, FIRST.id).click();
      // A second choice while the question stands: the question now names it.
      await templateButton(page, SECOND.id).click();
      expect(await page.locator('[data-template-consequence]').textContent()).toContain(SECOND.title);
      expect(await field(page).inputValue()).toBe(OWN_TEXT);
      await page.locator('[data-template-replace]').click();
      expect(await panel(page).isHidden()).toBe(true);
      expect(await field(page).inputValue()).toBe(SECOND.prompt);
      expect(await cursor(page)).toEqual({
        start: SECOND.prompt.length,
        end: SECOND.prompt.length,
        length: SECOND.prompt.length,
        focused: true,
      });
    } finally {
      await close();
    }
  });

  it('treats an edited template as the person’s own text', async () => {
    const { page, close } = await open();
    try {
      await templateButton(page, FIRST.id).click();
      await page.keyboard.type(' And never hold USO.');
      const edited = `${FIRST.prompt} And never hold USO.`;
      expect(await field(page).inputValue()).toBe(edited);
      await templateButton(page, SECOND.id).click();
      expect(await panel(page).isVisible()).toBe(true);
      expect(await field(page).inputValue()).toBe(edited);
      await page.keyboard.press('Escape');
      expect(await panel(page).isHidden()).toBe(true);
      expect(await field(page).inputValue()).toBe(edited);
      expect(await focusedTemplate(page)).toBe(SECOND.id);
    } finally {
      await close();
    }
  });

  it('works from the keyboard alone, with a visible focus ring', async () => {
    const { page, close } = await open();
    try {
      await page.locator('input[name="name"]').focus();
      await page.keyboard.press('Tab');
      expect(await focusedTemplate(page)).toBe(FIRST.id);
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      });
      expect(ring.style).toBe('solid');
      expect(ring.width).toBeGreaterThan(0);
      await page.keyboard.press('Enter');
      expect(await field(page).inputValue()).toBe(FIRST.prompt);
      expect((await cursor(page)).focused).toBe(true);

      // Back to the list: under tier 1 (the fixture API's default, tier 0) the locked line's link to
      // the token page stands between the templates and the field (D-161), then the last template.
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[data-templates-locked]') !== null)).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('href'))).toBe('/token');
      await page.keyboard.press('Shift+Tab');
      expect(await focusedTemplate(page)).toBe(HOSTILE.id);
      // To the second template, and Space: a template's text is replaced at once.
      await templateButton(page, SECOND.id).focus();
      await page.keyboard.press('Space');
      expect(await field(page).inputValue()).toBe(SECOND.prompt);

      // The person's own text: the question takes focus, Tab reaches "Replace the text", Enter answers.
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type(OWN_TEXT);
      await templateButton(page, FIRST.id).focus();
      await page.keyboard.press('Enter');
      expect(await field(page).inputValue()).toBe(OWN_TEXT);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-template-replace'))).toBe(true);
      await page.keyboard.press('Enter');
      expect(await field(page).inputValue()).toBe(FIRST.prompt);
      expect(await cursor(page)).toMatchObject({ start: FIRST.prompt.length, focused: true });
    } finally {
      await close();
    }
  });

  it('still builds an agent with one request, carrying the template’s text as the prompt', async () => {
    const { page, sent, close } = await open();
    try {
      await page.locator('input[name="name"]').fill('Template Tester');
      await templateButton(page, FIRST.id).click();
      await Promise.all([page.waitForURL(`${origin}/account`), page.locator('button[type="submit"]').click()]);
      expect(sent).toEqual([
        {
          method: 'POST',
          path: '/api/agents',
          body: { name: 'Template Tester', prompt: FIRST.prompt, division: 'open' },
        },
      ]);
    } finally {
      await close();
    }
  });

  it('refuses to send an empty prompt, as before, and asks nothing of the templates', async () => {
    const { page, sent, close } = await open();
    try {
      await page.locator('input[name="name"]').fill('Template Tester');
      await page.locator('button[type="submit"]').click();
      await expect.poll(() => page.locator('[data-field="prompt"] .field-error').count()).toBeGreaterThan(0);
      expect(sent).toEqual([]);
      expect(await panel(page).isHidden()).toBe(true);
    } finally {
      await close();
    }
  });

  for (const theme of ['dark', 'light'] as const) {
    for (const width of [360, 390, 768, 1440]) {
      it(`fits a window ${width} pixels wide in the ${theme} theme, with no sideways scroll`, async () => {
        const { page, close } = await open({ theme, width });
        try {
          await field(page).fill(OWN_TEXT);
          await templateButton(page, SECOND.id).click();
          const fit = await page.evaluate(() => {
            const items = [...document.querySelectorAll<HTMLElement>('.tpl-item, [data-template-confirm]')];
            const width = document.documentElement.clientWidth;
            return {
              scroll: document.scrollingElement ? document.scrollingElement.scrollWidth - width : 0,
              outside: items.filter((item) => {
                const box = item.getBoundingClientRect();
                return box.left < 0 || box.right > width;
              }).length,
              smallest: Math.min(...items.map((item) => item.getBoundingClientRect().height)),
              theme: document.documentElement.dataset.theme,
            };
          });
          expect(fit.scroll).toBeLessThanOrEqual(0);
          expect(fit.outside).toBe(0);
          expect(fit.smallest).toBeGreaterThanOrEqual(44);
          expect(fit.theme).toBe(theme);
          if (SHOTS) {
            mkdirSync(SHOTS, { recursive: true });
            await page.locator('[data-templates]').screenshot({ path: join(SHOTS, `templates-${theme}-${width}.png`) });
          }
        } finally {
          await close();
        }
      });
    }
  }

  it('lays the eight boxes in two even columns from 45em and in one column below it', async () => {
    for (const [width, columns] of [
      [360, 1],
      [700, 1],
      [720, 2],
      [1024, 2],
      [1440, 2],
      [1920, 2],
    ] as const) {
      const { page, close } = await open({ width });
      try {
        const grid = await page.evaluate(() => {
          const items = [...document.querySelectorAll<HTMLElement>('.tpl-item')].slice(0, 8);
          const lefts = new Set(items.map((item) => Math.round(item.getBoundingClientRect().left)));
          const widths = new Set(items.map((item) => Math.round(item.getBoundingClientRect().width)));
          const tops = new Set(items.map((item) => Math.round(item.getBoundingClientRect().top)));
          return { columns: lefts.size, widths: widths.size, rows: tops.size };
        });
        expect(grid, `at ${width}`).toEqual({ columns, widths: 1, rows: 8 / columns });
      } finally {
        await close();
      }
    }
  });

  it('keeps the padding of a box on a phone at 8 pixels and its line one step smaller', async () => {
    for (const [width, padding, line] of [
      [360, '8px', '12px'],
      [1440, '8px 12px', '13px'],
    ] as const) {
      const { page, close } = await open({ width });
      try {
        const item = templateButton(page, FIRST.id);
        expect(await item.evaluate((element) => getComputedStyle(element).padding)).toBe(padding);
        expect(await item.locator('.tpl-item-line').evaluate((element) => getComputedStyle(element).fontSize)).toBe(
          line,
        );
      } finally {
        await close();
      }
    }
  });

  // DC3-3: on a phone a tapped box keeps the hover style until the next tap elsewhere, so the wash
  // of a pointer over a box is given only where the pointer can hover.
  it('gives a box its hover wash only where the pointer can hover', async () => {
    const { page, close } = await open();
    try {
      const rules = await page.evaluate(() => {
        const found: string[] = [];
        const walk = (list: CSSRuleList, media: string) => {
          for (const rule of list) {
            if (rule instanceof CSSMediaRule) walk(rule.cssRules, `${media} ${rule.conditionText}`.trim());
            else if (rule instanceof CSSStyleRule && rule.selectorText.includes('.tpl-item:hover')) found.push(media);
          }
        };
        for (const sheet of document.styleSheets) walk(sheet.cssRules, '');
        return found;
      });
      expect(rules.length).toBeGreaterThan(0);
      for (const media of rules) expect(media).toContain('(hover: hover)');
    } finally {
      await close();
    }
  });

  it('keeps a visible edge on every box in forced colours, and nothing moves', async () => {
    for (const width of [360, 1440]) {
      const plain = await open({ width });
      const forced = await open({ width, forced: true });
      try {
        const measure = (page: Page) =>
          page.locator('.tpl-item').evaluateAll((items) =>
            items.map((item) => {
              const style = getComputedStyle(item);
              const box = item.getBoundingClientRect();
              return {
                border: style.borderTopWidth,
                style: style.borderTopStyle,
                width: box.width,
                height: box.height,
              };
            }),
          );
        const before = await measure(plain.page);
        const after = await measure(forced.page);
        for (const box of after) expect(box).toMatchObject({ border: '1px', style: 'solid' });
        expect(after.map((box) => [box.width, box.height])).toEqual(before.map((box) => [box.width, box.height]));
      } finally {
        await plain.close();
        await forced.close();
      }
    }
  });
});

/** The builder draft of the page's tab, as build.ts keeps it. */
async function storedDraft(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('prix.builder-draft');
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  });
}

const signedOutSection = (page: Page) => page.locator('[data-templates][data-templates-keep]');
const kept = (title: string) => templateWords().kept.replace('{title}', title);

/**
 * The signed-out status line's frame (DC3-1): its padding above and below the words, and its top
 * edge, which is drawn only while the line is stuck to the bottom of the window ('none' otherwise).
 */
async function statusFrame(page: Page): Promise<{ top: number; bottomAtLeast8: boolean; edge: string }> {
  return page.evaluate(() => {
    const element = document.querySelector('[data-templates-keep] .tpl-status') as HTMLElement;
    const style = getComputedStyle(element);
    const edge = getComputedStyle(element, '::before');
    const drawn = edge.content !== 'none' && edge.borderTopStyle !== 'none';
    return {
      top: Number.parseFloat(style.paddingTop),
      bottomAtLeast8: Number.parseFloat(style.paddingBottom) >= 8,
      edge: drawn ? edge.borderTopWidth : 'none',
    };
  });
}

/**
 * Waits until an image that fails to load has fired its error handler in `page` (T3-TEST-1). An
 * injected `<img onerror>` of a hostile text fails the same way, so once this sentinel has fired, a
 * handler that never ran is one that was never in the page, not one that had no time yet.
 */
async function imageErrorsSettled(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sentinel = document.createElement('img');
    sentinel.hidden = true;
    sentinel.addEventListener('error', () => {
      (window as unknown as { __sentinelFailed?: boolean }).__sentinelFailed = true;
      sentinel.remove();
    });
    sentinel.src = 'x';
    document.body.append(sentinel);
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __sentinelFailed?: boolean }).__sentinelFailed === true))
    .toBe(true);
}

describe('the strategy templates on the signed-out Build page', () => {
  it('shows the eight templates after the sign-in steps, with the signed-out hint and the note once', async () => {
    const { page, close } = await open({ signedOut: true });
    try {
      expect(await page.locator('form[data-build]').count()).toBe(0);
      const ids = await signedOutSection(page)
        .locator('button[data-template-id]')
        .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.templateId));
      expect(ids).toEqual([...TEMPLATES.map((template) => template.id), HOSTILE.id]);
      expect(await page.locator('#step-sign-in').count()).toBe(1);
      const inCard = await page.evaluate(() => {
        const card = document.querySelector('#step-sign-in')?.closest('section');
        const section = document.querySelector('[data-templates-keep]');
        return Boolean(card && section && card.contains(section));
      });
      expect(inCard).toBe(true);
      await expect.poll(() => page.getByText(templateWords().note).count()).toBe(1);
      expect(await page.getByText(templateWords().hintSignedOut).count()).toBe(1);
      expect(await page.getByText(templateWords().hint).count()).toBe(0);
      // No id repeats on the page.
      const repeated = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
        return ids.filter((id, index) => ids.indexOf(id) !== index);
      });
      expect(repeated).toEqual([]);
      expect(await page.locator('#templates-out-title').count()).toBe(1);
    } finally {
      await close();
    }
  });

  it('keeps a chosen template as the draft’s prompt beside its other fields, says so, and sends nothing', async () => {
    const { page, context, sent, dialogs, close } = await open({ signedOut: true });
    try {
      await page.evaluate(() =>
        window.sessionStorage.setItem(
          'prix.builder-draft',
          JSON.stringify({ name: 'Kept Name', division: 'open', publish: 'yes' }),
        ),
      );
      await signedOutSection(page).locator(`button[data-template-id="${FIRST.id}"]`).click();
      expect(await storedDraft(page)).toEqual({
        name: 'Kept Name',
        division: 'open',
        publish: 'yes',
        prompt: FIRST.prompt,
      });
      const status = signedOutSection(page).locator('[data-template-status]');
      expect(await status.textContent()).toBe(kept(FIRST.title));
      expect(await status.isVisible()).toBe(true);
      // Focus stays on the template, and nothing is marked as chosen.
      expect(await focusedTemplate(page)).toBe(FIRST.id);
      expect(await page.locator('[data-templates] [aria-current]').count()).toBe(0);
      // One key in this tab's storage, nothing elsewhere, no request, no cookie.
      expect(
        await page.evaluate(() => ({ session: window.sessionStorage.length, local: window.localStorage.length })),
      ).toEqual({ session: 1, local: 0 });
      expect(await context.cookies()).toEqual([]);
      expect(sent).toEqual([]);
      expect(dialogs).toEqual([]);

      // Another template's text replaces a template's text without asking.
      await signedOutSection(page).locator(`button[data-template-id="${SECOND.id}"]`).click();
      expect(await panel(page).isHidden()).toBe(true);
      expect((await storedDraft(page))?.prompt).toBe(SECOND.prompt);
      expect(await status.textContent()).toBe(kept(SECOND.title));
    } finally {
      await close();
    }
  });

  it('starts a draft when there is none', async () => {
    const { page, close } = await open({ signedOut: true });
    try {
      await signedOutSection(page).locator(`button[data-template-id="${FIRST.id}"]`).press('Enter');
      expect(await storedDraft(page)).toEqual({ prompt: FIRST.prompt });
      expect(await focusedTemplate(page)).toBe(FIRST.id);
    } finally {
      await close();
    }
  });

  it('replaces a prompt the person wrote only after the question, and keeps it when they say so', async () => {
    const { page, dialogs, close } = await open({ signedOut: true });
    try {
      const mine = { name: 'Mine', prompt: OWN_TEXT, division: 'pro', modelKeyId: 'key1' };
      await page.evaluate((draft) => window.sessionStorage.setItem('prix.builder-draft', JSON.stringify(draft)), mine);
      const section = signedOutSection(page);
      await section.locator(`button[data-template-id="${FIRST.id}"]`).click();
      expect(await panel(page).isVisible()).toBe(true);
      expect(await section.locator('[data-template-consequence]').textContent()).toContain(FIRST.title);
      expect(await storedDraft(page)).toEqual(mine);

      await section.locator('[data-template-keep]').click();
      expect(await panel(page).isHidden()).toBe(true);
      expect(await storedDraft(page)).toEqual(mine);
      expect(await focusedTemplate(page)).toBe(FIRST.id);

      // Escape keeps it too.
      await section.locator(`button[data-template-id="${SECOND.id}"]`).click();
      await page.keyboard.press('Escape');
      expect(await panel(page).isHidden()).toBe(true);
      expect(await storedDraft(page)).toEqual(mine);

      await section.locator(`button[data-template-id="${SECOND.id}"]`).click();
      await section.locator('[data-template-replace]').click();
      expect(await panel(page).isHidden()).toBe(true);
      expect(await storedDraft(page)).toEqual({ ...mine, prompt: SECOND.prompt });
      expect(await section.locator('[data-template-status]').textContent()).toBe(kept(SECOND.title));
      expect(await focusedTemplate(page)).toBe(SECOND.id);
      expect(dialogs).toEqual([]);
    } finally {
      await close();
    }
  });

  it('says the template could not be kept when storage throws, and throws nothing', async () => {
    const init = `(() => {
      const refuse = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
      Storage.prototype.getItem = refuse;
      Storage.prototype.setItem = refuse;
    })();`;
    const { page, sent, dialogs, close } = await open({ signedOut: true, init });
    try {
      await signedOutSection(page).locator(`button[data-template-id="${FIRST.id}"]`).click();
      expect(await signedOutSection(page).locator('[data-template-status]').textContent()).toBe(
        templateWords().notKept.replace('{title}', FIRST.title),
      );
      expect(await panel(page).isHidden()).toBe(true);
      expect(await focusedTemplate(page)).toBe(FIRST.id);
      expect(dialogs).toEqual([]);
      expect(sent).toEqual([]);
    } finally {
      await close();
    }
  });

  it('has the template’s text in the strategy prompt once the person has signed in', async () => {
    const { page, dialogs, close } = await open({ signedOut: true });
    try {
      await page.evaluate(() =>
        window.sessionStorage.setItem('prix.builder-draft', JSON.stringify({ name: 'Draft Keeper' })),
      );
      await signedOutSection(page).locator(`button[data-template-id="${SECOND.id}"]`).click();
      // The same tab, after the sign-in: the signed-in page restores the draft.
      await page.goto(`${origin}/page/dark`);
      await page.waitForSelector('html[data-mounted="true"]');
      expect(await field(page).inputValue()).toBe(SECOND.prompt);
      expect(await page.locator('input[name="name"]').inputValue()).toBe('Draft Keeper');
      expect(dialogs).toEqual([]);
    } finally {
      await close();
    }
  });

  it('keeps a template holding markup as text, there and after the sign-in', async () => {
    const { page, close } = await open({ signedOut: true });
    try {
      await signedOutSection(page).locator(`button[data-template-id="${HOSTILE.id}"]`).click();
      expect((await storedDraft(page))?.prompt).toBe(HOSTILE.prompt);
      expect(await signedOutSection(page).locator('[data-template-status]').textContent()).toBe(kept(HOSTILE.title));
      const outside = async () => {
        await imageErrorsSettled(page);
        return page.evaluate(() => ({
          markup: document.querySelectorAll('[data-templates] b, [data-templates] i, form b, form img').length,
          owned: (window as unknown as { __owned?: number }).__owned ?? 0,
        }));
      };
      expect(await outside()).toEqual({ markup: 0, owned: 0 });
      await page.goto(`${origin}/page/dark`);
      await page.waitForSelector('html[data-mounted="true"]');
      expect(await field(page).inputValue()).toBe(HOSTILE.prompt);
      expect(await outside()).toEqual({ markup: 0, owned: 0 });
    } finally {
      await close();
    }
  });

  // DC-T1: most readers arrive signed out on a phone. The status line follows eight stacked boxes,
  // so it rides at the bottom of the window while the section is in view, and settles under the
  // grid at the end of it.
  for (const [width, height] of [
    [390, 664],
    [360, 640],
  ] as const) {
    it(`shows what a tap did inside a ${width} by ${height} window, and moves no focus`, async () => {
      const { page, close } = await open({ width, height, touch: true, signedOut: true });
      try {
        await signedOutSection(page).locator(`button[data-template-id="${FIRST.id}"]`).tap();
        const box = signedOutSection(page).locator('.tpl-status');
        await expect.poll(() => box.locator('[data-template-status]').textContent()).toBe(kept(FIRST.title));
        const seen = await box.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            inside: rect.top >= 0 && rect.bottom <= window.innerHeight + 0.5 && rect.height > 0,
            position: style.position,
            background: style.backgroundColor,
            card: getComputedStyle(element.closest('.card') as Element).backgroundColor,
          };
        });
        expect(seen).toEqual({ inside: true, position: 'sticky', background: seen.card, card: seen.card });
        expect(await focusedTemplate(page)).toBe(FIRST.id);
        // DC3-1: the stuck line has room above and below its words, and a hairline edge on top.
        expect(await statusFrame(page)).toEqual({ top: 8, bottomAtLeast8: true, edge: '1px' });
        // At the end of the section the line sits under the grid, in the flow, with no edge.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const settled = await page.evaluate(() => {
          const list = document.querySelector('[data-templates-keep] .tpl-list')?.getBoundingClientRect();
          const status = document.querySelector('[data-templates-keep] .tpl-status')?.getBoundingClientRect();
          return Boolean(list && status && status.top >= list.bottom);
        });
        expect(settled).toBe(true);
        await expect.poll(() => statusFrame(page)).toEqual({ top: 8, bottomAtLeast8: true, edge: 'none' });
      } finally {
        await close();
      }
    });
  }

  // DC-T2: the status names the next step and gives a plain way to take it.
  it('offers a plain Sign in link after a choice, which moves focus to the card’s Sign in button only when pressed', async () => {
    const { page, sent, close } = await open({ signedOut: true });
    try {
      const section = signedOutSection(page);
      const link = section.locator('a[data-template-sign-in]');
      expect(await link.count()).toBe(1);
      expect(await link.isHidden()).toBe(true);
      await section.locator(`button[data-template-id="${FIRST.id}"]`).click();
      expect(await link.isVisible()).toBe(true);
      // DC3-2: the link carries the step, and the sentence before it does not say it again.
      expect(await link.textContent()).toBe(templateWords().keptSignIn);
      expect(await section.locator('[data-template-status]').textContent()).toBe(kept(FIRST.title));
      expect(kept(FIRST.title)).not.toContain(templateWords().keptSignIn);
      expect(await link.getAttribute('href')).toBe('#step-sign-in');
      // Choosing moves no focus.
      expect(await focusedTemplate(page)).toBe(FIRST.id);
      // One control on the page starts a wallet, and the link is not one.
      expect(await page.locator('[data-sign-in-button]').count()).toBe(1);
      await link.click();
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-sign-in-button'))).toBe(true);
      expect(new URL(page.url()).hash).toBe('');
      // From the keyboard too.
      await section.locator(`button[data-template-id="${SECOND.id}"]`).focus();
      await page.keyboard.press('Enter');
      expect(await focusedTemplate(page)).toBe(SECOND.id);
      await link.focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-sign-in-button'))).toBe(true);
      expect(sent).toEqual([]);
    } finally {
      await close();
    }
  });

  it('draws no rule between the wallet note and the templates in the sign-in card', async () => {
    const { page, close } = await open({ signedOut: true });
    try {
      const edge = await page.evaluate(() => {
        const part = document.querySelector('[data-templates-keep]')?.parentElement;
        return part ? getComputedStyle(part).borderTopStyle : null;
      });
      expect(edge).toBe('none');
    } finally {
      await close();
    }
  });

  // DC-T5: signed out there is no strategy prompt on the page, so the question says what is kept.
  it('asks about the kept text in the signed-out words', async () => {
    const { page, close } = await open({ signedOut: true });
    try {
      await page.evaluate(
        (prompt) => window.sessionStorage.setItem('prix.builder-draft', JSON.stringify({ prompt })),
        OWN_TEXT,
      );
      const section = signedOutSection(page);
      await section.locator(`button[data-template-id="${FIRST.id}"]`).click();
      expect(await section.locator('[data-template-consequence]').textContent()).toBe(
        templateWords().consequenceSignedOut.replace('{title}', FIRST.title),
      );
    } finally {
      await close();
    }
  });

  // TPL2-SEC-2: a draft is what this tab's storage holds, and anything can write there. Every field
  // of it reaches the page as text, and a key the builder does not own is left as it is.
  it('treats markup in every field of a stored draft as text, signed out and after the sign-in', async () => {
    const draftFields = ['name', 'prompt', 'division', 'publish', 'modelKeyId'];
    const markup = (field: string) => `<img src=x onerror="window.__draftOwned='${field}'"><b>${field}</b>&amp;`;
    const seeded: Record<string, string> = Object.fromEntries(draftFields.map((key) => [key, markup(key)]));
    seeded.unknown = '<script>window.__draftOwned="unknown"</script><svg onload="window.__draftOwned=1">';

    const count = (page: Page) =>
      page.evaluate(() => ({
        form: document.querySelectorAll('form[data-build] *').length,
        section: document.querySelectorAll('[data-templates] *').length,
      }));
    const clean = await open();
    const signedInBefore = await count(clean.page);
    await clean.close();

    const { page, dialogs, close } = await open({ signedOut: true });
    try {
      const sectionBefore = await count(page);
      await page.evaluate(
        (draft) => window.sessionStorage.setItem('prix.builder-draft', JSON.stringify(draft)),
        seeded,
      );
      const section = signedOutSection(page);
      await section.locator(`button[data-template-id="${FIRST.id}"]`).click();
      expect(await panel(page).isVisible()).toBe(true);
      await section.locator('[data-template-replace]').click();
      expect(await storedDraft(page)).toEqual({ ...seeded, prompt: FIRST.prompt });
      expect(await count(page)).toEqual(sectionBefore);

      await page.goto(`${origin}/page/dark`);
      await page.waitForSelector('html[data-mounted="true"]');
      expect(await count(page)).toEqual(signedInBefore);
      // The `__draftOwned` sentinel below means something only once an injected image would have failed.
      await imageErrorsSettled(page);
      const shown = await page.evaluate(() => ({
        owned: (window as unknown as { __draftOwned?: unknown }).__draftOwned ?? null,
        name: (document.querySelector('input[name="name"]') as HTMLInputElement | null)?.value,
        prompt: (document.querySelector('textarea[name="prompt"]') as HTMLTextAreaElement | null)?.value,
        preview: [...document.querySelectorAll('[data-preview] .agent-card-name span')].map((span) => span.textContent),
        markup: document.querySelectorAll('form b, form img, form script, [data-preview] b, [data-preview] img').length,
      }));
      expect(shown.owned).toBe(null);
      expect(shown.name).toBe(seeded.name);
      expect(shown.prompt).toBe(FIRST.prompt);
      expect(shown.preview.length).toBeGreaterThan(0);
      for (const name of shown.preview) expect(name).toBe(seeded.name);
      expect(shown.markup).toBe(0);
      expect((await storedDraft(page))?.unknown).toBe(seeded.unknown);
      expect(dialogs).toEqual([]);
    } finally {
      await close();
    }
  });

  for (const theme of ['dark', 'light'] as const) {
    for (const width of [360, 768, 1440]) {
      it(`fits a window ${width} pixels wide signed out in the ${theme} theme, with no sideways scroll`, async () => {
        const { page, close } = await open({ theme, width, signedOut: true });
        try {
          await signedOutSection(page).locator(`button[data-template-id="${SECOND.id}"]`).click();
          const fit = await page.evaluate(() => {
            const items = [...document.querySelectorAll<HTMLElement>('.tpl-item, .tpl-status')];
            const width = document.documentElement.clientWidth;
            return {
              scroll: document.scrollingElement ? document.scrollingElement.scrollWidth - width : 0,
              outside: items.filter((item) => {
                const box = item.getBoundingClientRect();
                return box.left < 0 || box.right > width;
              }).length,
              theme: document.documentElement.dataset.theme,
            };
          });
          expect(fit).toEqual({ scroll: 0, outside: 0, theme });
          if (SHOTS) {
            mkdirSync(SHOTS, { recursive: true });
            await page
              .locator('#step-sign-in')
              .locator('xpath=ancestor::section[1]')
              .screenshot({ path: join(SHOTS, `templates-signed-out-${theme}-${width}.png`) });
          }
        } finally {
          await close();
        }
      });
    }
  }
});
