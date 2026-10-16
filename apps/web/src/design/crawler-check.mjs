// The crawler's page driver (docs/DESIGN.md section 30), on a local SAMPLE build (PRIX_FIXTURES=1).
// Read-only: it only GETs pages of the origin it is given, and refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4392 --host 127.0.0.1
//   node apps/web/src/design/crawler-check.mjs http://127.0.0.1:4392 [directory for screenshots] [--budget]
//
// Time is Playwright's clock: every frame of a scripted session is driven, and every 50 ms the
// driver reads the glyphs the crawler drew (window.__crawler, a sample build's only) against walls
// and words it finds in the page itself:
//   - no glyph box meets a wall (a control, a form, a picture or chart, a figure, an animal, a medal,
//     the tape, a toast, anything fixed or sticky, words with a figure); while it stands, taps or
//     reads, none meets a word either;
//   - once settled, 0 frames in 5 s; the page never scrolls sideways;
//   - no request for the crawler's chunk under reduced motion, under Save-Data, or on a coarse pointer
//     before a tap that calls it; a tap on a link navigates as before;
//   - no crawler off its five pages.
// With --budget it measures, at 1920 by 1080 in real time, the crawler's own work per frame at 1x and
// 4x CPU, the layouts and style recalculations of the session, and one build of the map on /league.
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const origin = args[0];
const shots = args[1] && !args[1].startsWith('--') ? args[1] : null;
const budget = args.includes('--budget');
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('usage: node crawler-check.mjs <local origin of a sample build> [shots dir] [--budget]');
}

let failed = 0;
function check(ok, what, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

/** Runs in the page: the walls and words of `main`, measured exactly, in the window's coordinates. */
function walls() {
  const main = document.querySelector('main');
  const out = { walls: [], words: [], loud: [] };
  if (!main) return out;
  const hard =
    'a[href],button,input,select,textarea,summary,[role="button"],[tabindex]:not([tabindex="-1"]),img,svg,video,iframe,hr,form,.figures,.agent-mark,.medal,.ticker,.toast,dialog,[role="dialog"],[data-crawler-wall],ol:not([role="list"])';
  const box = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const range = document.createRange();
  const visit = (element) => {
    if (element.matches('.ground, .crawler, .visually-hidden')) return;
    const style = getComputedStyle(element);
    if (style.display === 'none') return;
    const r = element.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1 && (element.matches(hard) || ['fixed', 'sticky'].includes(style.position))) {
      out.walls.push(box(r));
      return;
    }
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        range.selectNodeContents(child);
        for (const line of range.getClientRects()) {
          if (line.width > 0) (/[0-9$%]/.test(child.textContent) ? out.walls : out.words).push(box(line));
          if (line.width > 0 && element.closest('h1,h2')) out.loud.push(box(line));
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) visit(child);
    }
  };
  for (const child of main.children) visit(child);
  return out;
}

/** Runs in the page: the crawler's state, its glyphs clipped to `main`, and what they meet. */
function sample() {
  const state = window.__crawler?.state();
  if (!state) return null;
  const found = (window.__walls ?? (() => ({ walls: [], words: [] })))();
  const main = document.querySelector('main').getBoundingClientRect();
  const meets = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const seen = state.glyphs
    .map((g) => {
      const x = Math.max(g.x, main.left, 0);
      const y = Math.max(g.y, main.top);
      const right = Math.min(g.x + g.w, main.right, document.documentElement.clientWidth);
      const bottom = Math.min(g.y + g.h, main.bottom);
      return { x, y, w: right - x, h: bottom - y, ch: g.ch };
    })
    .filter((g) => g.w > 0.01 && g.h > 0.01);
  const standing = ['stand', 'tap', 'read'].includes(state.mode);
  const onWall = seen.filter((g) => found.walls.some((w) => meets(g, w))).length;
  const onWord = standing ? seen.filter((g) => found.words.some((w) => meets(g, w))).length : 0;
  const onLoud = seen.filter((g) => found.loud.some((w) => meets(g, w))).length;
  return {
    onLoud,
    mode: state.mode,
    running: state.running,
    x: state.x,
    y: state.y,
    glyphs: seen.length,
    onWall,
    onWord,
    drawn: state.drawn,
    dropped: state.dropped,
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

const CHUNK = /\/_astro\/crawl-[^/]*\.js/;

/**
 * P1 of the first review: the layout's script stays inline on every page, as on main, and no page
 * asks for Vite's preload helper or the crawler's bundle in its HTML.
 */
async function served() {
  for (const path of ['/', '/build', '/live', '/league']) {
    const html = await (await fetch(`${origin}${path}`)).text();
    const external = html.match(/<script[^>]*src="[^"]*Layout\.astro_astro_type_script[^"]*"/g) ?? [];
    const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].some((m) =>
      m[1].includes('main[data-crawler]'),
    );
    check(
      external.length === 0 && inline,
      `${path}: the layout's script with the gate is inline`,
      external[0] ?? (inline ? '' : 'no inline gate'),
    );
    check(!html.includes('preload-helper'), `${path}: no preload helper in the HTML`);
    check(
      !/(src|href)="[^"]*\/_astro\/crawl-/.test(html),
      `${path}: the HTML neither loads nor preloads the crawler's bundle`,
    );
  }
}

async function open(browser, options, path, theme, extra = {}) {
  const context = await browser.newContext({ deviceScaleFactor: 1, ...options });
  const page = await context.newPage();
  const asked = [];
  page.on('request', (request) => {
    if (CHUNK.test(request.url())) asked.push(request.url());
  });
  if (extra.init) await page.addInitScript(extra.init);
  if (!extra.realTime) await page.clock.install();
  await page.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}theme=${theme}`, { waitUntil: 'load' });
  await page.evaluate(`window.__walls = ${walls.toString()}`);
  return { context, page, asked };
}

/** Waits in real time for the crawler's module to arrive, while the page's clock stands. */
async function arrived(page) {
  for (let k = 0; k < 100; k += 1) {
    if (await page.evaluate(() => Boolean(window.__crawler))) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

/** Runs the page's clock for `ms` in steps of 50, reading the crawler at every step. */
async function run(page, ms, log) {
  for (let t = 0; t < ms; t += 50) {
    await page.clock.runFor(50);
    const s = await page.evaluate(sample);
    if (s) log.push(s);
  }
  return log.at(-1) ?? null;
}

async function shoot(page, name) {
  if (!shots) return;
  const s = await page.evaluate(() => window.__crawler?.state());
  if (!s) return;
  const file = `${shots}/${name}.png`;
  const width = page.viewportSize().width;
  const clip = {
    x: Math.max(0, Math.min(width - 640, s.x - 320)),
    y: Math.max(0, s.y - 220),
    width: Math.min(640, width),
    height: 440,
  };
  await page.screenshot({ path: file, clip });
  // The whole window too: the crop shows the drawing, the window shows how it sits in the page.
  await page.screenshot({ path: `${shots}/${name}-full.png` });
  console.log(`     ${file}`);
}

/** A free point of the window: no element with words, no control, nothing drawn, near (x, y). */
async function freePoint(page, x, y) {
  return page.evaluate(
    ([x0, y0]) => {
      const hard = 'a,button,input,select,textarea,label,img,svg,canvas,form,.figures,.agent-mark,.card,.ticker,.top';
      for (let ring = 0; ring < 40; ring += 1) {
        for (let k = 0; k < 16; k += 1) {
          const x = x0 + Math.cos((k * Math.PI) / 8) * ring * 12;
          const y = y0 + Math.sin((k * Math.PI) / 8) * ring * 12;
          if (x < 8 || y < 8 || x > innerWidth - 8 || y > innerHeight - 8) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || hit.closest(hard)) continue;
          const own = [...hit.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          if (!own && hit.closest('main')) return { x, y };
        }
      }
      return null;
    },
    [x, y],
  );
}

function verdict(log, what) {
  const walled = log.filter((s) => s.onWall > 0);
  const worded = log.filter((s) => s.onWord > 0);
  const sideways = log.filter((s) => s.sideways !== 0);
  check(log.length > 0, `${what}: the crawler came`, `${log.length} samples`);
  check(
    walled.length === 0,
    `${what}: no glyph on a wall at any of ${log.length} samples`,
    walled.length ? JSON.stringify(walled[0]) : '',
  );
  check(
    worded.length === 0,
    `${what}: no glyph on a word while it stands, taps or reads`,
    worded.length ? JSON.stringify(worded[0]) : '',
  );
  check(sideways.length === 0, `${what}: no sideways scroll`, sideways.length ? `${sideways[0].sideways} px` : '');
  // F3 of the first review: it crosses the words of an h1 or an h2 only briefly, never for a second and a half.
  let run = 0;
  let longest = 0;
  for (const s of log) {
    run = s.onLoud > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  check(longest * 50 < 1500, `${what}: over an h1 or h2 at most briefly`, `${longest * 50} ms at once`);
  const modes = [...new Set(log.map((s) => s.mode))].join(' ');
  const dropped = log.at(-1)?.dropped ?? 0;
  console.log(`     modes ${modes}; glyphs left undrawn by the last guard: ${dropped}`);
}

async function desktop(browser, width, height, dpr, theme) {
  const tag = `${width}x${height} dpr ${dpr} ${theme}`;
  // CRAWLER_PATHS narrows a run while working, for example "/" alone.
  for (const path of (process.env.CRAWLER_PATHS ?? '/league,/').split(',')) {
    const { context, page, asked } = await open(
      browser,
      { viewport: { width, height }, deviceScaleFactor: dpr },
      path,
      theme,
    );
    await page.clock.runFor(2600);
    check(asked.length === 0, `${tag} ${path}: nothing asked before the first move`);
    const start = (await freePoint(page, width - 260, 260)) ?? { x: width - 200, y: 260 };
    await page.mouse.move(start.x, start.y);
    const came = await arrived(page);
    check(
      came && asked.length === 1,
      `${tag} ${path}: the chunk arrives on the first move, once`,
      `${asked.length} asked`,
    );
    if (!came) {
      await context.close();
      continue;
    }
    const log = [];
    // Following: the pointer drifts over the open ground of the page head.
    for (let k = 0; k < 24; k += 1) {
      await page.mouse.move(start.x - 120 + k * 6, start.y + Math.sin(k / 4) * 40);
      await run(page, 50, log);
    }
    await run(page, 400, log);
    await shoot(page, `follow-${path === '/' ? 'home' : 'league'}-${width}-${theme}`);
    // Resting: it closes in and taps.
    await run(page, 1500, log);
    await shoot(page, `tap-${path === '/' ? 'home' : 'league'}-${width}-${theme}`);
    await run(page, 1200, log);
    // Reading: the pointer rests on an agent's row.
    const row = await page.evaluate(() => {
      const el = document.querySelector('[data-crawler-row],[data-crawler-rows]>[data-agent]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width * 0.3, y: r.top + r.height / 2, top: r.top };
    });
    if (row) {
      if (row.top > height - 120) {
        await page.mouse.wheel(0, row.top - height / 2);
        await page.clock.runFor(400);
      }
      const rowNow = await page.evaluate(() => {
        const el = document.querySelector('[data-crawler-row],[data-crawler-rows]>[data-agent]');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width * 0.3, y: r.top + r.height / 2 };
      });
      await page.mouse.move(rowNow.x, rowNow.y, { steps: 4 });
      const before = log.length;
      let shot = false;
      for (let t = 0; t < 4000; t += 50) {
        await run(page, 50, log);
        // The shot is taken while its front feet run along the row's edge.
        if (!shot && log.at(-1)?.mode === 'read' && log.filter((s) => s.mode === 'read').length > 8) {
          await shoot(page, `read-${path === '/' ? 'home' : 'league'}-${width}-${theme}`);
          shot = true;
        }
      }
      const reading = log.slice(before).some((s) => s.mode === 'read');
      console.log(`     ${tag} ${path}: read a row ${reading ? 'from its edge' : 'no: it turned to the row'}`);
      if (!reading)
        console.log(`     plans: ${JSON.stringify((await page.evaluate(() => window.__crawler.state())).reads)}`);
      if (!shot) await shoot(page, `read-${path === '/' ? 'home' : 'league'}-${width}-${theme}`);
      // F1 of the first review: the founder's video rests on this moment, on / at 1920 by 1080.
      if (path === '/' && width === 1920) check(reading, `${tag} /: it reads a row of the hero board`);
      // F2 of the first review: within 4 s of the pointer's last move it stands, and the loop stops.
      await run(page, 250, log);
      const still = await page.evaluate(() => window.__crawler.state());
      check(!still.running, `${tag} ${path}: it stands within 4 s of the pointer's last move`, `mode ${still.mode}`);
      await run(page, 1500, log);
    }
    // Still: once settled, no frame for 5 s.
    await run(page, 3000, log);
    const before = await page.evaluate(() => window.__crawler.state());
    await page.clock.runFor(5000);
    const after = await page.evaluate(() => window.__crawler.state());
    check(
      after.drawn === before.drawn && !after.running,
      `${tag} ${path}: 0 frames in 5 s still`,
      `${after.drawn - before.drawn} frames, mode ${after.mode}`,
    );
    // Scurry: a press beside its body sends it away.
    const body = await page.evaluate(() => window.__crawler.state());
    await page.mouse.move(Math.max(4, body.x - 70), body.y + 10);
    await run(page, 100, log);
    await page.mouse.down();
    await page.mouse.up();
    await run(page, 300, log);
    await shoot(page, `scurry-${path === '/' ? 'home' : 'league'}-${width}-${theme}`);
    await run(page, 4500, log);
    verdict(log, `${tag} ${path}`);
    await context.close();
  }
}

/**
 * R20, found on production on 2026-10-15: the reader's first move lands in the header, above `main`
 * (the pointer comes from the address bar or the tabs), and the next ones inside the page. The
 * crawler must come into view within 3 s of the first move inside the page. On the code of D-154 it
 * started at the header's height, above the map, and never came in.
 */
async function entry(browser, width, height, theme) {
  const tag = `${width}x${height} dpr 1 ${theme} /`;
  const { context, page, asked } = await open(browser, { viewport: { width, height } }, '/', theme);
  await page.clock.runFor(2600);
  const head = { x: Math.round(width * 0.47), y: 40 };
  const top = await page.evaluate(() => document.querySelector('main').getBoundingClientRect().top);
  check(head.y < top, `${tag}: the first move lands in the header, above main`, `main's top ${Math.round(top)}`);
  await page.mouse.move(head.x, head.y);
  // The chunk, if the header's move calls it, arrives in real time while the page's clock stands.
  await new Promise((done) => setTimeout(done, 1500));
  const early = asked.length;
  /** Runs in the page: how many of its glyphs lie in the window and inside `main`. */
  const inView = () => {
    const state = window.__crawler?.state();
    if (!state) return -1;
    const main = document.querySelector('main').getBoundingClientRect();
    const x0 = Math.max(0, main.left);
    const x1 = Math.min(document.documentElement.clientWidth, main.right);
    const y0 = Math.max(0, main.top);
    const y1 = Math.min(innerHeight, main.bottom);
    return state.glyphs.filter((g) => g.x < x1 && g.x + g.w > x0 && g.y < y1 && g.y + g.h > y0).length;
  };
  const trail = [];
  let came = Number.NaN;
  for (let k = 0; k < 6 && Number.isNaN(came); k += 1) {
    await page.mouse.move(width - 420 + k * 10, 420 + k * 5, { steps: 4 });
    if (k === 0) await arrived(page);
    for (let t = 0; t < 500; t += 50) {
      await page.clock.runFor(50);
      const seen = await page.evaluate(inView);
      if (seen > 0 && Number.isNaN(came)) came = k * 500 + t + 50;
    }
    const s = await page.evaluate(() => window.__crawler?.state());
    trail.push(s ? `${Math.round(s.x)},${Math.round(s.y)} ${s.mode}` : 'no crawler');
  }
  console.log(
    `     ${tag}: chunk asked ${early} time(s) after the header's move; body after each move inside: ${trail.join(' | ')}`,
  );
  check(
    !Number.isNaN(came),
    `${tag}: first move in the header, then inside the page: it comes into view within 3 s`,
    Number.isNaN(came) ? 'never in view' : `in view after ${came} ms`,
  );
  await shoot(page, `entry-header-${width}-${theme}`);
  await context.close();
}

async function phone(browser, theme) {
  const tag = `390x844 coarse ${theme}`;
  const options = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
  // Desktop only in this version: a coarse pointer never loads it, not even after a tap on empty ground.
  for (const size of [options.viewport, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
    const { context, page, asked } = await open(browser, { ...options, viewport: size }, '/', theme);
    await page.clock.runFor(3000);
    await page.mouse.move(200, 300).catch(() => {});
    const point = (await freePoint(page, size.width - 90, 420)) ?? { x: size.width - 90, y: 420 };
    await page.touchscreen.tap(point.x, point.y);
    await new Promise((done) => setTimeout(done, 600));
    await page.clock.runFor(4000);
    const layer = await page.evaluate(() => document.querySelector('.crawler') !== null);
    check(
      asked.length === 0 && !layer,
      `${size.width}x${size.height} coarse ${theme}: nothing loads, even after a tap on empty ground`,
      `${asked.length} asked`,
    );
    await context.close();
  }
  // A tap on a link is the page's.
  const second = await open(browser, options, '/league', theme);
  const link = await second.page.evaluate(() => {
    const a = document.querySelector('nav.top-tabs a[href="/listed"]');
    const r = a?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (link) {
    await second.page.touchscreen.tap(link.x, link.y);
    await second.page.waitForURL(/\/listed/, { timeout: 15000 }).catch(() => {});
    check(
      new URL(second.page.url()).pathname === '/listed',
      `${tag}: a tap on a link navigates as before`,
      second.page.url(),
    );
    check(second.asked.length === 0, `${tag}: a tap on a link does not call the crawler`);
  }
  await second.context.close();
}

async function never(browser) {
  const options = { viewport: { width: 1440, height: 900 } };
  const cases = [
    { name: 'reduced motion', path: '/league', options: { ...options, reducedMotion: 'reduce' } },
    {
      name: 'Save-Data',
      path: '/league',
      options,
      init: () => Object.defineProperty(Navigator.prototype, 'connection', { get: () => ({ saveData: true }) }),
    },
  ];
  const agent = await (async () => {
    const { context, page } = await open(browser, options, '/league', 'dark');
    const href = await page.evaluate(() => document.querySelector('a[href^="/agents/"]')?.getAttribute('href'));
    await context.close();
    return href ?? '/agents/unknown';
  })();
  for (const path of ['/live', '/live/start', '/account', agent, '/build', '/chat', '/sign-in', '/no-such-page']) {
    cases.push({ name: `off the list: ${path}`, path, options });
  }
  for (const item of cases) {
    const { context, page, asked } = await open(browser, item.options, item.path, 'dark', { init: item.init });
    await page.clock.runFor(2600);
    await page.mouse.move(700, 300);
    await page.mouse.move(760, 340);
    await new Promise((done) => setTimeout(done, 600));
    await page.clock.runFor(1000);
    const there = await page.evaluate(() => ({
      marked: document.querySelector('main[data-crawler]') !== null,
      layer: document.querySelector('.crawler') !== null,
    }));
    check(
      asked.length === 0 && !there.layer,
      `${item.name}: no request for the chunk, no crawler`,
      `${asked.length} asked`,
    );
    if (item.name.startsWith('off')) check(!there.marked, `${item.name}: the page is not marked`);
    await context.close();
  }
  for (const path of ['/', '/league', '/listed', '/methodology', '/token']) {
    const { context, page } = await open(browser, options, path, 'dark');
    const there = await page.evaluate(() => ({
      marked: document.querySelector('main[data-crawler]') !== null,
      credit: document.documentElement.outerHTML.includes('Slava Rybin (@rybinfx)'),
    }));
    check(there.marked, `${path}: the page is marked for the crawler`);
    await context.close();
  }
}

async function measure(browser) {
  const { context, page } = await open(browser, { viewport: { width: 1920, height: 1080 } }, '/league', 'dark', {
    realTime: true,
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.waitForTimeout(2600);
  await page.mouse.move(1500, 260);
  await arrived(page);
  const builds = [];
  for (let k = 0; k < 5; k += 1) builds.push(await page.evaluate(() => window.__crawler.build()));
  console.log(`     a build of the map on /league at 1920x1080: ${builds.map((b) => b.toFixed(2)).join(', ')} ms`);
  for (const rate of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const metric = async () =>
      Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const s0 = await page.evaluate(() => window.__crawler.state());
    const m0 = await metric();
    for (let k = 0; k < 60; k += 1) {
      await page.mouse.move(1300 + Math.cos(k / 6) * 260, 300 + Math.sin(k / 6) * 140);
      await page.waitForTimeout(50);
    }
    const s1 = await page.evaluate(() => window.__crawler.state());
    const m1 = await metric();
    const frames = s1.drawn - s0.drawn;
    console.log(
      `     ${rate}x CPU: ${frames} frames; the crawler's own work ${((s1.work - s0.work) / Math.max(1, frames)).toFixed(3)} ms a frame; ` +
        `script of the page ${(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / Math.max(1, frames)).toFixed(3)} ms a frame; ` +
        `layouts ${m1.LayoutCount - m0.LayoutCount}, style recalculations ${m1.RecalcStyleCount - m0.RecalcStyleCount}`,
    );
    await page.waitForTimeout(2500);
  }
  await context.close();
}

if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  if (budget) {
    await measure(browser);
  } else if (args.includes('--served')) {
    await served();
  } else if (args.includes('--entry')) {
    // R20 alone: the first move in the header, at 1920 by 1080 in dark.
    await entry(browser, 1920, 1080, 'dark');
  } else if (process.env.CRAWLER_SIZE) {
    // One desktop size and theme while working, for example CRAWLER_SIZE=1920x1080x1 CRAWLER_THEME=dark.
    const [w, h, d] = process.env.CRAWLER_SIZE.split('x').map(Number);
    await desktop(browser, w, h, d, process.env.CRAWLER_THEME ?? 'dark');
    await entry(browser, w, h, process.env.CRAWLER_THEME ?? 'dark');
  } else {
    // The operator's pass for the first deploy: 1440 by 900 in both themes and a phone with a coarse
    // pointer; `--wide` adds 1920 by 1080 at a device scale of 2.
    await served();
    await never(browser);
    // 1440 at a device scale of 2 (so its crops are 2x), 1920 at 1, as most such screens are.
    for (const theme of ['dark', 'light']) {
      await desktop(browser, 1920, 1080, 1, theme);
      await desktop(browser, 1440, 900, 2, theme);
      await entry(browser, 1920, 1080, theme);
      await entry(browser, 1440, 900, theme);
    }
    await phone(browser, 'dark');
  }
} finally {
  await browser.close();
}
console.log(failed === 0 ? 'crawler-check: every check passed' : `crawler-check: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
