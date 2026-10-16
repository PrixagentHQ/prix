import { clearMessage, setBusy, showMessage } from '../../dom.ts';
import { type AdminTransport, runPollTally, setTelegramWebhook } from './admin-client.ts';
import { tallyMessageOf, webhookSlots } from './view.ts';

/**
 * The browser side of /admin/holders. Two presses and nothing else: set the webhook, and count one closed
 * poll. Every word it shows was rendered by the server from the copy deck. Nothing is kept in storage, and
 * the webhook's answer is put into the page as text, never as markup.
 */

/** The webhook control. `send` is for tests. */
export function mountWebhook(scope: HTMLElement, send?: AdminTransport): void {
  const button = scope.querySelector<HTMLButtonElement>('button[data-holders-webhook-set]');
  if (!button) return;
  const none = scope.querySelector<HTMLElement>('[data-holders-none]')?.textContent ?? '';
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    clearMessage(scope);
    setBusy(button, true);
    const result = await setTelegramWebhook(send);
    setBusy(button, false);
    if (result.ok) {
      showMessage(scope, 'set', webhookSlots(result.data, none));
      return;
    }
    if (result.error.code === 'unauthorized' && showMessage(scope, 'session')) return;
    showMessage(scope, 'failed');
  });
}

/** The tally control of one closed poll. `send` is for tests. */
export function mountTally(scope: HTMLElement, steps: Readonly<Record<string, string>>, send?: AdminTransport): void {
  const pollId = scope.dataset.holdersTally;
  const button = scope.querySelector<HTMLButtonElement>('button[data-holders-tally-run]');
  if (!pollId || !button) return;
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    clearMessage(scope);
    setBusy(button, true);
    const result = await runPollTally(pollId, send);
    setBusy(button, false);
    if (result.ok) {
      const message = tallyMessageOf(result.data, steps);
      showMessage(scope, message.name, message.slots);
      return;
    }
    if (result.error.code === 'unauthorized' && showMessage(scope, 'session')) return;
    showMessage(scope, 'request');
  });
}

function stepWordsOf(element: Element | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(element?.getAttribute('data-step-words') ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function mountHoldersAdmin(): void {
  const webhook = document.querySelector<HTMLElement>('[data-holders-webhook]');
  if (webhook) mountWebhook(webhook);
  const list = document.querySelector<HTMLElement>('[data-step-words]');
  const steps = stepWordsOf(list);
  for (const scope of document.querySelectorAll<HTMLElement>('[data-holders-tally]')) mountTally(scope, steps);
}
