import { reloadWith, setBusy, showConfirmation } from '../../dom.ts';
import type { AdminWords, Answer } from './answers.ts';
import { adminOutcome } from './answers.ts';
import { hideMessage, keepPicture, muteWriter, picturesOff, picturesOn, unmuteWriter } from './client.ts';

/**
 * The admins' page of the Community chat, in the browser: hide a message, mute its writer, lift the
 * mute (docs/contracts/phase-6-room.md section 7); and for pictures, remove one, keep one, and switch
 * every picture off or on (docs/contracts/phase-6-pictures.md section 9). Each control asks once before
 * it runs. A call about a message goes by the message's id, so no address travels in a path; the switch
 * goes by nothing.
 *
 * The page decides nothing. The API checks the admin again on every call and answers the generic 404
 * to anyone else. After a control that worked the page is loaded again and the server draws the new
 * state; the result is then said in words. The page holds no sentence of the script's own.
 */

const ACTS: Record<string, { call: (id: string) => Promise<Answer>; done: string }> = {
  hide: { call: hideMessage, done: 'room-hidden' },
  mute: { call: muteWriter, done: 'room-muted' },
  unmute: { call: unmuteWriter, done: 'room-unmuted' },
  // Removing a picture is the hide of its message: the API deletes the file in the same request.
  remove: { call: hideMessage, done: 'room-picture-removed' },
  keep: { call: keepPicture, done: 'room-picture-kept' },
  'pictures-off': { call: () => picturesOff(), done: 'room-pictures-off' },
  'pictures-on': { call: () => picturesOn(), done: 'room-pictures-on' },
};

function wordsOf(holder: HTMLElement | null): AdminWords {
  try {
    const words = JSON.parse(holder?.dataset.words ?? '') as Partial<AdminWords> | null;
    if (words && typeof words.codes === 'object' && words.codes !== null && typeof words.admin === 'string') {
      return words as AdminWords;
    }
  } catch {
    // Without its sentences a failed control still shows its title.
  }
  return { codes: {}, admin: '' };
}

function mountConfirm(group: HTMLElement): void {
  const ask = group.querySelector<HTMLButtonElement>('[data-confirm-ask]');
  const panel = group.querySelector<HTMLElement>('[data-confirm-panel]');
  if (!ask || !panel) return;
  const open = (opened: boolean): void => {
    panel.hidden = !opened;
    ask.hidden = opened;
    (opened ? panel : ask).focus();
  };
  ask.addEventListener('click', () => open(true));
  panel.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => open(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') open(false);
  });
}

/** Puts the page's message `name` into the place of one row, with `sentence` in its `{message}` slot, as text. */
function showIn(scope: HTMLElement, name: string, sentence: string): void {
  const outlet = scope.querySelector<HTMLElement>('[data-outlet]');
  const template = document.querySelector<HTMLTemplateElement>(`template[data-room-message="${name}"]`);
  if (!outlet || !template) return;
  const copy = template.content.cloneNode(true);
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue === '{message}') node.nodeValue = sentence;
  }
  outlet.replaceChildren(copy);
}

export function mountRoomAdmin(): void {
  showConfirmation();
  for (const group of document.querySelectorAll<HTMLElement>('[data-confirm]')) mountConfirm(group);
  const words = wordsOf(document.querySelector<HTMLElement>('[data-room-admin]'));

  document.addEventListener('click', async (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-room-act]');
    if (!button || button.disabled) return;
    const name = button.dataset.roomAct ?? '';
    const act = Object.hasOwn(ACTS, name) ? ACTS[name] : undefined;
    const scope = button.closest<HTMLElement>('[data-scope]');
    if (!act || !scope) return;

    scope.querySelector<HTMLElement>('[data-outlet]')?.replaceChildren();
    setBusy(button, true);
    const outcome = adminOutcome(await act.call(button.dataset.roomId ?? ''), words);
    if (outcome.kind === 'done') {
      reloadWith(act.done);
      return;
    }
    setBusy(button, false);
    if (outcome.kind === 'session') showIn(scope, 'session', '');
    else showIn(scope, `${name}-failed`, outcome.sentence);
  });
}
