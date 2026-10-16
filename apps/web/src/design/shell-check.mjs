// The header's checks of DESIGN.md section 5.2 (R13, R14) and the hero band of R17, on a local sample build.
// usage: node shell-check.mjs <origin> <shots dir>
import { chromium } from '@playwright/test';

const [origin, shots] = process.argv.slice(2);
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('local only');
const widths = [320, 360, 374, 375, 390, 419, 420, 719, 720, 768, 820, 1024, 1440];
const paths = ['/', '/league'];
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`FAIL ${msg}`);
};

const browser = await chromium.launch();
for (const coarse of [false, true]) {
  const context = await browser.newContext({ hasTouch: coarse, isMobile: false });
  for (const path of paths) {
    for (const theme of ['dark', 'light']) {
      for (const width of widths) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${origin}${path}?theme=${theme}`, { waitUntil: 'load' });
        const r = await page.evaluate(() => {
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
          const search = top.querySelector('.top-search');
          const how = top.querySelector('.top-how');
          const hero = document.querySelector('main > .zone--hero');
          const hb = hero?.getBoundingClientRect();
          return {
            sw: d.scrollWidth,
            cw: d.clientWidth,
            overlaps,
            outside,
            lines: lines.size,
            answers,
            search: search ? visible(search) : null,
            how: how ? visible(how) : null,
            home: top.classList.contains('top--home'),
            hero: hb ? [hb.left, hb.right] : null,
            heroBg: hero ? getComputedStyle(hero, '::before').backgroundImage : null,
          };
        });
        const tag = `${coarse ? 'coarse' : 'fine'} ${path} ${theme} ${width}`;
        if (r.sw !== r.cw) fail(`${tag}: scrollWidth ${r.sw} != ${r.cw}`);
        if (r.overlaps.length) fail(`${tag}: overlap ${r.overlaps.join(', ')}`);
        if (r.outside.length) fail(`${tag}: outside ${r.outside.join(', ')}`);
        if (r.lines !== 1) fail(`${tag}: actions on ${r.lines} lines`);
        if (r.answers.length) fail(`${tag}: centre does not answer ${r.answers.join(', ')}`);
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
  await context.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL OK');
process.exit(failed ? 1 : 0);
