// The files of a given size that the room's picture rule (room-picture.ts, roomPictureCheck) walks slowest:
// the seven shapes that are timed. Each is built here, in code, byte by byte, at whatever size is asked for.
//
// Two programs import this file (revision 5, perf's proposal): the operator's check script
// (room-picture.check.mts), which times each shape at ROOM_PICTURE_MAX_BYTES under Node, and perf's script
// (tools/perf/room-pictures.mjs), which times them in workerd for gate 3 of the contract. Until revision 5
// the check script held them, and perf built them a second time because that script runs its cases when it
// is imported. THIS FILE DOES NOTHING WHEN IT IS IMPORTED: it reads no argument, starts no process, prints
// nothing and calls the rule for nothing. It builds a file only when `make` is called.
//
// Every limit is read from the contract's constants. A caller checks what it was handed: that the file is
// exactly the size it asked for, and that the rule answers it with `facts`.
import type { RoomPictureFacts } from './room-picture.ts';
import {
  ROOM_PICTURE_ANIMATED_MAX_SIDE,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_PNG_MAX_CHUNKS,
} from './room-picture.ts';

type Part = Uint8Array | readonly number[] | string;

function cat(...parts: Part[]): Uint8Array {
  const arrays = parts.map((part) =>
    typeof part === 'string' ? Uint8Array.from(part, (letter) => letter.charCodeAt(0) & 0xff) : Uint8Array.from(part),
  );
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
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngChunk(type: string, data: Part = []): Uint8Array {
  const body = cat(type, data);
  return cat(u32be(body.length - 4), body, u32be(crc32(body)));
}
/** A grey picture of 8 bits, not interlaced, of the largest sides. */
const PNG_HEAD = cat(
  PNG_SIGNATURE,
  pngChunk('IHDR', [...u32be(ROOM_PICTURE_MAX_SIDE), ...u32be(ROOM_PICTURE_MAX_SIDE), 8, 0, 0, 0, 0]),
);
const PNG_END = pngChunk('IEND');
/** What a chunk takes beside its data: its length, its type and its CRC. */
const PNG_CHUNK_FRAME = 12;

/** A PNG of exactly `total` bytes: as many IDAT chunks of `each` bytes of data as fit, and one that takes the rest. */
function pngOfSize(total: number, each: number): Uint8Array {
  let left = total - PNG_HEAD.length - PNG_END.length;
  const parts: Part[] = [PNG_HEAD];
  while (left > 0) {
    const data = Math.min(each, left - PNG_CHUNK_FRAME);
    if (data < 0) throw new Error('pngOfSize: the sizes leave a chunk no room');
    parts.push(pngChunk('IDAT', new Uint8Array(data).fill(0x55)));
    left -= data + PNG_CHUNK_FRAME;
  }
  parts.push(PNG_END);
  return cat(...parts);
}
/**
 * A PNG of exactly `total` bytes in exactly `chunks` chunks, IHDR and IEND among them: the bytes are dealt
 * over the IDAT chunks as evenly as they go. (Until revision 5 every IDAT but the last had one size, which
 * gives exactly ROOM_PICTURE_PNG_MAX_CHUNKS chunks at 524,288 bytes and two fewer at 262,144: no single
 * size of a chunk makes 1,024 of them there.)
 */
function pngOfChunks(total: number, chunks: number): Uint8Array {
  const runs = chunks - 2;
  const left = total - PNG_HEAD.length - PNG_END.length;
  const least = Math.floor(left / runs);
  if (runs < 1 || least < PNG_CHUNK_FRAME) throw new Error('pngOfChunks: the sizes leave a chunk no room');
  const longer = left - least * runs;
  const parts: Part[] = [PNG_HEAD];
  for (let run = 0; run < runs; run += 1) {
    parts.push(pngChunk('IDAT', new Uint8Array(least - PNG_CHUNK_FRAME + (run < longer ? 1 : 0)).fill(0x55)));
  }
  parts.push(PNG_END);
  return cat(...parts);
}

// --- JPEG ------------------------------------------------------------------------------------------------

function segment(marker: number, data: Part = []): Uint8Array {
  const body = cat(data);
  return cat([0xff, marker], u16be(body.length + 2), body);
}
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = segment(0xe0, cat('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const DQT = segment(0xdb, [0, ...new Array<number>(64).fill(1)]);
const huffman = (table: number): Uint8Array => segment(0xc4, [table, 1, ...new Array<number>(15).fill(0), 0]);
/** A baseline frame of one component, 8 bits, of the largest sides. */
const FRAME = segment(0xc0, [8, ...u16be(ROOM_PICTURE_MAX_SIDE), ...u16be(ROOM_PICTURE_MAX_SIDE), 1, 1, 0x11, 0]);
const SCAN = segment(0xda, [1, 1, 0x00, 0, 63, 0]);

/** A JPEG of exactly `total` bytes whose scan is `filler` again and again. */
function jpegOfSize(total: number, filler: readonly number[]): Uint8Array {
  const head = cat(SOI, JFIF, DQT, FRAME, huffman(0x00), huffman(0x10), SCAN);
  if (total < head.length + 3) throw new Error('jpegOfSize: the size leaves the scan no room');
  const scan = new Uint8Array(total - head.length - 2);
  for (let index = 0; index < scan.length; index += 1) scan[index] = filler[index % filler.length] as number;
  // A scan may not end on a lone FF: the end marker's own FF would then read as its second byte.
  if (scan[scan.length - 1] === 0xff) scan[scan.length - 1] = 0;
  return cat(head, scan, EOI);
}

// --- GIF -------------------------------------------------------------------------------------------------

const gifScreen = (width: number, height: number): Uint8Array =>
  cat('GIF89a', u16le(width), u16le(height), [0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
const GIF_CONTROL = [0x21, 0xf9, 4, 0, ...u16le(10), 0, 0];
const GIF_LOOP = cat([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0]);
const GIF_END = [0x3b];

/** An animated GIF of exactly `total` bytes: ROOM_PICTURE_MAX_FRAMES frames whose data is sub-blocks of `each` bytes. */
function gifOfSize(total: number, each: number): Uint8Array {
  const side = ROOM_PICTURE_ANIMATED_MAX_SIDE;
  const head = cat(gifScreen(side, side), GIF_LOOP);
  const frames = ROOM_PICTURE_MAX_FRAMES;
  const fixed = 8 + 10 + 1 + 1;
  let left = total - head.length - 1;
  const parts: Part[] = [head];
  for (let frame = 0; frame < frames; frame += 1) {
    const share = frame === frames - 1 ? left : Math.floor(left / (frames - frame));
    const blocks: number[] = [];
    let room = share - fixed;
    while (room > 0) {
      let size = Math.min(each, room - 1);
      // Never leave one byte: a sub-block is its length and at least one byte.
      if (room - 1 - size === 1) size = size > 1 ? size - 1 : size + 1;
      if (size < 1) throw new Error('gifOfSize: the sizes leave a sub-block no room');
      blocks.push(size);
      for (let byte = 0; byte < size; byte += 1) blocks.push(0x11);
      room -= size + 1;
    }
    parts.push(GIF_CONTROL, [0x2c], u16le(0), u16le(0), u16le(side), u16le(side), [0], [8], blocks, [0]);
    left -= share;
  }
  parts.push(GIF_END);
  return cat(...parts);
}

// --- the seven shapes ------------------------------------------------------------------------------------

const PNG_MOST: RoomPictureFacts = {
  type: 'png',
  width: ROOM_PICTURE_MAX_SIDE,
  height: ROOM_PICTURE_MAX_SIDE,
  frames: 1,
};
const JPEG_MOST: RoomPictureFacts = {
  type: 'jpeg',
  width: ROOM_PICTURE_MAX_SIDE,
  height: ROOM_PICTURE_MAX_SIDE,
  frames: 1,
};
const GIF_MOST: RoomPictureFacts = {
  type: 'gif',
  width: ROOM_PICTURE_ANIMATED_MAX_SIDE,
  height: ROOM_PICTURE_ANIMATED_MAX_SIDE,
  frames: ROOM_PICTURE_MAX_FRAMES,
};

/** One timed shape: its key (the check script's `--first <key>`), its words, the file at a size, and what the rule answers for it. */
export interface RoomPictureShape {
  key: string;
  /** What the file is, to follow "the largest" or a size: "PNG, in chunks of 8 KiB". */
  what: string;
  /** The file at exactly `total` bytes. It throws when the shape cannot be built at that size. */
  make(total: number): Uint8Array;
  facts: RoomPictureFacts;
}

/**
 * The slowest shapes each walk still has under the rule's limits: as many chunks as a PNG may have, a scan
 * that is all stuffed bytes or all restart markers, sub-blocks of one byte; and beside each a plain file of
 * its type. The keys and the words are those the check script printed before revision 5.
 */
export const SHAPES: readonly RoomPictureShape[] = [
  { key: 'png-8k', what: 'PNG, in chunks of 8 KiB', make: (total) => pngOfSize(total, 8_192), facts: PNG_MOST },
  {
    key: 'png-chunks',
    what: `PNG, in the ${ROOM_PICTURE_PNG_MAX_CHUNKS} chunks a PNG may have`,
    make: (total) => pngOfChunks(total, ROOM_PICTURE_PNG_MAX_CHUNKS),
    facts: PNG_MOST,
  },
  {
    key: 'jpeg-plain',
    what: 'JPEG, a scan with no FF in it',
    make: (total) => jpegOfSize(total, [0x5a, 0xa5, 0x3c]),
    facts: JPEG_MOST,
  },
  {
    key: 'jpeg-stuffed',
    what: 'JPEG, a scan of stuffed bytes only',
    make: (total) => jpegOfSize(total, [0xff, 0x00]),
    facts: JPEG_MOST,
  },
  {
    key: 'jpeg-restart',
    what: 'JPEG, a scan of restart markers only',
    make: (total) => jpegOfSize(total, [0xff, 0xd3]),
    facts: JPEG_MOST,
  },
  {
    key: 'gif-255',
    what: `GIF, ${ROOM_PICTURE_MAX_FRAMES} frames in sub-blocks of 255 bytes`,
    make: (total) => gifOfSize(total, 255),
    facts: GIF_MOST,
  },
  {
    key: 'gif-1',
    what: `GIF, ${ROOM_PICTURE_MAX_FRAMES} frames in sub-blocks of one byte`,
    make: (total) => gifOfSize(total, 1),
    facts: GIF_MOST,
  },
];
