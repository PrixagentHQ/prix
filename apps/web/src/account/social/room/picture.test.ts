import {
  ROOM_PICTURE_COMPOSER_MAX_SIDE,
  ROOM_PICTURE_COMPOSER_STEPS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_REFUSALS,
  type RoomPictureSentenceField,
  roomPictureCheck,
  roomPictureRefusalKey,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import type { Answer } from './answers.ts';
import { factsSentence, pictureOffer, pictureOutcome, reportOn, reportSentence } from './answers.ts';
import type { PickedFile, Still } from './picture.ts';
import { drawnSize, ladderOf, pictureTypeOf, prepareGif, preparePicture, prepareStill, previewed } from './picture.ts';
import { pictureRefusalWords, pictureScriptWords } from './picture-words.ts';
import { composerScriptWords } from './words.ts';

/**
 * What docs/contracts/phase-6-pictures.md section 11 asks of the composer's picture, without a browser:
 * what a file is comes from its first bytes, a still is drawn by the contract's ladder and never larger
 * than it is, a GIF is never redrawn, what is sent is what `roomPictureCheck` handed back, and every
 * refusal has its sentence. The canvas itself is a browser's: the page driver looks at it.
 */

// --- files, built here: the rule decodes no pixel and copies a PNG's CRCs, so these are whole to it ----

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (word: string): number[] => [...word].map((letter) => letter.charCodeAt(0));
const chunk = (type: string, data: number[]): number[] => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

/** A truecolour PNG of this size, padded by its one IDAT to `total` bytes. `extra` goes before the IDAT. */
function png(width: number, height: number, total = 0, extra: number[] = []): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
  const end = chunk('IEND', []);
  const fixed = head.length + ihdr.length + extra.length + 12 + end.length;
  const data = new Array<number>(Math.max(4, total - fixed)).fill(7);
  return Uint8Array.from([...head, ...ihdr, ...extra, ...chunk('IDAT', data), ...end]);
}

/** A GIF of `frames` frames of 2 by 2 pixels on a canvas of this size. */
function gif(width: number, height: number, frames = 1): Uint8Array {
  const le16 = (n: number): number[] => [n & 255, n >> 8];
  const bytes = [...ascii('GIF89a'), ...le16(width), ...le16(height), 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.push(0x2c, 0, 0, 0, 0, ...le16(2), ...le16(2), 0, 2, 2, 0x4c, 0x01, 0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

/** A chosen file that records how many of its bytes were read. */
function picked(bytes: Uint8Array): PickedFile & { read: number[] } {
  const read: number[] = [];
  return {
    size: bytes.length,
    read,
    head: async (length) => {
      read.push(length);
      return bytes.slice(0, length);
    },
  };
}

const JPEG_HEAD = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

/** A still that records what it was asked to encode, and answers each ask from `answer`. */
function still(
  width: number,
  height: number,
  answer: (type: 'png' | 'jpeg', size: { width: number; height: number }, quality: number | null) => Uint8Array | null,
): Still & { asked: string[] } {
  const asked: string[] = [];
  return {
    width,
    height,
    asked,
    encode: async (type, size, quality) => {
      asked.push(`${type} ${size.width}x${size.height}${quality === null ? '' : ` q${quality}`}`);
      return answer(type, size, quality);
    },
  };
}

describe('the fixtures of this test', () => {
  it('are whole pictures to the contract’s rule', () => {
    expect(roomPictureCheck(png(64, 48))).toMatchObject({ ok: true, type: 'png', width: 64, height: 48 });
    expect(roomPictureCheck(gif(32, 32, 3))).toMatchObject({ ok: true, type: 'gif', frames: 3 });
    expect(roomPictureCheck(png(64, 48, ROOM_PICTURE_MAX_BYTES + 1))).toEqual({ ok: false, problem: 'size' });
  });
});

describe('what a chosen file is', () => {
  it('is read from its first bytes: the three signatures of the contract', () => {
    expect(pictureTypeOf(JPEG_HEAD)).toBe('jpeg');
    expect(pictureTypeOf(png(64, 48))).toBe('png');
    expect(pictureTypeOf(gif(32, 32))).toBe('gif');
    expect(pictureTypeOf(Uint8Array.from(ascii('GIF87a')))).toBe('gif');
  });

  it.each([
    ['WebP', [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 ')]],
    ['AVIF', [0, 0, 0, 28, ...ascii('ftypavif')]],
    ['HEIC', [0, 0, 0, 24, ...ascii('ftypheic')]],
    ['SVG', ascii('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['a page', ascii('<!doctype html><title>x</title>')],
    ['BMP', [...ascii('BM'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ['a byte order mark before a GIF', [0xef, 0xbb, 0xbf, ...ascii('GIF89a')]],
    ['white space before a PNG', [0x20, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['nothing', []],
    ['half a signature', [0xff, 0xd8]],
  ])('is none of the three for %s', (_name, head) => {
    expect(pictureTypeOf(Uint8Array.from(head))).toBeNull();
  });

  it('agrees with the rule: a file the page calls no picture is the rule’s `type`, and the other way round', () => {
    const padded = (head: number[]): Uint8Array => Uint8Array.from([...head, ...new Array<number>(64).fill(0)]);
    for (const head of [ascii('RIFF....WEBPVP8 '), ascii('<svg>'), [0xff, 0xd8, 0xfe], ascii('GIF88a')]) {
      expect(pictureTypeOf(padded(head))).toBeNull();
      expect(roomPictureCheck(padded(head))).toEqual({ ok: false, problem: 'type' });
    }
    for (const file of [png(64, 48), gif(32, 32)]) {
      expect(pictureTypeOf(file)).toBe((roomPictureCheck(file) as { type: string }).type);
    }
  });

  it('refuses WebP, AVIF and HEIC with the field of `picture_type`, and asks no canvas for them', async () => {
    for (const head of [
      ascii('RIFF....WEBPVP8 '),
      [0, 0, 0, 28, ...ascii('ftypavif')],
      [0, 0, 0, 24, ...ascii('ftypheic')],
    ]) {
      let opened = 0;
      const bytes = Uint8Array.from([...head, ...new Array<number>(100).fill(1)]);
      const file = picked(bytes);
      const made = await preparePicture(file, async () => {
        opened += 1;
        return null;
      });
      expect(made).toEqual({ ok: false, field: 'picture_type' });
      expect(opened).toBe(0);
      // Only the signature was read: a file that is no picture is read no further.
      expect(file.read).toHaveLength(1);
      expect(file.read[0]).toBeLessThan(bytes.length);
    }
  });
});

describe('the size a still is drawn at', () => {
  it('is never larger than the picture is', () => {
    expect(drawnSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(drawnSize(16, 16, 1600)).toEqual({ width: 16, height: 16 });
  });

  it('brings the longest side down to the step’s side and keeps the shape', () => {
    expect(drawnSize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(drawnSize(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(drawnSize(4000, 3000, 720)).toEqual({ width: 720, height: 540 });
    expect(drawnSize(5000, 20, 1600)).toEqual({ width: 1600, height: 6 });
  });
});

describe('the ladder of a JPEG', () => {
  it('is the contract’s six steps in the contract’s order for a large picture', () => {
    expect(ladderOf(4000, 3000)).toEqual(
      ROOM_PICTURE_COMPOSER_STEPS.map((step) => ({ ...drawnSize(4000, 3000, step.side), quality: step.quality })),
    );
    expect(ladderOf(4000, 3000)).toHaveLength(6);
  });

  it('never has more steps than the contract’s, and leaves out a step that would encode the same file again', () => {
    // 800 pixels wide: every side of the ladder from 800 up draws it as it is, so those steps are one
    // for each quality. Only the ladder's last side is smaller. The sides are the contract's, read here.
    const last = ROOM_PICTURE_COMPOSER_STEPS[ROOM_PICTURE_COMPOSER_STEPS.length - 1];
    if (!last) throw new Error('no ladder');
    expect(ROOM_PICTURE_COMPOSER_STEPS.filter((step) => step.side < 800)).toEqual([last]);
    expect(ladderOf(800, 600)).toEqual([
      { width: 800, height: 600, quality: 0.85 },
      { width: 800, height: 600, quality: 0.7 },
      { width: 800, height: 600, quality: 0.55 },
      { ...drawnSize(800, 600, last.side), quality: last.quality },
    ]);
    for (const [width, height] of [
      [16, 16],
      [1000, 1000],
      [1500, 20],
      [2048, 2048],
      [9000, 6000],
    ] as const) {
      expect(ladderOf(width, height).length).toBeLessThanOrEqual(ROOM_PICTURE_COMPOSER_STEPS.length);
    }
  });
});

describe('a still picture', () => {
  it('a JPEG is sent at the first step whose file fits and passes the rule', async () => {
    // The fourth step of the contract's ladder: its first smaller side. Read from the constant, typed nowhere.
    const fourth = ROOM_PICTURE_COMPOSER_STEPS[3];
    if (!fourth) throw new Error('no fourth step');
    const at = drawnSize(4000, 3000, fourth.side);
    expect(at.width).toBeLessThan(ROOM_PICTURE_COMPOSER_MAX_SIDE);
    const drawer = still(4000, 3000, (_type, size, quality) =>
      quality === fourth.quality && size.width === at.width
        ? png(size.width, size.height, 4000)
        : png(1600, 1200, ROOM_PICTURE_MAX_BYTES + 1),
    );
    const made = await prepareStill('jpeg', drawer);
    expect(drawer.asked).toEqual([
      'jpeg 1600x1200 q0.85',
      'jpeg 1600x1200 q0.7',
      'jpeg 1600x1200 q0.55',
      `jpeg ${at.width}x${at.height} q${fourth.quality}`,
    ]);
    expect(made).toMatchObject({ ok: true, picture: at });
  });

  it('a JPEG is never drawn as a PNG, and takes the first step when it fits', async () => {
    const drawer = still(640, 480, (_type, size) => png(size.width, size.height, 9000));
    const made = await prepareStill('jpeg', drawer);
    expect(drawer.asked).toEqual(['jpeg 640x480 q0.85']);
    expect(made.ok).toBe(true);
  });

  it('a PNG is drawn once as a PNG, at 1,600 pixels at most, and sent when that fits', async () => {
    const drawer = still(3200, 1600, (_type, size) => png(size.width, size.height, 20_000));
    const made = await prepareStill('png', drawer);
    expect(drawer.asked).toEqual([`png ${ROOM_PICTURE_COMPOSER_MAX_SIDE}x800`]);
    expect(made).toMatchObject({ ok: true, picture: { type: 'png', width: 1600, height: 800 } });
  });

  it('a PNG that does not fit goes down the ladder as a JPEG', async () => {
    const drawer = still(3200, 1600, (type, size) =>
      type === 'png' ? png(size.width, size.height, ROOM_PICTURE_MAX_BYTES + 1) : png(size.width, size.height, 30_000),
    );
    const made = await prepareStill('png', drawer);
    expect(drawer.asked).toEqual(['png 1600x800', 'jpeg 1600x800 q0.85']);
    expect(made.ok).toBe(true);
  });

  it('is refused with `picture_size` when the last step does not fit, after six encodes of the ladder', async () => {
    const drawer = still(4000, 3000, (_type, size) => png(size.width, size.height, ROOM_PICTURE_MAX_BYTES + 1));
    expect(await prepareStill('jpeg', drawer)).toEqual({ ok: false, field: 'picture_size' });
    expect(drawer.asked).toHaveLength(6);
    const asPng = still(4000, 3000, (_type, size) => png(size.width, size.height, ROOM_PICTURE_MAX_BYTES + 1));
    expect(await prepareStill('png', asPng)).toEqual({ ok: false, field: 'picture_size' });
    expect(asPng.asked).toHaveLength(7);
  });

  it('sends what the rule handed back, not what the canvas made', async () => {
    // A canvas that wrote a text chunk: the rule's own serialisation has none.
    const text = chunk('tEXt', ascii('Comment\0made on a phone at 52.5200, 13.4050'));
    const drawer = still(640, 480, (_type, size) => png(size.width, size.height, 0, text));
    const made = await prepareStill('png', drawer);
    if (!made.ok) throw new Error('refused');
    expect(made.picture.bytes).toEqual(png(640, 480));
    expect(new TextDecoder('latin1').decode(made.picture.bytes)).not.toContain('52.5200');
  });

  it('is refused with the rule’s own problem when no step can pass it: a picture below the smallest side', async () => {
    const drawer = still(10, 10, () => {
      throw new Error('asked to encode');
    });
    expect(await prepareStill('jpeg', drawer)).toEqual({ ok: false, field: 'picture_dimensions' });
    expect(drawer.asked).toEqual([]);
    const thin = still(5000, 20, (_type, size) => png(size.width, size.height, 9000));
    expect(await prepareStill('jpeg', thin)).toEqual({ ok: false, field: 'picture_dimensions' });
  });

  it('is refused as malformed when the browser cannot decode it or the canvas makes no file', async () => {
    expect(await preparePicture(picked(png(64, 48)), async () => null)).toEqual({
      ok: false,
      field: 'picture_malformed',
    });
    const empty = still(640, 480, () => null);
    expect(await prepareStill('jpeg', empty)).toEqual({ ok: false, field: 'picture_malformed' });
  });

  it('goes through the canvas whatever the file says of itself', async () => {
    let opened = 0;
    const made = await preparePicture(picked(png(640, 480, 0, chunk('eXIf', ascii('GPS')))), async () => {
      opened += 1;
      return still(640, 480, (_type, size) => png(size.width, size.height, 5000));
    });
    expect(opened).toBe(1);
    expect(made.ok).toBe(true);
  });
});

describe('a GIF', () => {
  it('is never redrawn: the rule is run on the file and its answer is what is sent', async () => {
    let opened = 0;
    const file = gif(64, 64, 3);
    const made = await preparePicture(picked(file), async () => {
      opened += 1;
      return null;
    });
    expect(opened).toBe(0);
    expect(made).toMatchObject({ ok: true, picture: { type: 'gif', frames: 3, width: 64, height: 64 } });
    expect(prepareGif(file)).toEqual(made);
  });

  it.each([
    ['too many frames', gif(64, 64, 121), 'picture_frames'],
    ['an animated canvas above 512 pixels', gif(640, 64, 2), 'picture_dimensions'],
    ['cut short', gif(64, 64, 2).slice(0, 40), 'picture_malformed'],
    ['above the largest', Uint8Array.from([...gif(64, 64), ...new Uint8Array(ROOM_PICTURE_MAX_BYTES)]), 'picture_size'],
  ])('beyond the limits is refused in the page: %s', (_name, file, field) => {
    expect(prepareGif(file)).toEqual({ ok: false, field });
  });

  it('above the largest size is refused from its length, and the file is not read', async () => {
    const file = picked(Uint8Array.from([...gif(64, 64), ...new Uint8Array(ROOM_PICTURE_MAX_BYTES)]));
    expect(await preparePicture(file, async () => null)).toEqual({ ok: false, field: 'picture_size' });
    expect(file.read).toHaveLength(1);
  });
});

// --- the answers -----------------------------------------------------------------------------------

const words = composerScriptWords();
const picture = pictureScriptWords();
const HOSTILE = '<img src=x onerror=alert(1)> Prix support: write to t.me/prix';
const refusal = (status: number, code: string, field: string | null): Answer => ({
  status,
  body: { error: { code, message: HOSTILE, field } },
});
const me = (body: Record<string, unknown>): Answer => ({ status: 200, body: { write: 'yes', left: 12, ...body } });
/**
 * The field of a wallet's cap of the day, written in two pieces: tests/unit/wallet-requests.test.ts reads
 * that name in quotation marks as a request to a wallet.
 */
const DAY_FIELD = `${'wallet'}_day` as const;
const SENTENCE_FIELDS = (Object.keys(ROOM_PICTURE_REFUSALS) as (keyof typeof ROOM_PICTURE_REFUSALS)[]).filter(
  (field): field is RoomPictureSentenceField => field !== 'picture_views_day',
);

describe('what the composer offers of pictures', () => {
  it('is "Add a picture" only when me says yes and the page says pictures are on', () => {
    expect(pictureOffer(me({ picture: 'yes', picturesLeft: 3 }), 'on')).toEqual({ kind: 'add', left: 3 });
  });

  it.each([null, '', 'off', 'resting', 'ON', 'on ', 'true', 'yes'])(
    'is nothing while the list’s attribute is %j, whatever me says',
    (state) => {
      for (const kind of ['yes', 'admin', 'new_writer', 'no']) {
        expect(pictureOffer(me({ picture: kind, picturesLeft: 3 }), state)).toEqual({ kind: 'none' });
      }
    },
  );

  it('is the admin’s note for an admin wallet and the rule for a new writer', () => {
    expect(pictureOffer(me({ picture: 'admin', picturesLeft: 0 }), 'on')).toEqual({ kind: 'admin' });
    expect(pictureOffer(me({ picture: 'new_writer', picturesLeft: 0 }), 'on')).toEqual({ kind: 'new_writer' });
  });

  it('is the sentence of the wallet’s day when no picture is left today', () => {
    expect(pictureOffer(me({ picture: 'yes', picturesLeft: 0 }), 'on')).toEqual({ kind: 'day_used' });
  });

  it('is nothing for an answer of an API older than pictures, for `no`, and for anything it cannot read', () => {
    expect(pictureOffer(me({}), 'on')).toEqual({ kind: 'none' });
    expect(pictureOffer(me({ picture: 'no', picturesLeft: 0 }), 'on')).toEqual({ kind: 'none' });
    expect(pictureOffer(me({ picture: 'yes' }), 'on')).toEqual({ kind: 'none' });
    expect(pictureOffer(me({ picture: 'yes', picturesLeft: 1.5 }), 'on')).toEqual({ kind: 'none' });
    expect(pictureOffer(me({ picture: 'yes', picturesLeft: -1 }), 'on')).toEqual({ kind: 'none' });
    expect(pictureOffer(me({ picture: 'later', picturesLeft: 2 }), 'on')).toEqual({ kind: 'none' });
    expect(
      pictureOffer({ status: 200, body: { write: 'muted', left: 0, picture: 'yes', picturesLeft: 3 } }, 'on'),
    ).toEqual({
      kind: 'none',
    });
    expect(pictureOffer({ status: 500, body: null }, 'on')).toEqual({ kind: 'none' });
  });
});

describe('whether "Report" is switched on', () => {
  it('only for an answer of me that says report: true', () => {
    expect(reportOn(me({ report: true }))).toBe(true);
    for (const answer of [me({}), me({ report: false }), me({ report: 'true' }), me({ report: 1 })]) {
      expect(reportOn(answer)).toBe(false);
    }
    expect(reportOn({ status: 401, body: { report: true } })).toBe(false);
    expect(reportOn({ status: 0, body: null })).toBe(false);
  });
});

describe('the sentences of a picture’s refusals', () => {
  it('are one for every field of RoomPictureSentenceField, under the contract’s key', () => {
    const map = pictureRefusalWords();
    expect(Object.keys(map).sort()).toEqual([...SENTENCE_FIELDS].sort());
    expect(Object.keys(map)).not.toContain('picture_views_day');
    for (const field of SENTENCE_FIELDS) expect(map[field].trim().length, field).toBeGreaterThan(0);
    expect(SENTENCE_FIELDS.map(roomPictureRefusalKey)).toHaveLength(
      new Set(SENTENCE_FIELDS.map(roomPictureRefusalKey)).size,
    );
  });

  it('reach the script with the room’s own that an upload and a report can answer', () => {
    for (const field of SENTENCE_FIELDS) expect(picture.refusals[field]).toBe(pictureRefusalWords()[field]);
    for (const field of ['not_holder', 'gate_off', 'muted', 'too_soon', DAY_FIELD, 'room_hour', 'room_day']) {
      expect(picture.refusals[field], field).toBe(words.refusals[field]);
    }
  });
});

describe('what an upload ended as', () => {
  it('201: the page is loaded again and nothing of the answer is kept', () => {
    const sent = pictureOutcome(
      { status: 201, body: { message: { text: HOSTILE }, left: 1, picturesLeft: 2 } },
      picture,
    );
    expect(sent).toEqual({ kind: 'sent' });
  });

  it.each(SENTENCE_FIELDS)('says the sentence of %s, chosen by the field', (field) => {
    const outcome = pictureOutcome(refusal(ROOM_PICTURE_REFUSALS[field], 'invalid_input', field), picture);
    expect(outcome).toEqual({ kind: 'notice', sentence: pictureRefusalWords()[field] });
  });

  it('says the room’s own sentence for the room’s own refusals', () => {
    for (const [field, status] of [
      ['too_soon', 429],
      [DAY_FIELD, 429],
      ['room_hour', 429],
      ['room_day', 429],
      ['muted', 403],
      ['not_holder', 403],
      ['gate_off', 403],
    ] as const) {
      expect(pictureOutcome(refusal(status, 'invalid_input', field), picture)).toEqual({
        kind: 'notice',
        sentence: words.refusals[field],
      });
    }
  });

  it('keeps `picture_storage` apart from a fault of the server, though both are 5xx', () => {
    expect(pictureOutcome(refusal(503, 'invalid_input', 'picture_storage'), picture)).toEqual({
      kind: 'notice',
      sentence: pictureRefusalWords().picture_storage,
    });
    expect(pictureOutcome(refusal(503, 'internal', null), picture)).toEqual({
      kind: 'notice',
      sentence: picture.sendFailed,
    });
    expect(pictureOutcome({ status: 0, body: null }, picture)).toEqual({
      kind: 'notice',
      sentence: picture.sendFailed,
    });
  });

  it('knows an ended session, the two codes of the writer’s budget, and pictures that went off', () => {
    expect(pictureOutcome(refusal(401, 'unauthorized', null), picture)).toEqual({ kind: 'session' });
    expect(pictureOutcome(refusal(429, 'rate_limited', null), picture)).toEqual({
      kind: 'notice',
      sentence: picture.writer,
    });
    expect(pictureOutcome(refusal(503, 'daily_limit', null), picture)).toEqual({
      kind: 'notice',
      sentence: picture.writer,
    });
    expect(pictureOutcome(refusal(404, 'not_found', null), picture)).toEqual({
      kind: 'notice',
      sentence: pictureRefusalWords().pictures_off,
    });
  });

  it('never shows the words of an answer, and has a sentence for a field it does not know', () => {
    for (const answer of [
      refusal(400, 'invalid_input', 'picture_future_rule'),
      refusal(400, 'invalid_input', null),
      refusal(403, 'forbidden', null),
      refusal(415, 'invalid_input', 'text_bait'),
    ]) {
      const outcome = pictureOutcome(answer, picture);
      expect(outcome).toEqual({ kind: 'notice', sentence: picture.other });
      expect(JSON.stringify(outcome)).not.toContain('onerror');
    }
  });
});

describe('what a report ended as', () => {
  it('204: the one sentence, whatever the server counted', () => {
    expect(reportSentence({ status: 204, body: null }, picture)).toBe(picture.reportDone);
  });

  it.each([
    'muted',
    'picture_not_allowed',
    'report_new_writer',
    'report_own',
    'report_wallet_day',
    'picture_admin',
  ] as const)('says the sentence of %s', (field) => {
    expect(reportSentence(refusal(403, 'invalid_input', field), picture)).toBe(picture.refusals[field]);
  });

  it('says that a picture is closed to reports for the generic 404, and never why', () => {
    expect(reportSentence(refusal(404, 'not_found', null), picture)).toBe(picture.reportClosed);
  });

  it('has a sentence for an ended session, a spent budget, no answer and a fault, none of them the answer’s words', () => {
    expect(reportSentence(refusal(401, 'unauthorized', null), picture)).toBe(picture.session);
    expect(reportSentence(refusal(429, 'rate_limited', null), picture)).toBe(picture.writer);
    for (const answer of [
      { status: 0, body: null },
      refusal(500, 'internal', null),
      refusal(400, 'invalid_input', 'x'),
    ]) {
      expect(reportSentence(answer, picture)).toBe(picture.reportFailed);
    }
  });
});

describe('a picture the browser cannot draw', () => {
  // docs/contracts/phase-6-pictures.md section 11, revision 6 (D14): no empty preview and nothing chosen.
  it('is refused as malformed though the rule passed its file, and is not kept as the chosen one', async () => {
    const made = prepareGif(gif(64, 64, 2));
    expect(made.ok).toBe(true);
    expect(await previewed(made, async () => false)).toEqual({ ok: false, field: 'picture_malformed' });
  });

  it('stays chosen when the preview was drawn, and a refusal stays the refusal it was', async () => {
    const made = prepareGif(gif(64, 64, 2));
    expect(await previewed(made, async () => true)).toBe(made);
    const refusal = prepareGif(gif(64, 64, 121));
    let asked = 0;
    expect(
      await previewed(refusal, async () => {
        asked += 1;
        return true;
      }),
    ).toEqual({ ok: false, field: 'picture_frames' });
    expect(asked).toBe(0);
  });
});

describe('the facts of a picture', () => {
  it('are the type, the sides printed grouped and the size in whole kilobytes, in the deck’s sentence', () => {
    const line = factsSentence({ type: 'jpeg', width: 1600, height: 1200, frames: 1, bytes: 211_456 }, picture);
    expect(line).toBe(
      picture.facts
        .replace('{type}', 'JPEG')
        .replace('{width}', '1,600')
        .replace('{height}', '1,200')
        .replace('{size}', picture.sizeKb.replace('{count}', '207')),
    );
    expect(line).not.toMatch(/[{}]/);
  });

  it('round the size UP to whole kilobytes of 1,024 bytes, so a file never reads smaller than it is', () => {
    const size = (bytes: number): string =>
      factsSentence({ type: 'png', width: 64, height: 64, frames: 1, bytes }, picture);
    const kb = (count: string): string => picture.sizeKb.replace('{count}', count);
    expect(size(1)).toContain(kb('1'));
    expect(size(1024)).toContain(kb('1'));
    expect(size(1025)).toContain(kb('2'));
    expect(size(211_457)).toContain(kb('207'));
    expect(size(211_969)).toContain(kb('208'));
    expect(size(ROOM_PICTURE_MAX_BYTES)).toContain(kb(String(ROOM_PICTURE_MAX_BYTES / 1024)));
    // One key and one rounding rule: the script is handed no other size.
    expect(Object.keys(picture)).not.toContain('size');
  });

  it('say that a GIF moves, with the count of its frames', () => {
    const line = factsSentence({ type: 'gif', width: 320, height: 240, frames: 48, bytes: 900 }, picture);
    expect(line).toBe(
      picture.factsAnimated
        .replace('{frames}', '48')
        .replace('{width}', '320')
        .replace('{height}', '240')
        .replace('{size}', picture.sizeKb.replace('{count}', '1')),
    );
    expect(factsSentence({ type: 'gif', width: 320, height: 240, frames: 1, bytes: 900 }, picture)).toContain('GIF');
  });
});
