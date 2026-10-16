// Builds the specimen as static pages, because the design folder has no route of its own.
//
//   node apps/web/src/design/specimen/export.mjs            build into .artifacts/specimen/
//   node apps/web/src/design/specimen/export.mjs --serve    build, then serve on http://127.0.0.1:4391
//   node apps/web/src/design/specimen/export.mjs --serve 8600    the same, on a port of your own
//
// Pages: index.html (every primitive), home.html (the home page as the system draws it),
// landing.html, agent.html, agent-stress.html, each in the dark theme; light.html and
// home-light.html are the first two in the light theme; crawler.html and crawler-light.html are the
// home page with the crawler let in (move the pointer over it).
// The pages load their scripts as modules, so open them through --serve, not from the disk.
// Everything this script writes is under a folder named .artifacts, which git ignores.

import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'astro';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../../..');
const repo = resolve(web, '../..');
const root = join(web, '.artifacts', 'specimen-site');
const out = join(repo, '.artifacts', 'specimen');
const pages = join(root, 'src', 'pages');

const views = {
  index: ['primitives', 'dark'],
  light: ['primitives', 'light'],
  home: ['home', 'dark'],
  'home-light': ['home', 'light'],
  crawler: ['crawler', 'dark'],
  'crawler-light': ['crawler', 'light'],
  landing: ['landing', 'dark'],
  agent: ['agent', 'dark'],
  'agent-stress': ['agent-stress', 'dark'],
};
const specimen = relative(pages, join(here, '..', 'Specimen.astro'))
  .split(sep)
  .join('/');

await rm(root, { recursive: true, force: true });
await rm(out, { recursive: true, force: true });
await mkdir(pages, { recursive: true });
for (const [name, [view, theme]] of Object.entries(views)) {
  const source = `---\nimport Specimen from '${specimen}';\n---\n\n<Specimen view="${view}" theme="${theme}" />\n`;
  await writeFile(join(pages, `${name}.astro`), source);
}

await build({
  root,
  configFile: false,
  output: 'static',
  outDir: out,
  site: 'https://prixagent.com',
  build: { format: 'file' },
  logLevel: 'warn',
  vite: {
    // The layout reads the token and the data API through modules that only exist in a Worker.
    // Here they stay outside the bundle; the layout's reads fail, are caught, and leave the
    // footer as it is. Fixture mode keeps the layout from asking an API that is not running.
    define: { __PRIX_FIXTURES__: 'true' },
    build: { rollupOptions: { external: ['cloudflare:workers'] } },
    ssr: { external: ['cloudflare:workers'] },
  },
});

await rm(root, { recursive: true, force: true });
for (const name of Object.keys(views)) console.log(join(out, `${name}.html`));

const serveAt = process.argv.indexOf('--serve');
if (serveAt >= 0) {
  const port = Number.parseInt(process.argv[serveAt + 1] ?? '', 10) || 4391;
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
  };
  // The specimen is a tool for this machine: it listens on the loopback address, not the network.
  createServer((request, response) => {
    // A malformed escape (%E0%A4%A) is an answer of 400, not a server that stops.
    let path;
    try {
      path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    const candidates = [path === '/' ? '/index.html' : path, `${path}.html`];
    // Inside the folder only: `out` itself or a path under it, never a sibling such as specimen-other.
    const inside = (candidate) => candidate === out || candidate.startsWith(out + sep);
    const file = candidates
      .map((candidate) => resolve(out, `.${candidate}`))
      .find((candidate) => inside(candidate) && existsSync(candidate) && extname(candidate) !== '');
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  }).listen(port, '127.0.0.1', () => {
    console.log(
      `Serving the specimen on http://127.0.0.1:${port} (index, /light, /home, /home-light, /landing, /agent, /agent-stress). Stop with Ctrl+C.`,
    );
  });
}
