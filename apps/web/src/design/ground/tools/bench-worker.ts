// Measures the field of characters (ground/field.ts) in workerd, the runtime of the site, the
// way ascii/tools/bench-worker.ts measures the avatars: a Worker cannot time itself, so the
// timing is done from outside, by the requests (bench-client.mjs).
//
//   esbuild apps/web/src/design/ground/tools/bench-worker.ts --bundle --format=esm --outfile=<dir>/worker.js
//   workerd serve <dir>/config.capnp        (one worker, `worker.js` as an ES module, one socket)
//   node apps/web/src/design/ground/tools/bench-client.mjs http://127.0.0.1:<port>
//
//   /noop        nothing: the cost of a request
//   /first       the first request of an isolate that prints the field, as the layout does
//   /kept?n=     n pages' worth of printing the field after the first (a copy of the constant)
//   /build?n=    n builds of the field from nothing (`fieldMarkup()`): what the site would pay
//                if it drew the field at run time instead of reading field.data.ts
// Nothing on the site imports this file.

import { FIELD_MARKUP } from '../field.data.ts';
import { fieldMarkup } from '../field.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get('n') ?? '1000');
    if (url.pathname === '/noop') return new Response('0');
    if (url.pathname === '/first') return new Response(`<div class="ground">${FIELD_MARKUP}</div>`);
    if (url.pathname === '/kept') {
      let length = 0;
      for (let index = 0; index < n; index += 1) length += `<div class="ground">${FIELD_MARKUP}</div>${index}`.length;
      return new Response(String(length));
    }
    if (url.pathname === '/build') {
      let length = 0;
      for (let index = 0; index < n; index += 1) length += fieldMarkup().length;
      return new Response(String(length));
    }
    return new Response('not found', { status: 404 });
  },
};
