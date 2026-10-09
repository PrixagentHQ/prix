// The browser half of FollowControl.astro. It sends the change through the browser entry of the
// follow client, says what went wrong in words and reloads on success, so the page shows what
// the server now holds (the button's state, the notes button and the follower count). No score
// or count is computed here.
import type { ApiResult } from '../../lib/api.ts';
import { createFollowApi } from '../../lib/follow-api.ts';

/** The follow button keeps its words and its sign; while it waits it is disabled and busy. */
function hold(button: HTMLButtonElement, on: boolean): void {
  button.disabled = on;
  if (on) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

/** The notes button says "Saving" while it waits, as Button's `busyLabel` asks. */
function busy(button: HTMLButtonElement, on: boolean): void {
  const label = button.dataset.label ?? button.textContent ?? '';
  const busyLabel = button.dataset.busyLabel ?? label;
  hold(button, on);
  button.textContent = on ? busyLabel : label;
}

function wire(root: HTMLElement): void {
  const actions = root.querySelector<HTMLElement>('.follow-actions');
  const agentId = root.dataset.agent;
  if (!actions || !agentId) return;
  const message = actions.querySelector<HTMLElement>('[data-follow-message]');
  const toggle = actions.querySelector<HTMLButtonElement>('[data-follow-toggle]');
  const notes = actions.querySelector<HTMLButtonElement>('[data-follow-notes]');
  const notify = actions.dataset.notify === 'true';
  const buttons = [toggle, notes].filter((each): each is HTMLButtonElement => each !== null);
  const api = createFollowApi();

  function say(words: string | undefined): void {
    if (!message) return;
    message.textContent = words ?? '';
    message.hidden = false;
  }

  async function run(
    button: HTMLButtonElement,
    show: (button: HTMLButtonElement, on: boolean) => void,
    send: () => Promise<ApiResult<unknown>>,
  ): Promise<void> {
    if (message) message.hidden = true;
    for (const each of buttons) each.disabled = true;
    show(button, true);
    const result = await send();
    if (result.ok) {
      window.location.reload();
      return;
    }
    show(button, false);
    for (const each of buttons) each.disabled = false;
    const { code, field } = result.error;
    const data = actions?.dataset;
    if (code === 'unauthorized') say(data?.msgUnauthorized);
    else if (code === 'invalid_input' && field === 'follows') say(data?.msgLimit);
    else if (code === 'forbidden') say(data?.msgForbidden);
    else if (code === 'rate_limited') say(data?.msgRate);
    else say(data?.msgFailed);
  }

  toggle?.addEventListener('click', () => {
    const following = toggle.getAttribute('aria-pressed') === 'true';
    void run(toggle, hold, () => (following ? api.deleteFollow(agentId) : api.putFollow(agentId, { notify: false })));
  });
  notes?.addEventListener('click', () => {
    void run(notes, busy, () => api.putFollow(agentId, { notify: !notify }));
  });
}

export function mountFollowControl(): void {
  for (const root of document.querySelectorAll<HTMLElement>('[data-follow]')) wire(root);
}
