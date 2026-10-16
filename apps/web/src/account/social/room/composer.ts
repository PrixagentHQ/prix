import { ROOM_PICTURE_DOM } from '@prix/contracts/room-picture';
import { clearMessage, controlOf, fieldOf, setBusy, setFieldError, showMessage } from '../../dom.ts';
import type { ComposerState, ComposerWords, PictureWords } from './answers.ts';
import {
  composerState,
  countOf,
  dayCapsSentence,
  leftSentence,
  pictureOffer,
  pictureOutcome,
  refusalWords,
  reportOn,
  sendOutcome,
  textRefusal,
} from './answers.ts';
import { postLine, postPicture, readMe } from './client.ts';
import type { PicturePart } from './picture.ts';
import { mountPicture } from './picture.ts';
import { mountReport } from './report.ts';

/**
 * The composer of the Community chat, in the browser (docs/contracts/phase-6-room.md sections 5, 6, 9
 * and 13). The server renders the form closed. When the script opens it asks the API once whether this
 * wallet may write, then opens the field or puts the sentence that says why not in the form's place. It
 * asks nothing again by itself: no timer, no second try, no call when the page comes back into view.
 *
 * Nothing here is trusted and nothing here decides. Its check of a text is the contract's own rule,
 * run before a send as a courtesy; the server judges the text again and its answer is the one that
 * counts. After a send that was taken the page is loaded again, so the new line is drawn by the server
 * as every other line is: the script never puts anything an answer carries into the page.
 *
 * The page holds no sentence of the script's own: every word was rendered by the server from the copy
 * deck, and what is typed stays in the field and goes nowhere but into the one request.
 */

function wordsOf(box: HTMLElement): ComposerWords | null {
  try {
    const words = JSON.parse(box.dataset.words ?? '') as Partial<ComposerWords> | null;
    if (!words || typeof words.refusals !== 'object' || words.refusals === null) return null;
    for (const name of ['writer', 'other', 'sendFailed', 'count', 'leftOne', 'leftOther'] as const) {
      if (typeof words[name] !== 'string') return null;
    }
    // Without the second parts a refusal still has its first sentence.
    const more = typeof words.more === 'object' && words.more !== null ? words.more : {};
    // Without the sentence of the caps nothing stands under the composer.
    const dayCaps = typeof words.dayCaps === 'string' ? words.dayCaps : undefined;
    return { ...(words as ComposerWords), more, dayCaps };
  } catch {
    return null;
  }
}

const PICTURE_SENTENCES = [
  'limits',
  'leftOne',
  'leftOther',
  'facts',
  'factsAnimated',
  'sizeKb',
  'writer',
  'other',
  'sendFailed',
  'session',
  'reportDone',
  'reportFailed',
  'reportClosed',
] as const;

/** The sentences of pictures, or null: without them nothing of pictures is offered and no report is switched on. */
function pictureWordsOf(box: HTMLElement): PictureWords | null {
  try {
    const words = JSON.parse(box.dataset.pictureWords ?? '') as Partial<PictureWords> | null;
    if (!words || typeof words.refusals !== 'object' || words.refusals === null) return null;
    for (const name of PICTURE_SENTENCES) if (typeof words[name] !== 'string') return null;
    return words as PictureWords;
  } catch {
    return null;
  }
}

/**
 * Shows the one part of the composer that fits the state, and hides the others. The server renders
 * the form itself as the part that shows, so until `me` answers nothing here has run.
 */
function show(box: HTMLElement, state: ComposerState): void {
  for (const part of box.querySelectorAll<HTMLElement>('[data-room-state]')) {
    part.hidden = part.dataset.roomState !== state;
  }
}

function mountForm(
  box: HTMLElement,
  words: ComposerWords,
  left: number,
  picture: (form: HTMLFormElement) => { part: PicturePart; words: PictureWords } | null,
): void {
  const form = box.querySelector<HTMLFormElement>('form[data-room-state="yes"]');
  const field = form ? fieldOf(form, 'text') : null;
  const input = field ? controlOf(field) : null;
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const counter = form?.querySelector<HTMLElement>('[data-room-count]');
  if (!form || !field || !(input instanceof HTMLInputElement) || !button || !counter) return;

  const allowed = {
    prixAddress: (box.dataset.prixAddress ?? '').toLowerCase() || null,
    siteHost: box.dataset.siteHost ?? '',
  };
  // The sentence takes the place the server kept for it, so nothing under it moves.
  const leftLine = form.querySelector<HTMLElement>('[data-room-left]');
  if (leftLine) {
    leftLine.textContent = leftSentence(left, words);
    leftLine.removeAttribute('aria-hidden');
  }
  const rest = form.querySelector<HTMLElement>('[data-room-more]');
  const described = [input.getAttribute('aria-describedby'), rest?.id, counter.id].filter(Boolean).join(' ');
  if (described) input.setAttribute('aria-describedby', described);

  /** A refusal of the text: its first sentence beside the field, what follows it under that. `null` takes both away. */
  const refuse = (said: { sentence: string; more: string } | null): void => {
    setFieldError(field, said?.sentence ?? null);
    if (!rest) return;
    rest.textContent = said?.more ?? '';
    rest.hidden = rest.textContent === '';
  };

  const count = (): void => {
    const now = countOf(input.value);
    counter.textContent = words.count.replace('{count}', String(now.count));
    counter.classList.toggle('field-error', now.over);
    counter.classList.toggle('field-count', !now.over);
    if (now.over) input.setAttribute('aria-invalid', 'true');
  };
  input.addEventListener('input', () => {
    refuse(null);
    count();
  });
  count();

  // The field and the button arrive closed. They open here, once `me` has said this wallet may write.
  input.disabled = false;
  button.disabled = false;
  const pictures = picture(form);
  // While a picture is chosen the send says that it sends a picture, and what it says while it does:
  // the deck's words, which the server set on the button beside its own two.
  const ofLine = { label: button.dataset.label, busy: button.dataset.busyLabel };
  pictures?.part.onChange((chosen) => {
    const label = chosen ? button.dataset.pictureLabel : ofLine.label;
    const busy = chosen ? button.dataset.pictureBusyLabel : ofLine.busy;
    if (label) {
      button.dataset.label = label;
      button.textContent = label;
    }
    if (busy) button.dataset.busyLabel = busy;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);
    refuse(null);
    count();

    // A picture is a message of its own, with no caption: while one is chosen the send is the picture's.
    const file = pictures?.part.body() ?? null;
    if (pictures && file !== null) {
      setBusy(button, true);
      pictures.part.lock(true);
      const ended = pictureOutcome(await postPicture(file), pictures.words);
      if (ended.kind === 'sent') {
        // The server draws the new row with every other. Nothing the answer carries is read.
        pictures.part.discard();
        window.location.reload();
        return;
      }
      pictures.part.lock(false);
      setBusy(button, false);
      const said =
        ended.kind === 'notice'
          ? showMessage(form, 'picture-failed', { message: ended.sentence })
          : showMessage(form, ended.kind);
      said?.scrollIntoView({ block: 'nearest' });
      return;
    }

    const line = input.value;
    const refused = textRefusal(line, allowed);
    if (refused !== null) {
      refuse(refusalWords(refused, words));
      input.focus();
      return;
    }

    setBusy(button, true);
    input.readOnly = true;
    const outcome = sendOutcome(await postLine(line), words);
    if (outcome.kind === 'sent') {
      // The server draws the new line with every other. An emptied field is not sent twice by a
      // browser that keeps what a form held across a reload.
      input.value = '';
      window.location.reload();
      return;
    }
    input.readOnly = false;
    setBusy(button, false);
    if (outcome.kind === 'field') {
      refuse(outcome);
      input.focus();
      return;
    }
    // Under the button, and brought onto the screen: an open keyboard leaves little of it.
    const shown =
      outcome.kind === 'notice'
        ? showMessage(form, 'failed', { message: outcome.sentence })
        : showMessage(form, outcome.kind);
    shown?.scrollIntoView({ block: 'nearest' });
  });
}

export async function mountComposer(): Promise<void> {
  const box = document.querySelector<HTMLElement>('[data-room-composer]');
  if (!box) return;
  const words = wordsOf(box);
  if (!words) {
    show(box, 'failed');
    return;
  }
  const answer = await readMe();
  const { state, left } = composerState(answer);
  show(box, state);

  // The caps of a day by holding: the deck's one sentence, exactly when `me` answered `dayCap`.
  const caps = box.querySelector<HTMLElement>('[data-room-day-caps]');
  const capsSaid = dayCapsSentence(answer, words);
  if (caps && capsSaid !== null) {
    caps.textContent = capsSaid;
    caps.hidden = false;
  }

  // Pictures: the list of messages is the page's own, found by the contract's attribute and by nothing
  // else. Its second attribute is the read's `pictures`; the one answer of `me` says the rest.
  const pictureWords = pictureWordsOf(box);
  const list = document.querySelector<HTMLElement>(`[${ROOM_PICTURE_DOM.list}]`);
  if (pictureWords && list && reportOn(answer)) {
    list.setAttribute(ROOM_PICTURE_DOM.reportOn, '');
    mountReport(list, pictureWords);
  }
  if (state !== 'yes') return;
  const offer = pictureOffer(answer, list?.getAttribute(ROOM_PICTURE_DOM.state) ?? null);
  mountForm(box, words, left, (form) =>
    pictureWords ? { part: mountPicture(form, pictureWords, offer), words: pictureWords } : null,
  );
}
