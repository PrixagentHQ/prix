// Screenshots of pages in both themes, to check that a speed change left the look as it was.
//
//   node tools/perf/shots.mjs <base-url> <out-dir> [--pages /,/league] [--compare <other-dir>]
//
// Each page is taken at 390 px and 1280 px, dark and light, full page, after the fonts are in
// and the network is quiet, with motion reduced so nothing is caught mid-way. GET only.
// With --compare it reports, per shot, whether the PNG is byte for byte the one in the other
// folder, and exits 1 when one differs (open the two files to see why: a clock on the page also
// makes a difference).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cli, parseArgs, UsageError } from './lib.mjs';

const WIDTHS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    pages: '/,/league,/agents/slowcompound,/token,/methodology,/build,/account?fixture=signed-in-agent',
    compare: '',
  });
  const [baseArg, outArg] = positional;
  if (!baseArg || !outArg)
    throw new UsageError('Usage: node tools/perf/shots.mjs <base-url> <out-dir> [--pages /,/league] [--compare dir]');
  const base = baseArg.replace(/\/$/, '');
  const out = resolve(outArg);
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  const names = [];
  try {
    for (const [profile, viewport] of Object.entries(WIDTHS)) {
      for (const theme of ['dark', 'light']) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        if (theme === 'light') await context.addCookies([{ name: 'prix_theme', value: 'light', url: base }]);
        const page = await context.newPage();
        await page.route('**/*', (route) => {
          const method = route.request().method();
          return method === 'GET' || method === 'HEAD' ? route.continue() : route.abort();
        });
        for (const path of options.pages.split(',')) {
          await page.goto(base + path, { waitUntil: 'networkidle', timeout: 60_000 });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(500);
          const name = `${profile}-${theme}-${path.replace(/[^a-z0-9]+/gi, '_') || 'home'}.png`;
          await writeFile(join(out, name), await page.screenshot({ fullPage: true, animations: 'disabled' }));
          names.push(name);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${names.length} screenshots to ${out}`);
  if (!options.compare) return 0;
  let differ = 0;
  for (const name of names) {
    let same = false;
    try {
      same = (await readFile(join(out, name))).equals(await readFile(join(resolve(options.compare), name)));
    } catch {
      same = false;
    }
    if (!same) differ += 1;
    console.log(`${same ? 'same   ' : 'DIFFERS'} ${name}`);
  }
  console.log(
    differ
      ? `FAIL ${differ} of ${names.length} screenshots differ`
      : `PASS all ${names.length} screenshots are identical`,
  );
  return differ ? 1 : 0;
}

cli(main);
