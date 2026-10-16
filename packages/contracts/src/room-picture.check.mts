// The operator's check of the room's picture rule (room-picture.ts, roomPictureCheck): what a hostile or a
// careless file brings must be refused or lose what it brought, and an honest picture must pass with its
// facts. Every fixture is built here, in code, byte by byte: no file is read. One line a case; exit 1 on any
// surprise.
// Usage: node --experimental-strip-types --no-warnings packages/contracts/src/room-picture.check.mts
//
// Revision 2 (2026-10-11) adds a case for every new limit and for each file the security review of draft 1
// names. A line that starts ACCEPTED is a file the rule lets through on purpose, with the reason and the
// place of the defence under it. Each timed file is also walked once in a process of its own
// (`--first <shape>`, which this script starts itself): the first call is what a fresh isolate pays, and it
// is printed beside the best of TIMED_RUNS. Only the best is judged here; the first call is judged by gate
// 3 of the contract, in workerd.
//
// Revision 3 (2026-10-11) adds one case, from the second security look (N3): a JPEG of 239 table segments
// of the longest length, ACCEPTED. The limit on a table segment bounds a segment, not a file.
//
// Revision 5 (2026-10-11): ROOM_PICTURE_MAX_BYTES is 262,144. Every case at the largest size is built from
// that constant, so each is rebuilt at the new size: the two files of tables hold as many segments as the
// largest file takes (119 DHT segments where there were 239, four DQT segments where there were eight). The
// seven timed shapes moved to room-picture.shapes.mts, which does nothing when it is imported, so that
// perf's script times the very files this one does. No case was added or taken away.

import { SHAPES } from './room-picture.shapes.mts';
import type { RoomPictureChecked, RoomPictureProblem, RoomPictureType } from './room-picture.ts';
import {
  ROOM_PICTURE_ANIMATED_MAX_SIDE,
  ROOM_PICTURE_COMPOSER_MAX_SIDE,
  ROOM_PICTURE_COMPOSER_STEPS,
  ROOM_PICTURE_GIF_KEPT,
  ROOM_PICTURE_GIF_MAX_BLOCKS,
  ROOM_PICTURE_ID_PATTERN,
  ROOM_PICTURE_JPEG_DHT_MAX_LENGTH,
  ROOM_PICTURE_JPEG_DQT_MAX_LENGTH,
  ROOM_PICTURE_JPEG_KEPT,
  ROOM_PICTURE_JPEG_MAX_SEGMENTS,
  ROOM_PICTURE_LIMITS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_MIN_BYTES,
  ROOM_PICTURE_MIN_SIDE,
  ROOM_PICTURE_PNG_KEPT,
  ROOM_PICTURE_PNG_MAX_CHUNKS,
  ROOM_PICTURE_REPORTER_AGE_SECONDS,
  ROOM_PICTURE_WRITER_AGE_SECONDS,
  roomPictureAdminPath,
  roomPictureCheck,
  roomPictureIdOf,
  roomPicturePath,
  roomPictureReportPath,
} from './room-picture.ts';

/** The slowest the walk of a file of the largest size may be on this machine, best of TIMED_RUNS, in milliseconds. */
const TIMED_MS = 5;
const TIMED_RUNS = 9;

/** Node's own process, when there is one: the arguments, and a child for the first call of a timed file. */
interface Spawned {
  status: number | null;
  stdout: string | null;
}
const runtime = (
  globalThis as unknown as {
    process?: {
      argv: string[];
      execArgv: string[];
      execPath: string;
      exitCode?: number;
      exit(code: number): never;
      getBuiltinModule?(
        name: string,
      ): { spawnSync(command: string, args: string[], options: { encoding: 'utf8' }): Spawned } | undefined;
    };
  }
).process;
/** Mutations of each fixture in the fuzz run. */
const MUTATIONS = 4_000;

type Part = Uint8Array | readonly number[] | string;

/** Bytes of a string, one for each character code: every string here is ASCII or a named byte. */
function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

function cat(...parts: Part[]): Uint8Array {
  const arrays = parts.map((part) => (typeof part === 'string' ? ascii(part) : Uint8Array.from(part)));
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
}

const u16be = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const u16le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32be = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/** True when `hay` holds the bytes of `needle`. */
function holds(hay: Uint8Array, needle: string): boolean {
  const want = ascii(needle);
  const first = want[0] as number;
  for (let from = hay.indexOf(first); from !== -1; from = hay.indexOf(first, from + 1)) {
    let same = true;
    for (let index = 1; index < want.length && same; index += 1) same = hay[from + index] === want[index];
    if (same) return true;
  }
  return false;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

// --- PNG fixtures ----------------------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}
/** A zlib stream of stored blocks: valid, and no compressor is needed to make it. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Part[] = [[0x78, 0x01]];
  for (let from = 0; from === 0 || from < raw.length; from += 65_535) {
    const block = raw.subarray(from, from + 65_535);
    const last = from + 65_535 >= raw.length ? 1 : 0;
    parts.push([last, ...u16le(block.length), ...u16le(~block.length & 0xffff)], block);
  }
  parts.push(u32be(adler32(raw)));
  return cat(...parts);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngChunk(type: string, data: Part = []): Uint8Array {
  const body = cat(type, data);
  return cat(u32be(body.length - 4), body, u32be(crc32(body)));
}
function pngHeader(width: number, height: number, depth = 8, colour = 0, interlace = 0): Uint8Array {
  return pngChunk('IHDR', [...u32be(width), ...u32be(height), depth, colour, 0, 0, interlace]);
}
/** The IDAT of a grey picture of 8 bits: every row a filter byte of 0 and `width` pixels of mid grey. */
function pngGreyData(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (width + 1)).fill(0x80);
  for (let row = 0; row < height; row += 1) raw[row * (width + 1)] = 0;
  return pngChunk('IDAT', zlibStored(raw));
}
const PNG_END = pngChunk('IEND');
const png = (...chunks: Uint8Array[]): Uint8Array => cat(PNG_SIGNATURE, ...chunks);

const PNG_SMALLEST = png(pngHeader(16, 16), pngGreyData(16, 16), PNG_END);
const PNG_TEXT = png(
  pngHeader(16, 16),
  pngChunk('gAMA', u32be(45_455)),
  pngChunk('pHYs', [...u32be(2_835), ...u32be(2_835), 1]),
  pngChunk('tEXt', 'Comment\0planted-text-chunk'),
  pngChunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<script>planted-itxt ns.adobe.com</script>'),
  pngChunk('zTXt', 'Software\0\0planted-ztxt'),
  pngChunk('eXIf', 'MM\0*planted-exif GPS 37.7749N 122.4194W'),
  pngChunk('tIME', [0x07, 0xea, 10, 11, 12, 0, 0]),
  pngChunk('iCCP', 'planted-icc\0\0ICC_PROFILE'),
  pngGreyData(16, 16),
  pngChunk('tEXt', 'Comment\0planted-after-data'),
  PNG_END,
);
const PNG_TEXT_CLEAN = png(pngHeader(16, 16), pngChunk('gAMA', u32be(45_455)), pngGreyData(16, 16), PNG_END);
/** An animated PNG: acTL and fcTL before the still, fcTL and fdAT after it. */
const PNG_ANIMATED = png(
  pngHeader(16, 16),
  pngChunk('acTL', [...u32be(2), ...u32be(0)]),
  pngChunk('fcTL', [...u32be(0), ...u32be(16), ...u32be(16), ...u32be(0), ...u32be(0), 0, 1, 0, 10, 0, 0]),
  pngGreyData(16, 16),
  pngChunk('fcTL', [...u32be(1), ...u32be(16), ...u32be(16), ...u32be(0), ...u32be(0), 0, 1, 0, 10, 0, 0]),
  pngChunk('fdAT', cat(u32be(2), zlibStored(new Uint8Array(16 * 17)))),
  PNG_END,
);
const PNG_PALETTE = png(
  pngHeader(16, 16, 8, 3),
  pngChunk('sRGB', [0]),
  pngChunk('PLTE', [0, 0, 0, 255, 255, 255]),
  pngChunk('tRNS', [0, 255]),
  pngChunk('IDAT', zlibStored(new Uint8Array(16 * 17))),
  PNG_END,
);

// --- JPEG fixtures ---------------------------------------------------------------------------------------

function segment(marker: number, data: Part = []): Uint8Array {
  const body = cat(data);
  return cat([0xff, marker], u16be(body.length + 2), body);
}
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = segment(0xe0, cat('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const JFIF_THUMBNAIL = segment(0xe0, cat('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 1, 1], [9, 9, 9]));
const ADOBE = segment(0xee, cat('Adobe', [0, 100, 0, 0, 0, 0, 1]));
const DQT = segment(0xdb, [0, ...new Array<number>(64).fill(1)]);
/** One code of one bit for the one symbol 0: a DC difference of nothing, and an end of block. */
const huffman = (table: number): Uint8Array => segment(0xc4, [table, 1, ...new Array<number>(15).fill(0), 0]);
const DHT_DC = huffman(0x00);
const DHT_AC = huffman(0x10);
function frameOf(marker: number, width: number, height: number, components = 1, precision = 8): Uint8Array {
  const each: number[] = [];
  for (let id = 1; id <= components; id += 1) each.push(id, 0x11, 0);
  return segment(marker, [precision, ...u16be(height), ...u16be(width), components, ...each]);
}
function scanOf(components = 1, from = 0, to = 63): Uint8Array {
  const each: number[] = [];
  for (let id = 1; id <= components; id += 1) each.push(id, 0x00);
  return segment(0xda, [components, ...each, from, to, 0]);
}
/** The scan data of a grey picture of one flat tone: two bits of zero for each block of eight by eight, the last byte filled with ones. */
function flatScan(width: number, height: number): Uint8Array {
  const bits = 2 * Math.ceil(width / 8) * Math.ceil(height / 8);
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  const spare = bytes.length * 8 - bits;
  if (spare > 0) bytes[bytes.length - 1] = (1 << spare) - 1;
  return bytes;
}
function jpeg(width: number, height: number, before: Part[] = [], after: Part[] = []): Uint8Array {
  return cat(
    SOI,
    ...before,
    DQT,
    frameOf(0xc0, width, height),
    DHT_DC,
    DHT_AC,
    ...after,
    scanOf(),
    flatScan(width, height),
    EOI,
  );
}

const JPEG_SMALLEST = jpeg(16, 16);
const JPEG_JFIF = jpeg(16, 16, [JFIF]);
const EXIF = segment(0xe1, 'Exif\0\0MM\0*planted-exif GPSLatitude 37.7749N GPSLongitude 122.4194W');
const XMP = segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>planted-xmp</x:xmpmeta>');
const ICC = segment(0xe2, 'ICC_PROFILE\0\x01\x01planted-icc');
const MPF = segment(0xe2, 'MPF\0MM\0*planted-mpf');
const IPTC = segment(0xed, 'Photoshop 3.0\x008BIM planted-iptc');
const COMMENT = segment(0xfe, 'planted-comment <script>alert(1)</script>');
const JPEG_EXIF = jpeg(
  16,
  16,
  [JFIF, EXIF, XMP, ICC, MPF, IPTC, COMMENT, ADOBE],
  [COMMENT, segment(0xef, 'planted-app15')],
);
const JPEG_EXIF_CLEAN = jpeg(16, 16, [JFIF, ADOBE]);
/** Three scans as a progressive file has them, with a table and a dropped comment between two of them. */
const JPEG_PROGRESSIVE = cat(
  SOI,
  JFIF,
  DQT,
  frameOf(0xc2, 16, 16),
  DHT_DC,
  DHT_AC,
  scanOf(1, 0, 0),
  [0x00],
  DHT_AC,
  COMMENT,
  scanOf(1, 1, 5),
  [0x12, 0xff, 0x00, 0x34],
  segment(0xdd, [0, 4]),
  scanOf(1, 6, 63),
  [0x56, 0xff, 0xd0, 0x78, 0xff, 0xd7, 0x9a],
  EOI,
);
const JPEG_COLOUR = cat(SOI, JFIF, DQT, frameOf(0xc0, 16, 16, 3), DHT_DC, DHT_AC, scanOf(3), [0x00, 0x00, 0x00], EOI);

// --- GIF fixtures ----------------------------------------------------------------------------------------

function subBlocks(data: Uint8Array, each = 255): Uint8Array {
  const parts: Part[] = [];
  for (let from = 0; from < data.length; from += each) {
    const block = data.subarray(from, from + each);
    parts.push([block.length], block);
  }
  parts.push([0]);
  return cat(...parts);
}
/**
 * LZW with nothing compressed, at a code size of 2: a clear code before every two pixels of colour 0, so
 * that the code width stays at three bits, then the end code. Codes are packed from the low bit.
 */
function lzwFlat(pixels: number): Uint8Array {
  const codes: number[] = [];
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (pixel % 2 === 0) codes.push(4);
    codes.push(0);
  }
  codes.push(5);
  const bytes = new Uint8Array(Math.ceil((codes.length * 3) / 8));
  codes.forEach((code, index) => {
    const bit = index * 3;
    bytes[bit >> 3] = (bytes[bit >> 3] as number) | ((code << (bit & 7)) & 0xff);
    if ((bit & 7) > 5) bytes[(bit >> 3) + 1] = (bytes[(bit >> 3) + 1] as number) | (code >> (8 - (bit & 7)));
  });
  return bytes;
}
function gifScreen(width: number, height: number, version = '89a', table = true): Uint8Array {
  return cat(`GIF${version}`, u16le(width), u16le(height), table ? [0x80, 0, 0, 0, 0, 0, 255, 255, 255] : [0, 0, 0]);
}
function gifImage(left: number, top: number, width: number, height: number, code = 2, local = false): Uint8Array {
  return cat(
    [0x2c],
    u16le(left),
    u16le(top),
    u16le(width),
    u16le(height),
    local ? [0x80, 0, 0, 0, 255, 255, 255] : [0],
    [code],
    subBlocks(lzwFlat(width * height)),
  );
}
const gifControl = (delay = 10): number[] => [0x21, 0xf9, 4, 0, ...u16le(delay), 0, 0];
const GIF_LOOP = cat([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0]);
const gifComment = (text: string): Uint8Array => cat([0x21, 0xfe], subBlocks(ascii(text)));
const GIF_XMP = cat(
  [0x21, 0xff, 11],
  'XMP DataXMP',
  subBlocks(ascii('<x:xmpmeta>planted-xmp ns.adobe.com</x:xmpmeta>')),
);
const GIF_PLAIN_TEXT = cat([0x21, 0x01, 12], new Uint8Array(12), subBlocks(ascii('planted-plain-text')));
const GIF_END = [0x3b];
function gifFrames(count: number, side: number): Uint8Array {
  const parts: Part[] = [gifScreen(side, side), GIF_LOOP];
  for (let frame = 0; frame < count; frame += 1) parts.push(gifControl(), gifImage(frame % side, 0, 1, 1));
  parts.push(GIF_END);
  return cat(...parts);
}

const GIF_SMALLEST = cat(gifScreen(16, 16), gifImage(0, 0, 16, 16), GIF_END);
const GIF_OLD = cat(gifScreen(16, 16, '87a'), gifImage(0, 0, 16, 16), GIF_END);
const GIF_COMMENT = cat(
  gifScreen(16, 16),
  gifComment('planted-comment <script>alert(1)</script>'),
  GIF_XMP,
  GIF_LOOP,
  gifControl(),
  GIF_PLAIN_TEXT,
  gifControl(7),
  gifComment('planted-between'),
  gifImage(0, 0, 16, 16),
  gifControl(),
  gifImage(4, 4, 8, 8, 2, true),
  GIF_LOOP,
  gifControl(),
  gifComment('planted-at-the-end'),
  GIF_END,
);
const GIF_COMMENT_CLEAN = cat(
  gifScreen(16, 16),
  GIF_LOOP,
  gifControl(7),
  gifImage(0, 0, 16, 16),
  gifControl(),
  gifImage(4, 4, 8, 8, 2, true),
  GIF_END,
);

// --- files of the largest size ---------------------------------------------------------------------------
//
// The seven files that are timed are in room-picture.shapes.mts since revision 5 (SHAPES). The two here are
// refused, and timed nowhere.

/** A PNG of exactly `total` bytes: `dropped` empty tEXt chunks, then one IDAT that takes the rest. */
function pngOfDroppedChunks(total: number, dropped: number): Uint8Array {
  const parts: Part[] = [PNG_SIGNATURE, pngHeader(ROOM_PICTURE_MAX_SIDE, ROOM_PICTURE_MAX_SIDE)];
  for (let chunk = 0; chunk < dropped; chunk += 1) parts.push(pngChunk('tEXt'));
  const before = cat(...parts);
  return cat(before, pngChunk('IDAT', new Uint8Array(total - before.length - 12 - PNG_END.length).fill(0x55)), PNG_END);
}
/** A GIF of exactly `total` bytes: one frame, then empty comment extensions of three bytes each to the end. */
function gifOfEmptyComments(total: number): Uint8Array {
  // The frame's data is one sub-block of 8, 9 or 10 bytes, whichever leaves a multiple of three.
  const frame = (data: number): Uint8Array =>
    cat(
      gifScreen(16, 16),
      [0x2c],
      u16le(0),
      u16le(0),
      u16le(16),
      u16le(16),
      [0, 2, data],
      new Uint8Array(data).fill(0x11),
      [0],
    );
  const head = frame(8 + ((total - frame(8).length - 1) % 3));
  const comments = new Uint8Array(total - head.length - 1);
  for (let at = 0; at < comments.length; at += 3) comments.set([0x21, 0xfe, 0x00], at);
  return cat(head, comments, GIF_END);
}

interface Facts {
  type: RoomPictureType;
  width: number;
  height: number;
  frames: number;
}
const GIF_MOST: Facts = {
  type: 'gif',
  width: ROOM_PICTURE_ANIMATED_MAX_SIDE,
  height: ROOM_PICTURE_ANIMATED_MAX_SIDE,
  frames: ROOM_PICTURE_MAX_FRAMES,
};

// `--first <shape>`: this process builds one file, walks it once and prints the milliseconds. Nothing else
// has called the rule before, so it is the first call of a fresh process. The run of the cases starts one
// such process for each shape.
{
  const started = runtime !== undefined && /room-picture\.check\.mts$/.test(runtime.argv[1] ?? '');
  const flag = runtime === undefined || !started ? -1 : runtime.argv.indexOf('--first');
  if (runtime !== undefined && flag !== -1) {
    const shape = SHAPES.find((each) => each.key === runtime.argv[flag + 1]);
    if (shape === undefined) {
      console.log('unknown shape');
      runtime.exit(2);
    } else {
      const file = shape.make(ROOM_PICTURE_MAX_BYTES);
      const from = performance.now();
      const answer = roomPictureCheck(file);
      const took = performance.now() - from;
      console.log(answer.ok ? took.toFixed(2) : `refused as ${answer.problem}`);
      runtime.exit(answer.ok ? 0 : 1);
    }
  }
}
/** The first call of a shape in a process of its own, in milliseconds; null when there is no way to start one; NaN when the child did not answer a figure. */
function firstCall(key: string): number | null {
  const child = runtime?.getBuiltinModule?.('node:child_process');
  const script = runtime?.argv[1];
  if (runtime === undefined || child === undefined || script === undefined) return null;
  // Only when this file is the program that was started: imported by another program (a test that reads
  // the fixtures), it must not start that program again.
  if (!/room-picture\.check\.mts$/.test(script)) return null;
  const run = child.spawnSync(runtime.execPath, [...runtime.execArgv, script, '--first', key], { encoding: 'utf8' });
  const text = (run.stdout ?? '').trim();
  return run.status === 0 && /^\d+\.\d\d$/.test(text) ? Number(text) : Number.NaN;
}

// --- the cases -------------------------------------------------------------------------------------------

let failed = 0;
let count = 0;
function line(ok: boolean, what: string, detail = ''): void {
  count += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail === '' ? '' : `: ${detail}`}`);
}
const told = (answer: RoomPictureChecked): string =>
  answer.ok
    ? `${answer.type} ${answer.width}x${answer.height}, ${answer.frames} frame(s), ${answer.bytes.length} bytes`
    : `refused as ${answer.problem}`;

/** The structures an output holds: every one must be on its type's list. */
function structuresOf(type: RoomPictureType, out: Uint8Array): string | null {
  if (type === 'png') {
    for (let at = 8; at < out.length; ) {
      const length =
        (((out[at] as number) << 24) |
          ((out[at + 1] as number) << 16) |
          ((out[at + 2] as number) << 8) |
          (out[at + 3] as number)) >>>
        0;
      const name = String.fromCharCode(...out.subarray(at + 4, at + 8));
      if (!(ROOM_PICTURE_PNG_KEPT as readonly string[]).includes(name)) return `chunk ${name}`;
      at += 12 + length;
    }
    return null;
  }
  if (type === 'jpeg') {
    for (let at = 0; at < out.length; ) {
      const marker = out[at + 1] as number;
      if (out[at] !== 0xff || !(ROOM_PICTURE_JPEG_KEPT as readonly number[]).includes(marker))
        return `marker ${marker.toString(16)} at ${at}`;
      if (marker === 0xd8 || marker === 0xd9) {
        at += 2;
        continue;
      }
      at += 2 + (((out[at + 2] as number) << 8) | (out[at + 3] as number));
      if (marker !== 0xda) continue;
      while (
        at < out.length &&
        (out[at] !== 0xff || out[at + 1] === 0 || ((out[at + 1] as number) >= 0xd0 && (out[at + 1] as number) <= 0xd7))
      )
        at += 1;
    }
    return null;
  }
  let at = 13 + ((out[10] as number) & 0x80 ? 3 << (((out[10] as number) & 7) + 1) : 0);
  while (at < out.length) {
    const block = out[at] as number;
    const label = block === 0x21 ? (out[at + 1] as number) : null;
    if (!ROOM_PICTURE_GIF_KEPT.some((kept) => kept.block === block && kept.label === label))
      return `block ${block.toString(16)}`;
    if (block === 0x3b) return at === out.length - 1 ? null : 'a byte after the trailer';
    if (label === 0xff && !holds(out.subarray(at, at + 14), 'NETSCAPE2.0'))
      return 'an application block that is not the loop block';
    if (block === 0x21) at += 2;
    else at += 10 + ((out[at + 9] as number) & 0x80 ? 3 << (((out[at + 9] as number) & 7) + 1) : 0) + 1;
    while (out[at] !== 0) at += 1 + (out[at] as number);
    at += 1;
  }
  return 'no trailer';
}

/** Passes with these facts; its output holds only listed structures and, checked again, answers itself. */
function passes(what: string, file: Uint8Array, facts: Facts, also?: (out: Uint8Array) => string | null): void {
  const answer = roomPictureCheck(file);
  if (!answer.ok) {
    line(false, what, told(answer));
    return;
  }
  const wrong =
    answer.type !== facts.type ||
    answer.width !== facts.width ||
    answer.height !== facts.height ||
    answer.frames !== facts.frames;
  if (wrong) {
    line(false, what, told(answer));
    return;
  }
  const stray = structuresOf(answer.type, answer.bytes);
  if (stray !== null) {
    line(false, what, `the output holds ${stray}`);
    return;
  }
  const again = roomPictureCheck(answer.bytes);
  if (!again.ok || !same(again.bytes, answer.bytes)) {
    line(false, what, 'the output, checked again, is not itself');
    return;
  }
  if (answer.bytes.length > file.length) {
    line(false, what, 'the output is longer than the file');
    return;
  }
  const more = also === undefined ? null : also(answer.bytes);
  line(more === null, `${what} (${told(answer)})`, more ?? '');
}
function refused(what: string, file: Uint8Array, problem: RoomPictureProblem): void {
  const answer = roomPictureCheck(file);
  line(
    !answer.ok && answer.problem === problem,
    `refused as ${problem}: ${what}`,
    answer.ok || answer.problem !== problem ? told(answer) : '',
  );
}
/**
 * A file the rule lets through ON PURPOSE, though it carries something a reader might expect it to stop.
 * It must pass with these facts, and what it carries must still be in the output: if the rule ever starts
 * to refuse or to clean it, this line fails and the contract's sentence about it is rewritten. The second
 * line says why passing is right and where the defence is.
 */
function accepted(what: string, file: Uint8Array, facts: Facts, survives: string, why: string): void {
  passes(`ACCEPTED: ${what}`, file, facts, (out) =>
    holds(out, survives) ? null : `the output no longer holds "${survives}": the rule changed, say so in the contract`,
  );
  console.log(`       why: ${why}`);
}
/**
 * True when these bytes, read one character a byte (Latin-1), parse as a script. The text is only parsed:
 * the function that `new Function` makes is never called, and nothing here is a user's file.
 */
function parsesAsScript(bytes: Uint8Array): boolean {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  try {
    new Function(text);
    return true;
  } catch {
    return false;
  }
}
const equals = (clean: Uint8Array) => (out: Uint8Array) =>
  same(out, clean) ? null : 'the output is not the clean file';
const without =
  (clean: Uint8Array, ...planted: string[]) =>
  (out: Uint8Array) => {
    const left = planted.filter((text) => holds(out, text));
    if (left.length > 0) return `the output still holds ${left.join(', ')}`;
    return same(out, clean) ? null : 'the output is not the clean file';
  };

const PNG_16: Facts = { type: 'png', width: 16, height: 16, frames: 1 };
const JPEG_16: Facts = { type: 'jpeg', width: 16, height: 16, frames: 1 };
const GIF_16: Facts = { type: 'gif', width: 16, height: 16, frames: 1 };

// A smallest valid file of each type: the output is the file.
passes('the smallest PNG', PNG_SMALLEST, PNG_16, equals(PNG_SMALLEST));
passes('the smallest JPEG', JPEG_SMALLEST, JPEG_16, equals(JPEG_SMALLEST));
passes('the smallest GIF', GIF_SMALLEST, GIF_16, equals(GIF_SMALLEST));
passes('a GIF87a is written as GIF89a', GIF_OLD, GIF_16, equals(GIF_SMALLEST));
passes('a JPEG with a JFIF header keeps it', JPEG_JFIF, JPEG_16, equals(JPEG_JFIF));
passes('a PNG with a palette and transparency', PNG_PALETTE, PNG_16, equals(PNG_PALETTE));
passes('a progressive JPEG of three scans with restart markers', JPEG_PROGRESSIVE, JPEG_16, (out) =>
  holds(out, 'planted') ? 'the comment between two scans is still there' : null,
);
passes('a JPEG of three components', JPEG_COLOUR, JPEG_16, equals(JPEG_COLOUR));

// Each with EXIF, a comment or a text chunk: the output no longer holds it.
passes(
  'a PNG with tEXt, iTXt, zTXt, eXIf, tIME, iCCP and pHYs loses them',
  PNG_TEXT,
  PNG_16,
  without(
    PNG_TEXT_CLEAN,
    'planted',
    'tEXt',
    'iTXt',
    'zTXt',
    'eXIf',
    'tIME',
    'iCCP',
    'pHYs',
    'script',
    'adobe',
    'GPS',
    'ICC_PROFILE',
  ),
);
passes(
  'a JPEG with EXIF and its GPS, XMP, ICC, MPF, IPTC and comments loses them',
  JPEG_EXIF,
  JPEG_16,
  without(
    JPEG_EXIF_CLEAN,
    'planted',
    'Exif',
    'GPS',
    'ns.adobe.com',
    'ICC_PROFILE',
    'MPF',
    'Photoshop',
    'script',
    '37.7749',
  ),
);
passes(
  'a GIF with comments, XMP and plain text loses them, and keeps one loop block',
  GIF_COMMENT,
  { type: 'gif', width: 16, height: 16, frames: 2 },
  without(GIF_COMMENT_CLEAN, 'planted', 'XMP', 'script', 'adobe'),
);
passes(
  'a JPEG whose JFIF header carries a thumbnail loses the header',
  jpeg(16, 16, [JFIF_THUMBNAIL]),
  JPEG_16,
  equals(JPEG_SMALLEST),
);
passes('a JPEG with a second JFIF header keeps the first', jpeg(16, 16, [JFIF, JFIF]), JPEG_16, equals(JPEG_JFIF));

// An animated PNG becomes its still.
passes('an APNG becomes its still', PNG_ANIMATED, PNG_16, without(PNG_SMALLEST, 'acTL', 'fcTL', 'fdAT'));

// One byte appended, and a truncated file.
for (const [name, file] of [
  ['PNG', PNG_TEXT],
  ['JPEG', JPEG_EXIF],
  ['GIF', GIF_COMMENT],
] as const) {
  let passed = 0;
  for (let byte = 0; byte < 256; byte += 1) if (roomPictureCheck(cat(file, [byte])).ok) passed += 1;
  line(
    passed === 0,
    `refused: a ${name} with one byte appended, whichever byte`,
    passed === 0 ? '' : `${passed} passed`,
  );
  refused(
    `a ${name} with its last byte cut off`,
    file.subarray(0, file.length - 1),
    file.length - 1 < ROOM_PICTURE_MIN_BYTES ? 'size' : 'malformed',
  );
  let cuts = 0;
  for (let length = 0; length < file.length; length += 1) if (roomPictureCheck(file.subarray(0, length)).ok) cuts += 1;
  line(
    cuts === 0,
    `refused: a ${name} cut at every one of its ${file.length} lengths`,
    cuts === 0 ? '' : `${cuts} passed`,
  );
}
refused(
  'a JPEG with a video after its end marker, as a motion photo has',
  cat(JPEG_EXIF, '\0\0\0\x18ftypmp42'),
  'malformed',
);
refused('a PNG with a ZIP after IEND', cat(PNG_SMALLEST, 'PK\x03\x04'), 'malformed');

// A second frame, too many frames, no frame.
refused(
  'a JPEG with a second frame',
  cat(SOI, DQT, frameOf(0xc0, 16, 16), frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), [0], EOI),
  'malformed',
);
refused('two JPEGs one after the other', cat(JPEG_SMALLEST, JPEG_SMALLEST), 'malformed');
refused(`a GIF with ${ROOM_PICTURE_MAX_FRAMES + 1} frames`, gifFrames(ROOM_PICTURE_MAX_FRAMES + 1, 64), 'frames');
passes(`a GIF with ${ROOM_PICTURE_MAX_FRAMES} frames`, gifFrames(ROOM_PICTURE_MAX_FRAMES, 64), {
  type: 'gif',
  width: 64,
  height: 64,
  frames: ROOM_PICTURE_MAX_FRAMES,
});
refused(
  'a GIF with no frame',
  cat(gifScreen(16, 16), gifComment('nothing to show, nothing to show'), GIF_END),
  'frames',
);

// What is not a picture of the three types.
refused('an empty file', new Uint8Array(0), 'size');
refused(`a file of ${ROOM_PICTURE_MIN_BYTES - 1} bytes`, PNG_SMALLEST.subarray(0, ROOM_PICTURE_MIN_BYTES - 1), 'size');
refused('a file one byte over the largest', new Uint8Array(ROOM_PICTURE_MAX_BYTES + 1), 'size');
refused('an SVG', ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'type');
refused(
  'an SVG behind an XML declaration',
  ascii('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
  'type',
);
refused('an HTML page', ascii('<!doctype html><html><body><script>alert(1)</script></body></html>'), 'type');
refused('a PDF', ascii('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n'), 'type');
refused('a ZIP', cat('PK\x03\x04', new Uint8Array(60)), 'type');
refused('a WebP', cat('RIFF', [56, 0, 0, 0], 'WEBPVP8 ', new Uint8Array(48)), 'type');
refused('a BMP', cat('BM', new Uint8Array(62)), 'type');
refused('a PNG behind a byte order mark', cat([0xef, 0xbb, 0xbf], PNG_SMALLEST), 'type');
refused('a GIF behind a space', cat(' ', GIF_SMALLEST), 'type');
refused('a GIF of an unknown version', cat('GIF90a', GIF_SMALLEST.subarray(6)), 'type');

// A file that is two things at once.
refused(
  'the file that is a GIF and a script: its width is the opening of a comment',
  cat(
    'GIF89a',
    '/*',
    u16le(16),
    [0x80, 0, 0],
    [0, 0, 0, 255, 255, 255],
    gifImage(0, 0, 16, 16),
    '*/=1;alert(1)',
    GIF_END,
  ),
  'dimensions',
);
refused(
  'an HTML page behind a PNG signature',
  cat(PNG_SIGNATURE, '<html><script>alert(1)</script></html>'),
  'malformed',
);
refused('a GIF with a PNG after its trailer', cat(GIF_SMALLEST, PNG_SMALLEST), 'malformed');
refused('a JPEG with a ZIP after its end marker', cat(JPEG_SMALLEST, 'PK\x03\x04', new Uint8Array(26)), 'malformed');
passes(
  'a PNG that carries a whole GIF and a page in a private chunk loses both',
  png(
    pngHeader(16, 16),
    pngChunk('prIX', cat(GIF_SMALLEST, '<script>planted-page</script>')),
    pngGreyData(16, 16),
    PNG_END,
  ),
  PNG_16,
  without(PNG_SMALLEST, 'GIF89a', 'planted', 'script'),
);
passes(
  'a JPEG that carries a whole PNG and a page in a comment loses both',
  jpeg(16, 16, [segment(0xfe, cat(PNG_SMALLEST, '<script>planted-page</script>'))]),
  JPEG_16,
  without(JPEG_SMALLEST, 'PNG', 'IHDR', 'planted', 'script'),
);
passes(
  'a GIF that carries a whole JPEG in an application block loses it',
  cat(
    gifScreen(16, 16),
    [0x21, 0xff, 11],
    'PRIXPRIX1.0',
    subBlocks(cat(JPEG_SMALLEST, 'planted-jpeg')),
    gifImage(0, 0, 16, 16),
    GIF_END,
  ),
  GIF_16,
  without(GIF_SMALLEST, 'planted', 'PRIX'),
);

// Sides, pixels and frames.
const MOST = ROOM_PICTURE_MAX_SIDE;
passes(`a PNG of ${MOST} by ${MOST}`, png(pngHeader(MOST, MOST), pngChunk('IDAT', [0]), PNG_END), {
  type: 'png',
  width: MOST,
  height: MOST,
  frames: 1,
});
refused(`a PNG of ${MOST + 1} by 16`, png(pngHeader(MOST + 1, 16), pngChunk('IDAT', [0]), PNG_END), 'dimensions');
refused('a PNG of 30,000 by 30,000', png(pngHeader(30_000, 30_000), pngChunk('IDAT', [0]), PNG_END), 'dimensions');
refused(
  `a PNG of ${ROOM_PICTURE_MIN_SIDE - 1} by 16`,
  png(pngHeader(ROOM_PICTURE_MIN_SIDE - 1, 16), pngGreyData(15, 16), PNG_END),
  'dimensions',
);
refused('a PNG of no width', png(pngHeader(0, 16), pngChunk('IDAT', [0]), PNG_END), 'malformed');
refused(`a JPEG of 16 by ${MOST + 1}`, jpeg(16, MOST + 1), 'dimensions');
passes(`a JPEG of ${MOST} by ${MOST}`, jpeg(MOST, MOST), { type: 'jpeg', width: MOST, height: MOST, frames: 1 });
refused(
  'a JPEG of 65,535 by 65,535',
  cat(SOI, DQT, frameOf(0xc0, 65_535, 65_535), DHT_DC, DHT_AC, scanOf(), [0], EOI),
  'dimensions',
);
refused('a JPEG whose height waits for a DNL segment', jpeg(16, 0), 'malformed');
const WIDE = ROOM_PICTURE_ANIMATED_MAX_SIDE + 1;
passes(`a still GIF of ${WIDE} by 16`, cat(gifScreen(WIDE, 16), gifImage(0, 0, 1, 1), GIF_END), {
  type: 'gif',
  width: WIDE,
  height: 16,
  frames: 1,
});
refused(
  `an animated GIF of ${WIDE} by 16`,
  cat(gifScreen(WIDE, 16), gifImage(0, 0, 1, 1), gifImage(1, 0, 1, 1), GIF_END),
  'dimensions',
);
refused(`a GIF of ${MOST + 1} by 16`, cat(gifScreen(MOST + 1, 16), gifImage(0, 0, 1, 1), GIF_END), 'dimensions');

// PNG: what is kept breaks its own rule, or stands where it may not.
refused(
  'a PNG with an unknown critical chunk',
  png(pngHeader(16, 16), pngChunk('PRIX', 'x'), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused(
  'a PNG whose first chunk is not IHDR',
  png(pngChunk('gAMA', u32be(1)), pngHeader(16, 16), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused('a PNG with two IHDR', png(pngHeader(16, 16), pngHeader(16, 16), pngGreyData(16, 16), PNG_END), 'malformed');
refused('a PNG with no IDAT', png(pngHeader(16, 16), PNG_END), 'malformed');
refused(
  'a PNG whose IDATs are apart',
  png(pngHeader(16, 16), pngGreyData(16, 16), pngChunk('tEXt', 'a\0b'), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused(
  'a PNG of an indexed colour with no palette',
  png(pngHeader(16, 16, 8, 3), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused(
  'a PNG whose palette is not whole colours',
  png(pngHeader(16, 16, 8, 3), pngChunk('PLTE', [1, 2, 3, 4]), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused(
  'a grey PNG with a palette',
  png(pngHeader(16, 16), pngChunk('PLTE', [1, 2, 3]), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused(
  'a PNG with gAMA after the data',
  png(pngHeader(16, 16), pngGreyData(16, 16), pngChunk('gAMA', u32be(1)), PNG_END),
  'malformed',
);
refused(
  'a PNG with a gAMA of five bytes',
  png(pngHeader(16, 16), pngChunk('gAMA', [0, 0, 0, 1, 2]), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused(
  'a PNG of a depth its colour type has not',
  png(pngHeader(16, 16, 4, 2), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused('a PNG whose IEND has data', png(pngHeader(16, 16), pngGreyData(16, 16), pngChunk('IEND', [1])), 'malformed');
refused(
  'a PNG with a digit in a chunk type',
  png(pngHeader(16, 16), pngChunk('tEX1', 'a'), pngGreyData(16, 16), PNG_END),
  'malformed',
);
refused(
  'a PNG whose chunk says it is longer than the file',
  cat(PNG_SIGNATURE, pngHeader(16, 16), u32be(0x7fffffff), 'IDAT', new Uint8Array(40)),
  'malformed',
);
{
  // The cap counts every chunk, kept and dropped: IHDR, the dropped ones, IDAT and IEND.
  const dropped = (count: number): Uint8Array[] => new Array<Uint8Array>(count).fill(pngChunk('tEXt'));
  passes(
    `a PNG with exactly ${ROOM_PICTURE_PNG_MAX_CHUNKS} chunks`,
    png(pngHeader(16, 16), ...dropped(ROOM_PICTURE_PNG_MAX_CHUNKS - 3), pngGreyData(16, 16), PNG_END),
    PNG_16,
    equals(PNG_SMALLEST),
  );
  refused(
    `a PNG with ${ROOM_PICTURE_PNG_MAX_CHUNKS + 1} chunks`,
    png(pngHeader(16, 16), ...dropped(ROOM_PICTURE_PNG_MAX_CHUNKS - 2), pngGreyData(16, 16), PNG_END),
    'malformed',
  );
  refused(
    "the security review's slow PNG: the largest size, 8,189 empty dropped chunks (M5)",
    pngOfDroppedChunks(ROOM_PICTURE_MAX_BYTES, 8_189),
    'malformed',
  );
}
// Revision 2: a palette only for an indexed picture (the security review's L1).
{
  const free = new Uint8Array(768).fill(0x41);
  refused(
    'a truecolour PNG with a palette of 768 free bytes (L1)',
    png(pngHeader(16, 16, 8, 2), pngChunk('PLTE', free), pngChunk('IDAT', [0]), PNG_END),
    'malformed',
  );
  refused(
    'a truecolour PNG with alpha and a palette',
    png(pngHeader(16, 16, 8, 6), pngChunk('PLTE', [1, 2, 3]), pngChunk('IDAT', [0]), PNG_END),
    'malformed',
  );
  const TRANSPARENT = png(
    pngHeader(16, 16, 8, 2),
    pngChunk('tRNS', [0, 1, 0, 2, 0, 3]),
    pngChunk('IDAT', [0]),
    PNG_END,
  );
  passes('a truecolour PNG with tRNS and no palette', TRANSPARENT, PNG_16, equals(TRANSPARENT));
}

// JPEG: what is on no list, and what breaks its own rule.
refused(
  'a lossless JPEG (SOF3)',
  cat(SOI, DQT, frameOf(0xc3, 16, 16), DHT_DC, DHT_AC, scanOf(), [0], EOI),
  'malformed',
);
refused(
  'an arithmetic JPEG (SOF9)',
  cat(SOI, DQT, frameOf(0xc9, 16, 16), DHT_DC, DHT_AC, scanOf(), [0], EOI),
  'malformed',
);
refused(
  'a JPEG of 12 bits a sample',
  cat(SOI, DQT, frameOf(0xc1, 16, 16, 1, 12), DHT_DC, DHT_AC, scanOf(), [0], EOI),
  'malformed',
);
refused(
  'a JPEG of four components',
  cat(SOI, DQT, frameOf(0xc0, 16, 16, 4), DHT_DC, DHT_AC, scanOf(4), [0], EOI),
  'malformed',
);
refused('a JPEG with a DNL segment', jpeg(16, 16, [], [segment(0xdc, [0, 16])]), 'malformed');
refused(
  'a JPEG with a fill byte before a segment',
  cat(SOI, [0xff], DQT, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), [0], EOI),
  'malformed',
);
refused(
  'a JPEG with a fill byte in its scan',
  cat(SOI, DQT, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), [0, 0xff], EOI),
  'malformed',
);
refused(
  'a JPEG with a restart marker outside a scan',
  cat(SOI, [0xff, 0xd0], DQT, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), [0], EOI),
  'malformed',
);
refused(
  'a JPEG whose scan comes before its frame',
  cat(SOI, DQT, DHT_DC, DHT_AC, scanOf(), [0], frameOf(0xc0, 16, 16), EOI),
  'malformed',
);
refused('a JPEG with no scan', cat(SOI, JFIF, DQT, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, EOI), 'malformed');
refused('a JPEG with no tables', cat(SOI, JFIF, frameOf(0xc0, 16, 16), scanOf(), new Uint8Array(8), EOI), 'malformed');
refused(
  'a JPEG with a DQT that is not whole tables',
  cat(
    SOI,
    segment(0xdb, [0, ...new Array<number>(70).fill(1)]),
    frameOf(0xc0, 16, 16),
    DHT_DC,
    DHT_AC,
    scanOf(),
    [0],
    EOI,
  ),
  'malformed',
);
refused(
  'a JPEG with a DHT that counts more symbols than it holds',
  cat(
    SOI,
    DQT,
    frameOf(0xc0, 16, 16),
    segment(0xc4, [0, 9, ...new Array<number>(15).fill(0), 0]),
    DHT_AC,
    scanOf(),
    [0],
    EOI,
  ),
  'malformed',
);
refused('a JPEG with no end marker', cat(JPEG_SMALLEST.subarray(0, JPEG_SMALLEST.length - 2), [0, 0]), 'malformed');
{
  const many: Part[] = [];
  for (let index = 0; index < ROOM_PICTURE_JPEG_MAX_SEGMENTS; index += 1) many.push(segment(0xfe, 'x'));
  refused(`a JPEG with more than ${ROOM_PICTURE_JPEG_MAX_SEGMENTS} segments`, jpeg(16, 16, many), 'malformed');
}
// Revision 2: a DQT and a DHT no longer than the tables a JPEG can use (the security review's L1).
{
  /** A quantisation table of 16 bits: a byte of precision and number, then 128 bytes. */
  const wide = (id: number): number[] => [0x10 | id, ...new Array<number>(128).fill(1)];
  /** A Huffman table of 256 symbols: a byte of class and number, 16 counts of 16, then the symbols. */
  const full = (table: number): number[] => [
    table,
    ...new Array<number>(16).fill(16),
    ...Array.from({ length: 256 }, (_, symbol) => symbol),
  ];
  const fourWide = segment(0xdb, [0, 1, 2, 3].flatMap(wide));
  const eightFull = segment(0xc4, [0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13].flatMap(full));
  line(
    fourWide.length - 2 === ROOM_PICTURE_JPEG_DQT_MAX_LENGTH &&
      eightFull.length - 2 === ROOM_PICTURE_JPEG_DHT_MAX_LENGTH,
    `the longest DQT is ${ROOM_PICTURE_JPEG_DQT_MAX_LENGTH} bytes (four tables of 16 bits) and the longest DHT ${ROOM_PICTURE_JPEG_DHT_MAX_LENGTH} (eight tables of 256 symbols)`,
  );
  const longest = jpeg(16, 16, [], [fourWide, eightFull]);
  passes('a JPEG with a DQT and a DHT of exactly the longest length', longest, JPEG_16, equals(longest));
  refused(
    'a JPEG with a DQT one table longer than the longest',
    jpeg(16, 16, [], [segment(0xdb, [...[0, 1, 2, 3].flatMap(wide), 0, ...new Array<number>(64).fill(1)])]),
    'malformed',
  );
  refused(
    'a JPEG with a DHT one table longer than the longest',
    jpeg(16, 16, [], [segment(0xc4, [0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13, 0x00].flatMap(full))]),
    'malformed',
  );
  // The review's file: DQT segments of 65,002 bytes (a thousand tables each) and four bytes of scan, of
  // which almost none are pixels. The review built eight of them, 520,121 bytes; since revision 5 it is as
  // many as the largest file holds (four at 262,144 bytes), so that the file is refused for its tables and
  // not for its size.
  const thousand = segment(
    0xdb,
    new Array<number>(1_000).fill(0).flatMap(() => [0, ...new Array<number>(64).fill(1)]),
  );
  const tablesRest = cat(SOI, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), [0, 0, 0, 0], EOI);
  const thousands = Math.floor((ROOM_PICTURE_MAX_BYTES - tablesRest.length) / thousand.length);
  const allTables = cat(
    SOI,
    ...new Array<Uint8Array>(thousands).fill(thousand),
    frameOf(0xc0, 16, 16),
    DHT_DC,
    DHT_AC,
    scanOf(),
    [0, 0, 0, 0],
    EOI,
  );
  refused(
    `the security review's JPEG of tables, as large as a file may be now: ${thousands} DQT segments of ${thousand.length - 2} bytes, ${allTables.length} bytes in all (L1)`,
    allTables,
    'malformed',
  );
  // Revision 3 (the second security look's N3): the limit bounds a segment, not a file. Tables cut into
  // DHT segments of the longest length pass with four bytes of scan, as many of them as the largest file
  // holds: 239 at revision 3's 524,288 bytes, 119 at revision 5's 262,144.
  const note = ascii('<script>planted-in-tables</script>');
  /** A Huffman table of 256 symbols, as `full`, whose symbols spell the note over and over. */
  const carrying = (table: number): number[] => [
    table,
    ...new Array<number>(16).fill(16),
    ...Array.from({ length: 256 }, (_, index) => note[index % note.length] as number),
  ];
  const longestDht = segment(0xc4, [0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13].flatMap(carrying));
  const manyRest = cat(SOI, DQT, frameOf(0xc0, 16, 16), scanOf(), [0, 0, 0, 0], EOI);
  const cut = Math.floor((ROOM_PICTURE_MAX_BYTES - manyRest.length) / longestDht.length);
  const manyTables = cat(
    SOI,
    DQT,
    frameOf(0xc0, 16, 16),
    ...new Array<Uint8Array>(cut).fill(longestDht),
    scanOf(),
    [0, 0, 0, 0],
    EOI,
  );
  accepted(
    `a JPEG of ${cut} DHT segments of the longest length (${longestDht.length} bytes each) and four bytes of scan: ${manyTables.length} bytes, of which ${cut * longestDht.length} are tables (N3)`,
    manyTables,
    JPEG_16,
    'planted-in-tables',
    'the limit on a table segment is there for the first bytes of a file (no first segment whose length spells the opening of a comment), not for what a file can carry: a scan is any bytes already, so tables give a sender nothing new. The bytes are inert because of section 7.',
  );
}

// GIF: what is on no list, and what breaks its own rule.
refused(
  'a GIF with an unknown extension',
  cat(gifScreen(16, 16), [0x21, 0x99, 1, 0, 0], gifImage(0, 0, 16, 16), GIF_END),
  'malformed',
);
refused('a GIF with an unknown block', cat(gifScreen(16, 16), [0x40], gifImage(0, 0, 16, 16), GIF_END), 'malformed');
refused('a GIF whose frame leaves the canvas', cat(gifScreen(16, 16), gifImage(8, 8, 16, 16), GIF_END), 'malformed');
refused(
  'a GIF with no colour table at all',
  cat(gifScreen(16, 16, '89a', false), gifImage(0, 0, 16, 16), GIF_END),
  'malformed',
);
passes(
  'a GIF with a local table only',
  cat(gifScreen(16, 16, '89a', false), gifImage(0, 0, 16, 16, 2, true), GIF_END),
  GIF_16,
);
refused('a GIF with an LZW code size of 9', cat(gifScreen(16, 16), gifImage(0, 0, 16, 16, 9), GIF_END), 'malformed');
refused(
  'a GIF whose frame has no data',
  cat(gifScreen(16, 16), [0x2c], u16le(0), u16le(0), u16le(16), u16le(16), [0, 2, 0], GIF_END),
  'malformed',
);
refused(
  'a GIF with a graphic control extension of five bytes',
  cat(gifScreen(16, 16), [0x21, 0xf9, 5, 0, 0, 0, 0, 0, 0], gifImage(0, 0, 16, 16), GIF_END),
  'malformed',
);
refused(
  'a GIF with no trailer',
  cat(gifScreen(16, 16), gifImage(0, 0, 16, 16), gifComment('the end is missing')),
  'malformed',
);
// Revision 2: the blocks of a GIF, kept and dropped together (the security review's M5). An image and an
// extension count one each; the trailer and the sub-blocks inside a block count nothing.
{
  const comments = (count: number): Uint8Array[] => new Array<Uint8Array>(count).fill(gifComment('x'));
  passes(
    `a GIF with exactly ${ROOM_PICTURE_GIF_MAX_BLOCKS} blocks`,
    cat(gifScreen(16, 16), ...comments(ROOM_PICTURE_GIF_MAX_BLOCKS - 1), gifImage(0, 0, 16, 16), GIF_END),
    GIF_16,
    equals(GIF_SMALLEST),
  );
  refused(
    `a GIF with ${ROOM_PICTURE_GIF_MAX_BLOCKS + 1} blocks`,
    cat(gifScreen(16, 16), ...comments(ROOM_PICTURE_GIF_MAX_BLOCKS), gifImage(0, 0, 16, 16), GIF_END),
    'malformed',
  );
  const slow = gifOfEmptyComments(ROOM_PICTURE_MAX_BYTES);
  refused(
    `the security review's slow GIF: the largest size, more than ${Math.floor(slow.length / 3_000)},000 empty dropped comments (M5)`,
    slow,
    'malformed',
  );
  line(
    slow.length === ROOM_PICTURE_MAX_BYTES,
    `that GIF is of the largest size, ${ROOM_PICTURE_MAX_BYTES} bytes`,
    `${slow.length} bytes`,
  );
}

// Revision 2: the two files of the security review that are a picture and a script at once (M1), and what
// else a hostile file still carries through the rule. THE RULE DOES NOT STOP A FILE THAT IS ALSO A SCRIPT.
{
  // The GIF. Its width is 96, whose low byte is a backtick: `GIF89a` then reads as the tag of a template
  // that runs to the next backtick, which is the first byte of the global table, and what follows it
  // there is a statement. Every byte of it is a kept structure, so the output is the file.
  const table = new Uint8Array(768).fill(0x20);
  table.set(ascii('`;globalThis.planted="gif-script";function GIF89a(){}//'), 0);
  const GIF_SCRIPT = cat(
    'GIF89a',
    [0x60, 0x00],
    u16le(16),
    [0xf7, 0, 0],
    table,
    [0x2c],
    u16le(0),
    u16le(0),
    u16le(16),
    u16le(16),
    [0, 2, 8],
    new Uint8Array(8).fill(0x11),
    [0],
    GIF_END,
  );
  accepted(
    'a GIF that is also a script: its width of 96 is a backtick, its global table holds the statement (M1)',
    GIF_SCRIPT,
    { type: 'gif', width: 96, height: 16, frames: 1 },
    'globalThis.planted="gif-script"',
    'no walk of a container can tell these bytes from a palette. The defence is section 7 of the contract and nothing here: the type from the row with nosniff, and the generic 404 to every request whose Sec-Fetch-Dest is not image. Neither is ever softened.',
  );
  const out = roomPictureCheck(GIF_SCRIPT);
  line(
    out.ok && same(out.bytes, GIF_SCRIPT) && parsesAsScript(out.bytes),
    'and the bytes that are stored for it parse as a script (parsed only, never called)',
  );
  line(!parsesAsScript(GIF_SMALLEST), 'while the smallest GIF does not parse as one');

  // The JPEG. Draft 1 let it through: no APP0, and a first segment, a DQT, whose length 0x2F2A spells the
  // opening of a comment (150 tables of 8 bits and 18 of 16). Revision 2's limit on a table segment
  // refuses it, and with that limit the length of every segment that can stand first in an output begins
  // with a byte of 8 or less.
  const tables: number[] = [];
  for (let index = 0; index < 150; index += 1) tables.push(index & 3, ...new Array<number>(64).fill(0x20));
  for (let index = 0; index < 18; index += 1) tables.push(0x10 | (index & 3), ...new Array<number>(128).fill(0x20));
  const note = ascii('*/=1;globalThis.planted="jpeg-script";/*');
  for (let index = 0; index < note.length; index += 1) tables[1 + index] = note[index] as number;
  const first = segment(0xdb, tables);
  const JPEG_SCRIPT = cat(SOI, first, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), '*/ //', EOI);
  line(
    first[2] === 0x2f && first[3] === 0x2a,
    'the JPEG that was also a script: the length of its first segment spells the opening of a comment',
  );
  refused(
    'that JPEG, since revision 2: its first segment is a DQT longer than four tables (M1, L1)',
    JPEG_SCRIPT,
    'malformed',
  );
  console.log(
    '       why: draft 1 ACCEPTED this file. No JPEG that is also a script is known to pass now; the defence is section 7 all the same, since nobody has shown that none exists.',
  );
  line(!parsesAsScript(JPEG_SMALLEST), 'and the smallest JPEG does not parse as a script');

  // Bytes that are not pixels and survive, each inside a structure the rule must keep.
  accepted(
    'a JPEG whose scan data is a page (L1)',
    cat(SOI, DQT, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), '<html><script>planted-scan</script></html>', EOI),
    JPEG_16,
    'planted-scan',
    'a scan is the pixels, and the rule decodes none. The bytes are inert because of how a picture is served (section 7).',
  );
  accepted(
    'a JPEG with markup inside a quantisation table (L1)',
    jpeg(16, 16, [], [segment(0xdb, [1, ...ascii('<svg onload=planted-table>'), ...new Array<number>(38).fill(1)])]),
    JPEG_16,
    'planted-table',
    'a table is 64 or 128 bytes of numbers, and any 64 bytes are a legal table. Revision 2 bounds a table segment at four tables; inside that the bytes are inert because of section 7.',
  );
  accepted(
    'a JPEG whose JFIF header spells seven bytes of its own (version, units, densities)',
    jpeg(16, 16, [segment(0xe0, cat('JFIF\0', 'PRIXPRI', [0, 0]))]),
    JPEG_16,
    'PRIXPRI',
    'seven bytes a decoder reads as numbers. Nothing fits in them.',
  );
  accepted(
    'a PNG whose IDAT is a page and not a zlib stream',
    png(pngHeader(16, 16), pngChunk('IDAT', '<html><script>planted-idat</script></html>'), PNG_END),
    PNG_16,
    'planted-idat',
    'the rule decodes no pixel and computes no CRC: this file shows nothing in a browser, which costs its sender the picture. Its bytes are inert because of section 7.',
  );
  accepted(
    'a PNG of a few dozen bytes that declares 2,048 by 2,048 pixels of 16 bits with alpha (L7)',
    png(pngHeader(MOST, MOST, 16, 6), pngChunk('IDAT', new Uint8Array(11).fill(0x4c)), PNG_END),
    { type: 'png', width: MOST, height: MOST, frames: 1 },
    'LLLLLLLLLLL',
    'the limits bound what a reader decodes (4,194,304 pixels), not what a sender pays for it. Nothing is decoded before a click, and the row says the dimensions first.',
  );
  const flash: Part[] = [gifScreen(ROOM_PICTURE_ANIMATED_MAX_SIDE, ROOM_PICTURE_ANIMATED_MAX_SIDE)];
  for (let frame = 0; frame < ROOM_PICTURE_MAX_FRAMES; frame += 1) {
    flash.push(
      gifControl(0),
      [0x2c],
      u16le(0),
      u16le(0),
      u16le(ROOM_PICTURE_ANIMATED_MAX_SIDE),
      u16le(ROOM_PICTURE_ANIMATED_MAX_SIDE),
      [0, 2, 2, 0x4c, 0x4c, 0],
    );
  }
  const FLASH = cat(...flash, GIF_END);
  accepted(
    `a GIF of ${FLASH.length} bytes that declares ${ROOM_PICTURE_MAX_FRAMES} frames of 512 by 512 with no delay: a picture that flashes (L7)`,
    FLASH,
    GIF_MOST,
    'LL',
    'the rule reads no pixel and no delay. The click is the measure, and the row says "GIF, animated, 120 frames" from the server\'s own count before it (section 11).',
  );
}

// Revision 2: what a browser script of the room reads from this file.
{
  line(
    roomPicturePath(12) === '/api/social/room/pictures/12' &&
      roomPictureReportPath(12) === '/api/social/room/pictures/12/report' &&
      roomPictureAdminPath(12) === '/api/social/admin/room/pictures/12',
    'the three paths of a picture are built from its id',
  );
  const noIds = ['', '0', '012', '1e3', '-1', '12 ', '12/../../me', '1234567890123456', 'abc', null, undefined];
  line(
    roomPictureIdOf('12') === 12 &&
      roomPictureIdOf('123456789012345') === 123_456_789_012_345 &&
      noIds.every((text) => roomPictureIdOf(text) === null) &&
      ROOM_PICTURE_ID_PATTERN.source === '^[1-9]\\d{0,14}$',
    `an attribute is an id only as digits with no leading zero: ${noIds.length} others are none`,
  );
  const steps = ROOM_PICTURE_COMPOSER_STEPS;
  // What the largest file leaves a pixel at each side of the ladder, in bits, for a picture of 4 by 3 and
  // for a square one: the arithmetic the sides were chosen by (revision 5).
  const sides = [...new Set(steps.map((step) => step.side))];
  const bits = (pixels: (side: number) => number): string =>
    sides.map((side) => ((ROOM_PICTURE_MAX_BYTES * 8) / pixels(side)).toFixed(2)).join(', ');
  line(
    steps[0].side === ROOM_PICTURE_COMPOSER_MAX_SIDE &&
      steps.every(
        (step, index) =>
          index === 0 ||
          (step.side === steps[index - 1]?.side && step.quality < (steps[index - 1]?.quality ?? 0)) ||
          (step.side < (steps[index - 1]?.side ?? 0) && step.quality === steps[index - 1]?.quality),
      ) &&
      steps.every((step) => step.side <= ROOM_PICTURE_MAX_SIDE && step.side >= ROOM_PICTURE_MIN_SIDE),
    `the composer's ladder goes down one thing at a time: ${steps.map((step) => `${step.side} at ${step.quality}`).join(', ')}; at the sides ${sides.join(', ')} the largest file leaves a pixel ${bits((side) => side * side * 0.75)} bits (4 by 3) and ${bits((side) => side * side)} bits (square)`,
  );
  line(
    ROOM_PICTURE_WRITER_AGE_SECONDS === 3_600 &&
      ROOM_PICTURE_REPORTER_AGE_SECONDS === 86_400 &&
      ROOM_PICTURE_LIMITS.writerAgeMinutes === 60 &&
      ROOM_PICTURE_LIMITS.reporterAgeHours === 24,
    'a wallet uploads an hour after its first message and reports a day after it',
  );
}

// A fuzz run: a mutated file never throws; whatever passes holds listed structures only and answers itself.
function fuzz(name: string, file: Uint8Array, seed: number): void {
  let state = seed >>> 0;
  const random = (below: number): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % below;
  };
  let accepted = 0;
  let wrong = '';
  for (let round = 0; round < MUTATIONS && wrong === ''; round += 1) {
    let bytes: Uint8Array = Uint8Array.from(file);
    for (let edits = 1 + random(3); edits > 0; edits -= 1) {
      const at = random(bytes.length);
      const kind = random(6);
      if (kind === 0) bytes[at] = random(256);
      else if (kind === 1) bytes[at] = (bytes[at] as number) ^ (1 << random(8));
      else if (kind === 2) bytes = cat(bytes.subarray(0, at), [random(256)], bytes.subarray(at));
      else if (kind === 3) bytes = cat(bytes.subarray(0, at), bytes.subarray(at + 1));
      else if (kind === 4) bytes = cat(bytes.subarray(0, at), bytes.subarray(at, at + random(40)), bytes.subarray(at));
      else bytes = cat(bytes.subarray(0, at), bytes.subarray(Math.min(bytes.length, at + random(40))));
    }
    try {
      const answer = roomPictureCheck(bytes);
      if (!answer.ok) continue;
      accepted += 1;
      const stray = structuresOf(answer.type, answer.bytes);
      const again = roomPictureCheck(answer.bytes);
      if (stray !== null) wrong = `round ${round}: the output holds ${stray}`;
      else if (!again.ok || !same(again.bytes, answer.bytes))
        wrong = `round ${round}: the output, checked again, is not itself`;
      else if (answer.bytes.length > bytes.length) wrong = `round ${round}: the output is longer than the file`;
    } catch (error) {
      wrong = `round ${round}: it threw ${error instanceof Error ? error.message : 'something'}`;
    }
  }
  line(
    wrong === '',
    `${MUTATIONS} mutations of a ${name}: none threw, ${accepted} passed and each holds listed structures only`,
    wrong,
  );
}
fuzz('PNG', PNG_TEXT, 0x50_4e_47);
fuzz('JPEG', JPEG_EXIF, 0x4a_50_47);
fuzz('progressive JPEG', JPEG_PROGRESSIVE, 0x50_52_4f);
fuzz('GIF', GIF_COMMENT, 0x47_49_46);

// A file at the largest size, timed: the slowest shapes each walk still has (SHAPES, room-picture.shapes.mts,
// since revision 5: under the rule's limits that is as many chunks as a PNG may have, a scan that is all
// stuffed bytes, sub-blocks of one byte). The best of
// TIMED_RUNS is judged here. The first call, in a process of its own, is printed beside it and judged by
// gate 3 of the contract, in workerd: it is what a fresh isolate pays, and it is several times the best.
function timed(key: string, what: string, file: Uint8Array, facts: Facts): void {
  if (file.length !== ROOM_PICTURE_MAX_BYTES) {
    line(false, what, `the fixture is ${file.length} bytes`);
    return;
  }
  const first = firstCall(key);
  let best = Number.POSITIVE_INFINITY;
  let answer = roomPictureCheck(file);
  for (let run = 0; run < TIMED_RUNS; run += 1) {
    const start = performance.now();
    answer = roomPictureCheck(file);
    best = Math.min(best, performance.now() - start);
  }
  const right =
    answer.ok &&
    answer.type === facts.type &&
    answer.width === facts.width &&
    answer.height === facts.height &&
    answer.frames === facts.frames;
  const firstText =
    first === null
      ? 'first call not measured: no child process here'
      : Number.isNaN(first)
        ? 'first call NOT MEASURED: the child gave no figure'
        : `first call in a fresh process ${first.toFixed(2)} ms`;
  const fine = right && best <= TIMED_MS && !(first !== null && Number.isNaN(first));
  line(
    fine,
    `${what}: ${ROOM_PICTURE_MAX_BYTES} bytes in ${best.toFixed(2)} ms (best of ${TIMED_RUNS}, at most ${TIMED_MS} ms); ${firstText}`,
    fine ? '' : right ? (best <= TIMED_MS ? 'the first call was not measured' : 'too slow') : told(answer),
  );
}
for (const shape of SHAPES) {
  timed(shape.key, `the largest ${shape.what}`, shape.make(ROOM_PICTURE_MAX_BYTES), shape.facts);
}

console.log(failed === 0 ? `ALL OK (${count} cases)` : `${failed} FAILED of ${count}`);
if (failed > 0 && runtime !== undefined) runtime.exitCode = 1;

/** The fixtures a decoder was shown by hand (docs/contracts/phase-6-pictures.md section 4): each with what the rule answers for it. */
export const ROOM_PICTURE_FIXTURES: Readonly<Record<string, Uint8Array>> = {
  'smallest.png': PNG_SMALLEST,
  'palette.png': PNG_PALETTE,
  'text.png': PNG_TEXT,
  'animated.png': PNG_ANIMATED,
  'smallest.jpg': JPEG_SMALLEST,
  'exif.jpg': JPEG_EXIF,
  'colour.jpg': JPEG_COLOUR,
  'smallest.gif': GIF_SMALLEST,
  'old.gif': GIF_OLD,
  'comment.gif': GIF_COMMENT,
  'frames.gif': gifFrames(ROOM_PICTURE_MAX_FRAMES, 64),
};
