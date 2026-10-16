// Looks at pictures in the composer of /chat and on /admin/chat of a SAMPLE build (PRIX_FIXTURES=1) and
// says whether they keep the rules of docs/contracts/phase-6-pictures.md sections 11 and 17 that only a
// browser shows. Read-only: it only GETs pages of the origin it is given, and it refuses any origin that
// is not local. No request of it leaves this machine.
//
//   PRIX_FIXTURES=1 pnpm --filter @prix/web exec astro build
//   pnpm --filter @prix/web exec astro preview --port 4396 --host 127.0.0.1
//   node apps/web/src/account/social/room/check-pictures.mjs http://127.0.0.1:4396 [directory for screenshots]
//
// It prints one line for each check and exits 1 when one fails.
//
// The list of messages on /chat is the other owner's (web-arena). The composer finds it by the
// contract's attribute `data-room-list` and reads `data-room-pictures` on it. Where the served page does
// not carry them yet, this driver STANDS IN for the other owner: it writes the two attributes on the
// served list and puts one picture row with a "Report" button into it, and says so in its first line.
import { mkdir } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const origin = process.argv[2];
const shots = process.argv[3] ?? null;
if (!origin) throw new Error('usage: node check-pictures.mjs <origin of a sample build> [directory for screenshots]');
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
  throw new Error('This check reads a local sample build only.');
}

let failed = 0;
function check(ok, what, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
}

const { ROOM_PICTURE_LIMITS, ROOM_PICTURE_MAX_BYTES, roomPictureCheck, roomPicturePath } = await import(
  '../../../../../../packages/contracts/src/room-picture.ts'
);
/** A whole number as the site prints one: grouped in thousands. */
const grouped = (value) => value.toLocaleString('en-US');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// --- files, made here ----------------------------------------------------------------------------------

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  return Buffer.concat([Buffer.from(be32(data.length)), body, Buffer.from(be32(crc32(body)))]);
}
/** A real PNG: a soft gradient, or noise that does not compress, with a text chunk that names a place. */
function png(width, height, noise = false) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * row + 1 + x * 3;
      if (noise) {
        for (let c = 0; c < 3; c += 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          raw[at + c] = seed & 255;
        }
      } else {
        raw[at] = Math.round((x / width) * 255);
        raw[at + 1] = Math.round((y / height) * 255);
        raw[at + 2] = 140;
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
    pngChunk('tEXt', Buffer.from('Comment\0taken at 52.5200, 13.4050 PRIX-LOCATION-MARK', 'latin1')),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', []),
  ]);
}
/**
 * The pixel data of a GIF image of `count` pixels of one colour, as a browser can read it: codes of three
 * bits, a clear code before each pixel so that the code table never grows, then the end code.
 */
function gifPixels(count) {
  const codes = [];
  for (let pixel = 0; pixel < count; pixel += 1) codes.push(4, 1);
  codes.push(5);
  const packed = [];
  let held = 0;
  let bits = 0;
  for (const code of codes) {
    held |= code << bits;
    bits += 3;
    while (bits >= 8) {
      packed.push(held & 255);
      held >>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) packed.push(held & 255);
  const blocks = [];
  for (let at = 0; at < packed.length; at += 255) {
    const block = packed.slice(at, at + 255);
    blocks.push(block.length, ...block);
  }
  return [2, ...blocks, 0];
}
/** A GIF of this many frames on a canvas of this size, each frame four pixels a browser can draw. */
function gif(width, height, frames) {
  const le16 = (n) => [n & 255, n >> 8];
  const bytes = [
    ...Buffer.from('GIF89a', 'latin1'),
    ...le16(width),
    ...le16(height),
    0x80,
    0,
    0,
    20,
    30,
    40,
    255,
    255,
    255,
  ];
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.push(0x2c, 0, 0, 0, 0, ...le16(2), ...le16(2), 0, ...gifPixels(4));
  }
  bytes.push(0x3b);
  return Buffer.from(bytes);
}
/** An APP1 segment as a camera writes it: orientation 6 (the picture lies on its side), and a place in words. */
function exif() {
  const tiff = Buffer.concat([
    Buffer.from('II*\0', 'latin1'),
    Buffer.from([8, 0, 0, 0, 1, 0]),
    Buffer.from([0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('GPS 52.5200 N 13.4050 E PRIX-LOCATION-MARK', 'latin1'),
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
}
/** The sides a JPEG's own frame header declares. */
function jpegSize(bytes) {
  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
    at += 2 + length;
  }
  return null;
}
const webp = Buffer.concat([Buffer.from('RIFF\x24\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(400, 1)]);
/**
 * A GIF whose blocks are in order, so the rule passes it, and whose pixel data no decoder can read: its
 * first code is one the code table does not hold yet.
 */
const undrawable = Buffer.from([
  ...Buffer.from('GIF89a', 'latin1'),
  ...[64, 0, 64, 0, 0x80, 0, 0],
  ...[20, 30, 40, 255, 255, 255],
  ...[0x2c, 0, 0, 0, 0, 64, 0, 64, 0, 0],
  ...[2, 24, ...new Array(24).fill(0xff), 0],
  0x3b,
]);

if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  // A JPEG as a phone writes one: made by the browser's own canvas, then given the camera's segment.
  const maker = await browser.newPage();
  const plain = Buffer.from(
    await maker.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2400;
      canvas.height = 1200;
      const pen = canvas.getContext('2d');
      for (let x = 0; x < 2400; x += 40) {
        pen.fillStyle = `rgb(${x % 255}, ${(x * 3) % 255}, 120)`;
        pen.fillRect(x, 0, 40, 1200);
      }
      return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    }),
    'base64',
  );
  await maker.close();
  const photo = Buffer.concat([plain.subarray(0, 2), exif(), plain.subarray(2)]);
  check(
    photo.includes('Exif') && photo.includes('PRIX-LOCATION-MARK'),
    'the sample photo carries a camera segment with a place in it',
  );
  check(
    jpegSize(photo)?.width === 2400 && jpegSize(photo)?.height === 1200,
    'the sample photo lies on its side: 2400 x 1200 with orientation 6',
  );

  const served = await (await fetch(`${origin}/chat?fixture=signed-in`)).text();
  const standIn = !served.includes('data-room-list');
  console.log(
    standIn
      ? 'note the served /chat has no data-room-list yet: this driver stands in for the list (web-arena lands it)'
      : 'note the served /chat carries data-room-list: the page is used as it is',
  );

  /**
   * The state of the other owner's sample (web-arena's fixtures.ts) whose served list says each value. On
   * the merged page nothing is written into the list here: the list says what its own read answered.
   */
  const LIST_SAYS = {
    on: 'social-room-pictures',
    off: 'social-room-pictures-off',
    resting: 'social-room-pictures-resting',
  };

  /** Opens /chat as a signed-in holder. `pictures` is the value the list says, or null for none. */
  async function openChat(context, fixture, pictures, theme = 'dark') {
    const page = await context.newPage();
    if (!standIn && pictures !== null) fixture = `${fixture},${LIST_SAYS[pictures]}`;
    if (standIn) {
      await page.route(/\/chat\?/, async (route) => {
        const response = await route.fetch();
        let html = await response.text();
        const state = pictures === null ? '' : ` data-room-pictures="${pictures}"`;
        const row =
          '<li data-room-picture-id="52" data-room-picture-shown><button type="button" class="button button--secondary" data-room-picture-report>Report</button> <span data-room-picture-report-note></span></li>';
        html = html.replace(/<ol class="room-list"([^>]*)>/, `<ol class="room-list" data-room-list${state}$1>${row}`);
        await route.fulfill({ response, body: html });
      });
    }
    await page.goto(`${origin}/chat?fixture=${encodeURIComponent(fixture)}&theme=${theme}`, {
      waitUntil: 'networkidle',
    });
    return page;
  }
  /** The sentences the server handed the composer's script: a check compares with these, never with a typed draft. */
  const wordsOf = async (page) =>
    JSON.parse((await page.locator('[data-room-composer]').getAttribute('data-picture-words')) ?? '{}');
  const add = (page) => page.locator('button[data-room-picture-add]');
  const choose = (page, name, mimeType, buffer) =>
    page.locator('input[data-room-picture-file]').setInputFiles({ name, mimeType, buffer });
  const sentBytes = (page) =>
    page.evaluate(async () =>
      globalThis.prixSampleUpload ? Array.from(new Uint8Array(await globalThis.prixSampleUpload.arrayBuffer())) : null,
    );

  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 });
  await context.addCookies([{ name: 'prix_theme', value: 'dark', url: origin }]);

  // --- whether "Add a picture" is offered -----------------------------------------------------------
  for (const [pictures, shown] of [
    [null, false],
    ['off', false],
    ['resting', false],
    ['on', true],
  ]) {
    const page = await openChat(context, 'signed-in', pictures);
    check(
      (await add(page).isVisible()) === shown,
      `the list says ${pictures ?? 'nothing'}: "Add a picture" is ${shown ? 'offered' : 'not offered'}`,
    );
    check(
      (await page.locator('img').count()) === 0 || !(await page.locator('.room-composer img').count()),
      `the list says ${pictures ?? 'nothing'}: the composer holds no image`,
    );
    await page.close();
  }
  for (const [fixture, offer, name] of [
    ['signed-in,social-room-me-pic-admin', 'admin', 'an admin wallet reads the note and gets no control'],
    ['signed-in,social-room-me-pic-new', 'new_writer', 'a new writer reads the rule and gets no control'],
    [
      'signed-in,social-room-me-pic-used',
      'day_used',
      'a wallet with no picture left today reads so and gets no control',
    ],
  ]) {
    const page = await openChat(context, fixture, 'on');
    const said = page.locator(`[data-room-picture-offer="${offer}"]`);
    check((await said.isVisible()) && !(await add(page).isVisible()), name, (await said.textContent())?.trim());
    if (shots) await page.screenshot({ path: `${shots}/composer-${offer}.png`, fullPage: true });
    await page.close();
  }
  for (const fixture of [
    'signed-in,social-room-me-pic-no',
    'signed-in,social-room-me-pic-none',
    'signed-in,social-room-me-muted',
  ]) {
    const page = await openChat(context, fixture, 'on');
    check(
      (await page.locator('[data-room-picture-offer]:visible').count()) === 0,
      `${fixture}: nothing of pictures is shown`,
    );
    await page.close();
  }

  // --- a picture picked ------------------------------------------------------------------------------
  {
    const page = await openChat(context, 'signed-in,social-room-pic-picture-storage', 'on');
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await add(page).focus();
    check(
      await add(page).evaluate((button) => button === document.activeElement),
      'picked: "Add a picture" takes focus from the keyboard',
    );
    await choose(page, 'IMG_0042.jpg', 'image/jpeg', photo);
    await page.locator('[data-room-picture]').waitFor({ state: 'visible' });
    const facts = (await page.locator('[data-room-picture-facts]').textContent())?.trim() ?? '';
    check(
      facts.includes('JPEG') && /\b800\b.*\b1,600\b/.test(facts) && !/\b1600\b/.test(facts),
      'picked: the facts say an upright JPEG of 800 x 1,600, its sides printed grouped',
      facts,
    );
    // The send says what it sends while a picture is chosen: the deck's two words, set by the server.
    const sendButton = page.locator('form[data-room-state="yes"] button[type="submit"]');
    const lineLabel = await sendButton.getAttribute('data-picture-label');
    check(
      Boolean(lineLabel) && (await sendButton.textContent())?.trim() === lineLabel,
      'picked: the send button says that it sends a picture',
      (await sendButton.textContent())?.trim(),
    );
    const noteLook = await page.evaluate(() => {
      const size = (selector) => {
        const element = document.querySelector(selector);
        const style = element ? getComputedStyle(element) : null;
        return style ? { size: Number.parseFloat(style.fontSize), colour: style.color } : null;
      };
      return { note: size('.room-pick-note'), quiet: size('[data-room-left]') };
    });
    check(
      noteLook.note !== null &&
        noteLook.quiet !== null &&
        noteLook.note.size > noteLook.quiet.size &&
        noteLook.note.colour !== noteLook.quiet.colour,
      'picked: the contract’s note is in the body size and in ink, not the quietest text of the form',
      JSON.stringify(noteLook),
    );
    check(
      (await page
        .locator('canvas[data-room-picture-preview]')
        .evaluate((canvas) => getComputedStyle(canvas).borderRadius)) === '0px',
      'picked: the preview has square corners',
    );
    check(
      await page.locator('canvas[data-room-picture-preview]').isVisible(),
      'picked: the preview is a canvas, and it shows',
    );
    const preview = await page
      .locator('canvas[data-room-picture-preview]')
      .evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
    check(preview.height > preview.width, 'picked: the preview stands upright', `${preview.width} x ${preview.height}`);
    check(
      !(await page.locator('[data-room-line]').isVisible()),
      'picked: the picture stands in the place of the line of text',
    );
    check(
      (await page.locator('.room-pick-note').textContent())?.includes('This picture will be public'),
      'picked: the contract’s note stands above the send',
    );
    check(
      (await page.locator('.room-composer img, .room-composer [src]').count()) === 0,
      'picked: no image element and no address of one',
    );
    if (shots) await page.screenshot({ path: `${shots}/composer-picked-dark-390.png`, fullPage: true });

    // The send, refused by the fixture so that the page stays: what would have left the browser.
    await page.locator('form[data-room-state="yes"] button[type="submit"]').click();
    await page.locator('form[data-room-state="yes"] [data-outlet] .notice').waitFor({ state: 'visible' });
    const sent = Buffer.from((await sentBytes(page)) ?? []);
    const ruled = roomPictureCheck(new Uint8Array(sent));
    check(ruled.ok && ruled.type === 'jpeg', 'sent: the file passes the contract’s rule as a JPEG');
    check(
      ruled.ok && Buffer.compare(Buffer.from(ruled.bytes), sent) === 0,
      'sent: it is the rule’s own serialisation, byte for byte',
    );
    check(
      !sent.includes('Exif') && !sent.includes('PRIX-LOCATION-MARK') && !sent.includes('GPS'),
      'sent: no camera segment and no place left the browser',
    );
    check(
      jpegSize(sent)?.width === 800 && jpegSize(sent)?.height === 1600,
      'sent: the picture stands upright in its pixels, its longest side at 1,600',
      JSON.stringify(jpegSize(sent)),
    );
    check(
      sent.length <= ROOM_PICTURE_MAX_BYTES,
      `sent: at most ${ROOM_PICTURE_LIMITS.maxKib} KiB`,
      `${sent.length} bytes`,
    );
    const sizeSaid = (await wordsOf(page)).sizeKb.replace('{count}', grouped(Math.ceil(sent.length / 1024)));
    check(
      facts.endsWith(sizeSaid),
      'picked: the size is whole kilobytes of 1,024 bytes, rounded up',
      `${sent.length} bytes read "${sizeSaid}"`,
    );
    const notice = (await page.locator('form[data-room-state="yes"] [data-outlet]').textContent())?.trim() ?? '';
    check(
      notice.includes((await wordsOf(page)).refusals.picture_storage),
      'refused by the server: the sentence of picture_storage stands under the form',
      notice,
    );
    const failedTitle = await page.evaluate(
      () =>
        document.querySelector('template[data-message="picture-failed"]')?.content.querySelector('.notice-title')
          ?.textContent ?? null,
    );
    check(
      failedTitle !== null &&
        (await page.locator('form[data-room-state="yes"] [data-outlet] .notice-title').textContent())?.trim() ===
          failedTitle.trim(),
      'refused by the server: the notice is titled as a picture that was not sent',
      failedTitle?.trim(),
    );
    check(await page.locator('[data-room-picture]').isVisible(), 'refused by the server: the picture is still chosen');
    check(
      (await sendButton.textContent())?.trim() === lineLabel && !(await sendButton.isDisabled()),
      'refused by the server: the send still says that it sends a picture, and is open again',
    );
    check(!requests.some((url) => url.includes('/api/')), 'a sample page sends nothing to an API');
    if (shots) await page.screenshot({ path: `${shots}/composer-refused-by-server.png`, fullPage: true });

    await page.locator('button[data-room-picture-discard]').click();
    check(
      (await page.locator('[data-room-line]').isVisible()) && (await add(page).isVisible()),
      'discarded: the line of text and "Add a picture" are back',
    );
    check(
      await add(page).evaluate((button) => button === document.activeElement),
      'discarded: focus is on "Add a picture"',
    );
    check(
      (await sendButton.textContent())?.trim() === (await sendButton.getAttribute('data-label')) &&
        (await sendButton.textContent())?.trim() !== lineLabel,
      'discarded: the send button says "Send" as for a line of text again',
      (await sendButton.textContent())?.trim(),
    );
    await page.close();
  }

  // --- a PNG, a GIF, and files the page refuses ------------------------------------------------------
  {
    const page = await openChat(context, 'signed-in,social-room-pic-picture-storage', 'on');
    const send = async () => {
      await page.locator('form[data-room-state="yes"] button[type="submit"]').click();
      await page.locator('form[data-room-state="yes"] [data-outlet] .notice').waitFor({ state: 'visible' });
      return Buffer.from((await sentBytes(page)) ?? []);
    };
    const problem = async () => {
      await page.locator('[data-room-picture-problem]').waitFor({ state: 'visible' });
      return (await page.locator('[data-room-picture-problem]').textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    };

    await choose(page, 'drawing.png', 'image/png', png(900, 600));
    await page.locator('[data-room-picture]').waitFor({ state: 'visible' });
    let sent = await send();
    let ruled = roomPictureCheck(new Uint8Array(sent));
    check(
      ruled.ok && ruled.type === 'png' && ruled.width === 900,
      'a PNG that fits is sent as a PNG, no larger than it is',
      ruled.ok ? `${ruled.width} x ${ruled.height}` : ruled.problem,
    );
    check(
      !sent.includes('PRIX-LOCATION-MARK') && !sent.includes('tEXt'),
      'a PNG: its text chunk did not leave the browser',
    );
    await page.locator('button[data-room-picture-discard]').click();

    await choose(page, 'noise.png', 'image/png', png(1400, 1000, true));
    await page.locator('[data-room-picture]').waitFor({ state: 'visible' });
    sent = await send();
    ruled = roomPictureCheck(new Uint8Array(sent));
    check(
      ruled.ok && ruled.type === 'jpeg' && sent.length <= ROOM_PICTURE_MAX_BYTES,
      'a PNG that does not fit goes down the ladder as a JPEG that fits',
      ruled.ok ? `${ruled.type} ${ruled.width} x ${ruled.height}, ${sent.length} bytes` : ruled.problem,
    );
    await page.locator('button[data-room-picture-discard]').click();

    const words = await wordsOf(page);
    const moving = gif(64, 64, 12);
    await choose(page, 'loop.gif', 'image/gif', moving);
    await page.locator('[data-room-picture]').waitFor({ state: 'visible' });
    const gifFacts = (await page.locator('[data-room-picture-facts]').textContent())?.trim() ?? '';
    const movingFacts = words.factsAnimated
      .replace('{frames}', '12')
      .replace('{width}', '64')
      .replace('{height}', '64')
      .replace('{size}', words.sizeKb.replace('{count}', '1'));
    check(gifFacts === movingFacts, 'a GIF: the facts say that it moves, with its frames', gifFacts);
    sent = await send();
    check(Buffer.compare(sent, moving) === 0, 'a GIF is not redrawn: the file is sent as the rule serialised it');
    await page.locator('button[data-room-picture-discard]').click();

    // Refused in the page. The name and the type a browser gives a file are never believed.
    await choose(page, 'holiday.png', 'image/png', webp);
    let said = await problem();
    check(
      said.startsWith(words.refusals.picture_type),
      'refused: a WebP named .png and typed image/png is no picture here',
      said,
    );
    // The figures are the contract's, as the deck prints one: grouped in thousands.
    check(
      said.endsWith(words.limits) &&
        [ROOM_PICTURE_LIMITS.maxKib, ROOM_PICTURE_LIMITS.maxSide].every((figure) =>
          words.limits.includes(figure.toLocaleString('en-US')),
        ),
      'refused: the limits are said under the sentence',
    );
    check(!(await page.locator('[data-room-picture]').isVisible()), 'refused: nothing is chosen');
    check(
      (await page.locator('form[data-room-state="yes"] [data-outlet] .notice').count()) === 0,
      'refused: what an earlier send ended as no longer stands under the form',
    );
    check(
      await add(page).evaluate((button) => button === document.activeElement),
      'refused: focus goes back to "Add a picture"',
    );
    if (shots) await page.screenshot({ path: `${shots}/composer-refused-dark-390.png`, fullPage: true });

    await choose(
      page,
      'page.jpg',
      'image/jpeg',
      Buffer.from('<!doctype html><script>document.title = "ran"</script>'.padEnd(200, ' ')),
    );
    said = await problem();
    check(
      said.startsWith(words.refusals.picture_type) && (await page.title()) !== 'ran',
      'refused: a page named .jpg',
      said,
    );

    await choose(page, 'long.gif', 'image/gif', gif(64, 64, 121));
    said = await problem();
    check(said.startsWith(words.refusals.picture_frames), 'refused: a GIF of 121 frames', said);

    await choose(page, 'wide.gif', 'image/gif', gif(640, 64, 2));
    said = await problem();
    check(said.startsWith(words.refusals.picture_dimensions), 'refused: an animated GIF above 512 pixels', said);

    await choose(page, 'huge.gif', 'image/gif', Buffer.concat([gif(64, 64, 1), Buffer.alloc(ROOM_PICTURE_MAX_BYTES)]));
    said = await problem();
    check(said.startsWith(words.refusals.picture_size), `refused: a GIF above ${ROOM_PICTURE_LIMITS.maxKib} KiB`, said);

    await choose(page, 'broken.jpg', 'image/jpeg', Buffer.concat([photo.subarray(0, 300), Buffer.alloc(200, 3)]));
    said = await problem();
    check(said.startsWith(words.refusals.picture_malformed), 'refused: a JPEG the browser cannot decode', said);

    // A refusal stands directly under the buttons, above the two lines of what is left today, which
    // stand in one stack (the design check's D11).
    const order = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const buttons = document.querySelector('form[data-room-state="yes"] button[type="submit"]')?.parentElement;
      return {
        buttons: buttons?.getBoundingClientRect().bottom ?? null,
        problem: box('[data-room-picture-problem]'),
        line: box('[data-room-left]'),
        pictures: box('[data-room-picture-left]'),
        stacked:
          document.querySelector('[data-room-left]')?.parentElement ===
          document.querySelector('[data-room-picture-left]')?.parentElement,
      };
    });
    check(
      order.buttons !== null &&
        order.problem !== null &&
        order.line !== null &&
        order.pictures !== null &&
        order.problem.height > 0 &&
        order.pictures.height > 0 &&
        order.problem.top >= order.buttons &&
        order.line.top >= order.problem.bottom &&
        order.pictures.top >= order.line.bottom &&
        order.stacked,
      'refused: the refusal stands directly under the buttons, above the two lines of what is left today',
    );

    // A file the rule passes and this browser cannot draw (the design check's D14): no empty preview, the
    // sentence of picture_malformed, nothing chosen and nothing sent. A GIF is sent as the rule serialised
    // it, so the rule alone would have let this one through to the preview.
    const before = (await sentBytes(page))?.length ?? null;
    check(roomPictureCheck(new Uint8Array(undrawable)).ok, 'the sample GIF with unreadable pixels passes the rule');
    await choose(page, 'undrawable.gif', 'image/gif', undrawable);
    said = await problem();
    check(
      said.startsWith(words.refusals.picture_malformed),
      'refused: a GIF the rule passes and the browser cannot draw',
      said,
    );
    check(
      !(await page.locator('[data-room-picture]').isVisible()) &&
        !(await page.locator('canvas[data-room-picture-preview]').isVisible()),
      'refused: a picture the browser cannot draw is not chosen, and there is no empty preview',
    );
    check(
      ((await sentBytes(page))?.length ?? null) === before &&
        (await page.locator('form[data-room-state="yes"] button[type="submit"]').textContent())?.trim() ===
          (await page.locator('form[data-room-state="yes"] button[type="submit"]').getAttribute('data-label')),
      'refused: nothing of it is sent, and the send is the line’s again',
    );

    await choose(page, 'tiny.png', 'image/png', png(10, 10));
    said = await problem();
    check(said.startsWith(words.refusals.picture_dimensions), 'refused: a picture below 16 pixels', said);
    check((await sentBytes(page)) !== null, 'a refused file sends nothing new');
    await page.close();
  }

  // --- a picture sent --------------------------------------------------------------------------------
  {
    const page = await openChat(context, 'signed-in', 'on');
    await choose(page, 'IMG_0042.jpg', 'image/jpeg', photo);
    await page.locator('[data-room-picture]').waitFor({ state: 'visible' });
    const before = await page.locator('[data-room-list] > li').count();
    const [loaded] = await Promise.all([
      page.waitForEvent('load'),
      page.locator('form[data-room-state="yes"] button[type="submit"]').click(),
    ]);
    check(Boolean(loaded), 'sent: after a 201 the page is loaded again');
    await page.waitForLoadState('networkidle');
    check(!(await page.locator('[data-room-picture]').isVisible()), 'sent: after the reload no picture is chosen');
    // The sample server stores nothing, so a page that shows a row more than before made it from the answer.
    const after = await page.locator('[data-room-list] > li').count();
    check(
      after === before,
      'sent: nothing of the answer was put into the page',
      `${before} rows before, ${after} after`,
    );
    await page.close();
  }

  // --- a report --------------------------------------------------------------------------------------
  // The rows are the other owner's and the press and its answer are this one's, so this is where the two
  // meet: the list's mark set from `me`, the button the stylesheet then shows in a row whose picture is
  // shown, the question set into the row's own note, and the sentence of the answer. A sample build has
  // no bytes route: the one picture a row asks for is answered here, with a PNG this driver draws. Where
  // the served page has no list yet, the row is the stand-in's, and "shown" is its attribute alone.
  {
    const picturesAt = roomPicturePath(1).slice(0, -1);
    /** Opens /chat and hands back the first row that offers a picture, with that picture shown. */
    const openRow = async (fixture, name, from = context) => {
      const page = await openChat(from, fixture, 'on');
      await page.route(
        (url) => url.pathname.startsWith(picturesAt),
        (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png(320, 240) }),
      );
      check(
        (await page.locator('[data-room-list][data-room-report-on]').count()) === 1,
        `${name}: the served list carries data-room-report-on`,
      );
      const row = standIn
        ? page.locator('[data-room-list] [data-room-picture-id]').first()
        : page
            .locator('[data-room-list] [data-room-picture-id]')
            .filter({ has: page.locator('button[data-room-picture-toggle]') })
            .first();
      const toggle = row.locator('button[data-room-picture-toggle]');
      const report = row.locator('[data-room-picture-report]');
      if (!standIn) {
        check(!(await report.isVisible()), `${name}: "Report" is not shown before the picture is`);
        await toggle.click();
        await row.locator('img').waitFor({ state: 'visible' });
        check(await report.isVisible(), `${name}: "Report" is shown in the row of a shown picture`);
      }
      const hide = () =>
        standIn ? row.evaluate((element) => element.removeAttribute('data-room-picture-shown')) : toggle.click();
      return { page, row, report, hide, note: row.locator('[data-room-picture-report-note]') };
    };
    const sentReports = (page) => page.evaluate(() => globalThis.prixSampleReports ?? 0);
    const focusOn = (locator) => locator.evaluate((element) => element === document.activeElement);
    const answers = (row) => row.locator('[data-room-picture-report-yes], [data-room-picture-report-no]');
    /** The question as the server rendered it, once, in the composer's template. */
    const questionOf = (page) =>
      page.evaluate(
        () =>
          document.querySelector('template[data-room-report-ask]')?.content.querySelector('.room-report-ask')
            ?.textContent ?? null,
      );
    const asks = async (page, row) =>
      (await row.locator('[data-room-picture-report-note] .room-report-ask').count()) === 1 &&
      (await row.locator('[data-room-picture-report-note] .room-report-ask').textContent()) ===
        (await questionOf(page)) &&
      (await answers(row).count()) === 2;

    // "Report picture" asks once before it reports (the security review's P2), and what closes the question.
    {
      const { page, row, report, hide, note } = await openRow('signed-in', 'a report asks first');
      check((await note.textContent()) === '', 'a report asks first: the row’s note is empty before a press');
      await report.click();
      check(
        (await questionOf(page)) !== null && (await asks(page, row)),
        'a report asks first: the first press sets the question and its two answers into the row’s note',
        (await note.textContent())?.replace(/\s+/g, ' ').trim(),
      );
      check((await sentReports(page)) === 0, 'a report asks first: the first press sends nothing');
      check(await focusOn(note), 'a report asks first: the question takes the focus, the note itself');
      check(
        !(await focusOn(row.locator('[data-room-picture-report-yes]'))) &&
          !(await focusOn(row.locator('[data-room-picture-report-no]'))),
        'a report asks first: neither of its two buttons has the focus',
      );
      if (shots) await row.screenshot({ path: `${shots}/report-question.png` });

      // A second press of the same key or on the same spot reports nothing.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await report.click();
      await report.dblclick();
      check(
        (await sentReports(page)) === 0 && (await asks(page, row)),
        'a report asks first: Enter twice, Space and more presses on "Report" send nothing, and the one question stays',
      );

      // The no restores the row as it was.
      await row.locator('[data-room-picture-report-no]').click();
      check(
        (await note.textContent()) === '' &&
          (await answers(row).count()) === 0 &&
          (await note.getAttribute('tabindex')) === null,
        'the no: the note is as it was',
      );
      check(await focusOn(report), 'the no: the focus is back on "Report"');
      check(
        (await sentReports(page)) === 0 && !(await report.isDisabled()),
        'the no: nothing was sent, and "Report" is open',
      );

      // From the keyboard alone: Enter on "Report" opens the question, and a held Enter reports nothing.
      await page.keyboard.down('Enter');
      for (let again = 0; again < 8; again += 1) await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      check(
        (await sentReports(page)) === 0 && (await asks(page, row)) && (await focusOn(note)),
        'from the keyboard: Enter held on "Report" opens the question once and reports nothing',
      );

      // "Hide picture" closes an open question as the no closes it, without moving the focus.
      const held = await page.evaluate(() => {
        const marked = document.activeElement;
        marked?.setAttribute('data-driver-focus', '');
        return marked !== null;
      });
      await hide();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-room-picture-report-yes], [data-room-picture-report-no]').length === 0,
      );
      check(
        (await note.textContent()) === '' && (await sentReports(page)) === 0,
        'hidden while the question is open: the question closes, and nothing is sent',
      );
      const after = await page.evaluate(() => ({
        report: document.activeElement?.hasAttribute('data-room-picture-report') ?? false,
        kept: document.activeElement?.hasAttribute('data-driver-focus') ?? false,
        toggle: document.activeElement?.hasAttribute('data-room-picture-toggle') ?? false,
      }));
      check(
        held && !after.report && (after.kept || after.toggle),
        'hidden while the question is open: the focus is not moved to "Report"',
        JSON.stringify(after),
      );
      await page.close();
    }

    for (const [fixture, expected, name] of [
      ['signed-in', (words) => words.reportDone, 'a report: 204 says the one sentence'],
      [
        'signed-in,social-room-report-own',
        (words) => words.refusals.report_own,
        'a report of the wallet’s own picture says so',
      ],
      [
        'signed-in,social-room-report-closed',
        (words) => words.reportClosed,
        'a report the server answers 404 says the picture takes none',
      ],
    ]) {
      const { page, row, report, note } = await openRow(fixture, name);
      await report.focus();
      await page.keyboard.press('Enter');
      check((await sentReports(page)) === 0 && (await focusOn(note)), `${name}: the press asks, and sends nothing`);
      // The yes, from the keyboard: Tab from the note reaches the first of its two buttons.
      await page.keyboard.press('Tab');
      check(
        await focusOn(row.locator('[data-room-picture-report-yes]')),
        `${name}: Tab from the question reaches its yes`,
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (globalThis.prixSampleReports ?? 0) > 0);
      await note.filter({ hasText: expected(await wordsOf(page)) }).waitFor({ state: 'visible' });
      const said = (await note.textContent()) ?? '';
      check(said === expected(await wordsOf(page)), name, said);
      check((await sentReports(page)) === 1, `${name}: the yes sends one report`);
      check((await answers(row).count()) === 0, `${name}: the question’s two buttons are removed, not disabled`);
      check(await focusOn(note), `${name}: the focus is on the note with the answer, not lost to the page`);
      check(await report.isDisabled(), `${name}: "Report" is closed for this page load`);
      await report.click({ force: true });
      await page.keyboard.press('Enter');
      check(
        (await sentReports(page)) === 1 && (await note.textContent()) === said,
        `${name}: no later press sends a second report`,
      );
      if (shots && fixture === 'signed-in') await row.screenshot({ path: `${shots}/report-answered.png` });
      await page.close();
    }

    // Two presses at one point where the question's two buttons wrap (the second confirming look, P2).
    // In a window this narrow "Report picture" wraps under "Hide picture", into the column where the
    // question's yes then stands. With "Report picture" just above the window's foot the question's note
    // is cut by it, the focus scrolls the page, and the yes comes to lie under the pointer: the second
    // press is on the yes. A pointer's press on the yes is no answer until the question has stood for a
    // moment. A key's press is one at once: a key reaches the yes only by Tab, never by a second press.
    /** Every click the page sees, in the page's own time, and what it was on: before the page's script runs. */
    const watchClicks = (page) =>
      page.evaluate(() => {
        globalThis.prixDriverClicks = [];
        document.addEventListener(
          'click',
          (event) => {
            const on = event.target instanceof Element ? event.target : null;
            globalThis.prixDriverClicks.push({
              at: performance.now(),
              count: event.detail,
              on: on?.closest('[data-room-picture-report-yes]')
                ? 'yes'
                : on?.closest('[data-room-picture-report-no]')
                  ? 'no'
                  : on?.closest('[data-room-picture-report]')
                    ? 'report'
                    : 'other',
            });
          },
          true,
        );
      });
    const clicksOf = (page) => page.evaluate(() => globalThis.prixDriverClicks);
    /** Milliseconds after the question opened by which a pointer's yes counts again, with room to spare. */
    const STOOD = 1_000;
    for (const [width, height, by] of [
      [280, 640, 'mouse'],
      [260, 600, 'mouse'],
      [280, 640, 'touch'],
    ]) {
      for (const gap of by === 'touch' ? [120] : [0, 120, 300, 500]) {
        const narrow = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 1,
          hasTouch: by === 'touch',
        });
        await narrow.addCookies([{ name: 'prix_theme', value: 'dark', url: origin }]);
        const name = `two ${by === 'touch' ? 'taps' : 'clicks'} at one point, ${width} x ${height}, ${gap} ms apart`;
        const { page, row, report } = await openRow('signed-in', name, narrow);
        const press = (x, y) => (by === 'touch' ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
        // "Report" 10 px above the window's foot: the question's note then lies below the foot.
        await report.evaluate((element) => element.scrollIntoView({ block: 'end' }));
        await page.evaluate(() => window.scrollBy(0, 10));
        await watchClicks(page);
        const at = await report.boundingBox();
        const x = at.x + at.width / 2;
        const y = at.y + at.height / 2;
        check(
          Math.round(height - at.y - at.height) === 10,
          `${name}: "Report" stands 10 px above the window’s foot`,
          `${Math.round(height - at.y - at.height)} px`,
        );
        await press(x, y);
        if (gap > 0) await wait(gap);
        await press(x, y);
        await wait(400);
        const [first, second] = await clicksOf(page);
        const apart = first && second ? Math.round(second.at - first.at) : null;
        check(
          first?.on === 'report' && second?.on === 'yes' && second.count > 0,
          `${name}: the page scrolled, and the second press came down on the question’s yes`,
          `on ${second?.on ?? 'nothing'}, ${apart ?? '?'} ms after the first`,
        );
        const sentThen = await sentReports(page);
        check(
          sentThen === 0 && (await asks(page, row)),
          `${name}: nothing is sent, and the question stays open`,
          `sent ${sentThen}, the second press ${apart ?? '?'} ms after the first`,
        );
        // A yes pressed once the question has stood reports, once.
        await page.waitForFunction(([opened, stood]) => performance.now() - opened > stood, [first?.at ?? 0, STOOD]);
        const stillAsked = row.locator('[data-room-picture-report-yes]');
        const yes = (await stillAsked.count()) === 1 ? await stillAsked.boundingBox() : null;
        if (yes) {
          await press(yes.x + yes.width / 2, yes.y + yes.height / 2);
          await page
            .waitForFunction(() => (globalThis.prixSampleReports ?? 0) > 0, null, { timeout: 5_000 })
            .catch(() => undefined);
          await press(yes.x + yes.width / 2, yes.y + yes.height / 2);
          await press(yes.x + yes.width / 2, yes.y + yes.height / 2);
          await wait(200);
        }
        check(
          yes !== null && (await sentReports(page)) === 1 && (await answers(row).count()) === 0,
          `${name}: a yes pressed once the question has stood reports, once`,
          `sent ${await sentReports(page)}`,
        );
        await narrow.close();
      }
    }

    // The keyboard's path does not wait: Enter on "Report", Tab to the yes, Enter, as fast as keys go.
    {
      const name = 'from the keyboard, at once';
      const { page, row, report } = await openRow('signed-in', name);
      await report.focus();
      await watchClicks(page);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page
        .waitForFunction(() => (globalThis.prixSampleReports ?? 0) > 0, null, { timeout: 5_000 })
        .catch(() => undefined);
      const [first, second] = await clicksOf(page);
      const apart = first && second ? Math.round(second.at - first.at) : null;
      check(
        first?.on === 'report' && second?.on === 'yes' && second.count === 0,
        `${name}: the second click is a key’s, on the yes`,
        `on ${second?.on ?? 'nothing'}, ${apart ?? '?'} ms after the first`,
      );
      check(
        (await sentReports(page)) === 1 && (await answers(row).count()) === 0,
        `${name}: Enter, Tab and Enter report once, however soon`,
        `sent ${await sentReports(page)}, the yes ${apart ?? '?'} ms after the question opened`,
      );
      await page.close();
    }

    const old = await openChat(context, 'signed-in,social-room-me-pic-none', 'on');
    check(
      (await old.locator('[data-room-list]').count()) === 1 &&
        (await old.locator('[data-room-report-on]').count()) === 0,
      'an answer of me without `report` switches no report on',
    );
    await old.close();
  }

  // --- the composer at three widths, both themes -----------------------------------------------------
  for (const theme of ['dark', 'light']) {
    for (const width of [360, 390, 1440]) {
      const sized = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      await sized.addCookies([{ name: 'prix_theme', value: theme, url: origin }]);
      const page = await openChat(sized, 'signed-in', 'on', theme);
      await choose(page, 'IMG_0042.jpg', 'image/jpeg', photo);
      await page.locator('canvas[data-room-picture-preview]').waitFor({ state: 'visible' });
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      check(fits, `${theme} ${width}: the composer with a picture has no sideways scroll`);
      if (shots)
        await page.locator('.room-composer').screenshot({ path: `${shots}/composer-picked-${theme}-${width}.png` });
      await sized.close();
    }
  }

  // --- the admins' page ------------------------------------------------------------------------------
  const picture = png(320, 240);
  for (const theme of ['dark', 'light']) {
    for (const width of [360, 390, 1440]) {
      const sized = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      await sized.addCookies([{ name: 'prix_theme', value: theme, url: origin }]);
      const page = await sized.newPage();
      const asked = [];
      /** How long the bytes of a look take, and whether the next look fails: set by the cases below. */
      let bytesAfter = 0;
      let failNext = false;
      await page.route(/\/api\/social\/admin\/room\/pictures\/\d+$/, async (route) => {
        asked.push(new URL(route.request().url()).pathname);
        if (failNext) {
          failNext = false;
          await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }).catch(() => undefined);
          return;
        }
        if (bytesAfter > 0) await wait(bytesAfter);
        // A picture that was hidden meanwhile no longer waits for its bytes.
        await route.fulfill({ status: 200, contentType: 'image/png', body: picture }).catch(() => undefined);
      });
      await page.goto(`${origin}/admin/chat?fixture=signed-in-admin&theme=${theme}`, { waitUntil: 'networkidle' });
      const where = `admins ${theme} ${width}`;
      const fits = () =>
        page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      check(await fits(), `${where}: no sideways scroll`);
      // A card's title stands the same distance above its first row in all three cards (the second design
      // look): a list set directly under its title read as a title with a date.
      const under = await page.evaluate(() =>
        ['room-switch-heading', 'room-pictures-heading', 'room-messages-heading'].map((id) => {
          const head = document.getElementById(id)?.closest('.acct-card-head');
          const next = head?.nextElementSibling;
          const first = next?.querySelector('li') ?? next;
          return head && first
            ? Math.round(first.getBoundingClientRect().top - head.getBoundingClientRect().bottom)
            : null;
        }),
      );
      check(
        under[0] !== null && under[0] > 0 && under.every((gap) => gap === under[0]),
        `${where}: the title of each of the three cards stands the same distance above its first row`,
        under.map((gap) => `${gap} px`).join(' | '),
      );
      if (shots) await page.screenshot({ path: `${shots}/admin-${theme}-${width}.png`, fullPage: true });
      if (theme !== 'dark' || width !== 390) {
        await sized.close();
        continue;
      }

      const reported = page.locator('[data-room-reported]');
      check((await reported.locator('li[data-scope]').count()) === 2, 'admins: two reported pictures wait');
      const first = reported.locator('li[data-scope]').nth(1);
      const row = (await first.textContent())?.replace(/\s+/g, ' ') ?? '';
      check(row.includes('0x6666666666666666666666666666666666666666'), 'admins: the writer’s whole address');
      check(
        row.includes('0x7777777777777777777777777777777777777777') &&
          row.includes('0x8888888888888888888888888888888888888888'),
        'admins: the reporters’ whole addresses',
      );
      const factsLine = (await first.locator('.room-admin-facts').textContent()) ?? '';
      check(
        ['JPEG', '1,600', '1,200', '207'].every((part) => factsLine.includes(part)) && !factsLine.includes('1600'),
        'admins: the facts of the file, its sides printed grouped',
        factsLine,
      );
      const chips = await first.locator('.cluster .chip').allTextContents();
      check(
        row.includes('bbbbbbbbbbbb') && chips.some((chip) => /\b3\b/.test(chip)),
        'admins: the first 12 hex of the hash, and the count of reports',
        chips.join(' | '),
      );
      check(
        (await page.locator('img').count()) === 0 && asked.length === 0,
        'admins: before a press the page holds no image and asks for none',
      );
      const gone = reported.locator('li[data-scope]').nth(0);
      check(
        (await gone.locator('button[data-room-look]').count()) === 0 &&
          (await gone.locator('.room-look-none').count()) === 1,
        'admins: a picture that is not viewable gets no "Show picture", and a sentence in its place',
      );
      check(
        (await page.locator('[data-room-switch="on"] button[data-room-act="pictures-off"]').count()) === 1,
        'admins: pictures are on, and the one control is the one that switches them off',
      );
      const titles = await page.evaluate(() =>
        ['room-switch-heading', 'room-pictures-heading', 'room-messages-heading'].map(
          (id) => document.getElementById(id)?.textContent?.trim() ?? '',
        ),
      );
      check(
        titles.every((title) => title.length > 0) && new Set(titles).size === 3,
        'admins: the card of the switch, of the reported pictures and of all messages each have a title',
        titles.join(' | '),
      );

      // The look: one press, blurred; "Hide picture" in the place of "Show picture" and with the focus;
      // "Unblur picture" only once the bytes have loaded, beside it and with no focus; the picture's place
      // under the buttons, in the picture's own proportion before a byte arrives; then out again.
      const boxOf = (locator) =>
        locator.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            x: Math.round(box.x + scrollX),
            y: Math.round(box.y + scrollY),
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        });
      const same = (one, other) => JSON.stringify(one) === JSON.stringify(other);
      const showButton = first.locator('button[data-room-look="show"]');
      const hideButton = first.locator('button[data-room-look="hide"]');
      const unblurButton = first.locator('button[data-room-look="unblur"]');
      const place = first.locator('[data-room-look-place]');
      check(
        (await showButton.isVisible()) && !(await hideButton.isVisible()) && !(await unblurButton.isVisible()),
        'the look: before a press only "Show picture" is offered',
      );
      await showButton.scrollIntoViewIfNeeded();
      const showAt = await boxOf(showButton);
      const unblurAt = await boxOf(unblurButton);
      bytesAfter = 1500;
      await showButton.click();
      const image = first.locator('img');
      await image.waitFor({ state: 'attached' });
      // The bytes are on their way and have not arrived.
      check(
        await hideButton.evaluate((button) => button === document.activeElement),
        'the look: after "Show picture" the focus is on "Hide picture"',
      );
      check(
        same(await boxOf(hideButton), showAt) && !(await showButton.isVisible()),
        'the look: "Hide picture" stands exactly where "Show picture" stood',
        `${JSON.stringify(showAt)} then ${JSON.stringify(await boxOf(hideButton))}`,
      );
      check(
        !(await unblurButton.isVisible()) && (await unblurButton.evaluate((button) => !button.matches(':focus'))),
        'the look: "Unblur picture" is not offered before the bytes have loaded',
      );
      const kept = await boxOf(place);
      const controlsBottom = await first
        .locator('.room-look-controls')
        .evaluate((element) => Math.round(element.getBoundingClientRect().bottom + scrollY));
      check(
        kept.y >= controlsBottom,
        'the look: the picture’s place stands under the buttons',
        `the buttons end at ${controlsBottom}, the place begins at ${kept.y}`,
      );
      check(
        kept.height > 0 && Math.abs(kept.width / kept.height - 1600 / 1200) < 0.02,
        'the look: before a byte arrives the place has the picture’s proportion, from the server’s two numbers',
        `${kept.width} x ${kept.height}`,
      );
      check(
        await place.evaluate((element) => getComputedStyle(element).borderRadius === '0px'),
        'the look: the place has square corners',
      );
      await unblurButton.waitFor({ state: 'visible' });
      check(
        asked.length === 1 && asked[0] === '/api/social/admin/room/pictures/50',
        'the look: one press asks for one picture, by the message’s id',
        asked.join(' '),
      );
      check(
        same(await boxOf(hideButton), showAt) &&
          same(await boxOf(unblurButton), unblurAt) &&
          same(await boxOf(place), kept),
        'the look: no control and no place moved when the bytes came',
      );
      check(
        (await hideButton.evaluate((button) => button === document.activeElement)) &&
          unblurAt.x >= showAt.x + showAt.width,
        'the look: "Unblur picture" appeared beside "Hide picture" and took no focus',
      );
      const look = await image.evaluate((img) => ({
        blurred: getComputedStyle(img).filter !== 'none',
        width: img.getAttribute('width'),
        height: img.getAttribute('height'),
        referrer: img.referrerPolicy,
        linked: img.closest('a') !== null,
        alt: img.alt,
        shown: Math.round(img.getBoundingClientRect().height),
      }));
      check(look.blurred, 'the look: the picture is blurred first');
      check(look.width === '1600' && look.height === '1200', 'the look: its box is the server’s own numbers');
      check(look.referrer === 'no-referrer' && !look.linked, 'the look: no referrer, and never a link');
      check(look.shown <= 192, 'the look: blurred, it is held small', `${look.shown} pixels high`);
      check(
        look.alt === 'Picture posted by 0x6666…6666',
        'the look: the alternative text names the writer only',
        look.alt,
      );
      if (shots) await page.screenshot({ path: `${shots}/admin-look-blurred.png`, fullPage: true });
      check(await fits(), 'the look: no sideways scroll with a picture shown');
      await unblurButton.click();
      check(
        await image.evaluate((img) => getComputedStyle(img).filter === 'none'),
        'the look: "Unblur picture" is a second, deliberate press',
      );
      const whole = await boxOf(image);
      check(
        whole.height > look.shown && whole.height <= 320 && same(whole, kept),
        'the look: unblurred, the picture fills the place kept for it, at most as tall as the public list’s',
        `${whole.width} x ${whole.height}, blurred it was ${look.shown} high`,
      );
      check(
        !(await unblurButton.isVisible()) &&
          (await hideButton.evaluate((button) => button === document.activeElement)) &&
          same(await boxOf(hideButton), showAt),
        'the look: after "Unblur picture" the focus is on "Hide picture", which has not moved',
      );
      if (shots) await page.screenshot({ path: `${shots}/admin-look-whole.png`, fullPage: true });
      await hideButton.click();
      check(
        (await page.locator('img').count()) === 0 && asked.length === 1,
        'the look: "Hide picture" takes the image out, and nothing was asked twice',
      );
      check(
        (await showButton.evaluate((button) => button === document.activeElement)) &&
          same(await boxOf(showButton), showAt) &&
          !(await unblurButton.isVisible()),
        'the look: "Show picture" is back in its place with the focus, and "Unblur picture" is gone',
      );

      // A second press on the same spot never unblurs (the security review's P1, the design check's D1).
      // Each case starts on a page loaded again, since a browser hands a picture it already holds for a
      // document straight back, whatever the route would answer. It ends with no picture that was ever
      // whole: a recorder in the page notes any image without its blur, at any moment.
      const adminPage = `${origin}/admin/chat?fixture=signed-in-admin&theme=${theme}`;
      const fresh = async () => {
        await page.goto(adminPage, { waitUntil: 'networkidle' });
        await page.evaluate(() => {
          globalThis.driverEverWhole = false;
          const look = () => {
            for (const each of document.querySelectorAll('[data-room-look-of] img')) {
              if (!each.classList.contains('room-look--blurred') || getComputedStyle(each).filter === 'none') {
                globalThis.driverEverWhole = true;
              }
            }
          };
          new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
        });
        await showButton.scrollIntoViewIfNeeded();
      };
      const settle = async (name) => {
        // Longer than the bytes take, so a load that comes late is seen too.
        await wait(bytesAfter + 600);
        const ended = await page.evaluate(() => ({
          everWhole: globalThis.driverEverWhole,
          images: [...document.querySelectorAll('[data-room-look-of] img')].map(
            (each) => getComputedStyle(each).filter !== 'none',
          ),
          unblur: (() => {
            const step = document.querySelectorAll('[data-room-look-step="unblur"]:not([data-room-look-away])');
            return step.length;
          })(),
        }));
        check(
          !ended.everWhole && ended.images.every(Boolean),
          `a second press never unblurs: ${name}`,
          ended.images.length === 0 ? 'ends hidden' : `ends blurred${ended.unblur ? ', "Unblur picture" offered' : ''}`,
        );
      };
      /** The middle of "Show picture" in the window, where the pointer presses. */
      const middle = () =>
        showButton.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
      for (const delay of [1500, 0]) {
        const bytes = delay === 0 ? 'the bytes at once' : `the bytes after ${delay} ms`;
        const cases = [
          ...[0, 120, 300, 500].map((apart) => [
            `two clicks at one point ${apart} ms apart, ${bytes}`,
            async () => {
              const centre = await middle();
              await page.mouse.click(centre.x, centre.y);
              if (apart > 0) await wait(apart);
              await page.mouse.click(centre.x, centre.y);
            },
          ]),
          [
            `a double click, ${bytes}`,
            async () => {
              const centre = await middle();
              await page.mouse.dblclick(centre.x, centre.y);
            },
          ],
          [
            `Enter twice, ${bytes}`,
            async () => {
              await showButton.focus();
              await page.keyboard.press('Enter');
              await page.keyboard.press('Enter');
            },
          ],
          [
            `Enter held for more than a second, ${bytes}`,
            async () => {
              await showButton.focus();
              await page.keyboard.down('Enter');
              for (let again = 0; again < 40; again += 1) {
                await page.keyboard.down('Enter');
                await wait(30);
              }
              await page.keyboard.up('Enter');
            },
          ],
          [
            `Space twice, ${bytes}`,
            async () => {
              await showButton.focus();
              await page.keyboard.press('Space');
              await page.keyboard.press('Space');
            },
          ],
          [
            `Enter, and Enter again once the bytes have loaded, ${bytes}`,
            async () => {
              await showButton.focus();
              await page.keyboard.press('Enter');
              await unblurButton.waitFor({ state: 'visible' });
              await page.keyboard.press('Enter');
            },
          ],
          [
            `three presses of Enter, ${bytes}`,
            async () => {
              await showButton.focus();
              await page.keyboard.press('Enter');
              await page.keyboard.press('Enter');
              await page.keyboard.press('Enter');
            },
          ],
        ];
        for (const [name, press] of cases) {
          bytesAfter = 0;
          await fresh();
          bytesAfter = delay;
          await press();
          await settle(name);
        }
      }
      bytesAfter = 0;

      // A load that failed: the sentence the server rendered, nothing asked again, and "Show picture" back.
      await fresh();
      failNext = true;
      await showButton.focus();
      await page.keyboard.press('Enter');
      const failedSaid = first.locator('[data-room-look-failed]');
      await failedSaid.waitFor({ state: 'visible' });
      const askedThen = asked.length;
      check(
        (await page.locator('[data-room-look-of] img').count()) === 0 &&
          (await showButton.isVisible()) &&
          !(await hideButton.isVisible()) &&
          !(await unblurButton.isVisible()),
        'the look, a load that failed: no picture, and "Show picture" is offered again',
      );
      check(
        await failedSaid.evaluate((element) => element === document.activeElement),
        'the look, a load that failed: the sentence takes the focus, so a held key asks for nothing again',
      );
      await wait(400);
      check(asked.length === askedThen, 'the look, a load that failed: nothing asks again by itself');
      await fresh();

      // Remove, keep and the switch: each asks first, and each result is said in words after the reload.
      // The sentences are the page's own: what the server rendered for the act, never a draft typed here.
      for (const [act, done] of [
        ['remove', 'room-picture-removed'],
        ['keep', 'room-picture-kept'],
        ['pictures-off', 'room-pictures-off'],
      ]) {
        const target =
          act === 'pictures-off'
            ? page.locator('[data-room-switch]')
            : page.locator('[data-room-reported] li[data-scope]').nth(1);
        const group = target.locator('[data-confirm]').filter({ has: page.locator(`button[data-room-act="${act}"]`) });
        check(
          !(await group.locator(`button[data-room-act="${act}"]`).isVisible()),
          `${act}: nothing runs from the first press`,
        );
        await group.locator('[data-confirm-ask]').click();
        const asks = await group.locator('[data-confirm-panel] p.body').allTextContents();
        check(
          asks.length === 2 && asks.every((sentence) => sentence.trim().length > 10),
          `${act}: a question, and what a yes leads to`,
          asks.map((sentence) => sentence.trim()).join(' | '),
        );
        const expected = await page.evaluate(
          (name) =>
            document.querySelector(`template[data-done="${name}"]`)?.content.querySelector('.notice-title')
              ?.textContent ?? null,
          done,
        );
        await Promise.all([page.waitForEvent('load'), group.locator(`button[data-room-act="${act}"]`).click()]);
        await page.waitForLoadState('networkidle');
        const said = (await page.locator('[data-done-outlet] .notice-title').textContent())?.trim() ?? '';
        check(
          expected !== null && said === expected.trim(),
          `${act}: the result is said in words after the reload`,
          said,
        );
      }
      await sized.close();
    }
  }

  // --- the other states of the admins' page ----------------------------------------------------------
  {
    const page = await context.newPage();
    const at = (fixture) =>
      page.goto(`${origin}/admin/chat?fixture=${encodeURIComponent(fixture)}&theme=dark`, { waitUntil: 'networkidle' });
    await at('signed-in-admin,social-room-pics-off');
    let said = (await page.locator('[data-room-switch="off"]').textContent())?.replace(/\s+/g, ' ') ?? '';
    const onControl = () => page.locator('[data-room-switch="off"] button[data-room-act="pictures-on"]').count();
    check(
      said.includes('2026') &&
        said.includes('12:04') &&
        said.includes('0x5555555555555555555555555555555555555555') &&
        (await onControl()) === 1,
      'admins, off by an admin: since when, by whom, and the one control is the one that switches them on',
      said.slice(0, 160),
    );
    if (shots) await page.screenshot({ path: `${shots}/admin-pictures-off.png`, fullPage: true });
    const byAdmin =
      (await page.locator('[data-room-switch="off"] .room-switch-by').textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    await at('signed-in-admin,social-room-pics-auto-off');
    said =
      (await page.locator('[data-room-switch="off"] .room-switch-by').textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    // Which count is the deck's to word (it names the hour or the day, and no figure): a sentence of its
    // own, not the one an admin's switch gets, and with no wallet in it.
    check(
      /\b(?:hour|day)\b/.test(said) && said !== byAdmin && !/0x[0-9a-f]{40}/.test(said) && (await onControl()) === 1,
      'admins, off by a count: which count, and no wallet',
      said.slice(0, 160),
    );
    await at('signed-in-admin,social-room-pics-none');
    check(
      (await page.locator('[data-room-reported] .room-reported-none').count()) === 1 &&
        (await page.locator('[data-room-reported] li').count()) === 0,
      'admins: an empty reported section says so in one sentence',
    );
    await at('signed-in-admin,social-room-pics-many');
    check(
      (await page.locator('[data-room-reported] .room-reported-more').count()) === 1,
      'admins: more reported pictures than shown is said',
    );
    const failedRead = await at('signed-in-admin,social-room-pics-fails');
    check(
      failedRead?.status() === 200 &&
        (await page.locator('section[aria-labelledby="room-pictures-heading"] .notice--error').count()) === 1 &&
        (await page.locator('.room-admin-row').count()) > 0,
      'admins: a failed read of the reported pictures is said in its place, and the messages still show',
    );
    await at('signed-in-admin,social-room-pics-old-api');
    check(
      (await page.locator('[data-room-reported], [data-room-switch], [data-room-look-of]').count()) === 0,
      'admins, an API older than pictures: nothing of pictures is shown',
    );
    check(
      (await page.locator('.room-admin-row').count()) === 6,
      'admins, an API older than pictures: the six messages show as before',
    );
    await at('signed-in-admin,social-room-mod-gone');
    const group = page.locator('[data-room-reported] li[data-scope]').nth(1).locator('[data-confirm]').first();
    await group.locator('[data-confirm-ask]').click();
    await group.locator('button[data-room-act="remove"]').click();
    const outlet = page.locator('[data-room-reported] li[data-scope]').nth(1).locator('[data-outlet]');
    await outlet.locator('.notice').waitFor({ state: 'visible' });
    const notRemoved = await page.evaluate(
      () =>
        document.querySelector('template[data-room-message="remove-failed"]')?.content.querySelector('.notice-title')
          ?.textContent ?? null,
    );
    const shownTitle = (await outlet.locator('.notice-title').textContent()) ?? '';
    check(
      notRemoved !== null && shownTitle.trim() === notRemoved.trim(),
      'admins: a removal that failed says so in the row, and the page stays',
      (await outlet.textContent())?.replace(/\s+/g, ' ').trim(),
    );
    const signedOut = await (await fetch(`${origin}/admin/chat?fixture=signed-out`)).text();
    check(
      !signedOut.includes('data-room-reported') &&
        !signedOut.includes('data-room-switch') &&
        !/0x[0-9a-f]{40}/.test(signedOut),
      'admins, signed out: no control, no picture and no address',
    );
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
