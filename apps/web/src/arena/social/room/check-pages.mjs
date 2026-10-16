// Looks at /chat of a SAMPLE build (PRIX_FIXTURES=1) in every state of ./fixtures.ts and says whether
// the page keeps the rules of docs/contracts/phase-6-room.md sections 9 and 13 that no type check sees.
// Read-only: it only GETs pages of the origin it is given, and it refuses any origin that is not local.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4391 --host 127.0.0.1
//   node apps/web/src/arena/social/room/check-pages.mjs http://127.0.0.1:4391 [directory for screenshots]
//
// It prints one line for each check and exits 1 when one fails. The checks:
//   - the status of the page in each state (200, 404 while the room is off, 500 and 503 when a read fails);
//   - `noindex` and `format-detection: telephone=no` in the head;
//   - a message is text: the markup state's tags arrive escaped, none becomes an element, a script or a
//     link, nothing of a message stands in an attribute, a script element or a JSON island, and the
//     script of a message does not run;
//   - the order of the page: title, disclaimer, the mark's sentence, the note on the token, the composer,
//     "Load new messages", the messages;
//   - the admin's mark is an element of its own with the drawn mark in it, on admin messages only;
//   - the entry "Chat" of the Social navigation is there only while the room is on, and is whole in its
//     row on its own page down to 340 pixels;
//   - an empty room asks a visitor to sign in only when no session was confirmed;
//   - nothing of the room on a page while it is off, and no request of the page that repeats by itself;
//   - no sideways scroll at 360, 390 and 1440 pixels, in both themes, in every state.
//
// Pictures (docs/contracts/phase-6-pictures.md, sections 11 and 17):
//   - before a click the page holds no <img> in the list and no address of a picture, and asks for none:
//     50 picture messages ask for 0 pictures, also three seconds later;
//   - the list has its name in every state the read answered, an empty room included, and says whether
//     pictures are on only while the read carries that;
//   - the contract's sentence about pictures stands under the room's own, in body size, only then;
//   - a picture message never shows its text, and each state has its row: the note, the facts and a button
//     while a picture may be shown; the facts and a sentence while pictures are off or resting; one
//     sentence for a reported picture and for one that is gone;
//   - "Show picture" asks for one picture, at the address of the message's id, with no referrer; the
//     <img> has the server's width and height as attributes, the contract's words in its place, and is no
//     link; the button does not move, the box is kept before the first byte arrives and nothing moves
//     when the picture does; "Hide picture" takes the element out again;
//   - a load that failed says so, and nothing asks again;
//   - "Report" is shown only in a row whose picture is shown, under a list that carries the account's mark;
//   - no sideways scroll with every picture open, the widest and the tallest among them.
// What the reviews of the first round ordered (the contract's revision 6, section 11):
//   - a shown picture has a hairline edge that is not the colour of its ground, and square corners, in
//     both themes;
//   - no admin's mark stands on a row that carries a picture, and a row of one sentence has no rule at
//     its left;
//   - the sides are printed grouped, and the smallest file does not read as its bytes;
//   - each "Show picture" is described by the writer and the time of its own row, by ids that stand once;
//   - while pictures rest, the long sentence stands once, between the heading and the list, in ink, and
//     every picture row keeps a shorter one;
//   - from 45em the button stands beside the note and the facts and adds no line to the row; below, under
//     them; at 720 and 800 pixels nothing leaves the page with every picture open and "Report" shown;
//   - a load that failed does not grow its row, at any width;
//   - the place of a report's question: written into the row's note with its two buttons by the contract's
//     names, it stays in the row's column, moves neither button of the row, and leaves the row as it was
//     when it is emptied again.
// A sample build has no bytes route: this script answers the address of a picture itself, with a PNG of
// the row's own width and height that it draws (a board of two greys). No file of anyone is involved.
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';
// The contract's own file for a browser script: it imports nothing, so Node reads it as it is.
import {
  ROOM_PICTURE_ALT,
  ROOM_PICTURE_DOM,
  ROOM_PICTURES_PATH,
  roomPicturePath,
} from '../../../../../../packages/contracts/src/room-picture.ts';

const origin = process.argv[2];
const shots = process.argv[3] ?? null;
if (!origin) throw new Error('usage: node check-pages.mjs <origin of a sample build> [directory for screenshots]');
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('This check reads a local sample build only.');
}

const STATES = [
  { name: 'default', fixture: 'signed-out', status: 200, messages: 10 },
  { name: 'signed-in', fixture: 'signed-in', status: 200, messages: 10 },
  { name: 'empty', fixture: 'signed-out,social-room-empty', status: 200, messages: 0 },
  { name: 'full', fixture: 'signed-out,social-room-full', status: 200, messages: 50 },
  { name: 'admin', fixture: 'signed-out,social-room-admin', status: 200, messages: 4 },
  { name: 'longest', fixture: 'signed-in,social-room-longest', status: 200, messages: 4 },
  { name: 'no-token', fixture: 'signed-out,social-room-no-token', status: 200, messages: 10 },
  { name: 'markup', fixture: 'signed-out,social-room-markup', status: 200, messages: 7 },
  { name: 'error', fixture: 'signed-out,social-room-error', status: 500, messages: 0 },
  { name: 'room-off', fixture: 'signed-out,social-room-off', status: 404, messages: 0 },
  { name: 'social-off', fixture: 'signed-out,social-off', status: 404, messages: 0 },
  { name: 'social-error', fixture: 'signed-out,social-error', status: 503, messages: 0 },
  // The read with pictures. `pictures` is what the list must say; `offered` is how many rows have the button.
  {
    name: 'pictures',
    fixture: 'signed-out,social-room-pictures',
    status: 200,
    messages: 13,
    pictures: 'on',
    offered: 6,
  },
  {
    name: 'pictures-signed-in',
    fixture: 'signed-in,social-room-pictures',
    status: 200,
    messages: 13,
    pictures: 'on',
    offered: 6,
  },
  {
    name: 'pictures-off',
    fixture: 'signed-out,social-room-pictures-off',
    status: 200,
    messages: 13,
    pictures: 'off',
    offered: 0,
  },
  {
    name: 'pictures-resting',
    fixture: 'signed-out,social-room-pictures-resting',
    status: 200,
    messages: 13,
    pictures: 'resting',
    offered: 0,
  },
  {
    name: 'pictures-full',
    fixture: 'signed-out,social-room-pictures-full',
    status: 200,
    messages: 50,
    pictures: 'on',
    offered: 50,
  },
  {
    name: 'pictures-empty',
    fixture: 'signed-out,social-room-pictures-empty',
    status: 200,
    messages: 0,
    pictures: 'on',
    offered: 0,
  },
];
/** The sample's picture messages in the three states that hold one of every kind: 6 shown, 1 reported, 2 gone. */
const SAMPLE = { pictures: 9, shown: 6, reported: 1, gone: 2 };

/**
 * A sentence of the contract's own, read from the file that holds it (that file imports zod, so this
 * script cannot load it): the page shows these as they stand, and this script types none of them.
 */
const CONTRACT = readFileSync(
  new URL('../../../../../../packages/contracts/src/phase6-room-pictures.ts', import.meta.url),
  'utf8',
);
function contractText(name) {
  const found = new RegExp(`export const ${name} =\\s*'([^']*)';`).exec(CONTRACT);
  if (!found) throw new Error(`${name} is not a plain sentence in the contract's file`);
  return found[1];
}
const PICTURE_DISCLAIMER = contractText('ROOM_PICTURE_DISCLAIMER');
const PICTURE_ROW_NOTE = contractText('ROOM_PICTURE_ROW_NOTE');
/** The text a picture message carries, which no page shows. */
const PICTURE_TEXT = contractText('ROOM_PICTURE_TEXT');
const WIDTHS = [360, 390, 1440];
/** Phones narrower than the three widths above, for the row of Social pages only. */
const NARROW = [340, 350];
const THEMES = ['dark', 'light'];

let failed = 0;
function check(ok, what, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

const urlOf = (path, fixture, theme) => `${origin}${path}?fixture=${encodeURIComponent(fixture)}&theme=${theme}`;

// --- the pictures this script answers with ---------------------------------------------------------

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

const drawn = new Map();
/** A PNG of `width` by `height`: a board of two greys, so a picture drawn at a wrong size or cut is seen. */
function png(width, height) {
  const key = `${width}x${height}`;
  if (drawn.has(key)) return drawn.get(key);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const from = y * (width + 1) + 1;
    for (let x = 0; x < width; x += 1) raw[from + x] = ((x >> 5) + (y >> 5)) % 2 === 0 ? 0x5c : 0x8a;
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // eight bits a sample, greyscale
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', head),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  drawn.set(key, file);
  return file;
}

const PICTURE_ROUTE = `**${ROOM_PICTURES_PATH}/**`;
const isPicture = (url) => new URL(url).pathname.startsWith(`${ROOM_PICTURES_PATH}/`);

/**
 * Answers every request for a picture in `context` as the bytes route would: with a picture of the
 * row's own width and height, which `sizes` holds by id (filled from the page by `sizesOf`). `how` lets a
 * check hold the answer back (`gate`, a promise) or refuse it (`fail`, a set of ids answered 404).
 */
async function answerPictures(context, sizes, how = {}) {
  await context.route(PICTURE_ROUTE, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    if (how.gate) await how.gate;
    const size = sizes.get(id);
    if (!size || how.fail?.has(id)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: png(size.width, size.height) });
  });
}

/** The id, width and height of every row that offers a picture, as the server wrote them. */
async function sizesOf(page, sizes) {
  const rows = await page.evaluate(
    (name) =>
      [...document.querySelectorAll(`[${name}]`)].flatMap((row) => {
        const frame = row.querySelector('[data-room-picture-frame]');
        return frame
          ? [{ id: row.getAttribute(name), width: Number(frame.dataset.width), height: Number(frame.dataset.height) }]
          : [];
      }),
    ROOM_PICTURE_DOM.id,
  );
  for (const row of rows) sizes.set(row.id, { width: row.width, height: row.height });
  return rows;
}

/** Resolves when every picture in the page has arrived and is drawn. */
const picturesDrawn = (page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll('.room-picture-image')].every((image) => image.complete && image.naturalWidth > 0),
  );

if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  // --- the served HTML, before any script ----------------------------------------------------------
  for (const state of STATES) {
    const response = await fetch(urlOf('/chat', state.fixture, 'dark'));
    const html = await response.text();
    check(response.status === state.status, `${state.name}: status ${state.status}`, `got ${response.status}`);
    if (state.status !== 200) {
      // Nothing of the room: no message, no composer, no disclaimer, no note on the token.
      check(
        !/class="[^"]*room-(?:item|terms|list|write|mark)/.test(html),
        `${state.name}: nothing of the room is rendered`,
      );
      continue;
    }
    check(/<meta name="robots" content="noindex"/.test(html), `${state.name}: noindex`);
    check(/<meta name="format-detection" content="telephone=no"/.test(html), `${state.name}: format-detection`);
    check(
      (html.match(/class="room-item/g) ?? []).length === state.messages,
      `${state.name}: ${state.messages} messages`,
    );

    // The list has its name whenever the read answered, and says whether pictures are on only while
    // the read carries that.
    const list = html.match(new RegExp(`<ol[^>]*\\s${ROOM_PICTURE_DOM.list}(?=[\\s>])[^>]*>`, 'g')) ?? [];
    check(list.length === 1, `${state.name}: the list carries ${ROOM_PICTURE_DOM.list}, once`, `${list.length}`);
    const said = new RegExp(`\\s${ROOM_PICTURE_DOM.state}="([^"]*)"`).exec(list[0] ?? '')?.[1] ?? null;
    check(
      said === (state.pictures ?? null),
      `${state.name}: the list says pictures ${state.pictures ?? 'nothing'}`,
      `${said}`,
    );
    check(
      new RegExp(`\\s${ROOM_PICTURE_DOM.list}=`).test(list[0] ?? '') === false,
      `${state.name}: ${ROOM_PICTURE_DOM.list} has no value`,
    );
    check(
      /\shidden(?=[\s>])/.test(list[0] ?? '') === (state.messages === 0),
      `${state.name}: the list is hidden only while it is empty`,
    );
    // Before any click: no picture and no address of one in what the server sent.
    const body = html.slice(html.indexOf('<main'));
    check(!/<img\b/i.test(body), `${state.name}: the page holds no <img>`);
    check(!html.includes(ROOM_PICTURES_PATH), `${state.name}: the page holds no address of a picture`);
    check(
      (html.match(/data-room-picture-toggle/g) ?? []).length === (state.offered ?? 0),
      `${state.name}: ${state.offered ?? 0} rows offer a picture`,
    );
    // The script of pictures is shipped only when a row offers one.
    check(
      /<script[^>]+src="[^"]*PictureScript[^"]*"/.test(html) === (state.offered ?? 0) > 0,
      `${state.name}: the script of pictures is ${(state.offered ?? 0) > 0 ? 'on the page' : 'left out'}`,
    );
  }

  const markup = await (await fetch(urlOf('/chat', 'signed-out,social-room-markup', 'dark'))).text();
  check(markup.includes('&lt;script&gt;document.title'), 'markup: a script tag of a message arrives escaped');
  check(!markup.includes('<script>document.title'), 'markup: no script element holds a message');
  check(!/<img[^>]+onerror/i.test(markup), 'markup: no element is made of a message');
  check(!/<h1[^>]*>Prix<\/h1>/.test(markup), 'markup: a message closes no element of the page');
  check(!/href="[^"]*prixagent\.example/.test(markup), 'markup: no link is made of anything in a message');
  check(!/<a[^>]*>[^<]*prixagent\.example/.test(markup), 'markup: a host in a message is not a link');
  check(markup.includes('&amp;lt;escaped once already&amp;gt;'), 'markup: text escaped once is escaped again');

  // --- the page in a browser -----------------------------------------------------------------------
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      // The site keeps its theme in a cookie and renders it on the server; the 404 a closed room
      // answers is a rewrite, which carries no `?theme=`.
      await context.addCookies([{ name: 'prix_theme', value: theme, url: origin }]);
      const sizes = new Map();
      const how = { gate: null, fail: new Set() };
      await answerPictures(context, sizes, how);
      const page = await context.newPage();
      for (const state of STATES) {
        const requests = [];
        page.removeAllListeners('request');
        page.on('request', (request) => requests.push(request.url()));
        await page.goto(urlOf('/chat', state.fixture, theme), { waitUntil: 'networkidle' });
        const facts = await page.evaluate(() => {
          const doc = document.documentElement;
          let widest = null;
          for (const element of document.querySelectorAll('body *')) {
            const box = element.getBoundingClientRect();
            if (box.width > 0 && box.right > doc.clientWidth + 0.5 && (!widest || box.right > widest.right)) {
              widest = {
                right: Math.round(box.right),
                tag: element.tagName.toLowerCase(),
                cls: String(element.className),
              };
            }
          }
          return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, widest, theme: doc.dataset.theme };
        });
        const where = `${theme} ${width} ${state.name}`;
        check(facts.theme === theme, `${where}: the page is in the ${theme} theme`);
        check(
          facts.scrollWidth <= facts.clientWidth,
          `${where}: no sideways scroll`,
          `document ${facts.scrollWidth} of ${facts.clientWidth}${facts.widest ? `, widest <${facts.widest.tag} class="${facts.widest.cls}"> to ${facts.widest.right}` : ''}`,
        );
        if (shots) await page.screenshot({ path: `${shots}/chat-${state.name}-${theme}-${width}.png`, fullPage: true });
        check(
          requests.filter(isPicture).length === 0,
          `${where}: ${state.offered ?? 0} rows offer a picture and the page asks for 0`,
          `${requests.filter(isPicture).length} asked`,
        );

        if (state.name === 'pictures') {
          // Every picture open at once, the widest and the tallest among them: each stays in its
          // column, is at most twenty lines high, keeps its proportion, and the page does not scroll
          // sideways.
          await sizesOf(page, sizes);
          for (const toggle of await page.locator('[data-room-picture-toggle]').all()) await toggle.click();
          await picturesDrawn(page);
          const open = await page.evaluate(() => {
            const doc = document.documentElement;
            const line = Number.parseFloat(getComputedStyle(doc).fontSize);
            return {
              scrollWidth: doc.scrollWidth,
              clientWidth: doc.clientWidth,
              highest: 20 * line,
              pictures: [...document.querySelectorAll('.room-picture-image')].map((image) => {
                const box = image.getBoundingClientRect();
                const column = image.closest('.room-picture').getBoundingClientRect();
                const style = getComputedStyle(image);
                // What the picture stands on: the first ground behind it that is not clear.
                let ground = 'rgba(0, 0, 0, 0)';
                for (let under = image.parentElement; under && ground === 'rgba(0, 0, 0, 0)'; ) {
                  ground = getComputedStyle(under).backgroundColor;
                  under = under.parentElement;
                }
                return {
                  width: box.width,
                  height: box.height,
                  natural: image.naturalWidth / image.naturalHeight,
                  wide: image.naturalWidth,
                  inside: box.left >= column.left - 0.5 && box.right <= column.right + 0.5,
                  edge: {
                    style: style.outlineStyle,
                    width: Number.parseFloat(style.outlineWidth),
                    offset: Number.parseFloat(style.outlineOffset),
                    colour: style.outlineColor,
                    ground,
                    corners: [
                      style.borderTopLeftRadius,
                      style.borderTopRightRadius,
                      style.borderBottomRightRadius,
                      style.borderBottomLeftRadius,
                    ].join(' '),
                  },
                };
              }),
            };
          });
          check(
            open.pictures.length === state.offered,
            `${where}: every offered picture is open`,
            `${open.pictures.length}`,
          );
          check(
            open.scrollWidth <= open.clientWidth,
            `${where}: no sideways scroll with every picture open`,
            `document ${open.scrollWidth} of ${open.clientWidth}`,
          );
          check(
            open.pictures.every((picture) => picture.inside && picture.height <= open.highest + 0.5),
            `${where}: every picture stays in its column and is at most twenty lines high`,
            open.pictures.map((picture) => `${Math.round(picture.width)}x${Math.round(picture.height)}`).join(' '),
          );
          check(
            open.pictures.every((picture) => Math.abs(picture.width / picture.height - picture.natural) < 0.02),
            `${where}: the box of every picture has the picture's own proportion`,
          );
          check(
            open.pictures.every((picture) => picture.width <= picture.wide + 0.5),
            `${where}: no picture is drawn larger than it is`,
          );
          // The edge is drawn inside the picture's own box (the proportion above is still the picture's),
          // and is seen against whatever the picture stands on, in this theme.
          check(
            open.pictures.every(
              ({ edge }) =>
                edge.style === 'solid' &&
                edge.width > 0 &&
                edge.offset === -edge.width &&
                edge.colour !== edge.ground &&
                edge.colour !== 'rgba(0, 0, 0, 0)',
            ),
            `${where}: every shown picture has a hairline edge that is not the colour of its ground`,
            JSON.stringify(open.pictures[0]?.edge),
          );
          check(
            open.pictures.every(({ edge }) => edge.corners === '0px 0px 0px 0px'),
            `${where}: every shown picture has square corners`,
            open.pictures[0]?.edge.corners,
          );
          if (shots) {
            await page.screenshot({ path: `${shots}/chat-pictures-open-${theme}-${width}.png`, fullPage: true });
          }

          // The closed rows again, as the server rendered them: where the button stands, and how high a
          // row is. From 45em a message is a row of a ledger and the button stands beside the note and
          // the facts; below, under them.
          await page.goto(urlOf('/chat', state.fixture, theme), { waitUntil: 'networkidle' });
          const laid = await page.evaluate((names) => {
            const list = document.querySelector(`[${names.list}]`);
            const box = (element) => {
              const rect = element.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
            };
            return {
              wide: matchMedia('(min-width: 45em)').matches,
              text: box(list.querySelector(`li:not([${names.id}])`)).height,
              rows: [...list.querySelectorAll(`li[${names.id}]`)]
                .filter((row) => row.querySelector('[data-room-picture-toggle]'))
                .map((row) => ({
                  row: box(row),
                  block: box(row.querySelector('.room-picture')),
                  about: box(row.querySelector('.room-picture-about')),
                  toggle: box(row.querySelector('[data-room-picture-toggle]')),
                })),
            };
          }, ROOM_PICTURE_DOM);
          if (laid.wide) {
            check(
              laid.rows.every(
                ({ about, toggle }) =>
                  toggle.left >= about.right - 0.5 && toggle.top < about.bottom && toggle.bottom > about.top,
              ),
              `${where}: the button stands beside the note and the facts`,
            );
            check(
              laid.rows.every(
                ({ block, about, toggle }) => block.height <= Math.max(about.height, toggle.height) + 0.5,
              ),
              `${where}: the button adds no line to a closed picture's row`,
              laid.rows
                .map(({ block, about }) => `${Math.round(block.height)} of ${Math.round(about.height)}`)
                .join(' '),
            );
            check(
              laid.rows.every(({ row }) => row.height <= 2 * laid.text),
              `${where}: a closed picture's row is at most as tall as two rows of text`,
              `${laid.rows.map(({ row }) => Math.round(row.height)).join(' ')} beside ${Math.round(laid.text)}`,
            );
          } else {
            check(
              laid.rows.every(({ about, toggle }) => toggle.top >= about.bottom - 0.5),
              `${where}: the button stands under the note and the facts`,
            );
          }

          // A load that failed puts a sentence where the button was: the row is no taller for it.
          const failing = page
            .locator(`li[${ROOM_PICTURE_DOM.id}]`)
            .filter({ has: page.locator('[data-room-picture-toggle]') })
            .nth(1);
          const failingId = await failing.getAttribute(ROOM_PICTURE_DOM.id);
          how.fail.add(failingId);
          const high = () => failing.evaluate((row) => Math.round(row.getBoundingClientRect().height * 10) / 10);
          const highBefore = await high();
          await failing.locator('[data-room-picture-toggle]').click();
          await failing.locator('[data-room-picture-failed]').waitFor({ state: 'visible' });
          const highAfter = await high();
          how.fail.delete(failingId);
          check(
            highAfter <= highBefore + 0.5,
            `${where}: a load that failed does not grow its row`,
            `${highBefore} then ${highAfter}`,
          );
          if (shots) {
            await page.screenshot({ path: `${shots}/chat-pictures-failed-${theme}-${width}.png`, fullPage: true });
          }
        }
        if (state.status === 200 && theme === 'dark') {
          // The row of Social pages scrolls inside itself when it is too long. The page's own entry
          // must not be the one that is cut off.
          const current = await page.evaluate(() => {
            const row = document.querySelector('nav[data-tabs="social-pages"]');
            const box = row?.querySelector('a[aria-current="true"]')?.getBoundingClientRect();
            const edge = row?.getBoundingClientRect();
            return box && edge
              ? {
                  left: Math.round(box.left),
                  right: Math.round(box.right),
                  from: Math.round(edge.left),
                  to: Math.round(edge.right),
                }
              : null;
          });
          check(
            current !== null && current.left >= current.from && current.right <= current.to,
            `${where}: the entry Chat is whole inside its row`,
            current ? `${current.left} to ${current.right} in ${current.from} to ${current.to}` : 'no current entry',
          );
        }

        if (theme === 'dark' && width === 360 && state.status === 200) {
          // Nothing asks again by itself: after the page is idle, three seconds bring no request.
          const before = requests.length;
          await page.waitForTimeout(3_000);
          check(
            requests.length === before,
            `${where}: no request after the page has loaded`,
            `${requests.length - before} more`,
          );
          // Nothing asks for a picture by itself, also later: only the clicks above did, in one state.
          if (state.name !== 'pictures') {
            check(
              requests.filter(isPicture).length === 0,
              `${where}: no picture was asked for three seconds later`,
              `${requests.filter(isPicture).length} asked`,
            );
          }
        }
      }
      await context.close();
    }
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(urlOf('/chat', 'signed-out,social-room-markup', 'dark'), { waitUntil: 'networkidle' });
  check((await page.title()) !== 'room-markup-ran', 'markup: the script of a message did not run');
  const made = await page.evaluate(() => {
    const list = document.querySelector('.room-list');
    return {
      elements: list.querySelectorAll('.room-text :not(.visually-hidden)').length,
      links: list.querySelectorAll('a').length,
      images: list.querySelectorAll('img, script, h1, b, i').length,
      first: list.querySelector('.room-text').lastChild.textContent.trim(),
    };
  });
  check(made.elements === 0, 'markup: a message holds no element but its label', `${made.elements}`);
  check(made.links === 0 && made.images === 0, 'markup: the list holds no link and no element of a message');
  check(
    made.first === '<script>document.title = "room-markup-ran"</script>',
    'markup: the text is shown as it was written',
  );
  // Every attribute, every script element, every template and every JSON island of the page, against a
  // piece of each message: a message stands in text nodes of the list and nowhere else.
  const pieces = ['room-markup-ran', 'prixagent.example', 'WWWWWWWW', '7 * 7', 'deadbeef', '3456 7890'];
  const leaks = await page.evaluate((needles) => {
    const found = [];
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (needles.some((needle) => attribute.value.includes(needle)))
          found.push(`${element.tagName} ${attribute.name}`);
      }
      if (['SCRIPT', 'TEMPLATE', 'STYLE', 'NOSCRIPT'].includes(element.tagName)) {
        if (needles.some((needle) => element.innerHTML.includes(needle))) found.push(element.tagName);
      }
    }
    const outside = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (outside.nextNode()) {
      const node = outside.currentNode;
      if (needles.some((needle) => node.textContent.includes(needle)) && !node.parentElement.closest('.room-text')) {
        found.push(`text in ${node.parentElement.tagName}`);
      }
    }
    return found;
  }, pieces);
  check(
    leaks.length === 0,
    'markup: no message stands in an attribute, a script, an island or outside the list',
    leaks.join(', '),
  );

  await page.goto(urlOf('/chat', 'signed-out', 'dark'), { waitUntil: 'networkidle' });
  const order = await page.evaluate(() => {
    const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? null;
    const terms = [...document.querySelectorAll('.room-terms > p')].map((p) => p.getBoundingClientRect().top);
    return {
      title: top('h1'),
      terms,
      composer: top('.room-write'),
      load: top('.room-head a.button'),
      list: top('.room-list'),
      loadHref: document.querySelector('.room-head a.button')?.getAttribute('href'),
      termsSize: getComputedStyle(document.querySelector('.room-terms > p')).fontSize,
      bodySize: getComputedStyle(document.body).fontSize,
      termsColour: getComputedStyle(document.querySelector('.room-terms > p')).color,
      bodyColour: getComputedStyle(document.body).color,
      address: document.querySelector('.room-address')?.textContent,
      composers: document.querySelectorAll('.room-write').length,
      older: [...document.querySelectorAll('main a')].filter((a) =>
        /older|before=|page=/i.test(a.getAttribute('href') ?? ''),
      ).length,
    };
  });
  const steps = [order.title, ...order.terms, order.composer, order.load, order.list];
  check(
    order.terms.length === 3 &&
      steps.every((value, index) => value !== null && (index === 0 || value >= steps[index - 1])),
    'order: title, disclaimer, the mark, the token, the composer, Load new messages, the messages',
    steps.map((value) => (value === null ? 'none' : Math.round(value))).join(' '),
  );
  check(
    order.termsSize === order.bodySize && order.termsColour === order.bodyColour,
    'the disclaimer is in body size and in ink',
    `${order.termsSize} ${order.termsColour}`,
  );
  check(
    /^\/chat\?fixture=/.test(order.loadHref ?? ''),
    '"Load new messages" is a link to the page itself',
    order.loadHref ?? 'none',
  );
  check(/^0x[0-9a-f]{40}$/.test(order.address ?? ''), 'the note on the token holds the whole address');
  check(order.composers === 1, 'the composer is mounted once');
  check(order.older === 0, 'no link to an older page');

  await page.goto(urlOf('/chat', 'signed-out,social-room-no-token', 'dark'), { waitUntil: 'networkidle' });
  check((await page.locator('.room-address').count()) === 0, 'no-token: the note on the token is left out');
  check((await page.locator('.room-terms > p').count()) === 2, 'no-token: the disclaimer and the mark stay');

  await page.goto(urlOf('/chat', 'signed-out,social-room-admin', 'dark'), { waitUntil: 'networkidle' });
  const marks = await page.evaluate(() =>
    [...document.querySelectorAll('.room-item')].map((item) => ({
      mark: item.querySelectorAll('.room-who > .room-mark').length,
      drawn: item.querySelectorAll('.room-mark svg.prix-mark').length,
      inText: item.querySelectorAll('.room-text .room-mark').length,
      text: item.querySelector('.room-text').lastChild.textContent.trim(),
    })),
  );
  check(
    marks.map((item) => item.mark).join('') === '0101',
    'admin: the mark stands on the admin messages only',
    JSON.stringify(marks.map((item) => item.mark)),
  );
  check(
    marks.every((item) => item.inText === 0 && item.drawn === item.mark),
    'admin: the mark is an element of its own, with the drawn mark, outside the text',
  );
  check(
    marks[0]?.text.startsWith('Prix') === true && marks[0]?.mark === 0,
    'admin: a message that uses the name in its text carries no mark',
  );
  check((await page.locator('.room-terms .room-mark').count()) === 1, 'admin: the mark stands once above the messages');

  // An empty room: the body under its title is chosen by the session. A signed-in visitor is never told
  // to sign in (the sample build's `signed-in` state is a confirmed session).
  const emptyBody = async (fixture) => {
    await page.goto(urlOf('/chat', fixture, 'dark'), { waitUntil: 'networkidle' });
    return ((await page.locator('.empty-body').first().textContent()) ?? '').trim();
  };
  const emptyOut = await emptyBody('signed-out,social-room-empty');
  const emptyIn = await emptyBody('signed-in,social-room-empty');
  check(/\bsign in\b/i.test(emptyOut), 'empty, signed out: the body says how to write', emptyOut);
  check(
    emptyIn.length > 0 && emptyIn !== emptyOut && !/\bsign(?:ed)? in\b/i.test(emptyIn),
    'empty, signed in: the body does not ask to sign in',
    emptyIn,
  );
  check(!/[{}]/.test(`${emptyOut}${emptyIn}`), 'empty: no unfilled slot in either body');

  // The row of Social pages on the narrowest phones, where its entries stand closer: "Chat" is whole on
  // its own page at 340 pixels. (At 320 the four names alone are wider than the row, and it scrolls.)
  for (const narrow of NARROW) {
    const small = await browser.newContext({ viewport: { width: narrow, height: 700 }, deviceScaleFactor: 1 });
    const phone = await small.newPage();
    await phone.goto(urlOf('/chat', 'signed-out', 'dark'), { waitUntil: 'networkidle' });
    const row = await phone.evaluate(() => {
      const list = document.querySelector('nav[data-tabs="social-pages"] .tabs-list');
      const entries = [...(list?.querySelectorAll('a') ?? [])].map((a) => a.getBoundingClientRect());
      const edge = list?.getBoundingClientRect();
      const last = entries.at(-1);
      return edge && last
        ? {
            gap: getComputedStyle(list).columnGap,
            names: Math.round(entries.reduce((sum, box) => sum + box.width, 0)),
            right: Math.round(last.right),
            to: Math.round(edge.right),
            tall: Math.round(last.height),
            page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          }
        : null;
    });
    check(
      row !== null && row.right <= row.to && row.page,
      `dark ${narrow}: the entry Chat is whole inside its row`,
      row ? `gap ${row.gap}, names ${row.names}, Chat ends at ${row.right} of ${row.to}, ${row.tall} tall` : 'no row',
    );
    if (shots) await phone.screenshot({ path: `${shots}/nav-${narrow}-dark.png` });
    await small.close();
  }

  // The entry of the Social navigation, on a list page of Phase 6.
  for (const [fixture, shown] of [
    ['signed-out', true],
    ['signed-out,social-room-off', false],
    ['signed-out,social-room-error', true],
  ]) {
    await page.goto(urlOf('/wars', fixture, 'dark'), { waitUntil: 'networkidle' });
    const entries = await page.locator('nav[data-tabs="social-pages"] a[href^="/chat"]').count();
    check(
      (entries === 1) === shown,
      `navigation with ${fixture}: the entry Chat is ${shown ? 'shown' : 'left out'}`,
      `${entries}`,
    );
    const header = await page.locator('header.top a[href^="/chat"]').count();
    check(header === 0, `navigation with ${fixture}: the site's header has no entry`);
  }
  await page.goto(urlOf('/chat', 'signed-out', 'dark'), { waitUntil: 'networkidle' });
  check(
    (await page.locator('nav[data-tabs="social-pages"] a[href^="/chat"][aria-current="true"]').count()) === 1,
    'navigation on /chat: the entry Chat is the current one',
  );
  await context.close();

  // --- pictures: the rows the server renders, and what a click does -----------------------------------
  const names = ROOM_PICTURE_DOM;
  for (const width of [1440, 360]) {
    const sizes = new Map();
    const how = { gate: null, fail: new Set() };
    const reader = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await answerPictures(reader, sizes, how);
    const view = await reader.newPage();
    const asked = [];
    view.on('request', (request) => {
      if (isPicture(request.url())) asked.push(request);
    });
    const at = `pictures at ${width}`;

    await view.goto(urlOf('/chat', 'signed-out,social-room-pictures', 'dark'), { waitUntil: 'networkidle' });
    await sizesOf(view, sizes);

    // The contract's sentence about pictures, under the room's own, in the same size and ink.
    const terms = await view.evaluate(() =>
      [...document.querySelectorAll('.room-terms > p')].map((p) => ({
        said: p.textContent.trim(),
        size: getComputedStyle(p).fontSize,
        colour: getComputedStyle(p).color,
      })),
    );
    check(
      terms.length === 4 && terms[1]?.said === PICTURE_DISCLAIMER,
      `${at}: the contract's sentence about pictures stands under the room's own`,
      `${terms.length} sentences`,
    );
    check(
      terms[1]?.size === terms[0]?.size && terms[1]?.colour === terms[0]?.colour,
      `${at}: it is in body size and in ink, as the room's own`,
    );

    // The rows, as the server rendered them.
    const rows = await view.evaluate(
      ({ names, text }) => {
        const list = document.querySelector(`[${names.list}]`);
        const pictures = [...list.querySelectorAll(`li[${names.id}]`)];
        const words = [];
        const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) words.push(walker.currentNode.textContent.trim());
        return {
          items: list.querySelectorAll('li').length,
          pictures: pictures.length,
          texts: list.querySelectorAll('.room-text').length,
          bothKinds: pictures.filter((row) => row.querySelector('.room-text')).length,
          toggles: list.querySelectorAll('[data-room-picture-toggle]').length,
          notes: [...list.querySelectorAll('.room-picture-note')].map((note) => note.lastChild.textContent.trim()),
          facts: [...list.querySelectorAll('.room-picture-facts')].map((facts) => facts.textContent.trim()),
          oneSentence: pictures.filter((row) => row.querySelector('.room-picture').children.length === 1).length,
          reports: list.querySelectorAll(`[${names.report}]`).length,
          reportsSeen: [...list.querySelectorAll(`[${names.report}]`)].filter(
            (button) => getComputedStyle(button).display !== 'none',
          ).length,
          answers: [...list.querySelectorAll(`[${names.reportNote}]`)].map((note) => note.childNodes.length),
          theText: words.filter((word) => word === text).length,
          images: list.querySelectorAll('img').length,
          links: list.querySelectorAll('a').length,
          marks: pictures.filter((row) => row.hasAttribute(names.shown)).length,
          ids: pictures.every((row) => /^[1-9]\d*$/.test(row.getAttribute(names.id))),
          adminOnPictures: pictures.filter((row) => row.querySelector('.room-mark')).length,
          adminOnText: list.querySelectorAll(`li:not([${names.id}]) .room-who > .room-mark`).length,
          lefts: pictures.map((row) => {
            const block = row.querySelector('.room-picture');
            return {
              one: block.children.length === 1,
              rule: Number.parseFloat(getComputedStyle(block).borderLeftWidth),
              inset: Number.parseFloat(getComputedStyle(block).paddingLeft),
            };
          }),
          described: [...list.querySelectorAll('[data-room-picture-toggle]')].map((button) => {
            const row = button.closest(`li[${names.id}]`);
            const refs = (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
            const found = refs.map((id) => document.getElementById(id));
            return {
              refs: refs.length,
              who: found[0] !== null && found[0] === row.querySelector('.room-who'),
              when: found[1] !== null && found[1] === row.querySelector('.room-when'),
              once: refs.every((id) => document.querySelectorAll(`[id="${id}"]`).length === 1),
              says: found.map((element) => element?.textContent ?? '').join(' '),
              writer: row.querySelector('.room-writer').textContent.trim(),
              time: row.querySelector('time').textContent.trim(),
            };
          }),
          resting: document.querySelectorAll('.room-resting').length,
        };
      },
      { names, text: PICTURE_TEXT },
    );
    check(
      rows.pictures === SAMPLE.pictures && rows.texts === rows.items - SAMPLE.pictures && rows.bothKinds === 0,
      `${at}: a picture message has the row of a picture in the place of its text`,
      `${rows.pictures} pictures, ${rows.texts} texts, ${rows.items} messages`,
    );
    check(rows.theText === 0, `${at}: the text of a picture message is never shown`, `${rows.theText}`);
    check(rows.ids, `${at}: every picture's row carries the id of its message`);
    check(
      rows.toggles === SAMPLE.shown && rows.notes.length === SAMPLE.shown && rows.facts.length === SAMPLE.shown,
      `${at}: a picture that may be shown has the note, the facts and the button`,
      `${rows.toggles} buttons, ${rows.notes.length} notes, ${rows.facts.length} facts`,
    );
    check(
      rows.notes.every((note) => note === PICTURE_ROW_NOTE),
      `${at}: the note is the contract's own sentence`,
    );
    // The sign between the two sides is the deck's (`social.roomPictureFacts`): "1,600 × 1,200 pixels".
    check(
      rows.facts.every((facts) => /\d+ × \d+/.test(facts) && !/[{}]/.test(facts)) &&
        rows.facts.some((facts) => /\b120\b/.test(facts)),
      `${at}: the facts hold both sides, and the frames of the animated GIF`,
      rows.facts.join(' | '),
    );
    // Grouped, as the site prints every number: no run of four digits, and the sample's 1,600 by 1,200.
    check(
      rows.facts.every((facts) => !/\d{4}/.test(facts)) && rows.facts.some((facts) => facts.includes('1,600 × 1,200')),
      `${at}: the sides are printed grouped`,
      rows.facts.join(' | '),
    );
    // The sample's smallest file has 96 bytes: its size is said in the one unit, rounded up, never as 96.
    const smallest = rows.facts.find((facts) => facts.includes('16 × 16')) ?? '';
    check(
      smallest.length > 0 && !/\b96\b/.test(smallest) && !/\b0\b/.test(smallest),
      `${at}: a file below one kilobyte does not read as its bytes, nor as nothing`,
      smallest,
    );
    check(
      rows.adminOnPictures === 0 && rows.adminOnText === 1,
      `${at}: no admin's mark stands on a row that carries a picture, and the admin's message of text keeps its own`,
      `${rows.adminOnPictures} on pictures, ${rows.adminOnText} on text`,
    );
    check(
      rows.lefts.every(({ one, rule, inset }) => (one ? rule === 0 && inset === 0 : rule > 0 && inset > 0)),
      `${at}: the rule at the left stands beside the note and the facts, never beside one sentence`,
      rows.lefts.map(({ one, rule }) => `${one ? 'one' : 'file'}:${rule}`).join(' '),
    );
    check(
      rows.described.length === SAMPLE.shown &&
        rows.described.every(
          (button) =>
            button.refs === 2 &&
            button.who &&
            button.when &&
            button.once &&
            button.says.includes(button.writer) &&
            button.says.includes(button.time),
        ),
      `${at}: each "Show picture" is described by the writer and the time of its own row`,
      rows.described[0]?.says.replace(/\s+/g, ' ').trim(),
    );
    check(rows.resting === 0, `${at}: nothing says that pictures rest while they are on`, `${rows.resting}`);
    check(
      rows.oneSentence === SAMPLE.reported + SAMPLE.gone,
      `${at}: a reported picture and one that is gone are one sentence`,
      `${rows.oneSentence}`,
    );
    check(
      rows.reports === SAMPLE.shown && rows.answers.length === SAMPLE.shown && rows.answers.every((n) => n === 0),
      `${at}: "Report" and the empty place of its answer stand in every row in the state shown`,
      `${rows.reports} buttons, ${rows.answers.length} places`,
    );
    check(rows.reportsSeen === 0, `${at}: no "Report" is shown before a picture is`, `${rows.reportsSeen}`);
    check(
      rows.images === 0 && rows.links === 0 && rows.marks === 0 && asked.length === 0,
      `${at}: before a click there is no picture, no link, no mark and no request`,
    );

    // "Show picture", with the bytes held back: what the page is before the first byte arrives.
    const offered = view.locator(`li[${names.id}]`).filter({ has: view.locator('[data-room-picture-toggle]') });
    const first = offered.nth(0);
    const toggle = first.locator('[data-room-picture-toggle]');
    const id = await first.getAttribute(names.id);
    const geometry = () =>
      first.evaluate((row) => {
        const box = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {
            top: Math.round((rect.top + window.scrollY) * 10) / 10,
            left: Math.round(rect.left * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          };
        };
        return {
          toggle: box(row.querySelector('[data-room-picture-toggle]')),
          image: box(row.querySelector('.room-picture-image')),
          next: box(row.nextElementSibling),
          row: box(row),
        };
      });
    const state = () =>
      first.evaluate((row, shown) => {
        const button = row.querySelector('[data-room-picture-toggle]');
        const image = row.querySelector('.room-picture-image');
        return {
          marked: row.hasAttribute(shown),
          label: button.textContent.trim(),
          show: button.dataset.label,
          hide: button.dataset.hideLabel,
          images: row.querySelectorAll('img').length,
          frameHidden: row.querySelector('[data-room-picture-frame]').hidden,
          focus: document.activeElement === button,
          image: image && {
            src: image.getAttribute('src'),
            width: image.getAttribute('width'),
            height: image.getAttribute('height'),
            alt: image.getAttribute('alt'),
            referrer: image.getAttribute('referrerpolicy'),
            link: image.closest('a') !== null,
            writer: row.querySelector('.room-writer').textContent.trim(),
          },
        };
      }, names.shown);

    const closed = await geometry();
    let release = () => {};
    how.gate = new Promise((resolve) => {
      release = resolve;
    });
    await toggle.click();
    const waiting = await geometry();
    const made = await state();
    release();
    how.gate = null;
    await picturesDrawn(view);
    const arrived = await geometry();
    const size = sizes.get(id);

    check(
      asked.length === 1 && new URL(asked[0].url()).pathname === roomPicturePath(Number(id)),
      `${at}: "Show picture" asks for one picture, at the address of the message's id`,
      asked.map((request) => new URL(request.url()).pathname).join(' '),
    );
    check(
      asked[0]?.resourceType() === 'image' && asked[0]?.headers().referer === undefined,
      `${at}: it is asked as an image, with no referrer`,
      `${asked[0]?.resourceType()} ${asked[0]?.headers().referer ?? ''}`,
    );
    check(
      made.images === 1 &&
        made.image?.src === roomPicturePath(Number(id)) &&
        made.image?.width === String(size.width) &&
        made.image?.height === String(size.height),
      `${at}: one <img>, with the server's width and height as attributes`,
      JSON.stringify(made.image),
    );
    check(
      made.image?.alt === ROOM_PICTURE_ALT.replace('{author}', made.image?.writer) &&
        made.image?.referrer === 'no-referrer' &&
        made.image?.link === false,
      `${at}: it has the contract's words in its place, sends no referrer and is no link`,
    );
    check(
      made.marked && made.label === made.hide && made.label !== made.show && made.focus,
      `${at}: the row is marked as shown and its button says "${made.hide}"`,
    );
    check(
      waiting.toggle.top === closed.toggle.top && waiting.toggle.left === closed.toggle.left,
      `${at}: the button stays where it was when the picture opens`,
      `${closed.toggle.top} then ${waiting.toggle.top}`,
    );
    check(
      waiting.image !== null &&
        waiting.image.height > 0 &&
        Math.abs(waiting.image.width / waiting.image.height - size.width / size.height) < 0.02,
      `${at}: the picture's box is kept before the first byte arrives`,
      JSON.stringify(waiting.image),
    );
    check(
      JSON.stringify(arrived) === JSON.stringify(waiting),
      `${at}: nothing moves when the picture arrives`,
      `${JSON.stringify(waiting)} then ${JSON.stringify(arrived)}`,
    );

    // "Report" is shown only in a row whose picture is shown, under a list with the account's mark.
    const reportsSeen = () =>
      view.evaluate(
        (names) =>
          [...document.querySelectorAll(`[${names.report}]`)]
            .filter((button) => getComputedStyle(button).display !== 'none')
            .map((button) => button.closest(`[${names.id}]`).getAttribute(names.id)),
        names,
      );
    const markList = (on) =>
      view.evaluate(({ names, on }) => document.querySelector(`[${names.list}]`).toggleAttribute(names.reportOn, on), {
        names,
        on,
      });
    check((await reportsSeen()).length === 0, `${at}: a shown picture has no "Report" without the account's mark`);
    await markList(true);
    check(
      (await reportsSeen()).join(' ') === id,
      `${at}: with the account's mark, "Report" is shown in the row of the shown picture and in no other`,
      (await reportsSeen()).join(' '),
    );

    // The place of a report's question. The click and the question are the account's: here the row's
    // note is filled as that script fills it (a sentence and two buttons that carry the contract's two
    // names), to see that this folder's row and stylesheet give it room. The sentence stands in for the
    // deck's question at about its length, and the two labels are the row's own: none is typed here.
    const asking = await first.evaluate(
      (row, { names, sentence }) => {
        const note = row.querySelector(`[${names.reportNote}]`);
        const block = row.querySelector('.room-picture');
        const toggle = row.querySelector('[data-room-picture-toggle]');
        const report = row.querySelector(`[${names.report}]`);
        const place = (element) => {
          const rect = element.getBoundingClientRect();
          return {
            top: Math.round((rect.top + window.scrollY) * 10) / 10,
            bottom: Math.round((rect.bottom + window.scrollY) * 10) / 10,
            left: Math.round(rect.left * 10) / 10,
            right: Math.round(rect.right * 10) / 10,
          };
        };
        const high = () => Math.round(row.getBoundingClientRect().height * 10) / 10;
        const before = { toggle: place(toggle), report: place(report), row: high() };
        const emptyShown = getComputedStyle(note).display;
        const button = (name, label) => {
          const made = document.createElement('button');
          made.type = 'button';
          made.setAttribute(name, '');
          made.textContent = label;
          return made;
        };
        const yes = button(names.reportYes, toggle.dataset.label);
        const no = button(names.reportNo, toggle.dataset.hideLabel);
        note.replaceChildren(document.createTextNode(sentence), yes, no);
        note.tabIndex = -1;
        note.focus();
        const open = {
          toggle: place(toggle),
          report: place(report),
          note: place(note),
          yes: place(yes),
          no: place(no),
          block: place(block),
          controls: place(row.querySelector('.room-picture-controls')),
          frame: place(row.querySelector('[data-room-picture-frame]')),
          shown: getComputedStyle(note).display,
          colour: getComputedStyle(note).color,
          ink: getComputedStyle(document.body).color,
          focus: document.activeElement === note,
          role: note.getAttribute('role'),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
        // The answer: the two buttons are removed and a sentence stays.
        note.replaceChildren(document.createTextNode(sentence));
        const answered = { colour: getComputedStyle(note).color, shown: getComputedStyle(note).display };
        // "Cancel": the note is empty again, and the row is as it was.
        note.replaceChildren();
        note.removeAttribute('tabindex');
        return { before, emptyShown, open, answered, after: { row: high(), shown: getComputedStyle(note).display } };
      },
      { names, sentence: PICTURE_DISCLAIMER.slice(0, 118) },
    );
    check(
      asking.emptyShown === 'none' &&
        asking.open.shown !== 'none' &&
        asking.open.focus &&
        asking.open.role === 'status',
      `${at}: the row's note is the place of the report's question, and can take the focus`,
      `${asking.emptyShown} then ${asking.open.shown}`,
    );
    check(
      asking.open.note.left >= asking.open.block.left - 0.5 &&
        asking.open.note.right <= asking.open.block.right + 0.5 &&
        [asking.open.yes, asking.open.no].every(
          (button) =>
            button.left >= asking.open.note.left - 0.5 &&
            button.right <= asking.open.note.right + 0.5 &&
            button.top >= asking.open.note.top - 0.5 &&
            button.bottom <= asking.open.note.bottom + 0.5,
        ) &&
        asking.open.scrollWidth <= asking.open.clientWidth,
      `${at}: the question and its two buttons stay in the row's column, and the page does not scroll sideways`,
      JSON.stringify({ note: asking.open.note, yes: asking.open.yes, no: asking.open.no }),
    );
    check(
      JSON.stringify(asking.open.toggle) === JSON.stringify(asking.before.toggle) &&
        JSON.stringify(asking.open.report) === JSON.stringify(asking.before.report),
      `${at}: the question moves neither "Hide picture" nor "Report"`,
      `${JSON.stringify(asking.before.report)} then ${JSON.stringify(asking.open.report)}`,
    );
    check(
      asking.open.note.top >= asking.open.controls.bottom - 0.5 &&
        asking.open.frame.top >= asking.open.note.bottom - 0.5,
      `${at}: the question stands under the row's buttons and over the picture`,
    );
    check(
      asking.open.colour === asking.open.ink && asking.answered.colour !== asking.open.ink,
      `${at}: the question is in ink, and the answer that stays is quieter`,
      `${asking.open.colour} then ${asking.answered.colour}`,
    );
    check(
      asking.after.shown === 'none' && asking.after.row === asking.before.row,
      `${at}: with the note empty again the row is as it was`,
      `${asking.before.row} then ${asking.after.row}`,
    );

    // "Hide picture": the element is gone, and the row is as the server rendered it.
    await toggle.click();
    const hidden = await state();
    const after = await geometry();
    check(
      hidden.images === 0 && !hidden.marked && hidden.frameHidden && hidden.label === hidden.show,
      `${at}: "Hide picture" takes the element out and the mark away`,
    );
    check(
      after.row.height === closed.row.height && after.toggle.top === closed.toggle.top,
      `${at}: the row is as high as before it was opened`,
      `${closed.row.height} then ${after.row.height}`,
    );
    check((await reportsSeen()).length === 0, `${at}: "Report" goes with the picture`);
    check(asked.length === 1, `${at}: hiding a picture asks for nothing`, `${asked.length}`);

    // A load that failed, opened from the keyboard: the one sentence, and nothing asks again.
    const second = offered.nth(1);
    const secondId = await second.getAttribute(names.id);
    how.fail.add(secondId);
    await second.locator('[data-room-picture-toggle]').focus();
    await view.keyboard.press('Enter');
    await second.locator('[data-room-picture-failed]').waitFor({ state: 'visible' });
    const failed = await second.evaluate((row, shown) => {
      const sentence = row.querySelector('[data-room-picture-failed]');
      return {
        said: sentence.textContent.trim(),
        focus: document.activeElement === sentence,
        role: sentence.getAttribute('role'),
        button: row.querySelector('[data-room-picture-toggle]').hidden,
        images: row.querySelectorAll('img').length,
        marked: row.hasAttribute(shown),
        frameHidden: row.querySelector('[data-room-picture-frame]').hidden,
      };
    }, names.shown);
    check(
      failed.said.length > 0 && failed.role === 'status' && failed.images === 0 && failed.frameHidden,
      `${at}: a load that failed shows its sentence in the picture's place`,
      failed.said,
    );
    check(failed.button && !failed.marked, `${at}: the button is gone and the row is not marked as shown`);
    check(failed.focus, `${at}: a reader at the keyboard stays in the row, on the sentence`);
    check((await reportsSeen()).length === 0, `${at}: a picture that failed has no "Report"`);
    const afterFailure = asked.length;
    await view.waitForTimeout(2_000);
    check(
      asked.length === afterFailure && asked.filter((request) => request.url().endsWith(`/${secondId}`)).length === 1,
      `${at}: nothing asks again after a load that failed`,
      `${asked.length - afterFailure} more`,
    );
    await markList(false);

    // The keyboard alone: Enter shows, Space hides, and the button keeps the focus.
    const third = offered.nth(2).locator('[data-room-picture-toggle]');
    await third.focus();
    await view.keyboard.press('Enter');
    await picturesDrawn(view);
    const opened = await offered.nth(2).evaluate((row, shown) => row.hasAttribute(shown), names.shown);
    await view.keyboard.press('Space');
    const shut = await offered.nth(2).evaluate((row, shown) => !row.hasAttribute(shown), names.shown);
    const focused = await third.evaluate((button) => document.activeElement === button);
    const ring = await third.evaluate((button) => getComputedStyle(button).outlineStyle !== 'none');
    check(
      opened && shut && focused && ring,
      `${at}: the button works from the keyboard and shows its focus`,
      `${opened} ${shut} ${focused} ${ring}`,
    );

    // Pictures off, and resting: the facts and a sentence, no button, and "Report" never shown.
    const sentences = {};
    for (const [name, fixture] of [
      ['off', 'social-room-pictures-off'],
      ['resting', 'social-room-pictures-resting'],
    ]) {
      await view.goto(urlOf('/chat', `signed-out,${fixture}`, 'dark'), { waitUntil: 'networkidle' });
      await view.evaluate((names) => document.querySelector(`[${names.list}]`).setAttribute(names.reportOn, ''), names);
      const quiet = await view.evaluate((names) => {
        const list = document.querySelector(`[${names.list}]`);
        return {
          toggles: list.querySelectorAll('[data-room-picture-toggle]').length,
          facts: list.querySelectorAll('.room-picture-facts').length,
          notes: list.querySelectorAll('.room-picture-note').length,
          said: [...list.querySelectorAll('.room-picture-controls > .room-picture-said')].map((p) =>
            p.textContent.trim(),
          ),
          reports: list.querySelectorAll(`[${names.report}]`).length,
          reportsSeen: [...list.querySelectorAll(`[${names.report}]`)].filter(
            (button) => getComputedStyle(button).display !== 'none',
          ).length,
          frames: list.querySelectorAll('[data-room-picture-frame]').length,
          terms: document.querySelectorAll('.room-terms > p').length,
          // What the page says once for every picture below it, and where.
          once: [...document.querySelectorAll('.room-resting')].map((p) => ({
            said: p.textContent.trim(),
            underHeading:
              p.getBoundingClientRect().top >= document.querySelector('.room-head').getBoundingClientRect().bottom,
            overList: p.getBoundingClientRect().bottom <= list.getBoundingClientRect().top,
            inList: list.contains(p),
            ink: getComputedStyle(p).color === getComputedStyle(document.body).color,
            body: getComputedStyle(p).fontSize === getComputedStyle(document.body).fontSize,
          })),
          rowsText: [...list.querySelectorAll(`li[${names.id}]`)].map((row) => row.textContent),
        };
      }, names);
      sentences[name] = quiet.said[0] ?? '';
      check(
        quiet.toggles === 0 && quiet.frames === 0 && quiet.facts === SAMPLE.shown && quiet.notes === SAMPLE.shown,
        `${at}, ${name}: the note and the facts, and no button`,
        `${quiet.toggles} buttons, ${quiet.facts} facts`,
      );
      check(
        quiet.said.length === SAMPLE.shown && quiet.said.every((said) => said.length > 0 && said === quiet.said[0]),
        `${at}, ${name}: one sentence says why no picture is shown`,
        quiet.said[0],
      );
      check(
        quiet.reports === SAMPLE.shown && quiet.reportsSeen === 0,
        `${at}, ${name}: "Report" is in the row and is never shown, also with the account's mark`,
      );
      check(quiet.terms === 4, `${at}, ${name}: the contract's sentence about pictures stays on the page`);
      if (name === 'resting') {
        const long = quiet.once[0];
        check(
          quiet.once.length === 1 && long.underHeading && long.overList && !long.inList,
          `${at}, resting: the long sentence stands once, between the heading of the list and the list`,
          `${quiet.once.length}`,
        );
        check(long?.ink && long?.body, `${at}, resting: it is in ink and in body size`);
        check(
          long !== undefined &&
            long.said.length > sentences.resting.length &&
            long.said !== sentences.resting &&
            quiet.rowsText.every((row) => !row.includes(long.said)),
          `${at}, resting: every picture row keeps a shorter sentence, and none repeats the long one`,
          `"${sentences.resting}" in a row`,
        );
      } else {
        check(quiet.once.length === 0, `${at}, ${name}: nothing says that pictures rest`, `${quiet.once.length}`);
      }
    }
    check(sentences.off !== sentences.resting, `${at}: off and resting are two sentences`);
    check(
      asked.length === afterFailure + 1,
      `${at}: every picture asked for was asked for by a click`,
      `${asked.length}`,
    );
    await reader.close();
  }

  // --- pictures: just above 45em, where the two columns of a row have the least room --------------------
  for (const width of [720, 800]) {
    const sizes = new Map();
    const tablet = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await answerPictures(tablet, sizes);
    const view = await tablet.newPage();
    for (const fixture of ['social-room-pictures', 'social-room-pictures-resting', 'social-room-pictures-off']) {
      await view.goto(urlOf('/chat', `signed-out,${fixture}`, 'light'), { waitUntil: 'networkidle' });
      await sizesOf(view, sizes);
      // With the account's mark and every picture open, so that "Report" stands beside every button.
      await view.evaluate((names) => document.querySelector(`[${names.list}]`).setAttribute(names.reportOn, ''), names);
      for (const toggle of await view.locator('[data-room-picture-toggle]').all()) await toggle.click();
      await picturesDrawn(view);
      const narrowest = await view.evaluate((names) => {
        const doc = document.documentElement;
        const inside = (element) => {
          const box = element.getBoundingClientRect();
          const column = element.closest('.room-picture').getBoundingClientRect();
          return box.width === 0 || (box.left >= column.left - 0.5 && box.right <= column.right + 0.5);
        };
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          wide: matchMedia('(min-width: 45em)').matches,
          parts: [
            ...document.querySelectorAll(
              `.room-picture-about, .room-picture-controls, .room-picture-controls > *, [${names.reportNote}], .room-picture-image`,
            ),
          ].every(inside),
        };
      }, names);
      check(
        narrowest.wide && narrowest.scrollWidth <= narrowest.clientWidth && narrowest.parts,
        `light ${width} ${fixture}: every part of a picture's row stays in its column, with every picture open and "Report" shown`,
        `document ${narrowest.scrollWidth} of ${narrowest.clientWidth}`,
      );
      if (shots) await view.screenshot({ path: `${shots}/chat-${fixture}-light-${width}.png`, fullPage: true });
    }
    await tablet.close();
  }
} finally {
  await browser.close();
}

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
