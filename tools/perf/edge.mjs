// A stand-in for Cloudflare's edge in front of a local `wrangler dev`, for speed measurements.
//
//   node tools/perf/edge.mjs --upstream http://127.0.0.1:8871 --port 8873
//
// Why: `wrangler dev` (miniflare) compresses every text response the Worker answers, as the
// edge would, but it ignores `Cache-Control: no-transform`. Cloudflare does not compress a
// response that carries it, and every page of the site carries it (apps/web/src/middleware.ts),
// so a local measurement through miniflare alone shows compressed HTML that production never
// sent. This proxy restores the production rule:
//
//   - A response that says `no-transform` and that the Worker did not encode itself is sent as
//     the Worker wrote it: the proxy gunzips what miniflare compressed. The site Worker marks
//     what it compresses itself with `Vary: Accept-Encoding` (middleware.ts adds it exactly
//     when it handles a text response), and such a response passes through unchanged.
//   - Everything else (built files, fonts) passes through as miniflare sent it.
//
// It forwards GET and HEAD only and answers 405 to anything else. Stop it with Ctrl+C.

import http from 'node:http';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip } from 'node:zlib';
import { cli, parseArgs, UsageError } from './lib.mjs';

async function main() {
  const { options } = parseArgs(process.argv.slice(2), { upstream: '', port: 8873 });
  if (!options.upstream)
    throw new UsageError('Usage: node tools/perf/edge.mjs --upstream http://127.0.0.1:8871 [--port 8873]');
  const upstream = new URL(options.upstream);
  const port = Number(options.port);

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const headers = { ...req.headers, host: upstream.host };
    const forward = http.request(
      { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers },
      (answer) => {
        const out = { ...answer.headers };
        const control = String(out['cache-control'] ?? '');
        const vary = String(out.vary ?? '');
        const workerEncoded = /\baccept-encoding\b/i.test(vary);
        const encoding = out['content-encoding'];
        const undo = /\bno-transform\b/i.test(control) && !workerEncoded && (encoding === 'gzip' || encoding === 'br');
        if (undo) {
          delete out['content-encoding'];
          delete out['content-length'];
          res.writeHead(answer.statusCode ?? 502, out);
          pipeline(answer, encoding === 'br' ? createBrotliDecompress() : createGunzip(), res, () => {});
        } else {
          res.writeHead(answer.statusCode ?? 502, out);
          pipeline(answer, res, () => {});
        }
      },
    );
    forward.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`upstream failed: ${error.message}`);
    });
    forward.end();
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`Edge stand-in on http://127.0.0.1:${port}, forwarding to ${upstream.origin}`);
  await new Promise(() => {});
  return 0;
}

cli(main);
