import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RoomPictureWriterRecord } from '@prix/contracts';
import {
  ROOM_PICTURE_BODY_SECONDS,
  ROOM_PICTURE_COPY_KEYS,
  ROOM_PICTURE_FETCH_HEADERS,
  ROOM_PICTURE_ID_PATTERN,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_POST_WRITE_ROWS,
  ROOM_PICTURE_PRUNE_ROWS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_REPORTER_AGE_SECONDS,
  ROOM_PICTURE_STORAGE_DAYS,
  ROOM_PICTURE_STORAGE_LIMIT_BYTES,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_VIEWS_PER_DAY_MAX,
  ROOM_PICTURE_WRITER_AGE_SECONDS,
  ROOM_PICTURES_ENABLED_VAR,
  ROOM_PICTURES_KV_BINDING,
  ROOM_PICTURES_PATH,
  ROOM_PICTURES_PER_DAY_DEFAULT,
  ROOM_PICTURES_PER_DAY_MAX,
  ROOM_REPORTED_PICTURES_PAUSE,
  ROOM_ROWS_PER_DAY,
  ROOM_ROWS_PER_MESSAGE,
  roomDailyCap,
  roomDailyCapBesidePictures,
  roomIdParamSchema,
  roomPictureCheck,
  roomPictureDropsRead,
  roomPictureHeaders,
  roomPictureIdOf,
  roomPictureRefusalKey,
  roomPictureReportRefusal,
  roomPictureRowsWorst,
  roomPictureStorageWorstBytes,
  roomPicturesEnabled,
  roomPictureTurnRefusal,
  roomPictureViewsCap,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../apps/web/src/content/deck.ts';
import { readSources, repoRoot } from '../support/repo.ts';
import {
  CORPUS,
  cat,
  GIF_COMMENT,
  GIF_SCRIPT,
  GIF_SMALLEST,
  hex,
  holds,
  JPEG_EXIF,
  JPEG_SCRIPT,
  JPEG_SMALLEST,
  LARGEST_FILES,
  MANY_TABLES_SEGMENTS,
  PNG_TEXT,
  parsesAsScript,
  SLOW_GIF_COMMENTS,
  THOUSANDS_SEGMENTS,
} from './support/picture-files.ts';

/**
 * Pictures in the room, the part that needs the contract alone (docs/contracts/phase-6-pictures.md at
 * revision 6): the rule of the file against every file its section 4 names, and the constants, tables and
 * functions every owner builds against. Nothing here asks a route or a database: the routes are in
 * room-picture-*.d1.test.ts, with the same files sent to the API itself.
 */

describe('roomPictureCheck against the corpus of section 4', () => {
  for (const { name, file, expect: wanted } of CORPUS) {
    it(name, () => {
      const answer = roomPictureCheck(file);
      if (!wanted.ok) {
        expect(answer).toEqual({ ok: false, problem: wanted.problem });
        return;
      }
      expect(answer.ok, JSON.stringify(answer.ok ? null : answer)).toBe(true);
      if (!answer.ok) return;
      expect({ type: answer.type, width: answer.width, height: answer.height, frames: answer.frames }).toEqual({
        type: wanted.type,
        width: wanted.width,
        height: wanted.height,
        frames: wanted.frames,
      });
      // The only bytes that may be stored: the rule's own serialisation.
      if (wanted.clean !== undefined) expect(hex(answer.bytes)).toBe(hex(wanted.clean));
      for (const text of wanted.gone ?? []) expect(holds(answer.bytes, text), `still holds ${text}`).toBe(false);
      if (wanted.stays !== undefined) expect(holds(answer.bytes, wanted.stays)).toBe(true);
      // What it hands back, checked again, answers itself.
      const again = roomPictureCheck(answer.bytes);
      expect(again.ok && hex(again.bytes) === hex(answer.bytes)).toBe(true);
    });
  }

  it('holds every problem the rule names, and files that pass of all three types', () => {
    const problems = new Set(CORPUS.flatMap(({ expect: wanted }) => (wanted.ok ? [] : [wanted.problem])));
    expect([...problems].sort()).toEqual(['dimensions', 'frames', 'malformed', 'size', 'type']);
    const types = new Set(CORPUS.flatMap(({ expect: wanted }) => (wanted.ok ? [wanted.type] : [])));
    expect([...types].sort()).toEqual(['gif', 'jpeg', 'png']);
    expect(CORPUS.filter(({ name }) => name.startsWith('ACCEPTED')).length).toBe(8);
  });

  it('builds its three largest files from the largest size: none is refused for its size, each for what it is', () => {
    // Revision 5: the largest file is 262,144 bytes. A file built for the old size would be refused as
    // `size`, and its case would say nothing of the tables, the comments or the segments.
    expect(ROOM_PICTURE_MAX_BYTES).toBe(262_144);
    for (const name of Object.values(LARGEST_FILES)) {
      const length = CORPUS.find((entry) => entry.name === name)?.file.length ?? 0;
      expect(length, name).toBeLessThanOrEqual(ROOM_PICTURE_MAX_BYTES);
      // Nothing more of its kind fits: one more segment of a thousand tables is 65,002 bytes.
      expect(length, name).toBeGreaterThan(ROOM_PICTURE_MAX_BYTES - 65_536);
    }
    // The counts the contract's section 23 gives for this size.
    expect(MANY_TABLES_SEGMENTS).toBe(119);
    expect(THOUSANDS_SEGMENTS).toBe(4);
    expect(SLOW_GIF_COMMENTS).toBeGreaterThan(87_000);
    expect(CORPUS.find((entry) => entry.name === LARGEST_FILES.manyTables)?.file.length).toBe(260_472);
    expect(CORPUS.find((entry) => entry.name === LARGEST_FILES.thousands)?.file.length).toBe(260_091);
  });

  for (const [type, file] of [
    ['PNG', PNG_TEXT],
    ['JPEG', JPEG_EXIF],
    ['GIF', GIF_COMMENT],
  ] as const) {
    it(`refuses a ${type} with any one byte appended, and cut at every one of its lengths`, () => {
      const appended = Array.from({ length: 256 }, (_, byte) => byte).filter(
        (byte) => roomPictureCheck(cat(file, [byte])).ok,
      );
      expect(appended).toEqual([]);
      const cuts: number[] = [];
      for (let length = 0; length < file.length; length += 1) {
        if (roomPictureCheck(file.subarray(0, length)).ok) cuts.push(length);
      }
      expect(cuts).toEqual([]);
    });
  }

  it('does not stop a file that is also a script: the stored bytes of that GIF parse as one, the JPEG is refused', () => {
    // Section 4 says so in as many words, and section 7 is what makes the file inert. The text is only
    // parsed here: the function is never called.
    const gif = roomPictureCheck(GIF_SCRIPT);
    expect(gif.ok && hex(gif.bytes) === hex(GIF_SCRIPT)).toBe(true);
    expect(gif.ok && parsesAsScript(gif.bytes)).toBe(true);
    expect(parsesAsScript(GIF_SMALLEST)).toBe(false);

    // After the two bytes of the start marker and the two of the DQT's own: the length that spells "/*".
    expect(JPEG_SCRIPT[4]).toBe(0x2f);
    expect(JPEG_SCRIPT[5]).toBe(0x2a);
    expect(roomPictureCheck(JPEG_SCRIPT)).toEqual({ ok: false, problem: 'malformed' });
    expect(parsesAsScript(JPEG_SMALLEST)).toBe(false);
  });

  it('never throws on 2,000 mutations of each type, and every answer that passes holds the limit of bytes', () => {
    // A fixed generator: the same mutations on every run.
    let seed = 0x9e3779b9;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    for (const file of [PNG_TEXT, JPEG_EXIF, GIF_COMMENT]) {
      for (let round = 0; round < 2_000; round += 1) {
        const copy = file.slice();
        const flips = 1 + Math.floor(next() * 3);
        for (let flip = 0; flip < flips; flip += 1) copy[Math.floor(next() * copy.length)] = Math.floor(next() * 256);
        const answer = roomPictureCheck(copy);
        if (answer.ok) {
          expect(answer.bytes.length).toBeLessThanOrEqual(ROOM_PICTURE_MAX_BYTES);
          expect(roomPictureCheck(answer.bytes).ok).toBe(true);
        }
      }
    }
  });
});

describe('the id of a picture in a path', () => {
  it('is one pattern in the browser file and in the schema of the routes', () => {
    // Section 11: the pattern is written twice, because a browser script cannot import zod.
    const strings = [
      '1',
      '12',
      '123456789012345',
      '1234567890123456',
      '0',
      '012',
      '',
      ' 12',
      '12 ',
      '1e3',
      '-1',
      '+1',
      '1.0',
      '12/../../me',
      'abc',
      '１２',
      '12\n',
    ];
    for (const text of strings) {
      expect(ROOM_PICTURE_ID_PATTERN.test(text), JSON.stringify(text)).toBe(roomIdParamSchema.safeParse(text).success);
      expect(roomPictureIdOf(text) !== null, JSON.stringify(text)).toBe(roomIdParamSchema.safeParse(text).success);
    }
    // Zod keeps the pattern it was given: the two sources are the same text.
    const checks = (
      roomIdParamSchema as unknown as { _zod: { def: { checks: { _zod: { def: { pattern?: RegExp } } }[] } } }
    )._zod.def.checks;
    const patterns = checks.map((check) => check._zod.def.pattern?.source).filter((source) => source !== undefined);
    expect(patterns).toEqual([ROOM_PICTURE_ID_PATTERN.source]);
  });
});

describe('the sentences of pictures', () => {
  it('are all in the deck: every key of ROOM_PICTURE_COPY_KEYS has words of its own', () => {
    const missing = ROOM_PICTURE_COPY_KEYS.filter(
      (key) => !Object.hasOwn(deck, key) || (deck[key] ?? '').trim() === '',
    );
    expect(missing).toEqual([]);
    expect(new Set(ROOM_PICTURE_COPY_KEYS).size).toBe(ROOM_PICTURE_COPY_KEYS.length);
  });

  it('have one sentence for each refusal a page can show, and none for the one it cannot', () => {
    const fields = Object.keys(ROOM_PICTURE_REFUSALS) as (keyof typeof ROOM_PICTURE_REFUSALS)[];
    for (const field of fields) {
      if (field === 'picture_views_day') continue;
      const key = roomPictureRefusalKey(field);
      expect(ROOM_PICTURE_COPY_KEYS, key).toContain(key);
      expect((deck[key] ?? '').trim(), key).not.toBe('');
    }
    expect(ROOM_PICTURE_COPY_KEYS.some((key) => /ViewsDay$/.test(key))).toBe(false);
  });

  it('never say that a picture is safe, verified or checked', () => {
    // Section 17, its last rule. "Not checked" is the one thing the contract itself says of a picture.
    const vouching = /\b(?:safe\w*|verif\w*|check\w*)\b/i;
    const found = ROOM_PICTURE_COPY_KEYS.filter((key) =>
      vouching.test((deck[key] ?? '').replace(/\bnot checked\b/gi, '')),
    );
    expect(found).toEqual([]);
  });
});

describe('the storage of seven days', () => {
  it('fits the plan at the highest cap of a day, with the arithmetic of section 6', () => {
    expect(ROOM_PICTURE_TTL_SECONDS).toBe(7 * 86_400);
    expect(roomPictureStorageWorstBytes()).toBe(
      ROOM_PICTURE_STORAGE_DAYS * ROOM_PICTURES_PER_DAY_MAX * ROOM_PICTURE_MAX_BYTES,
    );
    // Revision 5: 262,144 bytes a picture, so 353,894,400 at the ceiling of 150 a day, 35% of the plan.
    expect(roomPictureStorageWorstBytes()).toBe(353_894_400);
    expect(roomPictureStorageWorstBytes(ROOM_PICTURES_PER_DAY_DEFAULT)).toBe(
      ROOM_PICTURE_STORAGE_DAYS * ROOM_PICTURES_PER_DAY_DEFAULT * ROOM_PICTURE_MAX_BYTES,
    );
    expect(Math.round((100 * roomPictureStorageWorstBytes()) / ROOM_PICTURE_STORAGE_LIMIT_BYTES)).toBe(35);
    expect(roomPictureStorageWorstBytes()).toBeLessThan(ROOM_PICTURE_STORAGE_LIMIT_BYTES);
  });
});

describe("what drops the room's cached read", () => {
  it('is the upload that answered 201, and no other answer at or under the path of pictures', () => {
    expect(roomPictureDropsRead('POST', ROOM_PICTURES_PATH, 201)).toBe(true);
    const others: [string, string, number][] = [
      ['POST', ROOM_PICTURES_PATH, 200],
      ['POST', ROOM_PICTURES_PATH, 204],
      ['POST', ROOM_PICTURES_PATH, 400],
      ['POST', ROOM_PICTURES_PATH, 403],
      ['POST', ROOM_PICTURES_PATH, 429],
      ['POST', ROOM_PICTURES_PATH, 503],
      ['POST', `${ROOM_PICTURES_PATH}/12/report`, 204],
      ['POST', `${ROOM_PICTURES_PATH}/12/report`, 201],
      ['POST', `${ROOM_PICTURES_PATH}/`, 201],
      ['GET', `${ROOM_PICTURES_PATH}/12`, 200],
      ['GET', ROOM_PICTURES_PATH, 201],
      ['PUT', ROOM_PICTURES_PATH, 201],
      ['post', ROOM_PICTURES_PATH, 201],
    ];
    for (const [method, path, status] of others) {
      expect(roomPictureDropsRead(method, path, status), `${method} ${path} ${status}`).toBe(false);
    }
  });
});

describe('the headers of the bytes', () => {
  it('are these eleven and no other, with the type from the table', () => {
    expect(roomPictureHeaders(12, 'gif', 99)).toEqual({
      'Content-Type': 'image/gif',
      'Content-Length': '99',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Content-Disposition': 'attachment; filename="prix-chat-12.gif"',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, noimageindex, noarchive',
      'Accept-Ranges': 'none',
    });
    expect(roomPictureHeaders(7, 'jpeg', 40)['Content-Type']).toBe('image/jpeg');
    expect(roomPictureHeaders(7, 'jpeg', 40)['Content-Disposition']).toBe('attachment; filename="prix-chat-7.jpg"');
    expect(roomPictureHeaders(7, 'png', 40)['Content-Type']).toBe('image/png');
  });

  it('are asked for with two fetch headers, each exactly so', () => {
    expect(ROOM_PICTURE_FETCH_HEADERS).toEqual({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image' });
  });
});

describe('the one order of the refusals', () => {
  const NOW = '2026-10-20T12:00:00.000Z';
  const DAY = '2026-10-20';
  const ago = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1_000).toISOString();
  const writer = (over: Partial<RoomPictureWriterRecord> = {}): RoomPictureWriterRecord => ({
    address: '0x00000000000000000000000000000000000005b2',
    lastAt: null,
    day: null,
    count: 0,
    mutedAt: null,
    mutedBy: null,
    cutAt: null,
    firstAt: ago(2 * 86_400),
    picturesDay: null,
    picturesCount: 0,
    reportsDay: null,
    reportsCount: 0,
    reportStrikes: 0,
    reportedOpen: 0,
    ...over,
  });

  it('of an upload: what refuses a message first, then never-muted, the hour, the pause, the three of a day', () => {
    expect(roomPictureTurnRefusal(null, NOW, DAY)).toBe('new_writer');
    expect(roomPictureTurnRefusal(writer(), NOW, DAY)).toBeNull();
    const everything = writer({
      mutedAt: ago(10),
      cutAt: ago(10),
      day: DAY,
      count: 30,
      lastAt: ago(1),
      firstAt: null,
      reportedOpen: ROOM_REPORTED_PICTURES_PAUSE,
      picturesDay: DAY,
      picturesCount: 3,
    });
    const order = ['muted', 'day', 'too_soon', 'not_allowed', 'new_writer', 'paused', 'picture_day'];
    const lifts: Partial<RoomPictureWriterRecord>[] = [
      { mutedAt: null },
      { count: 0 },
      { lastAt: null },
      { cutAt: null },
      { firstAt: ago(2 * 86_400) },
      { reportedOpen: 0 },
      { picturesCount: 0 },
    ];
    let row = everything;
    const seen: (string | null)[] = [];
    for (const lift of lifts) {
      seen.push(roomPictureTurnRefusal(row, NOW, DAY));
      row = { ...row, ...lift };
    }
    expect(seen).toEqual(order);
    expect(roomPictureTurnRefusal(row, NOW, DAY)).toBeNull();
  });

  it('of an upload: a first message of 59 minutes is too new, one of an hour is not', () => {
    expect(roomPictureTurnRefusal(writer({ firstAt: ago(ROOM_PICTURE_WRITER_AGE_SECONDS - 1) }), NOW, DAY)).toBe(
      'new_writer',
    );
    expect(roomPictureTurnRefusal(writer({ firstAt: ago(ROOM_PICTURE_WRITER_AGE_SECONDS) }), NOW, DAY)).toBeNull();
    expect(roomPictureTurnRefusal(writer({ firstAt: 'not a time' }), NOW, DAY)).toBe('new_writer');
  });

  it('of a report: a reporter of 23 hours is too new, and `already` stands before `own` and the day', () => {
    const other = '0x00000000000000000000000000000000000005c9';
    const self = writer().address;
    expect(ROOM_PICTURE_REPORTER_AGE_SECONDS).toBe(86_400);
    expect(roomPictureReportRefusal(writer({ firstAt: ago(23 * 3_600) }), other, false, NOW, DAY)).toBe('new_writer');
    expect(roomPictureReportRefusal(writer({ firstAt: ago(86_400) }), other, false, NOW, DAY)).toBeNull();
    const full = writer({ reportsDay: DAY, reportsCount: 5 });
    expect(roomPictureReportRefusal(full, other, false, NOW, DAY)).toBe('report_day');
    expect(roomPictureReportRefusal(full, other, true, NOW, DAY)).toBe('already');
    expect(roomPictureReportRefusal(writer(), self, true, NOW, DAY)).toBe('already');
    expect(roomPictureReportRefusal(writer(), self.toUpperCase().replace('0X', '0x'), false, NOW, DAY)).toBe('own');
    expect(roomPictureReportRefusal(writer({ reportStrikes: 2 }), other, true, NOW, DAY)).toBe('struck');
    expect(roomPictureReportRefusal(writer({ cutAt: ago(5) }), other, false, NOW, DAY)).toBe('not_allowed');
    expect(roomPictureReportRefusal(null, other, false, NOW, DAY)).toBe('new_writer');
  });
});

describe('what a browser script takes from the contracts', () => {
  const scripts = [
    ...readSources('apps/web/src/arena/social/room', ['.ts'], (path) => /\.test\.ts$|fixtures\.ts$/.test(path)),
    ...readSources('apps/web/src/account/social/room', ['.ts'], (path) => /\.test\.ts$|fixtures\.ts$/.test(path)),
  ];
  /** The scripts a page ships: the ones that touch the document. The others run on the server. */
  const browser = scripts.filter(({ source }) => /\bdocument\b|\bHTMLElement\b|\bHTML\w+Element\b/.test(source));

  it('is found: the scripts of both pages are read', () => {
    const names = browser.map(({ path }) => path.split('/').slice(-2).join('/'));
    expect(names).toEqual(
      expect.arrayContaining(['room/pictures.ts', 'room/report.ts', 'room/picture.ts', 'room/admin-look.ts']),
    );
  });

  it('imports values from @prix/contracts/room-picture and from no other file of the contracts', () => {
    const found: string[] = [];
    for (const { path, source } of browser) {
      for (const match of source.matchAll(/import\s+(type\s+)?[^;]*?from\s+'(@prix\/contracts[^']*)'/g)) {
        if (match[1] !== undefined) continue;
        if (match[2] !== '@prix/contracts/room-picture') found.push(`${path}: ${match[2]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("builds a picture's address from the id of an attribute only through roomPictureIdOf, and writes no path itself", () => {
    const found: string[] = [];
    for (const { path, source } of browser) {
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      if (/\/api\/social\/(?:admin\/)?room\/pictures/.test(code)) found.push(`${path}: a path of pictures written out`);
      // Every address is built from one name, and that name is what roomPictureIdOf answered in this
      // file, or a parameter that is a number already (the client's own function, whose callers are
      // judged here too).
      for (const call of code.matchAll(/roomPicture(?:Admin|Report)?Path\(([^)]*)\)/g)) {
        const given = (call[1] ?? '').trim();
        const named = /^[A-Za-z_]\w*$/.test(given);
        const fromRule = named && new RegExp(`\\bconst ${given} = roomPictureIdOf\\(`).test(code);
        const aNumber = named && new RegExp(`\\(${given}: number\\)`).test(code);
        if (!(fromRule || aNumber)) found.push(`${path}: ${call[0]} is not built from what roomPictureIdOf answered`);
      }
      for (const call of code.matchAll(/\breportPicture\(([^)]*)\)/g)) {
        const given = (call[1] ?? '').trim();
        if (given === 'id: number') continue;
        const named = /^[A-Za-z_]\w*$/.test(given);
        if (!(named && new RegExp(`\\bconst ${given} = roomPictureIdOf\\(`).test(code))) {
          found.push(`${path}: ${call[0]} is not handed what roomPictureIdOf answered`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

/**
 * The KV namespace `prix-room-pictures`, created on the operator's account on 2026-10-11 (infra/README.md
 * section 18). An id is not a secret. It is typed here so that a slip of one character in the config,
 * which would bind another namespace or none, fails a test.
 */
const ROOM_PICTURES_NAMESPACE_ID = '0407f2417b4e49029d406858639fbe04';

/** What `pictureConfigProblems` says of a config that breaks the rule, one sentence for each way. */
const SWITCH_NOT_BOUND = `"${ROOM_PICTURES_ENABLED_VAR}" reads "true" and no ${ROOM_PICTURES_KV_BINDING} is bound`;
const NOT_THE_NAMESPACE = `kv_namespaces is not the one binding of ${ROOM_PICTURES_KV_BINDING} to the namespace ${ROOM_PICTURES_NAMESPACE_ID}`;
const switchReads = (value: unknown): string =>
  `"${ROOM_PICTURES_ENABLED_VAR}" reads ${JSON.stringify(value)}, neither "false" nor "true"`;
const switchNamed = (times: number): string =>
  `"${ROOM_PICTURES_ENABLED_VAR}" is named ${times} times in what a deploy reads`;

/**
 * What is wrong with the pictures' part of a Worker's config, as sentences: none for a config that holds
 * the rule. It judges what a deploy reads, the config without its comment lines.
 *
 * The rule is the same whatever a deploy has bound or switched on, so it holds before the namespace is
 * bound, between the binding and the switch, and after both: the switch reads "false" or "true" and
 * nothing else; it reads "true" only while the config binds the KV namespace of the pictures; and a
 * config that binds a KV namespace at all binds exactly one, ROOM_PICTURES, with the id of
 * `prix-room-pictures`.
 */
function pictureConfigProblems(config: string): string[] {
  const live = config
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const { vars, kv_namespaces: namespaces } = JSON.parse(live) as {
    vars?: Record<string, unknown>;
    kv_namespaces?: unknown;
  };
  const on = vars?.[ROOM_PICTURES_ENABLED_VAR];
  const bound =
    Array.isArray(namespaces) &&
    namespaces.some(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { binding?: unknown }).binding === ROOM_PICTURES_KV_BINDING,
    );
  const problems: string[] = [];
  // Once, so that the one value read here is the only one a deploy can read.
  const named = live.split(`"${ROOM_PICTURES_ENABLED_VAR}"`).length - 1;
  if (named !== 1) problems.push(switchNamed(named));
  if (on !== 'false' && on !== 'true') problems.push(switchReads(on));
  if (on === 'true' && !bound) problems.push(SWITCH_NOT_BOUND);
  if (
    namespaces !== undefined &&
    !isDeepStrictEqual(namespaces, [{ binding: ROOM_PICTURES_KV_BINDING, id: ROOM_PICTURES_NAMESPACE_ID }])
  ) {
    problems.push(NOT_THE_NAMESPACE);
  }
  return problems;
}

describe("the switch of pictures and the binding of their namespace in the Worker's config", () => {
  const config = readFileSync(join(repoRoot(), 'apps', 'api', 'wrangler.jsonc'), 'utf8');

  it('holds the rule in apps/api/wrangler.jsonc: ROOM_PICTURES_ENABLED reads "false" or "true", "true" only beside the binding, and a KV binding is the one of ROOM_PICTURES with the namespace’s id', () => {
    expect(pictureConfigProblems(config)).toEqual([]);
  });

  /** A config as small as the rule needs: the binding or what stands in its place, and the switch. */
  const made = (on: unknown, binding = ''): string =>
    [
      '{',
      '  // A comment line, which no deploy reads.',
      binding,
      `  "vars": { "${ROOM_PICTURES_ENABLED_VAR}": ${JSON.stringify(on)} }`,
      '}',
    ].join('\n');
  const entry = (binding: string, id: string): string => `{ "binding": "${binding}", "id": "${id}" }`;
  const ONE = entry(ROOM_PICTURES_KV_BINDING, ROOM_PICTURES_NAMESPACE_ID);
  const BOUND = `  "kv_namespaces": [${ONE}],`;
  /** The id with its last character slipped. */
  const SLIPPED = `${ROOM_PICTURES_NAMESPACE_ID.slice(0, -1)}5`;

  it.each<[string, string]>([
    ['as the build left it: off, with the binding in a comment', made('false', `  // ${BOUND.trim()}`)],
    ['off, with no word of a binding', made('false')],
    ['with the namespace bound and the switch still off', made('false', BOUND)],
    ['with the namespace bound and the switch on', made('true', BOUND)],
  ])('finds nothing wrong in a config %s', (_name, text) => {
    expect(pictureConfigProblems(text)).toEqual([]);
  });

  it.each<[string, string, string[]]>([
    ['is on with the binding still in its comment', made('true', `  // ${BOUND.trim()}`), [SWITCH_NOT_BOUND]],
    ['is on with no word of a binding', made('true'), [SWITCH_NOT_BOUND]],
    [
      'is on beside another binding alone',
      made('true', `  "kv_namespaces": [${entry('OBJECTS', ROOM_PICTURES_NAMESPACE_ID)}],`),
      [SWITCH_NOT_BOUND, NOT_THE_NAMESPACE],
    ],
    [
      'binds a namespace whose id differs by one character',
      made('false', `  "kv_namespaces": [${entry(ROOM_PICTURES_KV_BINDING, SLIPPED)}],`),
      [NOT_THE_NAMESPACE],
    ],
    [
      'is on and binds a namespace whose id differs by one character',
      made('true', `  "kv_namespaces": [${entry(ROOM_PICTURES_KV_BINDING, SLIPPED)}],`),
      [NOT_THE_NAMESPACE],
    ],
    [
      'binds a second namespace beside it',
      made('false', `  "kv_namespaces": [${ONE}, ${entry('OBJECTS', SLIPPED)}],`),
      [NOT_THE_NAMESPACE],
    ],
    [
      'binds ROOM_PICTURES with no id, which lets a deploy make a namespace by itself',
      made('true', `  "kv_namespaces": [{ "binding": "${ROOM_PICTURES_KV_BINDING}" }],`),
      [NOT_THE_NAMESPACE],
    ],
    [
      'binds it with a key more than the binding and the id',
      made(
        'false',
        `  "kv_namespaces": [{ "binding": "${ROOM_PICTURES_KV_BINDING}", "id": "${ROOM_PICTURES_NAMESPACE_ID}", "preview_id": "${SLIPPED}" }],`,
      ),
      [NOT_THE_NAMESPACE],
    ],
    ['holds an empty list of namespaces', made('false', '  "kv_namespaces": [],'), [NOT_THE_NAMESPACE]],
    ['spells the switch "TRUE"', made('TRUE', BOUND), [switchReads('TRUE')]],
    ['spells the switch "1"', made('1', BOUND), [switchReads('1')]],
    ['leaves the switch empty', made('', BOUND), [switchReads('')]],
    ['gives the switch a value that is no string', made(true, BOUND), [switchReads(true)]],
    [
      'names the switch twice, the second time on, with nothing bound',
      made('false').replace('}', `, "${ROOM_PICTURES_ENABLED_VAR}": "true" }`),
      [switchNamed(2), SWITCH_NOT_BOUND],
    ],
    ['does not name the switch', '{\n  "vars": {}\n}', [switchNamed(0), switchReads(undefined)]],
  ])('says what is wrong with a config that %s', (_name, text, problems) => {
    expect(pictureConfigProblems(text)).toEqual(problems);
  });

  it('needs all three switches, each "true" after trimming and lower-casing', () => {
    expect(roomPicturesEnabled('true', 'true', 'true')).toBe(true);
    expect(roomPicturesEnabled(' TRUE ', 'True', 'true\n')).toBe(true);
    for (const off of ['false', undefined, '', '1', 'yes', 'on', 'truee', 't rue']) {
      expect(roomPicturesEnabled(off, 'true', 'true'), String(off)).toBe(false);
      expect(roomPicturesEnabled('true', off, 'true'), String(off)).toBe(false);
      expect(roomPicturesEnabled('true', 'true', off), String(off)).toBe(false);
    }
  });
});

describe('the log lines of pictures', () => {
  it('are the nine of the contract', () => {
    // Seven at revision 3; `room_picture_upload_failed` since revision 4; `room_picture_report_failed`
    // since the operator's reading of revision 6.
    expect(Object.values(ROOM_PICTURE_LOG_EVENTS)).toHaveLength(9);
    expect(Object.values(ROOM_PICTURE_LOG_EVENTS).sort()).toEqual([
      'room_picture_delete_failed',
      'room_picture_length_mismatch',
      'room_picture_orphan',
      'room_picture_report_failed',
      'room_picture_reported',
      'room_picture_upload_failed',
      'room_picture_views_cap',
      'room_pictures_auto_off',
      'room_pictures_swept',
    ]);
  });
});

describe('the rows of a day beside pictures (revision 5)', () => {
  const messages = roomDailyCap(undefined);
  const views = roomPictureViewsCap(undefined);

  it('books 11 rows for a stored upload, and counts a picture at 5 rows more than the 9 of a message', () => {
    expect(ROOM_PICTURE_POST_WRITE_ROWS).toBe(11);
    expect(ROOM_PICTURE_POST_WRITE_ROWS + ROOM_PICTURE_PRUNE_ROWS - ROOM_ROWS_PER_MESSAGE).toBe(5);
    // The three figures of section 23, each from the constants.
    expect(roomPictureRowsWorst(ROOM_PICTURES_PER_DAY_DEFAULT, views)).toBe(2_150);
    expect(roomPictureRowsWorst(ROOM_PICTURES_PER_DAY_MAX, views)).toBe(3_050);
    expect(roomPictureRowsWorst(ROOM_PICTURES_PER_DAY_MAX, ROOM_PICTURE_VIEWS_PER_DAY_MAX)).toBe(3_450);
  });

  it("never raises the room's share: the messages give way, from 56 pictures a day on", () => {
    expect(ROOM_ROWS_PER_DAY).toBe(5_700);
    expect(messages).toBe(400);
    expect(roomDailyCapBesidePictures(messages, ROOM_PICTURES_PER_DAY_DEFAULT, views)).toBe(394);
    expect(roomDailyCapBesidePictures(messages, 55, views)).toBe(400);
    expect(roomDailyCapBesidePictures(messages, 56, views)).toBeLessThan(400);
    expect(roomDailyCapBesidePictures(messages, ROOM_PICTURES_PER_DAY_MAX, views)).toBe(294);
    expect(roomDailyCapBesidePictures(messages, ROOM_PICTURES_PER_DAY_MAX, ROOM_PICTURE_VIEWS_PER_DAY_MAX)).toBe(250);
    // At every cap a variable can set, the day fits the room's share.
    for (const pictures of [0, 5, 20, 55, 60, 100, ROOM_PICTURES_PER_DAY_MAX]) {
      for (const seen of [0, views, ROOM_PICTURE_VIEWS_PER_DAY_MAX]) {
        const cap = roomDailyCapBesidePictures(messages, pictures, seen);
        expect(cap * ROOM_ROWS_PER_MESSAGE + roomPictureRowsWorst(pictures, seen)).toBeLessThanOrEqual(
          ROOM_ROWS_PER_DAY,
        );
      }
    }
  });
});

describe('the keys and the slots of revisions 5 and 6', () => {
  const keyOf = (name: string): string => `social.roomPicture${name}`;

  it('holds the eleven keys of revision 5 and the six of revision 6, and no second key for a size', () => {
    const added = [
      ...['SizeKb', 'Send', 'Sending', 'SendFailed', 'SendFailedTitle', 'ReportClosed'],
      ...['AdminOnState', 'AdminReportedBy', 'AdminReportsOne', 'AdminReportsOther', 'AdminHash'],
      ...['ReportAsk', 'ReportYes', 'ReportNo', 'RestingRow', 'AdminPicturesTitle', 'AdminMessagesTitle'],
    ];
    expect(added.filter((name) => !ROOM_PICTURE_COPY_KEYS.includes(keyOf(name) as never))).toEqual([]);
    expect(added.filter((name) => (deck[keyOf(name)] ?? '').trim() === '')).toEqual([]);
    // 87 at revision 5, and six more.
    expect(ROOM_PICTURE_COPY_KEYS).toHaveLength(93);
    // One key, one rounding rule, for both web owners.
    for (const gone of ['SizeBytes', 'Size']) {
      expect(ROOM_PICTURE_COPY_KEYS).not.toContain(keyOf(gone));
      expect(Object.hasOwn(deck, keyOf(gone)), gone).toBe(false);
    }
  });

  it('gives each sentence exactly the slots the contract names, and no other sentence a slot', () => {
    const slots: Record<string, string[]> = {
      Facts: ['height', 'size', 'type', 'width'],
      FactsAnimated: ['frames', 'height', 'size', 'width'],
      SizeKb: ['count'],
      LeftOther: ['count'],
      AdminReportsOther: ['count'],
      NewWriter: ['minutes'],
      AdminOffState: ['at'],
      AdminHash: ['hash'],
    };
    const wrong: string[] = [];
    for (const key of ROOM_PICTURE_COPY_KEYS) {
      const found = [...new Set([...(deck[key] ?? '').matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ''))].sort();
      // By its whole name: `NewWriter` is the composer's rule and has the slot, the refusal of that name has none.
      const name = Object.keys(slots).find((each) => key === keyOf(each));
      const wanted = name === undefined ? [] : (slots[name] ?? []);
      if (JSON.stringify(found) !== JSON.stringify(wanted)) wrong.push(`${key}: ${found.join(' ')}`);
    }
    expect(wrong).toEqual([]);
    // A sentence that names a figure of the limits has no slot for it: a page never types a number.
    expect(deck[keyOf('RefusalSize')] ?? '').toMatch(/\d/);
  });

  it('says of a malformed picture what is true of a file that cannot be read and of one that did not arrive whole', () => {
    // The operator's reading of revision 6: the same refusal now also answers a body that came too late.
    const said = deck[roomPictureRefusalKey('picture_malformed')] ?? '';
    expect(said).toMatch(/did not arrive whole/i);
    expect(said).toMatch(/cannot be read/i);
    expect(said).not.toMatch(/\bbroken\b/i);
    expect(said).toMatch(/try again|choose another/i);
  });
});

describe("the deadline of an upload's body", () => {
  it('is thirty seconds: the review proposed ten, and the operator took thirty for a phone on a slow network', () => {
    expect(ROOM_PICTURE_BODY_SECONDS).toBe(30);
  });
});

describe('what the code of the API may not reach for', () => {
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const routes = readSources('apps/api/src/http/social/room', ['.ts'], (path) => /\.test\.ts$|test-support/.test(path));
  const stores = readSources(
    'apps/api/src/store',
    ['.ts'],
    (path) => !/room-picture/.test(path) || /\.test\.ts$/.test(path),
  );

  it('is read: the routes of the room and the two files of the pictures store', () => {
    expect(routes.map(({ path }) => path.split('/').at(-1))).toEqual(
      expect.arrayContaining(['routes-pictures.ts', 'routes-pictures-admin.ts', 'routes-admin.ts', 'shared.ts']),
    );
    expect(stores.map(({ path }) => path.split('/').at(-1)).sort()).toEqual([
      'room-picture-bytes.ts',
      'room-pictures.ts',
    ]);
  });

  it('has no handle on the Cache API in any route of the room: no key, no put, no match', () => {
    // Section 17: the entry drops the room's read; no route does, and the bytes never enter a cache.
    const found = routes.filter(({ source }) =>
      /\bcaches\b|\bcache\.(?:match|put|delete)\b|\bCacheStorage\b/.test(code(source)),
    );
    expect(found.map(({ path }) => path)).toEqual([]);
  });

  it('runs no statement of the pictures store in a D1 session: the primary answers every one', () => {
    // Section 6: a session may read a replica, and D1 must refuse a removed picture at the next request.
    const found = [...routes, ...stores].filter(({ source }) => /\bwithSession\b/.test(code(source)));
    expect(found.map(({ path }) => path)).toEqual([]);
  });

  it('gives the bytes port a put with an expiry, a get and a delete, and no list and no metadata', () => {
    const port = stores.find(({ path }) => path.endsWith('room-picture-bytes.ts'));
    const text = code(port?.source ?? '');
    expect(text).not.toMatch(/\.list\s*\(|getWithMetadata|\bmetadata\b/);
    // Every call of KV's put in it hands an expirationTtl.
    const puts = [...text.matchAll(/\.put\(([^;]*)\);/g)].map((match) => match[1] ?? '');
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((call) => /expirationTtl/.test(call))).toBe(true);
  });

  it('writes no byte, key or hash of a picture into a log line: the one function takes an id, a count or a step', () => {
    const found: string[] = [];
    for (const { path, source } of routes) {
      for (const call of code(source).matchAll(/logPicture\(([^)]*)\)/g)) {
        const given = call[1] ?? '';
        if (/logPicture\s*$/.test(given) || given.includes('event:')) continue;
        // A message's id, a count, or the number of the step that threw (the two lines of a fault in work
        // that was handed over: revisions 4 and 6). Nothing else is ever named.
        if (!/\{\s*(?:id(?::\s*[\w.]+)?|count(?::\s*[\w.]+)?|step(?::\s*[\w.]+)?)\s*\}\s*$/.test(given))
          found.push(`${path}: logPicture(${given})`);
      }
      if (/console\.(?:log|error|warn)\([^)]*\b(?:sha256|key|author|address)\b/.test(code(source))) {
        found.push(`${path}: a console line that names a key, a hash or an address`);
      }
    }
    expect(found).toEqual([]);
  });
});
