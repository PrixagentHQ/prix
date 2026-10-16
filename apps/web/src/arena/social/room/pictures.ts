import {
  ROOM_PICTURE_DOM,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_MIN_SIDE,
  roomPictureIdOf,
  roomPicturePath,
} from '@prix/contracts/room-picture';

/**
 * Pictures in the Community chat, in the browser (docs/contracts/phase-6-pictures.md, sections 11 and 17).
 * The one script of this folder. The server renders the row of a picture with its facts and the button
 * "Show picture", and the page holds no picture and no address of one. A click on that button makes one
 * `<img>`, whose address is built from the id of the message; "Hide picture" takes it out again, which
 * also stops a GIF. A picture is never a link.
 *
 * Nothing here asks by itself: no picture is loaded before a click, none is loaded again after it failed,
 * and there is no timer and no observer. A load that failed shows the one sentence the server rendered
 * for it, whatever the status was: an `<img>`'s error carries none.
 *
 * Nothing here decides. Whether a picture is offered at all is the server's (it rendered the button or
 * did not), and the bytes route judges every request again. The "Report" button, its note and who sees
 * them are the account's: this script never touches them.
 *
 * Every word on the page was rendered by the server from the copy deck. This script moves them, and
 * writes none of its own.
 */

/** The attributes of a row, as text, exactly as the server wrote them. */
export interface PictureMarks {
  id: string | null | undefined;
  width: string | null | undefined;
  height: string | null | undefined;
  alt: string | null | undefined;
}

/** The one picture a click makes. */
export interface PictureImage {
  src: string;
  width: number;
  height: number;
  alt: string;
}

/** A side of a picture as an attribute holds it: digits with no leading zero, inside the contract's limits. */
function sideOf(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/.test(value)) return null;
  const side = Number(value);
  return side >= ROOM_PICTURE_MIN_SIDE && side <= ROOM_PICTURE_MAX_SIDE ? side : null;
}

/**
 * The picture of a row, or null when the row's attributes are not what the server writes: the script then
 * does nothing. The address comes from the id through the contract's two functions and from nothing else,
 * so whatever stands in the attribute, the path asked is a picture's.
 */
export function pictureImage(marks: PictureMarks): PictureImage | null {
  const id = roomPictureIdOf(marks.id);
  const width = sideOf(marks.width);
  const height = sideOf(marks.height);
  if (id === null || width === null || height === null) return null;
  if (typeof marks.alt !== 'string' || marks.alt.length === 0) return null;
  return { src: roomPicturePath(id), width, height, alt: marks.alt };
}

/** The parts of a row that offers a picture, or null when one is missing. */
interface Parts {
  row: HTMLElement;
  toggle: HTMLButtonElement;
  frame: HTMLElement;
  failed: HTMLElement;
}

function partsOf(toggle: HTMLButtonElement): Parts | null {
  const row = toggle.closest<HTMLElement>(`[${ROOM_PICTURE_DOM.id}]`);
  const frame = row?.querySelector<HTMLElement>('[data-room-picture-frame]');
  const failed = row?.querySelector<HTMLElement>('[data-room-picture-failed]');
  return row && frame && failed ? { row, toggle, frame, failed } : null;
}

/** "Hide picture": the element is removed, which stops a GIF, and the row is as the server rendered it. */
function hide({ row, toggle, frame }: Parts): void {
  frame.replaceChildren();
  frame.hidden = true;
  frame.style.removeProperty('--room-picture-ratio');
  row.removeAttribute(ROOM_PICTURE_DOM.shown);
  toggle.textContent = toggle.dataset.label ?? '';
}

/**
 * A load that failed: the picture and its button go, and the sentence the server rendered stands where
 * the button was. The button does not come back on this page, so nothing asks again.
 */
function fail(parts: Parts): void {
  const held = document.activeElement === parts.toggle;
  hide(parts);
  parts.toggle.hidden = true;
  parts.failed.hidden = false;
  // A reader at the keyboard stays in the row, on the sentence that says what happened.
  if (held) parts.failed.focus();
}

/** "Show picture": one `<img>`, in the room the server's width and height give it. */
function show(parts: Parts): void {
  const { row, toggle, frame } = parts;
  const picture = pictureImage({
    id: row.getAttribute(ROOM_PICTURE_DOM.id),
    width: frame.dataset.width,
    height: frame.dataset.height,
    alt: frame.dataset.alt,
  });
  if (picture === null) return;
  const image = document.createElement('img');
  image.className = 'room-picture-image';
  // The two sides are attributes, so the browser keeps the picture's box before the first byte arrives.
  image.width = picture.width;
  image.height = picture.height;
  image.alt = picture.alt;
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    // A picture that was hidden meanwhile is no longer in the page, and its error says nothing of the row.
    if (image.isConnected) fail(parts);
  });
  image.src = picture.src;
  // The proportion of the picture, for the stylesheet: the frame is then no wider than a picture of its
  // greatest height, and the box the browser keeps is the picture's own, not a wider one around it.
  frame.style.setProperty('--room-picture-ratio', String(picture.width / picture.height));
  frame.replaceChildren(image);
  frame.hidden = false;
  row.setAttribute(ROOM_PICTURE_DOM.shown, '');
  toggle.textContent = toggle.dataset.hideLabel ?? '';
}

/**
 * Listens on the list of messages for a click on a row's button. One listener for the whole list: the
 * rows are the server's, and none is added after the page has loaded.
 */
export function mountPictures(): void {
  for (const list of document.querySelectorAll<HTMLElement>(`[${ROOM_PICTURE_DOM.list}]`)) {
    list.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const toggle = target?.closest<HTMLButtonElement>('button[data-room-picture-toggle]');
      const parts = toggle ? partsOf(toggle) : null;
      if (parts === null) return;
      if (parts.row.hasAttribute(ROOM_PICTURE_DOM.shown)) hide(parts);
      else show(parts);
    });
  }
}
