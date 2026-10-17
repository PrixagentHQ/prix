// The header's checks of DESIGN.md section 5.2 (R13, R14, R22, R23) and the hero band of R17, on a local sample build.
// usage: node shell-check.mjs <origin> <shots dir>
import { chromium } from '@playwright/test';

const [origin, shots] = process.argv.slice(2);
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('local only');
const widths = [320, 360, 374, 375, 390, 419, 420, 719, 720, 768, 820, 1024, 1440];
const paths = ['/', '/league'];
/** R23: on /league, every eighth pixel from 720 to 904, and three desktop widths. */
const bandWidths = [...Array.from({ length: 24 }, (_, i) => 720 + i * 8), 1024, 1440, 1920];
let failed = 0;
let cases = 0;
const fail = (msg) => {
  failed++;
  console.log(`FAIL ${msg}`);
};

/** R22: the address of the Prix Community group on Telegram, exactly (content/facts.ts, `links.telegram`). */
const TELEGRAM = 'https://t.me/+Ic9RKLzDMiE1NGFl';

/** R23: the icon links the header shows at a width, by host, in order. */
const wantIcons = (width) =>
  width >= 840 ? 'x.com github.com t.me' : width >= 720 ? 'x.com t.me' : width >= 375 ? 'x.com' : '';

/**
 * R22, R23, section 5.2: the header's icon links are X, GitHub and Telegram, in this order in the
 * document and side by side; Telegram opens in the same tab with `noopener noreferrer`. The ones
 * shown are exactly X, GitHub and Telegram from 840, X and Telegram from 720 to 839, X alone from
 * 375 to 719 and none under 375; those shown share one box, one glyph size and one row, 8 apart.
 */
function iconFaults(icons, width) {
  const found = [];
  const host = (i) => new URL(i.href).host;
  const hosts = icons.map(host);
  if (hosts.join(' ') !== 'x.com github.com t.me') found.push(`icon links ${hosts.join(', ')}`);
  const [, gh, tg] = icons;
  if (!tg) return found;
  if (tg.href !== TELEGRAM) found.push(`Telegram's address ${tg.href}`);
  if (tg.rel !== 'noopener noreferrer') found.push(`Telegram's rel ${tg.rel}`);
  if (icons.some((i) => i.target !== null)) found.push('an icon link opens another tab');
  if (!gh.next) found.push('Telegram does not follow GitHub');
  const shown = icons.filter((i) => i.shown);
  const got = shown.map(host).join(' ');
  if (got !== wantIcons(width)) found.push(`icons shown [${got}], want [${wantIcons(width)}]`);
  for (let k = 1; k < shown.length; k++) {
    const [a, b] = [shown[k - 1], shown[k]];
    if (a.w !== b.w || a.h !== b.h) found.push(`icon boxes ${a.w}x${a.h}, ${b.w}x${b.h}`);
    if (a.glyph !== b.glyph) found.push(`glyphs ${a.glyph}, ${b.glyph}`);
    if (a.mid !== b.mid) found.push(`icon rows ${a.mid}, ${b.mid}`);
    if (Math.abs(b.l - a.r - 8) > 0.5) found.push(`icons ${host(a)} and ${host(b)} ${b.l - a.r} apart`);
  }
  return found;
}

/** Read in the page: the header's controls, its icon links and its search field. */
function readHeader() {
  const d = document.documentElement;
  const top = document.querySelector('header.top');
  const visible = (e) => {
    const s = getComputedStyle(e);
    const b = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  const controls = [
    ...top.querySelectorAll('.top-bar > .wordmark, .top-acts > a, .top-acts > button, .top-acts > form button'),
  ].filter(visible);
  const boxes = controls.map((e) => {
    const b = e.getBoundingClientRect();
    return {
      name: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24),
      l: b.left,
      r: b.right,
      t: b.top,
      b: b.bottom,
    };
  });
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const c = boxes[j];
      if (a.l < c.r - 0.5 && c.l < a.r - 0.5 && a.t < c.b - 0.5 && c.t < a.b - 0.5)
        overlaps.push(`${a.name}/${c.name}`);
    }
  const outside = boxes.filter((b) => b.l < 0 || b.r > d.clientWidth + 0.5).map((b) => b.name);
  const acts = boxes.filter((b) => b.name !== 'Prix, home');
  const lines = new Set(acts.map((b) => Math.round((b.t + b.b) / 2)));
  const answers = controls
    .filter((e) => {
      const b = e.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !(hit && (hit === e || e.contains(hit)));
    })
    .map((e) => (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24));
  // R22: the icon links, X, GitHub and Telegram, in this order and one after the other.
  const icons = [...top.querySelectorAll('.top-acts > a.top-x')].map((e) => {
    const b = e.getBoundingClientRect();
    return {
      href: e.getAttribute('href'),
      rel: e.getAttribute('rel'),
      target: e.getAttribute('target'),
      shown: visible(e),
      next: e.nextElementSibling?.classList.contains('top-x') ?? false,
      w: Math.round(b.width * 10) / 10,
      h: Math.round(b.height * 10) / 10,
      l: Math.round(b.left * 10) / 10,
      r: Math.round(b.right * 10) / 10,
      mid: Math.round(b.top + b.height / 2),
      glyph: (() => {
        const g = e.querySelector('svg')?.getBoundingClientRect();
        return g ? `${Math.round(g.width)}x${Math.round(g.height)}` : null;
      })(),
    };
  });
  const search = top.querySelector('.top-search');
  const input = search?.querySelector('input');
  const how = top.querySelector('.top-how');
  const hero = document.querySelector('main > .zone--hero');
  const hb = hero?.getBoundingClientRect();
  return {
    icons,
    sw: d.scrollWidth,
    cw: d.clientWidth,
    overlaps,
    outside,
    lines: lines.size,
    answers,
    search: search ? visible(search) : null,
    input: input && visible(input) ? Math.round(input.getBoundingClientRect().width * 10) / 10 : null,
    how: how ? visible(how) : null,
    home: top.classList.contains('top--home'),
    hero: hb ? [hb.left, hb.right] : null,
    heroBg: hero ? getComputedStyle(hero, '::before').backgroundImage : null,
  };
}

/**
 * R23: the search input's width with exactly two icons, X and Telegram, at this width. It runs in a
 * second tab of its own, where GitHub is set aside and X and Telegram are shown for good, so the
 * tab that is checked is never touched.
 */
function inputWithTwoIcons() {
  const top = document.querySelector('header.top');
  const [x, gh, tg] = top.querySelectorAll('.top-acts > a.top-x');
  x.style.display = 'inline-grid';
  gh.style.display = 'none';
  tg.style.display = 'inline-grid';
  return Math.round(top.querySelector('.top-search input').getBoundingClientRect().width * 10) / 10;
}

/** The faults every case of the header shares. */
function shellFaults(r, width) {
  const found = iconFaults(r.icons, width);
  if (r.sw !== r.cw) found.push(`scrollWidth ${r.sw} != ${r.cw}`);
  if (r.overlaps.length) found.push(`overlap ${r.overlaps.join(', ')}`);
  if (r.outside.length) found.push(`outside ${r.outside.join(', ')}`);
  if (r.lines !== 1) found.push(`actions on ${r.lines} lines`);
  if (r.answers.length) found.push(`centre does not answer ${r.answers.join(', ')}`);
  return found;
}

const browser = await chromium.launch();
for (const coarse of [false, true]) {
  const context = await browser.newContext({ hasTouch: coarse, isMobile: false });
  for (const path of paths) {
    for (const theme of ['dark', 'light']) {
      for (const width of widths) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${origin}${path}?theme=${theme}`, { waitUntil: 'load' });
        const r = await page.evaluate(readHeader);
        const tag = `${coarse ? 'coarse' : 'fine'} ${path} ${theme} ${width}`;
        cases++;
        for (const msg of shellFaults(r, width)) fail(`${tag}: ${msg}`);
        if (r.hero && (Math.abs(r.hero[0]) > 0.5 || Math.abs(r.hero[1] - r.cw) > 0.5))
          fail(`${tag}: hero ${r.hero} not edge to edge`);
        if (r.heroBg?.includes('radial')) fail(`${tag}: hero light is radial`);
        if (r.home && r.how) fail(`${tag}: home header shows How it works`);
        if (r.home && width < 720 && r.search) fail(`${tag}: home header shows search under 720`);
        if (!r.home && width < 720 && !r.search) fail(`${tag}: header search missing`);
        if (shots && !coarse && path === '/' && [360, 390, 768].includes(width))
          await page.screenshot({ path: `${shots}/home-${theme}-${width}.png` });
        await page.close();
      }
    }
  }

  // R23 (TG-D1): on /league, where "How it works" stands in the row, from 720 to 839 the header
  // shows X and Telegram only, so the search input is exactly as wide as with two icons; from 720
  // it is at least 46 wide under a fine pointer, and it never narrows as the window widens inside
  // a band (720 to 839, then from 840 with GitHub back); from 840 it is never narrower than the
  // two-icon input at 720.
  const page = await context.newPage();
  await page.goto(`${origin}/league?theme=dark`, { waitUntil: 'load' });
  const twoTab = await context.newPage();
  await twoTab.goto(`${origin}/league?theme=dark`, { waitUntil: 'load' });
  const pointer = coarse ? 'coarse' : 'fine';
  let floor = null;
  let last = null;
  for (const width of bandWidths) {
    await page.setViewportSize({ width, height: 800 });
    await twoTab.setViewportSize({ width, height: 800 });
    const r = await page.evaluate(readHeader);
    const two = await twoTab.evaluate(inputWithTwoIcons);
    const tag = `${pointer} /league band ${width}`;
    cases++;
    for (const msg of shellFaults(r, width)) fail(`${tag}: ${msg}`);
    if (r.input === null) {
      fail(`${tag}: header search input not shown`);
      continue;
    }
    if (width === 720) floor = two;
    if (!coarse && width === 720 && r.input < 46) fail(`${tag}: search input ${r.input} wide, under 46`);
    if (width < 840 && r.input < two - 0.5) fail(`${tag}: search input ${r.input} wide, ${two} with two icons`);
    if (width >= 840 && floor !== null && r.input < floor - 0.5)
      fail(`${tag}: search input ${r.input} wide, under ${floor} (two icons at 720)`);
    const sameBand = last && last.width >= 840 === width >= 840;
    if (sameBand && r.input < last.input - 0.5)
      fail(`${tag}: search input ${r.input} wide, ${last.input} at ${last.width}`);
    last = { width, input: r.input };
    if (shots && !coarse && [720, 768, 800, 832, 840].includes(width))
      await page.screenshot({ path: `${shots}/league-header-${width}.png`, clip: { x: 0, y: 0, width, height: 72 } });
  }
  await page.close();
  await twoTab.close();
  await context.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED of ${cases} cases` : `ALL OK, ${cases} cases`);
process.exit(failed ? 1 : 0);
