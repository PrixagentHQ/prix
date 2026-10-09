// Checks that the site Worker compresses its pages itself (apps/web/src/middleware.ts), GET only.
//
//   node tools/perf/compression.mjs <base-url> [--pages /,/league,/token]
//
// For every page it makes two GET requests with node:http, which never decompresses on its own:
//   1. Accept-Encoding: gzip, deflate, br. The answer must say Content-Encoding: gzip, keep
//      `no-transform` in Cache-Control (it keeps Cloudflare's Web Analytics script out), list
//      Accept-Encoding in Vary, and its body must gunzip to an HTML document.
//   2. Accept-Encoding: identity. The answer must not be encoded.
// It prints the raw and the compressed size of each page.
//
// Against a local build, start `astro preview` first (tools/perf/README.md). Against
// prixagent.com it sends nothing but GET requests.
//
// Exit 0 when every page passes, 1 when one fails, 2 on a usage error or a crash.

import http from 'node:http';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import { cli, int, parseArgs, table, UsageError } from './lib.mjs';

function get(url, acceptEncoding) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      { method: 'GET', headers: { 'Accept-Encoding': acceptEncoding, Accept: 'text/html' }, timeout: 30_000 },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
        );
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error(`timeout on ${url}`)));
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2), { pages: '/,/league,/token,/methodology' });
  if (!positional[0]) throw new UsageError('Usage: node tools/perf/compression.mjs <base-url> [--pages /,/league]');
  const base = positional[0].replace(/\/$/, '');
  const failures = [];
  const rows = [['page', 'status', 'encoding', 'raw', 'gzip', 'saved', 'identity encoding']];
  for (const path of options.pages.split(',')) {
    const url = new URL(base + path);
    const packed = await get(url, 'gzip, deflate, br');
    const plain = await get(url, 'identity');
    const encoding = packed.headers['content-encoding'] ?? '';
    const control = packed.headers['cache-control'] ?? '';
    const vary = packed.headers.vary ?? '';
    let raw = 0;
    if (encoding !== 'gzip') failures.push(`${path}: Content-Encoding is "${encoding}", not gzip`);
    else {
      try {
        const html = gunzipSync(packed.body).toString('utf8');
        raw = Buffer.byteLength(html);
        if (!/^\s*<!doctype html>/i.test(html)) failures.push(`${path}: the gunzipped body is not an HTML document`);
      } catch (error) {
        failures.push(`${path}: the body does not gunzip (${error.message})`);
      }
    }
    if (!/\bno-transform\b/i.test(control)) failures.push(`${path}: Cache-Control "${control}" lost no-transform`);
    if (!/\baccept-encoding\b/i.test(vary)) failures.push(`${path}: Vary "${vary}" does not name Accept-Encoding`);
    if (plain.headers['content-encoding'])
      failures.push(`${path}: an identity request got ${plain.headers['content-encoding']}`);
    if (plain.status !== packed.status)
      failures.push(`${path}: status ${packed.status} with gzip, ${plain.status} without`);
    rows.push([
      path,
      String(packed.status),
      encoding || '(none)',
      `${int(raw || plain.body.length)} B`,
      `${int(packed.body.length)} B`,
      raw ? `${Math.round((1 - packed.body.length / raw) * 100)}%` : '-',
      plain.headers['content-encoding'] ?? '(none)',
    ]);
  }
  console.log(table(rows));
  if (failures.length) {
    for (const failure of failures) console.log(`  ${failure}`);
    console.log(`FAIL ${failures.length} problem(s)`);
    return 1;
  }
  console.log('PASS every page is gzipped by the Worker, keeps no-transform and varies on Accept-Encoding');
  return 0;
}

cli(main);
