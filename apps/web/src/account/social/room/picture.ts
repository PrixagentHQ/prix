import type { RoomPictureChecked, RoomPictureProblem, RoomPictureType } from '@prix/contracts/room-picture';
import {
  ROOM_PICTURE_COMPOSER_MAX_SIDE,
  ROOM_PICTURE_COMPOSER_STEPS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MIN_SIDE,
  roomPictureCheck,
} from '@prix/contracts/room-picture';
import { clearMessage, setBusy } from '../../dom.ts';
import type { PictureOffer, PictureWords } from './answers.ts';
import { factsSentence, picturesLeftSentence } from './answers.ts';

/**
 * The picture of the composer, in the browser (docs/contracts/phase-6-pictures.md section 11): the
 * picker, the canvas that redraws a still before it is sent, the contract's own rule on what is sent,
 * and the preview.
 *
 * What a chosen file is, is read from its first bytes, never from the type or the name a browser gives
 * it. A JPEG or a PNG is always drawn again through a canvas, upright, so that what a phone wrote into
 * the file (where the photo was taken, with which device) never leaves the phone: the file that is sent
 * is one the canvas made. A GIF cannot be drawn again, so the rule alone is run on it. A file of any
 * other type is refused here and never converted. There is no paste and no drag: a picture is chosen.
 *
 * None of this is trusted, and none of it decides. The server runs the same rule on whatever arrives
 * and stores only what the rule hands back. The page holds no sentence of the script's own.
 */

/** The field of a refusal the page itself gives a chosen file: the rule's problem under its field's name. */
export type PictureProblemField = `picture_${RoomPictureProblem}`;

/** A picture that passed the rule: its facts, and `bytes`, the rule's own serialisation, which is what is sent. */
export type CheckedPicture = Extract<RoomPictureChecked, { ok: true }>;

export type Prepared = { ok: true; picture: CheckedPicture } | { ok: false; field: PictureProblemField };

const refused = (problem: RoomPictureProblem): Prepared => ({ ok: false, field: `picture_${problem}` });

const starts = (bytes: Uint8Array, head: readonly number[]): boolean =>
  bytes.length >= head.length && head.every((byte, at) => bytes[at] === byte);

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const;
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const;

/**
 * What a file is, from its first bytes: the three signatures of the contract's section 4, and nothing
 * else. WebP, AVIF, HEIC, SVG and every other file are null, also one this browser could decode.
 */
export function pictureTypeOf(head: Uint8Array): RoomPictureType | null {
  if (starts(head, JPEG)) return 'jpeg';
  if (starts(head, PNG)) return 'png';
  if (starts(head, GIF87) || starts(head, GIF89)) return 'gif';
  return null;
}

export interface Size {
  width: number;
  height: number;
}

/** The size a picture is drawn at for a longest side of `side`: its own shape, and never larger than it is. */
export function drawnSize(width: number, height: number, side: number): Size {
  const scale = Math.min(1, side / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The tries of a JPEG for a picture of this size: the contract's ladder in its order, each step with
 * the size it draws. A step that would draw the size and the quality of an earlier one is left out,
 * since it would make the same file again; so there are never more tries than the ladder has steps.
 */
export function ladderOf(width: number, height: number): Array<Size & { quality: number }> {
  const tries: Array<Size & { quality: number }> = [];
  for (const step of ROOM_PICTURE_COMPOSER_STEPS) {
    const next = { ...drawnSize(width, height, step.side), quality: step.quality };
    const same = tries.some((made) => made.width === next.width && made.quality === next.quality);
    if (!same) tries.push(next);
  }
  return tries;
}

/** A decoded still, upright, and the one thing asked of it: a file of it at a size. */
export interface Still extends Size {
  /** The picture drawn at `size` as a file of `type`, or null when the canvas made none. A JPEG stands on white. */
  encode(type: 'png' | 'jpeg', size: Size, quality: number | null): Promise<Uint8Array | null>;
}

const fitsRule = (size: Size): boolean => Math.min(size.width, size.height) >= ROOM_PICTURE_MIN_SIDE;

/**
 * A JPEG or a PNG, drawn again. A PNG is drawn once as a PNG at 1,600 pixels at most and sent when the
 * rule passes it. A PNG that does not, and every JPEG, goes down the ladder as a JPEG. The first file
 * the rule passes is the answer, as the rule serialised it; when no step passes, the refusal is the
 * rule's own for the last file: `picture_size` for a picture that stays too large.
 */
export async function prepareStill(type: 'jpeg' | 'png', still: Still): Promise<Prepared> {
  if (!fitsRule(still)) return refused('dimensions');
  let last: RoomPictureProblem = 'dimensions';
  const attempt = async (as: 'png' | 'jpeg', size: Size, quality: number | null): Promise<Prepared | null> => {
    // The rule refuses a side below its smallest, so no file is made of one.
    if (!fitsRule(size)) return null;
    const file = await still.encode(as, size, quality);
    if (file === null) return refused('malformed');
    const checked = roomPictureCheck(file);
    if (checked.ok) return { ok: true, picture: checked };
    last = checked.problem;
    return null;
  };
  if (type === 'png') {
    const made = await attempt('png', drawnSize(still.width, still.height, ROOM_PICTURE_COMPOSER_MAX_SIDE), null);
    if (made !== null) return made;
  }
  for (const step of ladderOf(still.width, still.height)) {
    const made = await attempt('jpeg', step, step.quality);
    if (made !== null) return made;
  }
  return refused(last);
}

/** A GIF is never drawn again: the rule is run on the file, and its answer is what is sent. */
export function prepareGif(bytes: Uint8Array): Prepared {
  const checked = roomPictureCheck(bytes);
  return checked.ok ? { ok: true, picture: checked } : refused(checked.problem);
}

/** A chosen file as the page reads it: its length, and its first bytes when they are asked for. */
export interface PickedFile {
  size: number;
  /** The first `length` bytes of the file. */
  head(length: number): Promise<Uint8Array>;
}

/** More than the longest of the three signatures. */
const SIGNATURE_BYTES = 16;

/**
 * What is sent for a chosen file, or the field of its refusal. Only the first bytes are read to learn
 * what it is: a file of no known type is read no further, and neither is a GIF above the largest size.
 * `open` decodes a still upright; null means this browser could not. It is asked for a JPEG and a PNG
 * only, and for every one of them: no still is sent as it was chosen.
 */
export async function preparePicture(
  file: PickedFile,
  open: (type: 'jpeg' | 'png') => Promise<Still | null>,
): Promise<Prepared> {
  const type = pictureTypeOf(await file.head(SIGNATURE_BYTES));
  if (type === null) return refused('type');
  if (type === 'gif') {
    return file.size > ROOM_PICTURE_MAX_BYTES ? refused('size') : prepareGif(await file.head(file.size));
  }
  const still = await open(type);
  return still === null ? refused('malformed') : prepareStill(type, still);
}

/**
 * A picture is chosen only when the browser could also draw it (revision 6): a file whose first bytes
 * name one of the three types, which the rule passes and the browser then cannot decode, is refused as
 * `picture_malformed`. So there is never a chosen picture with an empty preview, and nothing of it is
 * sent. `draw` draws the preview and says whether it could; it is not asked for a refusal.
 */
export async function previewed(
  made: Prepared,
  draw: (picture: CheckedPicture) => Promise<boolean>,
): Promise<Prepared> {
  if (!made.ok) return made;
  return (await draw(made.picture)) ? made : refused('malformed');
}

// --- the browser ------------------------------------------------------------------------------------

/** A file's bytes, in a buffer of their own, as a body or as something to decode. */
const blobOf = (bytes: Uint8Array): Blob => new Blob([bytes.slice().buffer]);

/**
 * Decodes a still upright (the orientation a camera wrote beside the pixels is applied to the pixels)
 * and hands back a way to make files of it. Each file is drawn on a canvas of its own, a JPEG on white.
 */
async function openStill(file: Blob): Promise<(Still & { close(): void }) | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    close: () => bitmap.close(),
    encode: (type, size, quality) =>
      new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const pen = canvas.getContext('2d');
        if (!pen) {
          resolve(null);
          return;
        }
        if (type === 'jpeg') {
          pen.fillStyle = '#ffffff';
          pen.fillRect(0, 0, size.width, size.height);
        }
        pen.drawImage(bitmap, 0, 0, size.width, size.height);
        canvas.toBlob(
          (made) => {
            if (!made) resolve(null);
            else
              made.arrayBuffer().then(
                (buffer) => resolve(new Uint8Array(buffer)),
                () => resolve(null),
              );
          },
          type === 'png' ? 'image/png' : 'image/jpeg',
          quality ?? undefined,
        );
      }),
  };
}

/** The longest side of the preview's canvas, in its own pixels. The stylesheet decides how large it is shown. */
const PREVIEW_SIDE = 640;

/**
 * Draws what will be sent into the page's canvas: the very file, decoded again, so the preview is the
 * picture as others will get it. For a GIF it is the first frame. A canvas, because the site takes
 * images from itself only. Returns false when the browser could not decode the file.
 */
async function drawPreview(canvas: HTMLCanvasElement, picture: CheckedPicture): Promise<boolean> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blobOf(picture.bytes));
  } catch {
    return false;
  }
  const size = drawnSize(bitmap.width, bitmap.height, PREVIEW_SIDE);
  canvas.width = size.width;
  canvas.height = size.height;
  const pen = canvas.getContext('2d');
  pen?.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  return pen !== null;
}

/** The picture of the composer, as the composer's own script sees it. */
export interface PicturePart {
  /** The file to send when a picture is chosen, as the rule serialised it; else null, and the composer sends its line of text. */
  body(): Blob | null;
  /** Takes the chosen picture out again, and with it everything the page said about it. */
  discard(): void;
  /** While the one request of a send is under way the chosen picture cannot be taken out. */
  lock(locked: boolean): void;
  /** Told whenever a picture is chosen or taken out again, so the send can say what it sends. */
  onChange(heard: (chosen: boolean) => void): void;
}

function showOffer(form: HTMLElement, kind: PictureOffer['kind']): void {
  for (const part of form.querySelectorAll<HTMLElement>('[data-room-picture-offer]')) {
    part.hidden = part.dataset.roomPictureOffer !== kind;
  }
}

/**
 * Opens the picture part of the composer's form for what `me` and the page's list said. With nothing
 * to offer it shows nothing and answers a part that never holds a picture.
 */
export function mountPicture(form: HTMLFormElement, words: PictureWords, offer: PictureOffer): PicturePart {
  const none: PicturePart = {
    body: () => null,
    discard: () => undefined,
    lock: () => undefined,
    onChange: () => undefined,
  };
  showOffer(form, offer.kind);
  if (offer.kind !== 'add') return none;

  const add = form.querySelector<HTMLButtonElement>('button[data-room-picture-add]');
  const input = form.querySelector<HTMLInputElement>('input[data-room-picture-file]');
  const line = form.querySelector<HTMLElement>('[data-room-line]');
  const part = form.querySelector<HTMLElement>('[data-room-picture]');
  const canvas = form.querySelector<HTMLCanvasElement>('canvas[data-room-picture-preview]');
  const facts = form.querySelector<HTMLElement>('[data-room-picture-facts]');
  const discardButton = form.querySelector<HTMLButtonElement>('button[data-room-picture-discard]');
  const problem = form.querySelector<HTMLElement>('[data-room-picture-problem]');
  const sentence = problem?.querySelector<HTMLElement>('[data-room-picture-problem-sentence]');
  const leftLine = form.querySelector<HTMLElement>('[data-room-picture-left]');
  if (!add || !input || !line || !part || !canvas || !facts || !discardButton || !problem || !sentence) {
    showOffer(form, 'none');
    return none;
  }

  if (leftLine) {
    leftLine.textContent = picturesLeftSentence(offer.left, words);
    leftLine.hidden = false;
  }

  let picture: CheckedPicture | null = null;
  let heard: (chosen: boolean) => void = () => undefined;

  const refuse = (field: string | null): void => {
    sentence.textContent = field === null ? '' : (words.refusals[field] ?? words.other);
    problem.hidden = field === null;
  };

  /** A picture has no caption: while one is chosen it stands in the place of the line of text. */
  const show = (next: CheckedPicture | null): void => {
    picture = next;
    part.hidden = next === null;
    line.hidden = next !== null;
    add.hidden = next !== null;
    if (next === null) {
      facts.textContent = '';
      canvas.hidden = true;
    } else {
      facts.textContent = factsSentence({ ...next, bytes: next.bytes.length }, words);
    }
    heard(next !== null);
  };

  const choose = async (file: File): Promise<void> => {
    // What an earlier send ended as was about another file.
    clearMessage(form);
    refuse(null);
    setBusy(add, true);
    let made: Prepared;
    const opened: Array<{ close(): void }> = [];
    try {
      made = await preparePicture(
        { size: file.size, head: async (length) => new Uint8Array(await file.slice(0, length).arrayBuffer()) },
        async () => {
          const still = await openStill(file);
          if (still) opened.push(still);
          return still;
        },
      );
    } catch {
      made = refused('malformed');
    }
    for (const still of opened) still.close();
    // The preview is drawn before anything is shown as chosen: a file this browser cannot draw is refused.
    made = await previewed(made, (picture) => drawPreview(canvas, picture)).catch(() => refused('malformed'));
    setBusy(add, false);
    if (!made.ok) {
      show(null);
      refuse(made.field);
      add.focus();
      return;
    }
    show(made.picture);
    canvas.hidden = false;
    discardButton.focus();
  };

  add.addEventListener('click', () => {
    if (!add.disabled) input.click();
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    // The same file can be chosen again after a refusal or a discard.
    input.value = '';
    if (file) void choose(file);
  });
  const discard = (): void => {
    show(null);
    refuse(null);
  };
  discardButton.addEventListener('click', () => {
    clearMessage(form);
    discard();
    add.focus();
  });

  return {
    body: () => {
      const bytes = picture?.bytes;
      return bytes ? blobOf(bytes) : null;
    },
    discard,
    lock: (locked) => {
      discardButton.disabled = locked;
    },
    onChange: (listener) => {
      heard = listener;
    },
  };
}
