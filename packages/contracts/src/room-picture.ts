/**
 * The picture rule of the room (Phase 6.4, docs/contracts/phase-6-pictures.md section 4), in a file of its
 * own with no import at all: the composer's script imports it by its path
 * (`@prix/contracts/room-picture`) and checks a file with the very function the server uses. The server's
 * answer is the one that counts: it runs `roomPictureCheck` on whatever arrives and stores only what the
 * function hands back.
 *
 * What it is. An allowlist walk of a JPEG, PNG or GIF container from the first byte to the last. It decodes
 * no pixel. It answers a problem, or the picture's facts with `bytes`: the function's OWN serialisation of
 * the file, made of the chunks, segments and blocks on the lists below and nothing else, in the order they
 * came. Metadata is dropped because it is never copied: no list of things to remove exists, so a kind of
 * metadata nobody thought of is dropped too. A byte the walk cannot place (a gap, a truncation, one byte
 * after the end marker, a structure that is not on a list and may not be dropped) refuses the whole file.
 *
 * What it is not. It does not judge what a picture shows, and it cannot empty the pixel data, a palette or
 * a coding table of bytes that also spell something. IT DOES NOT STOP A FILE THAT IS ALSO A SCRIPT: a GIF
 * whose width's low byte is a backtick passes this function and parses as a script (the check script holds
 * that file as ACCEPTED). Such bytes are inert only because of how the picture is served (section 7: the
 * type from the row with `nosniff`, and the rule that every request whose `Sec-Fetch-Dest` is not `image`
 * is answered the generic 404), never because of this file. Nobody softens either of those two on the
 * strength of this check.
 *
 * Cost. One pass over the input, one buffer of the input's length and one copy of the result: no
 * recursion, no regular expression, nothing allocated per pixel or per byte. It never throws: every read
 * is inside the input, and the output never passes what was consumed.
 *
 * Revision 2 (2026-10-11, from the security review of draft 1 and the builder's reading): 1,024 chunks of
 * a PNG and 1,024 blocks of a GIF at most; a DQT and a DHT no longer than the tables a JPEG can use; a
 * PLTE only for an indexed PNG; and, further down, everything a browser script of the room needs of the
 * contract, since such a script may import values from this file alone.
 *
 * Revision 3 (2026-10-11, from the second look of both readers): no change to the rule. Two more names in
 * ROOM_PICTURE_DOM (`list` and `state`), and one sentence at the table limits: they bound a segment, not
 * what a file carries.
 *
 * Revision 5 (2026-10-11, after the first build round): no change to the rule. ROOM_PICTURE_MAX_BYTES is
 * 262,144 (256 KiB), half of what it was: gate 3 fired as the contract expected (the document's sections
 * 13, 16 and 23). The composer's ladder follows the size (ROOM_PICTURE_COMPOSER_STEPS), and so does the
 * figure at the table limits.
 *
 * Revision 6 (2026-10-12, after the reviews of the first round's built code): no change to the rule and
 * to no constant of this file. Two more names in ROOM_PICTURE_DOM (`reportYes` and `reportNo`), for the
 * question "Report picture" now asks before it reports, and what the comment there says of the click. This
 * file still holds the walker and the pages' small helpers together, so a reader's page loads the walker
 * with them (a contracts chunk of 13,511 bytes for a signed-out reader of `/chat`, measured on a production
 * build): dividing the file in two is a contract change of its own, after the launch (the document's
 * sections 11 and 15).
 */

/** The three types a picture may have. The type is read from the first bytes and from nothing else. */
export const ROOM_PICTURE_TYPES = ['jpeg', 'png', 'gif'] as const;
export type RoomPictureType = (typeof ROOM_PICTURE_TYPES)[number];

/**
 * The largest and the smallest file, in bytes: 256 KiB, and less than any picture of the smallest side can
 * be. The largest was 524,288 until revision 5. Gate 3 of the contract fired: in local workerd the first
 * call of `roomPictureCheck` in a fresh isolate took 3.5 to 4.25 ms for the three JPEG scans at 524,288
 * bytes, against the gate's 3 ms, and 2.6 to 3.25 ms at this size. Production's logs at the drill are the
 * gate's own figure.
 */
export const ROOM_PICTURE_MAX_BYTES = 262_144;
export const ROOM_PICTURE_MIN_BYTES = 32;
/** Each side of a picture, in pixels, and the most pixels of one frame. The decoded size is what a reader's browser pays. */
export const ROOM_PICTURE_MIN_SIDE = 16;
export const ROOM_PICTURE_MAX_SIDE = 2_048;
export const ROOM_PICTURE_MAX_PIXELS = 4_194_304;
/** A GIF of more than one frame: the most frames, and the largest side of its canvas. */
export const ROOM_PICTURE_MAX_FRAMES = 120;
export const ROOM_PICTURE_ANIMATED_MAX_SIDE = 512;
/**
 * The most chunks of a PNG, the most segments of a JPEG and the most blocks of a GIF the walk reads, kept
 * and dropped together. A GIF's blocks are its images and its extensions at the top level (a graphic
 * control extension, a comment, an application or a plain-text extension each count one); the trailer is
 * not one, and neither are the sub-blocks inside a block. An honest file is far below each: the largest
 * animated GIF the rule takes has 120 images, 120 graphic control extensions and one loop block. The two
 * of 1,024 are revision 2's: a file of thousands of empty dropped chunks or comments was the cheapest way
 * to make the walk slow (the security review's M5).
 */
export const ROOM_PICTURE_PNG_MAX_CHUNKS = 1_024;
export const ROOM_PICTURE_JPEG_MAX_SEGMENTS = 256;
export const ROOM_PICTURE_GIF_MAX_BLOCKS = 1_024;
/**
 * The longest DQT and DHT segment of a JPEG, as the segment's own length field counts it (itself and the
 * data): four quantisation tables of 16 bits (1 + 128 bytes each), and eight Huffman tables of 256
 * symbols (1 + 16 + 256 bytes each). A JPEG has no more table slots than these, so no honest encoder
 * writes a longer segment. A longer one is malformed: tables were the largest room for bytes that are not
 * pixels, and a first segment whose length spelled the opening of a comment made a JPEG that was also a
 * script (the security review's L1 and M1).
 *
 * The limit bounds a segment, not a file (revision 3, the second look's N3): as many DHT segments of the
 * longest length as the largest file holds pass with four bytes of scan. At 262,144 bytes that is 119
 * segments, a file of 260,472 bytes of which 260,372 are tables (the check script builds it from the
 * constants and holds it as ACCEPTED; at revision 3's size it was 239 segments and 523,032 bytes). The
 * limit is there for the first bytes of a file, not for what a file can carry: a scan is any bytes
 * already.
 */
export const ROOM_PICTURE_JPEG_DQT_MAX_LENGTH = 2 + 4 * 129;
export const ROOM_PICTURE_JPEG_DHT_MAX_LENGTH = 2 + 8 * 273;

/**
 * Why a file is refused, in the order they are judged: `size` (shorter than ROOM_PICTURE_MIN_BYTES or
 * longer than ROOM_PICTURE_MAX_BYTES, judged before a byte is read); `type` (the first bytes are not a
 * JPEG's, a PNG's or a GIF's); then, as the walk meets them, `malformed` (a truncation, a gap, a byte after
 * the end marker, a structure that is neither kept nor dropped, a kept structure that breaks its own
 * rule), `dimensions` (a side or the pixel count outside the limits) and `frames` (a GIF with no frame or
 * with more than ROOM_PICTURE_MAX_FRAMES).
 */
export const ROOM_PICTURE_PROBLEMS = ['size', 'type', 'malformed', 'dimensions', 'frames'] as const;
export type RoomPictureProblem = (typeof ROOM_PICTURE_PROBLEMS)[number];

/** What the walk learned of a picture. `frames` is 1 for a JPEG, a PNG and a still GIF. */
export interface RoomPictureFacts {
  type: RoomPictureType;
  width: number;
  height: number;
  frames: number;
}

export type RoomPictureChecked =
  | (RoomPictureFacts & {
      ok: true;
      /** The function's own serialisation, in a buffer of its own and of exactly this length. The only bytes that are ever stored. */
      bytes: Uint8Array;
    })
  | { ok: false; problem: RoomPictureProblem };

/**
 * The allowlists, as data, for a test that reads an output and asks that it holds nothing else.
 *
 * PNG: the chunk types that are copied. Every other ancillary chunk (a lower-case first letter) is dropped:
 * tEXt, zTXt, iTXt, eXIf, tIME, iCCP, pHYs, bKGD, hIST, sPLT, and acTL, fcTL and fdAT, so an animated PNG
 * becomes its still. Every other critical chunk refuses the file.
 */
export const ROOM_PICTURE_PNG_KEPT = ['IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'IDAT', 'IEND'] as const;
/**
 * JPEG: the markers that are copied, by their second byte. SOI; APP0 only as the first segment and only as
 * "JFIF" with no thumbnail (16 bytes); APP14 only as "Adobe" (14 bytes), once, before the first scan; DQT;
 * DHT; DRI; exactly one SOF0, SOF1 or SOF2; SOS with its scan data, in which only a stuffed zero and RST0
 * to RST7 may follow an FF; EOI as the last two bytes. Dropped: every other APP0 to APP15 (EXIF with its
 * GPS, XMP, ICC, MPF, IPTC) and COM. Every other marker refuses the file.
 */
export const ROOM_PICTURE_JPEG_KEPT = [0xd8, 0xe0, 0xee, 0xdb, 0xc4, 0xdd, 0xc0, 0xc1, 0xc2, 0xda, 0xd9] as const;
/**
 * GIF: the blocks that are copied, by their first byte and, for an extension, its label. The image
 * descriptor with its table and data; the graphic control extension that stands before an image; the
 * application extension only as the first "NETSCAPE2.0" loop block; the trailer. Dropped: the comment
 * extension, the plain-text extension (with the graphic control extension before it) and every other
 * application extension (XMP, ICC). Every other block refuses the file.
 */
export const ROOM_PICTURE_GIF_KEPT = [
  { block: 0x2c, label: null },
  { block: 0x21, label: 0xf9 },
  { block: 0x21, label: 0xff },
  { block: 0x3b, label: null },
] as const;

/** A walk's answer: the problem, or the facts with the length of what it wrote. */
type Walked = RoomPictureProblem | { width: number; height: number; frames: number; length: number };

/** A byte the caller has already shown to be inside the input. */
function at(bytes: Uint8Array, index: number): number {
  return bytes[index] as number;
}

/** Four bytes as one number, the first the highest: a PNG's lengths and sides. The caller has shown all four to be inside the input. */
function big32(bytes: Uint8Array, index: number): number {
  return (
    at(bytes, index) * 0x1000000 + ((at(bytes, index + 1) << 16) | (at(bytes, index + 2) << 8) | at(bytes, index + 3))
  );
}

/** True when a side or the pixel count is outside the limits of a still picture, or of an animated one. */
function outside(width: number, height: number, animated: boolean): boolean {
  const most = animated ? ROOM_PICTURE_ANIMATED_MAX_SIDE : ROOM_PICTURE_MAX_SIDE;
  return (
    width < ROOM_PICTURE_MIN_SIDE ||
    height < ROOM_PICTURE_MIN_SIDE ||
    width > most ||
    height > most ||
    width * height > ROOM_PICTURE_MAX_PIXELS
  );
}

/** True when the input holds exactly these character codes from `from` on. */
function spells(bytes: Uint8Array, from: number, word: string): boolean {
  if (from + word.length > bytes.length) return false;
  for (let index = 0; index < word.length; index += 1) {
    if (bytes[from + index] !== word.charCodeAt(index)) return false;
  }
  return true;
}

/** The type the first bytes name, or null. The three signatures cannot be true of one file. */
function signatureOf(bytes: Uint8Array): RoomPictureType | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (spells(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (spells(bytes, 0, 'GIF87a') || spells(bytes, 0, 'GIF89a')) return 'gif';
  return null;
}

// --- PNG -------------------------------------------------------------------------------------------------

/** The bit depths each colour type may have, by the colour type. */
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
/** The length of sBIT by the colour type. */
const PNG_SBIT_LENGTH: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 };

/**
 * A PNG. After the signature every chunk is a length, a type of four letters, the data and a CRC, and the
 * walk must end on the last byte of IEND's CRC. Kept, each by its own rule: IHDR (first, 13 bytes, a legal
 * colour type and depth, compression 0, filter 0, interlace 0 or 1); gAMA (4 bytes), cHRM (32), sRGB (1)
 * and sBIT (by the colour type), each once and before PLTE and IDAT; PLTE (once, before IDAT, a multiple of
 * three up to 768 bytes and no more entries than the depth can index, only for an indexed picture and
 * always for one: a palette on a grey or a truecolour picture is refused, since a decoder may ignore it
 * and it is 768 bytes that are not pixels); tRNS (once, after PLTE and before IDAT, 2 bytes for grey, 6 for
 * colour, at most one a palette entry, never with an alpha channel); IDAT (one run, at least one); IEND
 * (length 0, last).
 * Dropped: every other ancillary chunk. Refused: any other critical chunk, a type that is not four letters,
 * an IDAT after the run of IDATs has ended, more than ROOM_PICTURE_PNG_MAX_CHUNKS chunks. CRCs are copied
 * and not computed: a browser's decoder checks them, and a wrong one costs its sender the picture.
 */
function walkPng(input: Uint8Array, out: Uint8Array): Walked {
  const size = input.length;
  out.set(input.subarray(0, 8), 0);
  let read = 8;
  let written = 8;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let colour = 0;
  let depth = 0;
  /** Palette entries; -1 while there is no PLTE. */
  let palette = -1;
  /** 0: no IDAT yet; 1: inside the run of IDATs; 2: the run has ended. */
  let data = 0;
  let gama = false;
  let chrm = false;
  let srgb = false;
  let sbit = false;
  let trns = false;

  for (;;) {
    if (size - read < 12) return 'malformed';
    const length = big32(input, read);
    if (length > size - read - 12) return 'malformed';
    chunks += 1;
    if (chunks > ROOM_PICTURE_PNG_MAX_CHUNKS) return 'malformed';
    for (let index = 4; index < 8; index += 1) {
      const letter = at(input, read + index) | 0x20;
      if (letter < 0x61 || letter > 0x7a) return 'malformed';
    }
    const name = String.fromCharCode(
      at(input, read + 4),
      at(input, read + 5),
      at(input, read + 6),
      at(input, read + 7),
    );
    const body = read + 8;
    const end = body + length + 4;
    let keep = false;

    if (chunks === 1) {
      if (name !== 'IHDR' || length !== 13) return 'malformed';
      width = big32(input, body);
      height = big32(input, body + 4);
      depth = at(input, body + 8);
      colour = at(input, body + 9);
      const depths = PNG_DEPTHS[colour];
      if (depths === undefined || !depths.includes(depth)) return 'malformed';
      if (at(input, body + 10) !== 0 || at(input, body + 11) !== 0 || at(input, body + 12) > 1) return 'malformed';
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return 'malformed';
      if (outside(width, height, false)) return 'dimensions';
      keep = true;
    } else if (name === 'IHDR') {
      return 'malformed';
    } else if (name === 'gAMA' || name === 'cHRM' || name === 'sRGB' || name === 'sBIT') {
      if (palette !== -1 || data !== 0) return 'malformed';
      if (name === 'gAMA') {
        if (gama || length !== 4) return 'malformed';
        gama = true;
      } else if (name === 'cHRM') {
        if (chrm || length !== 32) return 'malformed';
        chrm = true;
      } else if (name === 'sRGB') {
        if (srgb || length !== 1) return 'malformed';
        srgb = true;
      } else {
        if (sbit || length !== PNG_SBIT_LENGTH[colour]) return 'malformed';
        sbit = true;
      }
      keep = true;
    } else if (name === 'PLTE') {
      // Only an indexed picture has a palette here. On a truecolour one it is a suggestion a decoder may
      // ignore: 768 bytes that are not pixels.
      if (palette !== -1 || trns || data !== 0 || colour !== 3) return 'malformed';
      if (length === 0 || length > 768 || length % 3 !== 0) return 'malformed';
      palette = length / 3;
      if (palette > 1 << depth) return 'malformed';
      keep = true;
    } else if (name === 'tRNS') {
      if (trns || data !== 0) return 'malformed';
      if (colour === 0) {
        if (length !== 2) return 'malformed';
      } else if (colour === 2) {
        if (length !== 6) return 'malformed';
      } else if (colour === 3) {
        if (palette === -1 || length === 0 || length > palette) return 'malformed';
      } else {
        return 'malformed';
      }
      trns = true;
      keep = true;
    } else if (name === 'IDAT') {
      if (data === 2 || (colour === 3 && palette === -1)) return 'malformed';
      data = 1;
      keep = true;
    } else if (name === 'IEND') {
      if (length !== 0 || data === 0 || end !== size) return 'malformed';
      out.set(input.subarray(read, end), written);
      return { width, height, frames: 1, length: written + (end - read) };
    } else {
      // A chunk that is on no list. A critical one (an upper-case first letter) refuses the file; an
      // ancillary one is dropped, and it ends the run of IDATs if one was under way.
      if ((at(input, read + 4) & 0x20) === 0) return 'malformed';
      if (data === 1) data = 2;
    }

    if (keep) {
      out.set(input.subarray(read, end), written);
      written += end - read;
    }
    read = end;
  }
}

// --- JPEG ------------------------------------------------------------------------------------------------

/** True when a DQT segment's data is whole tables and nothing else: a byte of precision and number, then 64 or 128 bytes. */
function jpegTablesOfQuantisation(input: Uint8Array, from: number, end: number): boolean {
  let read = from;
  if (read >= end) return false;
  while (read < end) {
    const first = at(input, read);
    if (first >> 4 > 1 || (first & 15) > 3) return false;
    read += first >> 4 === 0 ? 65 : 129;
  }
  return read === end;
}

/** True when a DHT segment's data is whole tables and nothing else: a byte of class and number, 16 counts, then that many symbols. */
function jpegTablesOfHuffman(input: Uint8Array, from: number, end: number): boolean {
  let read = from;
  if (read >= end) return false;
  while (read < end) {
    if (end - read < 17) return false;
    const first = at(input, read);
    if (first >> 4 > 1 || (first & 15) > 3) return false;
    let symbols = 0;
    for (let index = 1; index <= 16; index += 1) symbols += at(input, read + index);
    if (symbols > 256) return false;
    read += 17 + symbols;
  }
  return read === end;
}

/**
 * A JPEG. After SOI every segment is FF, a marker and a length that counts itself, with no fill byte before
 * it, and the walk must end on EOI as the last two bytes. Kept, each by its own rule: APP0 only as the
 * first segment, 16 bytes long, spelling "JFIF" and carrying no thumbnail; APP14 only as "Adobe", 14 bytes
 * long, once, before the first scan (it says whether three components are RGB); DQT and DHT made of whole
 * tables and no longer than ROOM_PICTURE_JPEG_DQT_MAX_LENGTH and ROOM_PICTURE_JPEG_DHT_MAX_LENGTH (so the
 * length of every segment that can stand first in an output begins with a byte of 8 or less: a control
 * character, at which a reading of the file as a script fails); DRI (4 bytes); exactly one SOF0, SOF1 or SOF2 with 8 bits a sample, one or three components and
 * sampling factors of 1 to 4; SOS after the frame and after a DQT and a DHT, with its scan data, in which an
 * FF is followed only by a stuffed zero or by RST0 to RST7. Dropped: every other APPn and COM, wherever a
 * segment may stand. Refused: any other marker (every other SOF, DAC, DNL, DHP, EXP, JPGn, TEM, a restart
 * marker outside a scan, a second SOI), a second frame, a scan before the frame, EOI before a scan, a fill
 * byte, more than ROOM_PICTURE_JPEG_MAX_SEGMENTS segments. The orientation is lost with APP1: the composer
 * bakes it into the pixels first.
 */
function walkJpeg(input: Uint8Array, out: Uint8Array): Walked {
  const size = input.length;
  out[0] = 0xff;
  out[1] = 0xd8;
  let read = 2;
  let written = 2;
  let segments = 0;
  let width = 0;
  let height = 0;
  let components = 0;
  let adobe = false;
  let quantisation = false;
  let huffman = false;
  let frame = false;
  let scans = 0;

  for (;;) {
    if (size - read < 2 || at(input, read) !== 0xff) return 'malformed';
    const marker = at(input, read + 1);
    if (marker === 0xd9) {
      if (scans === 0 || read + 2 !== size) return 'malformed';
      out[written] = 0xff;
      out[written + 1] = 0xd9;
      return { width, height, frames: 1, length: written + 2 };
    }
    segments += 1;
    if (segments > ROOM_PICTURE_JPEG_MAX_SEGMENTS) return 'malformed';
    // Every marker that may stand here carries a length. One that carries none (a restart marker, a second
    // SOI, TEM, a fill byte) is refused below with every other marker that is on no list.
    const known = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe || marker === 0xdb || marker === 0xc4;
    if (!known && marker !== 0xdd && marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2 && marker !== 0xda) {
      return 'malformed';
    }
    if (size - read < 4) return 'malformed';
    const length = (at(input, read + 2) << 8) | at(input, read + 3);
    if (length < 2 || length > size - read - 2) return 'malformed';
    const body = read + 4;
    let end = read + 2 + length;
    let keep = false;

    if (marker === 0xe0) {
      // JFIF, with no thumbnail: "JFIF", a zero, the version, the units, two densities, 0 by 0.
      keep =
        segments === 1 &&
        length === 16 &&
        spells(input, body, 'JFIF\0') &&
        at(input, body + 12) === 0 &&
        at(input, body + 13) === 0;
    } else if (marker === 0xee) {
      keep = !adobe && scans === 0 && length === 14 && spells(input, body, 'Adobe');
      if (keep) adobe = true;
    } else if (marker === 0xdb) {
      if (length > ROOM_PICTURE_JPEG_DQT_MAX_LENGTH) return 'malformed';
      if (!jpegTablesOfQuantisation(input, body, end)) return 'malformed';
      quantisation = true;
      keep = true;
    } else if (marker === 0xc4) {
      if (length > ROOM_PICTURE_JPEG_DHT_MAX_LENGTH) return 'malformed';
      if (!jpegTablesOfHuffman(input, body, end)) return 'malformed';
      huffman = true;
      keep = true;
    } else if (marker === 0xdd) {
      if (length !== 4) return 'malformed';
      keep = true;
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame || length < 11) return 'malformed';
      components = at(input, body + 5);
      if ((components !== 1 && components !== 3) || length !== 8 + 3 * components) return 'malformed';
      if (at(input, body) !== 8) return 'malformed';
      height = (at(input, body + 1) << 8) | at(input, body + 2);
      width = (at(input, body + 3) << 8) | at(input, body + 4);
      if (width === 0 || height === 0) return 'malformed';
      for (let index = 0; index < components; index += 1) {
        const sampling = at(input, body + 7 + 3 * index);
        const across = sampling >> 4;
        const down = sampling & 15;
        if (across < 1 || across > 4 || down < 1 || down > 4 || at(input, body + 8 + 3 * index) > 3) return 'malformed';
      }
      if (outside(width, height, false)) return 'dimensions';
      frame = true;
      keep = true;
    } else if (marker === 0xda) {
      if (!frame || !quantisation || !huffman || length < 8) return 'malformed';
      const inScan = at(input, body);
      if (inScan < 1 || inScan > components || length !== 6 + 2 * inScan) return 'malformed';
      // The scan's data: everything up to the next FF that is followed by neither a stuffed zero nor a
      // restart marker. That FF starts the next segment and is judged at the top of the loop.
      // A plain loop on purpose: a search call for every FF costs ten times as much on a scan that is all
      // stuffed bytes, which is the file a sender would choose.
      let scan = end;
      for (;;) {
        while (scan < size && input[scan] !== 0xff) scan += 1;
        if (scan + 1 >= size) return 'malformed';
        const next = at(input, scan + 1);
        if (next !== 0x00 && (next < 0xd0 || next > 0xd7)) break;
        scan += 2;
      }
      end = scan;
      scans += 1;
      keep = true;
    }
    // Else: an APPn or a COM that is on no list. Dropped.

    if (keep) {
      out.set(input.subarray(read, end), written);
      written += end - read;
    }
    read = end;
  }
}

// --- GIF -------------------------------------------------------------------------------------------------

/** The end of a run of sub-blocks that starts at `from` (the index after its terminator), or -1 when the input ends first. */
function gifSubBlocksEnd(input: Uint8Array, from: number): number {
  const size = input.length;
  let read = from;
  for (;;) {
    if (read >= size) return -1;
    const length = at(input, read);
    read += 1 + length;
    if (length === 0) return read;
  }
}

/**
 * A GIF, still or animated. The header is written as "GIF89a" whichever of the two it was; the screen
 * descriptor is copied with its aspect byte written as 0; the global table follows when the descriptor
 * says so. Then blocks, up to the trailer, which must be the last byte. Kept: an image descriptor whose
 * rectangle lies inside the canvas, with its local table, an LZW code size of 2 to 8 and its data
 * sub-blocks (at least one byte of data, and a table to draw from, local or global); the graphic control
 * extension (block size 4) that stands before an image, written with that image; the first application
 * extension that is the "NETSCAPE2.0" loop block of three bytes. Dropped: the comment extension, the
 * plain-text extension with the graphic control extension before it, every other application extension,
 * and a graphic control extension no image follows. Refused: any other block or extension label, no frame
 * or more than ROOM_PICTURE_MAX_FRAMES, more than ROOM_PICTURE_GIF_MAX_BLOCKS blocks (images and
 * extensions, kept and dropped together), a canvas outside the limits of a still picture, and for more than
 * one frame a canvas side above ROOM_PICTURE_ANIMATED_MAX_SIDE.
 *
 * This walk does NOT stop a GIF that is also a script. The side limits refuse the one known file (its width
 * bytes are the opening of a comment, which reads as 10,799 pixels). A GIF whose width's low byte is a
 * backtick (a width of 96 and every 256 more, up to 1,888) passes: `GIF89a` then reads as the tag of a
 * template that ends at a backtick in the global table, and what follows it there runs. Such a file is
 * inert only because of section 7 of the contract, the type from the row with `nosniff` and the generic
 * 404 to every request whose `Sec-Fetch-Dest` is not `image`. Neither is ever softened.
 */
function walkGif(input: Uint8Array, out: Uint8Array): Walked {
  const size = input.length;
  const width = at(input, 6) | (at(input, 7) << 8);
  const height = at(input, 8) | (at(input, 9) << 8);
  if (outside(width, height, false)) return 'dimensions';
  out.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  out.set(input.subarray(6, 12), 6);
  out[12] = 0;
  let read = 13;
  let written = 13;
  const screen = at(input, 10);
  const globalTable = (screen & 0x80) !== 0;
  if (globalTable) {
    const length = 3 << ((screen & 7) + 1);
    if (size - read < length) return 'malformed';
    out.set(input.subarray(read, read + length), written);
    read += length;
    written += length;
  }
  let frames = 0;
  /** Images and extensions met so far, kept and dropped together. */
  let blocks = 0;
  /** Where a graphic control extension that waits for its image starts in the input; -1 when none waits. */
  let control = -1;
  let loop = false;

  for (;;) {
    if (read >= size) return 'malformed';
    const block = at(input, read);
    if (block === 0x3b) {
      if (read !== size - 1) return 'malformed';
      out[written] = 0x3b;
      written += 1;
      break;
    }
    blocks += 1;
    if (blocks > ROOM_PICTURE_GIF_MAX_BLOCKS) return 'malformed';
    if (block === 0x21) {
      if (size - read < 3) return 'malformed';
      const label = at(input, read + 1);
      if (label === 0xf9) {
        if (size - read < 8 || at(input, read + 2) !== 4 || at(input, read + 7) !== 0) return 'malformed';
        control = read;
        read += 8;
        continue;
      }
      if (label !== 0xff && label !== 0xfe && label !== 0x01) return 'malformed';
      if (
        label === 0xff &&
        !loop &&
        size - read >= 19 &&
        at(input, read + 2) === 11 &&
        spells(input, read + 3, 'NETSCAPE2.0') &&
        at(input, read + 14) === 3 &&
        at(input, read + 15) === 1 &&
        at(input, read + 18) === 0
      ) {
        out.set(input.subarray(read, read + 19), written);
        written += 19;
        read += 19;
        loop = true;
        continue;
      }
      // Dropped: its sub-blocks are walked and not copied. A plain-text extension takes the graphic control
      // extension before it along.
      if (label === 0x01) control = -1;
      const end = gifSubBlocksEnd(input, read + 2);
      if (end === -1) return 'malformed';
      read = end;
      continue;
    }
    if (block !== 0x2c) return 'malformed';

    if (size - read < 10) return 'malformed';
    const left = at(input, read + 1) | (at(input, read + 2) << 8);
    const top = at(input, read + 3) | (at(input, read + 4) << 8);
    const wide = at(input, read + 5) | (at(input, read + 6) << 8);
    const high = at(input, read + 7) | (at(input, read + 8) << 8);
    if (wide === 0 || high === 0 || left + wide > width || top + high > height) return 'malformed';
    frames += 1;
    if (frames > ROOM_PICTURE_MAX_FRAMES) return 'frames';
    const local = at(input, read + 9);
    let data = read + 10;
    if ((local & 0x80) !== 0) data += 3 << ((local & 7) + 1);
    else if (!globalTable) return 'malformed';
    if (data >= size) return 'malformed';
    const code = at(input, data);
    if (code < 2 || code > 8) return 'malformed';
    const end = gifSubBlocksEnd(input, data + 1);
    // No sub-block with a byte in it: the run is its terminator alone.
    if (end === -1 || end === data + 2) return 'malformed';
    if (control !== -1) {
      out.set(input.subarray(control, control + 8), written);
      written += 8;
      control = -1;
    }
    out.set(input.subarray(read, end), written);
    written += end - read;
    read = end;
  }

  if (frames === 0) return 'frames';
  if (frames > 1 && outside(width, height, true)) return 'dimensions';
  return { width, height, frames, length: written };
}

/**
 * The picture rule. `input` is a whole file as it arrived. The answer is a problem of
 * ROOM_PICTURE_PROBLEMS, or the picture's facts with `bytes`, the only bytes that may be stored: this
 * function's own serialisation of the file, of the kept structures alone. For a file that holds nothing
 * else it is the file itself (a GIF87a aside, which is written as GIF89a), and checking an answer's `bytes`
 * again answers the same bytes.
 */
export function roomPictureCheck(input: Uint8Array): RoomPictureChecked {
  const size = input.length;
  if (size < ROOM_PICTURE_MIN_BYTES || size > ROOM_PICTURE_MAX_BYTES) return { ok: false, problem: 'size' };
  const type = signatureOf(input);
  if (type === null) return { ok: false, problem: 'type' };
  const out = new Uint8Array(size);
  const walked = type === 'png' ? walkPng(input, out) : type === 'jpeg' ? walkJpeg(input, out) : walkGif(input, out);
  if (typeof walked === 'string') return { ok: false, problem: walked };
  return {
    ok: true,
    type,
    width: walked.width,
    height: walked.height,
    frames: walked.frames,
    bytes: out.slice(0, walked.length),
  };
}

// --- what a browser script of the room needs of the contract -------------------------------------------
//
// A browser script may import values from `@prix/contracts/room-picture` and from no other file of the
// contracts (the others import zod; web-account's `rules.test.ts` refuses a script that does). So every
// constant and helper that `pictures.ts`, `picture.ts`, `report.ts` and the admins' script need is here,
// and `phase6-room-pictures.ts` exports all of it again for the server. Anything else a script needs it
// reads from a `data-` attribute that its own .astro wrote on the server.

/** Pictures of one wallet in one UTC day, on top of every cap of a message. */
export const ROOM_PICTURES_PER_WALLET_PER_DAY = 3;
/**
 * A wallet uploads no sooner than this after its first message that was stored: one hour (the operator,
 * 2026-10-11: the founder asked for free uploads, and an hour still makes a drive-by cost a text message that
 * passed the text rule and an hour of waiting, with that message in front of everyone meanwhile).
 */
export const ROOM_PICTURE_WRITER_AGE_SECONDS = 3_600;
/**
 * A wallet reports no sooner than this after its first message that was stored: one day (revision 2, the
 * security review's L4). Three reports hide a picture and five hidden pictures in an hour switch pictures
 * off, so a report is the stronger lever and waits longer than an upload: wallets made tonight cannot
 * switch pictures off tonight.
 */
export const ROOM_PICTURE_REPORTER_AGE_SECONDS = 86_400;
/**
 * How long a picture is shown and its bytes are kept, in seconds: seven days. Every KV put carries it as
 * `expirationTtl`, and D1 refuses a picture whose message is this old. It is seven days because the
 * namespace then stays under KV's 1 GB at the day's highest cap (`roomPictureStorageWorstBytes`).
 */
export const ROOM_PICTURE_TTL_SECONDS = 604_800;

/** The content type of an upload, exactly: the body is the file's bytes and nothing else. */
export const ROOM_PICTURE_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * The paths of pictures. A page builds the address of a picture's bytes from the message's id; no response
 * ever carries a URL. `ROOM_PICTURES_PATH` itself takes the upload (POST).
 */
export const ROOM_PICTURES_PATH = '/api/social/room/pictures';
export const ROOM_PICTURES_ADMIN_PATH = '/api/social/admin/room/pictures';
/** The bytes of a picture, for the `src` of the one `<img>` a click makes. */
export function roomPicturePath(id: number): string {
  return `${ROOM_PICTURES_PATH}/${id}`;
}
/** The report of a picture (POST). */
export function roomPictureReportPath(id: number): string {
  return `${ROOM_PICTURES_PATH}/${id}/report`;
}
/** The bytes of a picture as an admin looks at it, for the `src` of the `<img>` on the admins' page. */
export function roomPictureAdminPath(id: number): string {
  return `${ROOM_PICTURES_ADMIN_PATH}/${id}`;
}
/**
 * A message's id as text: digits with no leading zero. It is `roomIdParamSchema`'s pattern (phase6-room.ts),
 * written again here because that file imports zod; a test of qa pins that the two are one pattern.
 */
export const ROOM_PICTURE_ID_PATTERN = /^[1-9]\d{0,14}$/;
/**
 * The id a `data-` attribute holds, or null when it is no id. A script builds a path from an attribute only
 * through this function: whatever stands in the attribute, the path it makes is one of the three above.
 */
export function roomPictureIdOf(text: string | null | undefined): number | null {
  return typeof text === 'string' && ROOM_PICTURE_ID_PATTERN.test(text) ? Number(text) : null;
}

/**
 * The attributes the two web owners share on `/chat`, so that neither imports from the other. web-arena
 * writes the row; web-account reads `me` once (in its composer's script, as before) and owns the report.
 *
 * - `id`: on the row of every picture message, the message's id. Read through `roomPictureIdOf`.
 * - `shown`: on that row while its picture is shown. web-arena's script sets it at "Show picture" and
 *   removes it at "Hide picture".
 * - `report`: on the "Report" button, which is in the row from the first byte for every picture in the
 *   state `shown`. web-arena's stylesheet shows it only inside a row that carries `shown` and under a list
 *   that carries `reportOn`; no script hides or shows it.
 * - `reportNote`: on the empty element beside the button where the answer of a report is written. Since
 *   revision 6 it is also the place of the question: web-account's script writes the question and its two
 *   buttons into it, and gives it `tabindex="-1"` when it moves the focus there.
 * - `reportYes` and `reportNo` (revision 6): on the two buttons of the question, which web-account's script
 *   makes inside the element that carries `reportNote`. web-arena's stylesheet may lay them out by these
 *   two names and by nothing else of web-account's; a test finds them by these names.
 * - `list` (revision 3): on the element that holds the list of messages, with no value. web-arena writes
 *   it on the server, whenever the room's read answered, also when the room has no message to show (the
 *   element is then empty). web-account finds that element by this attribute and by nothing else: never by
 *   a class, an id or a label of web-arena's.
 * - `state` (revision 3): on that same element, the read's `pictures` as its value (`on`, `off` or
 *   `resting`); absent while the read carries no `pictures`. web-arena writes it on the server.
 *   web-account's composer script reads it: "Add a picture" is offered only while the value is exactly
 *   `on`, and the composer learns it from this attribute and from no prop.
 * - `reportOn`: on the element that carries `list`. web-account's composer script sets it, with no value,
 *   once its one `me` read answered `report: true`; nothing else sets it.
 *
 * The click is web-account's: `report.ts` listens on the element that carries `list`. "Report" asks once
 * before it reports (revision 6; before, the first press reported and could not be undone). A press on an
 * element with `report` sends nothing: it writes the question into the `reportNote` of the row around it,
 * with the two buttons `reportYes` and `reportNo`, and moves the focus to that element itself, never to
 * one of the two buttons, so that a second press of the same key or on the same spot reports nothing; the
 * button with `report` stays in its place meanwhile, and a press on it while the question is open does
 * nothing. Only a press on `reportYes` takes the id of the row around it and calls `reportPicture(id)`,
 * once. A press on `reportNo` empties the element and gives the focus back to the button with `report`:
 * the row is as it was. After the call the two buttons are removed, not disabled, the button with `report`
 * is closed for that page load, and the sentence of the answer is written into `reportNote`, which takes
 * the focus. When a row stops being shown while its question is open (the reader pressed "Hide picture",
 * and web-arena's script took `shown` away), the question closes as `reportNo` closes it, without moving
 * the focus: `report.ts` watches the attribute `shown` of the one row whose question is open, and lets go
 * of it when the question closes.
 */
export const ROOM_PICTURE_DOM = {
  id: 'data-room-picture-id',
  shown: 'data-room-picture-shown',
  report: 'data-room-picture-report',
  reportNote: 'data-room-picture-report-note',
  reportYes: 'data-room-picture-report-yes',
  reportNo: 'data-room-picture-report-no',
  list: 'data-room-list',
  state: 'data-room-pictures',
  reportOn: 'data-room-report-on',
} as const;

/** The longest side the composer draws a still picture at, before it sends. The server's own limit is ROOM_PICTURE_MAX_SIDE. A picture is never drawn larger than it is. */
export const ROOM_PICTURE_COMPOSER_MAX_SIDE = 1_600;
/**
 * The composer's ladder for a JPEG, in order: the longest side and the quality of each try. It takes the
 * first try whose file is at most ROOM_PICTURE_MAX_BYTES and that `roomPictureCheck` passes, and refuses
 * the picture in the page when the last one does not fit. Quality goes down first, at the full side; the
 * smaller sides are tried at the lowest quality only: six encodes at most.
 *
 * How the sides were chosen (revision 5, for 262,144 bytes; they were 1,280, 960 and 720 for 524,288). By
 * arithmetic, not by a measurement of any browser's encoder: what counts is how many bits of the file a
 * pixel may take. Each smaller side has about half the pixels of the one before (1,600, 1,120, 800, 560:
 * each about 1,600 divided by a power of the square root of 2), so each step doubles that budget. For a
 * picture of 4 by 3 the largest file leaves 1.09 bits a pixel at 1,600, 2.23 at 1,120, 4.37 at 800 and
 * 8.92 at 560; for a square one 0.82, 1.67, 3.28 and 6.69 (the check script prints both rows from the
 * constants). So every step can land: the full side for a chart, a drawing or a flat photo; 1,120 for
 * the photo that fitted at the full side while the file could be twice as large; 800 for a detailed
 * one; and 560 keeps for the last step about the room it had before (720 at 524,288 bytes left 10.79 and
 * 8.09 bits a pixel), which is more than a JPEG of 8 bits at this quality spends on anything but noise.
 * Which step a phone's photo lands at is for the browser matrix of gate 5 to see.
 */
export const ROOM_PICTURE_COMPOSER_STEPS = [
  { side: ROOM_PICTURE_COMPOSER_MAX_SIDE, quality: 0.85 },
  { side: ROOM_PICTURE_COMPOSER_MAX_SIDE, quality: 0.7 },
  { side: ROOM_PICTURE_COMPOSER_MAX_SIDE, quality: 0.55 },
  { side: 1_120, quality: 0.55 },
  { side: 800, quality: 0.55 },
  { side: 560, quality: 0.55 },
] as const;

/** The alternative text of a shown picture. `{author}` is the writer's short address. Nothing of the picture is described: Prix has not seen it. */
export const ROOM_PICTURE_ALT = 'Picture posted by {author}';

/**
 * The limits a page may print in its sentences, so that no page types a number. `maxKib` is 256 since
 * revision 5. A sentence the editor wrote one of these figures into has no slot for it, and no page
 * passes one (the comment at ROOM_PICTURE_COPY_KEYS, phase6-room-pictures.ts).
 */
export const ROOM_PICTURE_LIMITS = {
  maxKib: ROOM_PICTURE_MAX_BYTES / 1_024,
  minSide: ROOM_PICTURE_MIN_SIDE,
  maxSide: ROOM_PICTURE_MAX_SIDE,
  maxFrames: ROOM_PICTURE_MAX_FRAMES,
  animatedMaxSide: ROOM_PICTURE_ANIMATED_MAX_SIDE,
  perWalletPerDay: ROOM_PICTURES_PER_WALLET_PER_DAY,
  shownDays: ROOM_PICTURE_TTL_SECONDS / 86_400,
  writerAgeMinutes: ROOM_PICTURE_WRITER_AGE_SECONDS / 60,
  reporterAgeHours: ROOM_PICTURE_REPORTER_AGE_SECONDS / 3_600,
} as const;
