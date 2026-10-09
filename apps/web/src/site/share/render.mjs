// Renders the share images of ShareImage.astro to the PNGs that pages name in their head.
//
//   node apps/web/src/site/share/render.mjs --port 8611
//       writes prix-share.png (the site's own image) beside this file
//   node apps/web/src/site/share/render.mjs --port 8611 --samples
//       also writes three sample agent images into .artifacts/share/, for review
//
// Run it again whenever ShareImage.astro, the tokens, the fonts or the strings `share.statement`,
// `share.siteHost`, `common.simulationLabel`,
// `common.notAdviceLabel` or `common.noOrdersLabel` change, and commit the new PNGs. X and Farcaster do not show an SVG, so the image is rasterised here, in a real
// browser with the site's own fonts, and served as a static file.
//
// It builds a throwaway static page, serves it on a local port (8841, or --port <n>), and
// takes a screenshot at 1200 by 630. Everything else it writes is under .artifacts, which git ignores.

import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'astro';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../../..');
const repo = resolve(web, '../..');
const root = join(web, '.artifacts', 'share-site');
const out = join(web, '.artifacts', 'share-built');
const pages = join(root, 'src', 'pages');
const samplesDir = join(repo, '.artifacts', 'share');

const args = process.argv.slice(2);
const withSamples = args.includes('--samples');
const portAt = args.indexOf('--port');
const port = Number.parseInt(args[portAt + 1] ?? '', 10) || 8841;

// Sample agents, for looking at the template only. No page imports this file.
const figures = (rank) => [
  rank,
  { label: 'Return', value: '+6.84%', tone: 'gain' },
  { label: 'Max drawdown', value: '−1.92%' },
  { label: 'Trades', value: '18' },
];
const context = 'Open division. 9 trading days.';
const samples = {
  'sample-leader': {
    name: 'Sample Compounder',
    context,
    figures: figures({ label: 'Rank', value: '1', suffix: 'of 10 ranked agents', first: true }),
  },
  'sample-long-name': {
    name: 'W'.repeat(32),
    context,
    figures: figures({ label: 'Rank', value: '7', suffix: 'of 10 ranked agents' }),
  },
  'sample-unranked': {
    name: 'Sample agent with a long name',
    context,
    figures: [
      { label: 'Rank', value: 'Not ranked yet', words: true },
      { label: 'Return', value: '−0.42%', tone: 'loss' },
      { label: 'Max drawdown', value: '−0.54%' },
      { label: 'Trades', value: '6' },
    ],
  },
};

const component = relative(pages, join(here, '..', 'ShareImage.astro'))
  .split(sep)
  .join('/');
const pageSource = (agent) => `---
import ShareImage from '${component}';
const agent = ${JSON.stringify(agent ?? null)};
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Share image</title>
    <style is:global>
      html,
      body {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <ShareImage agent={agent ?? undefined} />
  </body>
</html>
`;

const targets = {
  'prix-share': join(here, 'prix-share.png'),
};
await rm(root, { recursive: true, force: true });
await rm(out, { recursive: true, force: true });
await mkdir(pages, { recursive: true });
await writeFile(join(pages, 'prix-share.astro'), pageSource(null));
if (withSamples) {
  await mkdir(samplesDir, { recursive: true });
  for (const [name, agent] of Object.entries(samples)) {
    await writeFile(join(pages, `${name}.astro`), pageSource(agent));
    targets[name] = join(samplesDir, `${name}.png`);
  }
}

await build({
  root,
  configFile: false,
  output: 'static',
  outDir: out,
  site: 'https://prixagent.com',
  build: { format: 'file' },
  logLevel: 'warn',
});

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const file = resolve(out, `.${path}`);
  if (!file.startsWith(out) || !existsSync(file) || extname(file) === '') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(port, '127.0.0.1', done));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  for (const [name, target] of Object.entries(targets)) {
    await page.goto(`http://127.0.0.1:${port}/${name}.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Text closer than 48 units to an edge would be cut by some previews.
    const tight = await page.evaluate(() =>
      [...document.querySelectorAll('svg text')]
        .map((node) => ({ text: node.textContent.trim(), box: node.getBoundingClientRect() }))
        .filter(({ box }) => box.left < 48 || box.top < 48 || box.right > 1200 - 48 || box.bottom > 630 - 48)
        .map(
          ({ text, box }) =>
            `"${text}" reaches ${Math.round(box.left)}, ${Math.round(box.top)}, ${Math.round(box.right)}, ${Math.round(box.bottom)}`,
        ),
    );
    await page.screenshot({ path: target, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    console.log(target);
    for (const line of tight) console.log(`  inside the 48 unit margin: ${line}`);
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
}
