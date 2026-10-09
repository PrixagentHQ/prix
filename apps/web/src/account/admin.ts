import { createApi } from '../lib/api.ts';
import { mountActions } from './actions.ts';
import {
  clearMessage,
  clearOnInput,
  fieldOf,
  fieldValue,
  focusFirstInvalid,
  report,
  setBusy,
  showFailure,
  showMessage,
  wordsOf,
} from './dom.ts';
import { idOk } from './validate.ts';

/**
 * The admin page, in the browser: hide or unhide an agent by its id. Releasing a hold is one
 * of the one-press actions of actions.ts. Being shown this page grants nothing: the API
 * answers these calls only for a wallet on its own list of administrators.
 */
export function mountAdmin(): void {
  mountActions();
  const form = document.querySelector<HTMLFormElement>('form[data-hide-form]');
  const field = form && fieldOf(form, 'agentId');
  if (!form || !field) return;
  const words = wordsOf(form);
  clearOnInput(field);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    clearMessage(form);
    // A whole address may be pasted: the id is what follows the last slash.
    const id = fieldValue(form, 'agentId').trim().split(/[?#]/)[0]?.split('/').pop() ?? '';
    if (report(field, idOk(id) ? null : (words.idRejected ?? ''))) {
      focusFirstInvalid(form);
      return;
    }
    const hidden = button.value === 'true';
    setBusy(button, true);
    const result = await createApi().setAgentHidden(id, { hidden });
    setBusy(button, false);
    if (result.ok) showMessage(form, hidden ? 'hidden' : 'unhidden', { id });
    else showFailure(form, result);
  });
}
