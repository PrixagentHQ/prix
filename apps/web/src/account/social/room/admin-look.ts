import { ROOM_PICTURE_ALT, roomPictureAdminPath, roomPictureIdOf } from '@prix/contracts/room-picture';

/**
 * The admin's look at a picture, in the browser (docs/contracts/phase-6-pictures.md sections 9, 11 and
 * 17). Before a press the page holds no image and no address of one. "Show picture" makes one image for
 * one picture, through the admins' own bytes route, held small and blurred; "Unblur picture" is a
 * second, deliberate press; "Hide picture" takes the image out of the page. Nothing here loads a picture
 * by itself, and a load that failed is not tried again: the sentence the server rendered says so, and
 * the admin may press again.
 *
 * A second press on the same spot never unblurs a picture, by mouse, touch or key (revision 6). After
 * "Show picture" the control in its place, and with the focus, is "Hide picture": a double click, a
 * double tap, Enter twice, Enter held and Space twice each end with the picture hidden again or still
 * blurred. "Unblur picture" is shown only from the image's own `load`, only while that image is still in
 * the page, and is never given the focus when it appears. The picture's place stands under the buttons
 * and has the picture's proportion from the server's two numbers before a byte arrives, so no control
 * moves when the bytes come.
 *
 * The address is built from the message's id through the contract's own two functions, whatever stands
 * in the attribute. The image is never a link. The API checks the admin again on every look.
 */

const BLURRED = 'room-look--blurred';
/** A step that is not offered now. Not `hidden`: "Show" and "Hide" keep one place between them. */
const AWAY = 'data-room-look-away';

const side = (text: string | undefined): number | null => {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export function mountAdminLook(): void {
  document.addEventListener('click', (event) => {
    const pressed = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-room-look]');
    const holder = pressed?.closest<HTMLElement>('[data-room-look-of]');
    const place = holder?.querySelector<HTMLElement>('[data-room-look-place]');
    const id = roomPictureIdOf(holder?.dataset.roomLookOf);
    if (!pressed || !holder || !place || id === null) return;

    const button = (step: string): HTMLButtonElement | null =>
      holder.querySelector<HTMLButtonElement>(`button[data-room-look="${step}"]`);
    const failed = holder.querySelector<HTMLElement>('[data-room-look-failed]');
    /** Offers one step, or takes it away. A step that is away cannot be pressed, focused or read out. */
    const set = (step: string, offered: boolean): void => {
      holder.querySelector<HTMLElement>(`[data-room-look-step="${step}"]`)?.toggleAttribute(AWAY, !offered);
    };
    /**
     * The one button that stands in the first place now, with the focus, so the keyboard stays where the
     * work is. "Unblur picture" is never offered here: only the image's own load offers it.
     */
    const offer = (step: 'show' | 'hide'): void => {
      set('show', step === 'show');
      set('hide', step === 'hide');
      set('unblur', false);
      button(step)?.focus();
    };
    const clear = (): void => {
      place.replaceChildren();
      place.hidden = true;
      place.style.removeProperty('--room-look-ratio');
      place.style.removeProperty('--room-look-width');
    };

    const step = pressed.dataset.roomLook;
    if (step === 'hide') {
      clear();
      offer('show');
      return;
    }
    if (step === 'unblur') {
      place.querySelector('img')?.classList.remove(BLURRED);
      // The button that was pressed goes; the focus goes to the one that stays.
      set('unblur', false);
      button('hide')?.focus();
      return;
    }
    if (step !== 'show') return;

    if (failed) failed.hidden = true;
    const image = document.createElement('img');
    const width = side(holder.dataset.width);
    const height = side(holder.dataset.height);
    // The server's own numbers: as attributes of the image, and as the proportion and the width of its
    // place, so the place is the picture's own shape before a byte arrives.
    if (width !== null && height !== null) {
      image.width = width;
      image.height = height;
      place.style.setProperty('--room-look-ratio', String(width / height));
      place.style.setProperty('--room-look-width', `${width}px`);
    }
    image.alt = ROOM_PICTURE_ALT.replace('{author}', holder.dataset.author ?? '');
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    image.className = `room-look-image ${BLURRED}`;
    image.addEventListener('load', () => {
      // A picture that was hidden meanwhile is no longer in the page, and offers nothing.
      if (image.isConnected) set('unblur', true);
    });
    image.addEventListener('error', () => {
      if (!image.isConnected) return;
      const held = holder.contains(document.activeElement);
      clear();
      set('hide', false);
      set('unblur', false);
      set('show', true);
      if (!failed) return;
      failed.hidden = false;
      // The sentence takes the focus, not "Show picture": a key held down asks for nothing again.
      if (held) failed.focus();
    });
    image.src = roomPictureAdminPath(id);
    place.replaceChildren(image);
    place.hidden = false;
    offer('hide');
  });
}
