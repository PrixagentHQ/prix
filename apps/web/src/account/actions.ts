import type { UpdateAgentInput } from '@prix/contracts';
import type { ApiResult } from '../lib/api.ts';
import { createApi } from '../lib/api.ts';
import { clearMessage, reloadWith, setBusy, showConfirmation, showFailure } from './dom.ts';

/**
 * The one-press actions of the account and admin pages: pause, resume, publish, unpublish,
 * delete a key, release a hold. The server rendered what each button does into `data-act`;
 * this file sends it, names the wait on the button, and reloads so that the page shows what
 * the API now says. An action that is hard to undo asks once first (`data-confirm`).
 */

interface Act {
  call: 'patch' | 'deleteKey' | 'release';
  /** The agent, the key or the symbol the call is about. */
  id: string;
  body?: UpdateAgentInput;
  /** The confirmation the page shows after the reload. */
  done: string;
}

function send(act: Act): Promise<ApiResult<unknown>> {
  const api = createApi();
  if (act.call === 'patch') return api.updateAgent(act.id, act.body ?? {});
  if (act.call === 'deleteKey') return api.deleteModelKey(act.id);
  return api.releaseHold(act.id);
}

function mountConfirm(group: HTMLElement): void {
  const ask = group.querySelector<HTMLButtonElement>('[data-confirm-ask]');
  const panel = group.querySelector<HTMLElement>('[data-confirm-panel]');
  const opener = group.querySelector<HTMLElement>('[data-confirm-open]');
  if (!ask || !panel || !opener) return;
  const show = (open: boolean): void => {
    panel.hidden = !open;
    opener.hidden = open;
    // Focus goes to the question, not to the button that confirms: a second Enter confirms nothing.
    (open ? panel : ask).focus();
  };
  ask.addEventListener('click', () => show(true));
  panel.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => show(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') show(false);
  });
}

export function mountActions(): void {
  showConfirmation();
  for (const group of document.querySelectorAll<HTMLElement>('[data-confirm]')) mountConfirm(group);

  document.addEventListener('click', async (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-act]');
    if (!button || button.disabled) return;
    let act: Act;
    try {
      act = JSON.parse(button.dataset.act ?? '') as Act;
    } catch {
      return;
    }
    const scope = button.closest<HTMLElement>('[data-scope]') ?? document.body;
    clearMessage(scope);
    setBusy(button, true);
    const result = await send(act);
    if (result.ok) {
      // The button keeps naming the wait until the page has loaded again.
      reloadWith(act.done);
      return;
    }
    setBusy(button, false);
    showFailure(scope, result);
  });
}
