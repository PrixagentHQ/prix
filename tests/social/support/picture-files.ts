import type { RoomPictureProblem, RoomPictureType } from '@prix/contracts/room-picture';
import {
  ROOM_PICTURE_ANIMATED_MAX_SIDE,
  ROOM_PICTURE_GIF_MAX_BLOCKS,
  ROOM_PICTURE_JPEG_MAX_SEGMENTS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_MIN_BYTES,
  ROOM_PICTURE_MIN_SIDE,
  ROOM_PICTURE_PNG_MAX_CHUNKS,
} from '@prix/contracts/room-picture';

/**
 * The files of the pictures' tests, each built here in code: no file of anyone is read, and none is kept
 * on disk. `CORPUS` is every file docs/contracts/phase-6-pictures.md section 4 names, with what the
 * contract says of it: the problem it is refused with, or the facts it passes with, what must be gone
 * from the stored bytes and what stays in them on purpose.
 *
 * The builders write the three containers as their own specifications lay them out (PNG chunks with their
 * CRC, JPEG segments with their length, GIF blocks with their sub-blocks). They decide nothing about the
 * rule: what a file is expected to do is written beside it from the contract's text.
 */

type Part = string | ArrayLike<number>;

/** Bytes of a string, one for each character code: every string here is ASCII or a named byte. */
export function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

export function cat(...parts: Part[]): Uint8Array {
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
export function holds(hay: Uint8Array, needle: string): boolean {
  const want = ascii(needle);
  const first = want[0] as number;
  for (let from = hay.indexOf(first); from !== -1; from = hay.indexOf(first, from + 1)) {
    let equal = true;
    for (let index = 1; index < want.length && equal; index += 1) equal = hay[from + index] === want[index];
    if (equal) return true;
  }
  return false;
}

/** Lower-case hex of bytes: two values compare as text, and a failure prints something readable. */
export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

// --- PNG -------------------------------------------------------------------------------------------------

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
export function pngChunk(type: string, data: Part = []): Uint8Array {
  const body = cat(type, data);
  return cat(u32be(body.length - 4), body, u32be(crc32(body)));
}
export function pngHeader(width: number, height: number, depth = 8, colour = 0): Uint8Array {
  return pngChunk('IHDR', [...u32be(width), ...u32be(height), depth, colour, 0, 0, 0]);
}
/** The IDAT of a grey picture of 8 bits: every row a filter byte of 0 and `width` pixels of mid grey. */
export function pngGreyData(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (width + 1)).fill(0x80);
  for (let row = 0; row < height; row += 1) raw[row * (width + 1)] = 0;
  return pngChunk('IDAT', zlibStored(raw));
}
export const PNG_END = pngChunk('IEND');
export const png = (...chunks: Uint8Array[]): Uint8Array => cat(PNG_SIGNATURE, ...chunks);

export const PNG_SMALLEST = png(pngHeader(16, 16), pngGreyData(16, 16), PNG_END);
/** A PNG with every ancillary chunk the contract names as dropped, and a gAMA that is kept. */
export const PNG_TEXT = png(
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
export const PNG_TEXT_CLEAN = png(pngHeader(16, 16), pngChunk('gAMA', u32be(45_455)), pngGreyData(16, 16), PNG_END);
/** An animated PNG: acTL and fcTL before the still, fcTL and fdAT after it. */
export const PNG_ANIMATED = png(
  pngHeader(16, 16),
  pngChunk('acTL', [...u32be(2), ...u32be(0)]),
  pngChunk('fcTL', [...u32be(0), ...u32be(16), ...u32be(16), ...u32be(0), ...u32be(0), 0, 1, 0, 10, 0, 0]),
  pngGreyData(16, 16),
  pngChunk('fcTL', [...u32be(1), ...u32be(16), ...u32be(16), ...u32be(0), ...u32be(0), 0, 1, 0, 10, 0, 0]),
  pngChunk('fdAT', cat(u32be(2), zlibStored(new Uint8Array(16 * 17)))),
  PNG_END,
);

// --- JPEG ------------------------------------------------------------------------------------------------

export function segment(marker: number, data: Part = []): Uint8Array {
  const body = cat(data);
  return cat([0xff, marker], u16be(body.length + 2), body);
}
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = segment(0xe0, cat('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const ADOBE = segment(0xee, cat('Adobe', [0, 100, 0, 0, 0, 0, 1]));
const DQT = segment(0xdb, [0, ...new Array<number>(64).fill(1)]);
/** One code of one bit for the one symbol 0: a DC difference of nothing, and an end of block. */
const huffman = (table: number): Uint8Array => segment(0xc4, [table, 1, ...new Array<number>(15).fill(0), 0]);
const DHT_DC = huffman(0x00);
const DHT_AC = huffman(0x10);
function frameOf(marker: number, width: number, height: number, components = 1): Uint8Array {
  const each: number[] = [];
  for (let id = 1; id <= components; id += 1) each.push(id, 0x11, 0);
  return segment(marker, [8, ...u16be(height), ...u16be(width), components, ...each]);
}
function scanOf(): Uint8Array {
  return segment(0xda, [1, 1, 0x00, 0, 63, 0]);
}
/** The scan data of a grey picture of one flat tone: two bits of zero for each block of eight by eight, the last byte filled with ones. */
function flatScan(width: number, height: number): Uint8Array {
  const bits = 2 * Math.ceil(width / 8) * Math.ceil(height / 8);
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  const spare = bytes.length * 8 - bits;
  if (spare > 0) bytes[bytes.length - 1] = (1 << spare) - 1;
  return bytes;
}
export function jpeg(width: number, height: number, before: Part[] = [], after: Part[] = []): Uint8Array {
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

export const JPEG_SMALLEST = jpeg(16, 16);
const EXIF = segment(0xe1, 'Exif\0\0MM\0*planted-exif GPSLatitude 37.7749N GPSLongitude 122.4194W');
const XMP = segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>planted-xmp</x:xmpmeta>');
const ICC = segment(0xe2, 'ICC_PROFILE\0\x01\x01planted-icc');
const MPF = segment(0xe2, 'MPF\0MM\0*planted-mpf');
const IPTC = segment(0xed, 'Photoshop 3.0\x008BIM planted-iptc');
const COMMENT = segment(0xfe, 'planted-comment <script>alert(1)</script>');
/** A JPEG as a phone writes one: EXIF with a location, XMP, ICC, MPF, IPTC and comments. */
export const JPEG_EXIF = jpeg(
  16,
  16,
  [JFIF, EXIF, XMP, ICC, MPF, IPTC, COMMENT, ADOBE],
  [COMMENT, segment(0xef, 'planted-app15')],
);
export const JPEG_EXIF_CLEAN = jpeg(16, 16, [JFIF, ADOBE]);

// --- GIF -------------------------------------------------------------------------------------------------

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
function gifScreen(width: number, height: number, version = '89a', table = true, tint = 255): Uint8Array {
  return cat(`GIF${version}`, u16le(width), u16le(height), table ? [0x80, 0, 0, 0, 0, 0, tint, 255, 255] : [0, 0, 0]);
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
/** An animated GIF of `count` frames of one pixel each on a canvas of `side`. */
export function gifFrames(count: number, side: number): Uint8Array {
  const parts: Part[] = [gifScreen(side, side), GIF_LOOP];
  for (let frame = 0; frame < count; frame += 1) parts.push(gifControl(), gifImage(frame % side, 0, 1, 1));
  parts.push(GIF_END);
  return cat(...parts);
}

export const GIF_SMALLEST = cat(gifScreen(16, 16), gifImage(0, 0, 16, 16), GIF_END);
/**
 * A still GIF of 16 by 16 that the rule hands back as it came, and that differs from every other `tint`:
 * the one byte is a colour of its table, so each has its own SHA-256. For tests that need several
 * pictures, or the same bytes twice.
 */
export function gifTinted(tint: number): Uint8Array {
  return cat(gifScreen(16, 16, '89a', true, tint & 0xff), gifImage(0, 0, 16, 16), GIF_END);
}
export const GIF_COMMENT = cat(
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
export const GIF_COMMENT_CLEAN = cat(
  gifScreen(16, 16),
  GIF_LOOP,
  gifControl(7),
  gifImage(0, 0, 16, 16),
  gifControl(),
  gifImage(4, 4, 8, 8, 2, true),
  GIF_END,
);

/**
 * THE GIF THAT IS ALSO A SCRIPT (the security review's M1, the contract's section 4). Its width is 96,
 * whose low byte is a backtick: `GIF89a` then reads as the tag of a template that runs to the next
 * backtick, the first byte of the global table, and what follows it there is a statement. Every byte of
 * it is a structure the rule keeps, so what is stored is the file. It is inert only because of how a
 * picture is served (section 7).
 */
export const GIF_SCRIPT = ((): Uint8Array => {
  const table = new Uint8Array(768).fill(0x20);
  table.set(ascii('`;globalThis.planted="gif-script";function GIF89a(){}//'), 0);
  return cat(
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
})();

/**
 * THE JPEG THAT WAS ALSO A SCRIPT. It has no APP0, and its first segment is a DQT whose length 0x2F2A
 * spells the opening of a comment (150 tables of 8 bits and 18 of 16). The limit on a table segment
 * refuses it since revision 2.
 */
export const JPEG_SCRIPT = ((): Uint8Array => {
  const tables: number[] = [];
  for (let index = 0; index < 150; index += 1) tables.push(index & 3, ...new Array<number>(64).fill(0x20));
  for (let index = 0; index < 18; index += 1) tables.push(0x10 | (index & 3), ...new Array<number>(128).fill(0x20));
  const note = ascii('*/=1;globalThis.planted="jpeg-script";/*');
  for (let index = 0; index < note.length; index += 1) tables[1 + index] = note[index] as number;
  return cat(SOI, segment(0xdb, tables), frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), '*/ //', EOI);
})();

/**
 * True when these bytes, read one character a byte (Latin-1), parse as a script. The text is only parsed:
 * the function that `new Function` makes is never called, and nothing here is a user's file.
 */
export function parsesAsScript(bytes: Uint8Array): boolean {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  try {
    new Function(text);
    return true;
  } catch {
    return false;
  }
}

// --- the corpus ------------------------------------------------------------------------------------------

export interface Passing {
  ok: true;
  type: RoomPictureType;
  width: number;
  height: number;
  frames: number;
  /** The stored bytes are exactly these (the clean file); absent when only `gone` and `stays` are asked. */
  clean?: Uint8Array;
  /** Text that the stored bytes no longer hold. */
  gone?: string[];
  /** Text that stays in the stored bytes on purpose: one of the contract's files that are ACCEPTED. */
  stays?: string;
}
export interface Refused {
  ok: false;
  problem: RoomPictureProblem;
}
export interface CorpusFile {
  name: string;
  file: Uint8Array;
  expect: Passing | Refused;
}

/** A file that is none of the three types, padded to a length the rule looks at. */
function padded(head: Part): Uint8Array {
  const bytes = cat(head);
  return bytes.length >= 64 ? bytes : cat(bytes, new Uint8Array(64 - bytes.length));
}

const MOST = ROOM_PICTURE_MAX_SIDE;
const WIDE = ROOM_PICTURE_ANIMATED_MAX_SIDE + 1;
const refused = (name: string, file: Uint8Array, problem: RoomPictureProblem): CorpusFile => ({
  name,
  file,
  expect: { ok: false, problem },
});
const passes = (name: string, file: Uint8Array, expect: Omit<Passing, 'ok'>): CorpusFile => ({
  name,
  file,
  expect: { ok: true, ...expect },
});
const PNG_16 = { type: 'png', width: 16, height: 16, frames: 1 } as const;
const JPEG_16 = { type: 'jpeg', width: 16, height: 16, frames: 1 } as const;
const GIF_16 = { type: 'gif', width: 16, height: 16, frames: 1 } as const;

/** A Huffman table of 256 symbols whose symbols spell a note over and over. */
function carryingTable(table: number, note: Uint8Array): number[] {
  return [
    table,
    ...new Array<number>(16).fill(16),
    ...Array.from({ length: 256 }, (_, index) => note[index % note.length] as number),
  ];
}
/** A quantisation table of 16 bits: a byte of precision and number, then 128 bytes. */
const wideTable = (id: number): number[] => [0x10 | id, ...new Array<number>(128).fill(1)];
const fullTable = (table: number): number[] => [
  table,
  ...new Array<number>(16).fill(16),
  ...Array.from({ length: 256 }, (_, symbol) => symbol),
];

function flashingGif(): Uint8Array {
  const side = ROOM_PICTURE_ANIMATED_MAX_SIDE;
  const parts: Part[] = [gifScreen(side, side)];
  for (let frame = 0; frame < ROOM_PICTURE_MAX_FRAMES; frame += 1) {
    parts.push(gifControl(0), [0x2c], u16le(0), u16le(0), u16le(side), u16le(side), [0, 2, 2, 0x4c, 0x4c, 0]);
  }
  return cat(...parts, GIF_END);
}

/**
 * The three files of the corpus that are as large as a file may be. Each is built from
 * `ROOM_PICTURE_MAX_BYTES`, as the contract's check script builds its own (revision 5): as many segments
 * or blocks as the largest file holds, so that none is refused for its size and each for what it is.
 */
const TABLES_NOTE = ascii('<script>planted-in-tables</script>');
const LONGEST_DHT = segment(
  0xc4,
  [0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13].flatMap((table) => carryingTable(table, TABLES_NOTE)),
);
const MANY_TABLES_REST = cat(SOI, DQT, frameOf(0xc0, 16, 16), scanOf(), [0, 0, 0, 0], EOI);
/** 119 at 262,144 bytes (239 at revision 3's 524,288). */
export const MANY_TABLES_SEGMENTS = Math.floor((ROOM_PICTURE_MAX_BYTES - MANY_TABLES_REST.length) / LONGEST_DHT.length);
function jpegOfManyTables(): Uint8Array {
  return cat(
    SOI,
    DQT,
    frameOf(0xc0, 16, 16),
    ...new Array<Uint8Array>(MANY_TABLES_SEGMENTS).fill(LONGEST_DHT),
    scanOf(),
    [0, 0, 0, 0],
    EOI,
  );
}

/** A DQT segment of a thousand tables of 8 bits: 65,002 bytes, far past the four a segment may hold. */
const THOUSAND_TABLES = segment(
  0xdb,
  new Array<number>(1_000).fill(0).flatMap(() => [0, ...new Array<number>(64).fill(1)]),
);
const THOUSANDS_REST = cat(SOI, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), [0, 0, 0, 0], EOI);
/** Four at 262,144 bytes (the review's file had eight, 520,121 bytes). */
export const THOUSANDS_SEGMENTS = Math.floor((ROOM_PICTURE_MAX_BYTES - THOUSANDS_REST.length) / THOUSAND_TABLES.length);
function jpegOfThousandsOfTables(): Uint8Array {
  return cat(
    SOI,
    ...new Array<Uint8Array>(THOUSANDS_SEGMENTS).fill(THOUSAND_TABLES),
    frameOf(0xc0, 16, 16),
    DHT_DC,
    DHT_AC,
    scanOf(),
    [0, 0, 0, 0],
    EOI,
  );
}

const SLOW_GIF_REST = cat(gifScreen(16, 16), gifImage(0, 0, 16, 16), GIF_END);
/** More than 87,000 at 262,144 bytes (the review's file had 174,000). */
export const SLOW_GIF_COMMENTS = Math.floor((ROOM_PICTURE_MAX_BYTES - SLOW_GIF_REST.length) / 3);
function gifOfEmptyComments(): Uint8Array {
  return cat(
    gifScreen(16, 16),
    new Uint8Array(SLOW_GIF_COMMENTS * 3).map((_, index) => [0x21, 0xfe, 0][index % 3] as number),
    gifImage(0, 0, 16, 16),
    GIF_END,
  );
}
/** The names of the three, for a test that asks each for its size. */
export const LARGEST_FILES = {
  manyTables: `ACCEPTED: a JPEG of ${MANY_TABLES_SEGMENTS} DHT segments of the longest length`,
  slowGif: `the review's slow GIF: as large as a file may be, ${SLOW_GIF_COMMENTS} empty comments`,
  thousands: `the review's JPEG of tables, as large as a file may be: ${THOUSANDS_SEGMENTS} DQT segments of a thousand tables each`,
} as const;

/**
 * Every file section 4 of the contract names, with what the contract says of it. Sent to
 * `roomPictureCheck` and, as it is, to the API.
 */
export const CORPUS: readonly CorpusFile[] = [
  // --- what passes, and what is stored for it ---
  passes('the smallest PNG comes back as itself', PNG_SMALLEST, { ...PNG_16, clean: PNG_SMALLEST }),
  passes('the smallest JPEG comes back as itself', JPEG_SMALLEST, { ...JPEG_16, clean: JPEG_SMALLEST }),
  passes('the smallest GIF comes back as itself', GIF_SMALLEST, { ...GIF_16, clean: GIF_SMALLEST }),
  passes('a GIF87a is written as GIF89a', cat(gifScreen(16, 16, '87a'), gifImage(0, 0, 16, 16), GIF_END), {
    ...GIF_16,
    clean: GIF_SMALLEST,
  }),
  passes('a PNG with tEXt, iTXt, zTXt, eXIf, tIME, iCCP and pHYs loses them', PNG_TEXT, {
    ...PNG_16,
    clean: PNG_TEXT_CLEAN,
    gone: ['planted', 'tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME', 'iCCP', 'pHYs', 'script', 'GPS', 'ICC_PROFILE'],
  }),
  passes('a JPEG with EXIF and its GPS, XMP, ICC, MPF, IPTC and comments loses them', JPEG_EXIF, {
    ...JPEG_16,
    clean: JPEG_EXIF_CLEAN,
    gone: ['planted', 'Exif', 'GPS', 'ns.adobe.com', 'ICC_PROFILE', 'MPF', 'Photoshop', 'script', '37.7749'],
  }),
  passes('a GIF with comments, XMP and plain text loses them, and keeps one loop block', GIF_COMMENT, {
    type: 'gif',
    width: 16,
    height: 16,
    frames: 2,
    clean: GIF_COMMENT_CLEAN,
    gone: ['planted', 'XMP', 'script', 'adobe'],
  }),
  passes('an animated PNG becomes its still', PNG_ANIMATED, {
    ...PNG_16,
    clean: PNG_SMALLEST,
    gone: ['acTL', 'fcTL', 'fdAT'],
  }),
  passes(
    'a PNG that carries a whole GIF and a page in a private chunk loses both',
    png(
      pngHeader(16, 16),
      pngChunk('prIX', cat(GIF_SMALLEST, '<script>planted-page</script>')),
      pngGreyData(16, 16),
      PNG_END,
    ),
    { ...PNG_16, clean: PNG_SMALLEST, gone: ['GIF89a', 'planted', 'script'] },
  ),
  passes(
    'a JPEG that carries a whole PNG and a page in a comment loses both',
    jpeg(16, 16, [segment(0xfe, cat(PNG_SMALLEST, '<script>planted-page</script>'))]),
    { ...JPEG_16, clean: JPEG_SMALLEST, gone: ['PNG', 'IHDR', 'planted', 'script'] },
  ),
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
    { ...GIF_16, clean: GIF_SMALLEST, gone: ['planted', 'PRIX'] },
  ),
  passes(`a GIF with ${ROOM_PICTURE_MAX_FRAMES} frames`, gifFrames(ROOM_PICTURE_MAX_FRAMES, 64), {
    type: 'gif',
    width: 64,
    height: 64,
    frames: ROOM_PICTURE_MAX_FRAMES,
  }),
  passes(`a PNG of ${MOST} by ${MOST}`, png(pngHeader(MOST, MOST), pngChunk('IDAT', [0]), PNG_END), {
    type: 'png',
    width: MOST,
    height: MOST,
    frames: 1,
  }),
  passes(
    'a JPEG with a DQT and a DHT of exactly the longest length',
    jpeg(
      16,
      16,
      [],
      [
        segment(0xdb, [0, 1, 2, 3].flatMap(wideTable)),
        segment(0xc4, [0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13].flatMap(fullTable)),
      ],
    ),
    JPEG_16,
  ),

  // --- the eight files that are ACCEPTED on purpose (section 4) ---
  passes('ACCEPTED: the GIF that is also a script, stored as it came', GIF_SCRIPT, {
    type: 'gif',
    width: 96,
    height: 16,
    frames: 1,
    clean: GIF_SCRIPT,
    stays: 'globalThis.planted="gif-script"',
  }),
  passes(
    'ACCEPTED: a JPEG whose scan data is a page',
    cat(SOI, DQT, frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), '<html><script>planted-scan</script></html>', EOI),
    { ...JPEG_16, stays: 'planted-scan' },
  ),
  passes(
    'ACCEPTED: a JPEG with markup inside a quantisation table',
    jpeg(16, 16, [], [segment(0xdb, [1, ...ascii('<svg onload=planted-table>'), ...new Array<number>(38).fill(1)])]),
    { ...JPEG_16, stays: 'planted-table' },
  ),
  passes(
    'ACCEPTED: a JPEG whose JFIF header spells seven bytes of its own',
    jpeg(16, 16, [segment(0xe0, cat('JFIF\0', 'PRIXPRI', [0, 0]))]),
    { ...JPEG_16, stays: 'PRIXPRI' },
  ),
  passes(LARGEST_FILES.manyTables, jpegOfManyTables(), {
    ...JPEG_16,
    stays: 'planted-in-tables',
  }),
  passes(
    'ACCEPTED: a PNG whose IDAT is a page and not a zlib stream',
    png(pngHeader(16, 16), pngChunk('IDAT', '<html><script>planted-idat</script></html>'), PNG_END),
    { ...PNG_16, stays: 'planted-idat' },
  ),
  passes(
    'ACCEPTED: a PNG of a few dozen bytes that declares 2,048 by 2,048 pixels of 16 bits',
    png(pngHeader(MOST, MOST, 16, 6), pngChunk('IDAT', new Uint8Array(11).fill(0x4c)), PNG_END),
    { type: 'png', width: MOST, height: MOST, frames: 1, stays: 'LLLLLLLLLLL' },
  ),
  passes('ACCEPTED: a GIF of 120 frames of 512 by 512 with no delay', flashingGif(), {
    type: 'gif',
    width: ROOM_PICTURE_ANIMATED_MAX_SIDE,
    height: ROOM_PICTURE_ANIMATED_MAX_SIDE,
    frames: ROOM_PICTURE_MAX_FRAMES,
    stays: 'LL',
  }),

  // --- size ---
  refused(
    `a file of ${ROOM_PICTURE_MIN_BYTES - 1} bytes`,
    PNG_SMALLEST.subarray(0, ROOM_PICTURE_MIN_BYTES - 1),
    'size',
  ),
  refused('a file one byte over the largest', new Uint8Array(ROOM_PICTURE_MAX_BYTES + 1), 'size'),

  // --- type: nothing else is a picture here ---
  refused('an SVG', padded('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'type'),
  refused(
    'an SVG behind an XML declaration',
    padded('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    'type',
  ),
  refused('an HTML page', padded('<!doctype html><html><body><script>alert(1)</script></body></html>'), 'type'),
  refused('a PDF', padded('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n'), 'type'),
  refused('a ZIP', padded('PK\x03\x04'), 'type'),
  refused('a WebP', padded(cat('RIFF', [56, 0, 0, 0], 'WEBPVP8 ')), 'type'),
  refused('a BMP', padded('BM'), 'type'),
  refused('an ICO', padded([0, 0, 1, 0, 1, 0, 16, 16]), 'type'),
  refused('a TIFF, little-endian', padded('II*\0'), 'type'),
  refused('a TIFF, big-endian', padded('MM\0*'), 'type'),
  refused('an AVIF', padded(cat([0, 0, 0, 28], 'ftypavif')), 'type'),
  refused('a HEIC', padded(cat([0, 0, 0, 24], 'ftypheic')), 'type'),
  refused('a PNG behind a byte order mark', cat([0xef, 0xbb, 0xbf], PNG_SMALLEST), 'type'),
  refused('a GIF behind a space', cat(' ', GIF_SMALLEST), 'type'),
  refused('a GIF behind a line break', cat('\n', GIF_SMALLEST), 'type'),
  refused('a GIF of an unknown version', cat('GIF90a', GIF_SMALLEST.subarray(6)), 'type'),

  // --- malformed: the walk must consume the file exactly ---
  refused('a PNG with its last byte cut off', PNG_TEXT.subarray(0, PNG_TEXT.length - 1), 'malformed'),
  refused('a JPEG with its last byte cut off', JPEG_EXIF.subarray(0, JPEG_EXIF.length - 1), 'malformed'),
  refused('a GIF with its last byte cut off', GIF_COMMENT.subarray(0, GIF_COMMENT.length - 1), 'malformed'),
  refused('a PNG with one byte after IEND', cat(PNG_SMALLEST, [0]), 'malformed'),
  refused('a JPEG with one byte after its end marker', cat(JPEG_SMALLEST, [0]), 'malformed'),
  refused('a GIF with one byte after its trailer', cat(GIF_SMALLEST, [0]), 'malformed'),
  refused(
    'a JPEG with a video after its end marker, as a motion photo has',
    cat(JPEG_EXIF, '\0\0\0\x18ftypmp42'),
    'malformed',
  ),
  refused('a PNG with a ZIP after IEND', cat(PNG_SMALLEST, 'PK\x03\x04'), 'malformed'),
  refused('a GIF with a PNG after its trailer', cat(GIF_SMALLEST, PNG_SMALLEST), 'malformed'),
  refused('two JPEGs one after the other', cat(JPEG_SMALLEST, JPEG_SMALLEST), 'malformed'),
  refused(
    'an HTML page behind a PNG signature',
    cat(PNG_SIGNATURE, '<html><script>alert(1)</script></html>'),
    'malformed',
  ),
  refused(
    'THE JPEG THAT WAS ALSO A SCRIPT: its first segment is a DQT longer than four tables',
    JPEG_SCRIPT,
    'malformed',
  ),
  // The three files of the security review that section 4 names as refused: two that were slow to walk,
  // and one that was tables and almost no pixels.
  refused(
    "the review's slow PNG: 8,189 empty chunks",
    png(pngHeader(16, 16), ...new Array<Uint8Array>(8_189).fill(pngChunk('tEXt')), pngGreyData(16, 16), PNG_END),
    'malformed',
  ),
  refused(LARGEST_FILES.slowGif, gifOfEmptyComments(), 'malformed'),
  refused(LARGEST_FILES.thousands, jpegOfThousandsOfTables(), 'malformed'),
  // PNG: what is on no list, and what breaks its own rule.
  refused(
    'a PNG with a critical chunk that is not on the list',
    png(pngHeader(16, 16), pngChunk('ABCD', [1, 2, 3]), pngGreyData(16, 16), PNG_END),
    'malformed',
  ),
  refused(
    'a PNG with a chunk type that is not four letters',
    png(pngHeader(16, 16), pngChunk('te1t', [1]), pngGreyData(16, 16), PNG_END),
    'malformed',
  ),
  refused(
    'a PNG with an IDAT after the run has ended',
    png(pngHeader(16, 16), pngGreyData(16, 16), pngChunk('tEXt', 'a\0b'), pngChunk('IDAT', [0]), PNG_END),
    'malformed',
  ),
  refused(
    'a PNG with a PLTE on a truecolour picture',
    png(pngHeader(16, 16, 8, 2), pngChunk('PLTE', [0, 0, 0, 255, 255, 255]), pngChunk('IDAT', [0]), PNG_END),
    'malformed',
  ),
  refused('a PNG with no IDAT', png(pngHeader(16, 16), PNG_END), 'malformed'),
  refused('a PNG with two IHDR', png(pngHeader(16, 16), pngHeader(16, 16), pngGreyData(16, 16), PNG_END), 'malformed'),
  refused('a PNG whose IEND has data', png(pngHeader(16, 16), pngGreyData(16, 16), pngChunk('IEND', [1])), 'malformed'),
  refused(
    `a PNG with more than ${ROOM_PICTURE_PNG_MAX_CHUNKS} chunks`,
    png(
      pngHeader(16, 16),
      ...new Array<Uint8Array>(ROOM_PICTURE_PNG_MAX_CHUNKS).fill(pngChunk('tEXt', 'a\0b')),
      pngGreyData(16, 16),
      PNG_END,
    ),
    'malformed',
  ),
  // JPEG: every other marker, and the order.
  ...(
    [
      ['SOF3 (lossless)', 0xc3],
      ['SOF9 (arithmetic)', 0xc9],
    ] as const
  ).map(([name, marker]) =>
    refused(
      `a JPEG whose frame is ${name}`,
      cat(SOI, DQT, frameOf(marker, 16, 16), DHT_DC, DHT_AC, scanOf(), flatScan(16, 16), EOI),
      'malformed',
    ),
  ),
  ...(
    [
      ['DAC', 0xcc],
      ['DNL', 0xdc],
      ['DHP', 0xde],
      ['EXP', 0xdf],
    ] as const
  ).map(([name, marker]) =>
    refused(`a JPEG with a ${name} segment`, jpeg(16, 16, [], [segment(marker, [0, 16])]), 'malformed'),
  ),
  refused(
    'a JPEG with a second frame',
    cat(SOI, DQT, frameOf(0xc0, 16, 16), frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), [0], EOI),
    'malformed',
  ),
  refused(
    'a JPEG with a scan before the frame',
    cat(SOI, DQT, DHT_DC, DHT_AC, scanOf(), flatScan(16, 16), frameOf(0xc0, 16, 16), EOI),
    'malformed',
  ),
  refused(
    'a JPEG with no tables',
    cat(SOI, JFIF, frameOf(0xc0, 16, 16), scanOf(), new Uint8Array(8), EOI),
    'malformed',
  ),
  refused(
    'a JPEG with a fill byte before a marker',
    cat(SOI, DQT, [0xff], frameOf(0xc0, 16, 16), DHT_DC, DHT_AC, scanOf(), flatScan(16, 16), EOI),
    'malformed',
  ),
  refused(
    'a JPEG with a DQT one table longer than the longest',
    jpeg(16, 16, [], [segment(0xdb, [...[0, 1, 2, 3].flatMap(wideTable), 0, ...new Array<number>(64).fill(1)])]),
    'malformed',
  ),
  refused(
    'a JPEG with a DHT one table longer than the longest',
    jpeg(16, 16, [], [segment(0xc4, [0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13, 0x00].flatMap(fullTable))]),
    'malformed',
  ),
  refused(
    `a JPEG with more than ${ROOM_PICTURE_JPEG_MAX_SEGMENTS} segments`,
    jpeg(16, 16, new Array<Uint8Array>(ROOM_PICTURE_JPEG_MAX_SEGMENTS).fill(segment(0xfe, 'x'))),
    'malformed',
  ),
  refused('a JPEG with no end marker', cat(JPEG_SMALLEST.subarray(0, JPEG_SMALLEST.length - 2), [0, 0]), 'malformed'),
  // GIF: what is on no list, and what breaks its own rule.
  refused(
    'a GIF with an unknown extension',
    cat(gifScreen(16, 16), [0x21, 0x99, 1, 0, 0], gifImage(0, 0, 16, 16), GIF_END),
    'malformed',
  ),
  refused('a GIF with an unknown block', cat(gifScreen(16, 16), [0x40], gifImage(0, 0, 16, 16), GIF_END), 'malformed'),
  refused('a GIF whose frame leaves the canvas', cat(gifScreen(16, 16), gifImage(8, 8, 16, 16), GIF_END), 'malformed'),
  refused(
    'a GIF with no colour table at all',
    cat(gifScreen(16, 16, '89a', false), gifImage(0, 0, 16, 16), GIF_END),
    'malformed',
  ),
  refused('a GIF with an LZW code size of 9', cat(gifScreen(16, 16), gifImage(0, 0, 16, 16, 9), GIF_END), 'malformed'),
  refused(
    'a GIF whose frame has no data',
    cat(gifScreen(16, 16), [0x2c], u16le(0), u16le(0), u16le(16), u16le(16), [0, 2, 0], GIF_END),
    'malformed',
  ),
  refused(
    'a GIF with no trailer',
    cat(gifScreen(16, 16), gifImage(0, 0, 16, 16), gifComment('the end is missing')),
    'malformed',
  ),
  refused(
    `a GIF with ${ROOM_PICTURE_GIF_MAX_BLOCKS + 1} blocks`,
    cat(
      gifScreen(16, 16),
      ...new Array<Uint8Array>(ROOM_PICTURE_GIF_MAX_BLOCKS).fill(gifComment('x')),
      gifImage(0, 0, 16, 16),
      GIF_END,
    ),
    'malformed',
  ),

  // --- dimensions ---
  refused(`a PNG of ${MOST + 1} by 16`, png(pngHeader(MOST + 1, 16), pngChunk('IDAT', [0]), PNG_END), 'dimensions'),
  refused(
    `a PNG of ${ROOM_PICTURE_MIN_SIDE - 1} by 16`,
    png(pngHeader(ROOM_PICTURE_MIN_SIDE - 1, 16), pngChunk('IDAT', [0]), PNG_END),
    'dimensions',
  ),
  refused('a PNG of 30,000 by 30,000', png(pngHeader(30_000, 30_000), pngChunk('IDAT', [0]), PNG_END), 'dimensions'),
  refused(`a JPEG of 16 by ${MOST + 1}`, jpeg(16, MOST + 1), 'dimensions'),
  refused(`a GIF of ${MOST + 1} by 16`, cat(gifScreen(MOST + 1, 16), gifImage(0, 0, 1, 1), GIF_END), 'dimensions'),
  refused(`an animated GIF on a canvas of ${WIDE}`, gifFrames(2, WIDE), 'dimensions'),
  refused(
    'the known GIF that is also a script: its width is the opening of a comment, 10,799 pixels',
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
  ),

  // --- frames ---
  refused(`a GIF with ${ROOM_PICTURE_MAX_FRAMES + 1} frames`, gifFrames(ROOM_PICTURE_MAX_FRAMES + 1, 64), 'frames'),
  refused(
    'a GIF with no frame',
    cat(gifScreen(16, 16), gifComment('nothing to show, nothing to show'), GIF_END),
    'frames',
  ),
];
