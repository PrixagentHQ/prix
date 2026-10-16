import { ROOM_PICTURE_DOM, roomPictureIdOf } from '@prix/contracts/room-picture';
import type { PictureWords } from './answers.ts';
import { reportSentence } from './answers.ts';
import { reportPicture } from './client.ts';

/**
 * The report of a picture on `/chat` (docs/contracts/phase-6-pictures.md sections 8, 11 and 17). The list
 * of messages and its rows are the other owner's: this script finds the list by the contract's attribute
 * and by nothing else, and listens on it.
 *
 * "Report picture" asks once before it reports (revision 6). The first press sends nothing: it sets the
 * question the server rendered, with its two answers, into the row's note, and the note itself takes the
 * focus, never one of the two buttons, so a second press of the same key or on the same spot reports
 * nothing. While the question is open a press on "Report picture" does nothing. Only the yes makes the
 * one call for the picture of the row around it. The no takes the question out again: the note is as it
 * was and the focus is back on "Report picture". After a report the question's two buttons are removed,
 * the button is closed for this page load, and the note holds the sentence of the answer and has the
 * focus.
 *
 * One question is open at a time. When its row stops being shown (the reader pressed "Hide picture", and
 * the list's own script took the mark away), the question closes as the no closes it, without moving the
 * focus: this script watches that one attribute of that one row, and lets go of it when the question
 * closes.
 *
 * A pointer's press on the yes is no answer until the question has stood for REPORT_ANSWER_AFTER_MS. The
 * question's focus can scroll the page, and where the two answers wrap under "Report picture" the yes
 * then comes to lie where the pointer is: a second press at the same point would be on the yes. It does
 * nothing, and the question stays open. No timer runs: the time of opening is kept and compared.
 *
 * The page decides nothing: the server judges every report whatever the page showed, and its answer
 * never says what was counted. Nothing here asks again, and no word of an answer reaches the page.
 */

/** How long a question stands before a pointer's press on its yes is an answer, in milliseconds. */
export const REPORT_ANSWER_AFTER_MS = 700;

/** What a click says about where it came from. */
export interface Press {
  /** The click count: 1 or more for a mouse, a finger or a pen, 0 for a key. */
  detail: number;
  /** The kind of pointer, where the browser says one: the empty string for a key. */
  pointerType?: unknown;
}

/**
 * Whether a press is a key's (Enter or Space on the button that has the focus): it carries no click count
 * and names no pointer. Both must hold, so anything else is taken for a pointer.
 */
export function fromKey(press: Press): boolean {
  return press.detail === 0 && (press.pointerType === undefined || press.pointerType === '');
}

/**
 * Whether a press on the yes comes too soon after its question opened to be an answer. A key's press never
 * does: a key reaches the yes only by Tab from the note, never by a second press of the key that opened
 * the question, which lands on the note and does nothing.
 */
export function tooSoon(press: Press, since: number, now: number): boolean {
  return !fromKey(press) && now - since < REPORT_ANSWER_AFTER_MS;
}

/** The question that is open: its row, when it opened, what watches the row, and what puts the row back as it was. */
interface Asked {
  row: HTMLElement;
  since: number;
  watch: MutationObserver;
  close(refocus: boolean): void;
}

export function mountReport(list: HTMLElement, words: PictureWords): void {
  const ask = document.querySelector<HTMLTemplateElement>('template[data-room-report-ask]');
  let asked: Asked | null = null;

  /** Opens the question in the note of this row. Nothing is sent. */
  const open = (row: HTMLElement, button: HTMLElement, note: HTMLElement): void => {
    if (!ask) return;
    asked?.close(false);
    const before = note.getAttribute('tabindex');
    const watch = new MutationObserver(() => {
      if (!row.hasAttribute(ROOM_PICTURE_DOM.shown)) asked?.close(false);
    });
    asked = {
      row,
      since: performance.now(),
      watch,
      close: (refocus) => {
        watch.disconnect();
        asked = null;
        note.replaceChildren();
        if (before === null) note.removeAttribute('tabindex');
        else note.setAttribute('tabindex', before);
        if (refocus) button.focus();
      },
    };
    note.replaceChildren(ask.content.cloneNode(true));
    note.tabIndex = -1;
    note.focus();
    watch.observe(row, { attributes: true, attributeFilter: [ROOM_PICTURE_DOM.shown] });
  };

  /** The yes: the one call. The question's buttons go, the button is closed for good, the note says the answer. */
  const send = async (row: HTMLElement, button: HTMLElement, note: HTMLElement, id: number): Promise<void> => {
    button.setAttribute('disabled', '');
    for (const answer of note.querySelectorAll(`[${ROOM_PICTURE_DOM.reportYes}], [${ROOM_PICTURE_DOM.reportNo}]`)) {
      answer.remove();
    }
    // The yes had the focus and is gone: the note keeps it, so the keyboard stays in the row.
    note.focus();
    const said = reportSentence(await reportPicture(id), words);
    note.textContent = said;
    // Not when the reader has moved on meanwhile: the sentence stands in the row either way.
    if (row.contains(document.activeElement) || document.activeElement === document.body) note.focus();
  };

  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>(`[${ROOM_PICTURE_DOM.id}]`);
    if (!target || !row || !list.contains(row)) return;
    const button = row.querySelector<HTMLElement>(`[${ROOM_PICTURE_DOM.report}]`);
    const note = row.querySelector<HTMLElement>(`[${ROOM_PICTURE_DOM.reportNote}]`);
    if (!button || !note) return;

    if (target.closest(`[${ROOM_PICTURE_DOM.reportNo}]`)) {
      if (asked?.row === row) asked.close(true);
      return;
    }
    if (target.closest(`[${ROOM_PICTURE_DOM.reportYes}]`)) {
      const id = roomPictureIdOf(row.getAttribute(ROOM_PICTURE_DOM.id));
      if (asked?.row !== row || id === null || button.hasAttribute('disabled')) return;
      // A pointer's second press at the point of the first: the question stays open, and nothing is sent.
      if (tooSoon(event, asked.since, performance.now())) return;
      // The row is no longer watched: its question is answered, and the answer stays whatever the row shows.
      asked.watch.disconnect();
      asked = null;
      void send(row, button, note, id);
      return;
    }
    if (!target.closest(`[${ROOM_PICTURE_DOM.report}]`)) return;
    // A button that is closed, or whose question is open already, does nothing.
    if (button.hasAttribute('disabled') || asked?.row === row) return;
    if (roomPictureIdOf(row.getAttribute(ROOM_PICTURE_DOM.id)) === null) return;
    open(row, button, note);
  });
}
