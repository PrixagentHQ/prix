import { clearMessage, setBusy, showMessage } from '../dom.ts';
import { castVote, fetchPollMe, type PollTransport } from './poll-client.ts';
import { type ControlState, controlStateOf, keepsButtons, type RefusalMessage, refusalMessageOf } from './rules.ts';

/**
 * The browser side of the vote control (PollVoteControl.astro). Every word it shows was rendered by the
 * server from the copy deck; this script only shows and hides it. It asks GET /api/polls/me once when the
 * control opens, never on a timer, and POSTs a vote only on a press. Nothing is kept in storage.
 */

/** A state of the control, or `none`: no line beneath the options. */
type StateName = ControlState['kind'] | 'none';

function showState(scope: HTMLElement, state: StateName): void {
  const states = scope.querySelector<HTMLElement>('[data-poll-states]');
  if (!states) return;
  for (const element of states.querySelectorAll<HTMLElement>('[data-poll-state]')) {
    element.hidden = element.dataset.pollState !== state;
  }
  states.removeAttribute('aria-busy');
}

/** Shows the vote buttons, with "Your vote" in place of the button of the current choice; or hides them all. */
export function showChoice(scope: HTMLElement, voting: boolean, current: string | null): void {
  for (const option of scope.querySelectorAll<HTMLElement>('[data-poll-option]')) {
    const mine = voting && option.dataset.pollOption === current;
    const action = option.querySelector<HTMLElement>('[data-poll-vote-action]');
    const yours = option.querySelector<HTMLElement>('[data-poll-yours]');
    if (action) action.hidden = !voting || mine;
    if (yours) yours.hidden = !mine;
    const button = option.querySelector<HTMLButtonElement>('button[data-poll-vote-button]');
    const nameId = option.dataset.pollNameId;
    if (button && nameId) button.setAttribute('aria-describedby', nameId);
  }
}

function apply(scope: HTMLElement, state: ControlState): void {
  showState(scope, state.kind);
  showChoice(scope, state.kind === 'vote', state.kind === 'vote' ? state.option : null);
}

/**
 * The line under each option's row where a refused vote is said (POLL-DC-1): on a phone the bottom of the
 * control is below the window, so a refusal said only there looked like a press that did nothing. Each line is
 * made empty when the control opens, at the end of the option's row (the list item around it, web-site's
 * ballot row) so that it spans the row; a page without such a row gets it right after the option.
 */
function placeSaidLines(scope: HTMLElement): void {
  for (const option of scope.querySelectorAll<HTMLElement>('[data-poll-option]')) {
    if (option.dataset.pollSaidPlaced) continue;
    const line = document.createElement('div');
    line.className = 'poll-vote-said';
    line.dataset.pollSaid = option.dataset.pollOption ?? '';
    const row = option.closest('li');
    if (row && scope.contains(row)) row.append(line);
    else option.after(line);
    option.dataset.pollSaidPlaced = 'true';
  }
}

function saidLineOf(scope: HTMLElement, option: string): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-poll-said="${CSS.escape(option)}"]`);
}

function clearSaidLines(scope: HTMLElement): void {
  for (const line of scope.querySelectorAll<HTMLElement>('[data-poll-said]')) {
    line.replaceChildren();
    line.removeAttribute('tabindex');
  }
}

/**
 * Says `message` under the row of the option that was pressed: a copy of the `<template data-message>` the
 * server rendered, an error Notice, so the line is its own live region (role="alert"). Returns the line, or
 * null when the message has no template (a refusal that only a state of the control says) or no line.
 */
function sayUnderOption(scope: HTMLElement, option: string, message: RefusalMessage): HTMLElement | null {
  const line = saidLineOf(scope, option);
  const template = scope.querySelector<HTMLTemplateElement>(`template[data-message="${message}"]`);
  if (!line || !template) return null;
  line.replaceChildren(template.content.cloneNode(true));
  return line;
}

/**
 * Brings a said line wholly into the window (POLL5-DC-1): on a 360x640 phone a two-line refusal under a row
 * near the bottom edge was cut. `nearest` scrolls only as far as the line needs, so the pressed button above
 * it stays in view, and the scroll is instant (never smooth), which also holds under reduced motion.
 */
function reveal(line: HTMLElement): void {
  line.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}

/** Moves focus to an element that has none of its own, without scrolling when it is already in view. */
function focusOn(element: HTMLElement, preventScroll: boolean): void {
  if (!element.matches('a[href], button, input, select, textarea')) element.tabIndex = -1;
  element.focus({ preventScroll });
}

/**
 * What a refused vote leaves on the control (POLL-DC-1). The refusal is said under the row of the option that
 * was pressed, where the holder is looking; the bottom status keeps the steady sentences.
 *
 * - One that another press could pass (too many requests, full, a fault) keeps the buttons, and focus stays
 *   on the pressed button.
 * - One that no press can pass (not open yet, an unknown option) takes the buttons away, and focus goes to the
 *   words under the row, since the pressed button is gone.
 * - One that a state of the control already says turns the control to that state. Closed is said under the
 *   row as well, with focus there. Signed out, below the amount and tiers off have no line of their own: focus
 *   goes to the state's own sentence (or its sign-in link), which brings it into the window.
 */
export function afterRefusal(
  scope: HTMLElement,
  message: RefusalMessage,
  state: ControlState,
  pressed?: HTMLButtonElement,
): ControlState {
  const option = pressed?.dataset.pollVoteButton;
  const said = option ? sayUnderOption(scope, option, message) : null;
  const turnsTo: Partial<Record<RefusalMessage, ControlState>> = {
    session: { kind: 'signIn' },
    needTokens: { kind: 'needTokens' },
    gateOff: { kind: 'gateOff' },
    refusedClosed: { kind: 'closed' },
  };
  const next = turnsTo[message];
  if (next) {
    apply(scope, next);
    if (said) {
      focusOn(said, true);
      reveal(said);
    } else if (pressed) {
      const steady = scope.querySelector<HTMLElement>(`[data-poll-state="${next.kind}"]`);
      const target = steady?.querySelector<HTMLElement>('a[href], button') ?? steady;
      if (target) focusOn(target, false);
    }
    return next;
  }
  // Without a pressed option (or a line for it) the refusal is said in the control's outlet, as before.
  if (!said) showMessage(scope, message);
  if (keepsButtons(message)) {
    pressed?.focus({ preventScroll: true });
    if (said) reveal(said);
    return state;
  }
  showChoice(scope, false, null);
  showState(scope, 'none');
  if (said) {
    focusOn(said, true);
    reveal(said);
  }
  return { kind: 'closed' };
}

/** One control: read the wallet's state once, then vote on a press. `send` is for tests. */
export async function mountPollVote(scope: HTMLElement, send?: PollTransport): Promise<void> {
  const pollId = scope.dataset.pollVote;
  if (!pollId) return;
  placeSaidLines(scope);
  let state = controlStateOf(pollId, await fetchPollMe(send));
  apply(scope, state);

  scope.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLButtonElement>('button[data-poll-vote-button]');
    if (!button || !scope.contains(button) || button.disabled || state.kind !== 'vote') return;
    const option = button.dataset.pollVoteButton;
    if (!option) return;
    clearMessage(scope);
    clearSaidLines(scope);
    setBusy(button, true);
    const result = await castVote(pollId, option, send);
    setBusy(button, false);
    if (result.ok) {
      state = { kind: 'vote', option: result.data.option };
      apply(scope, state);
      showMessage(scope, 'saved');
      // The button that was pressed is hidden now: focus goes to the words that replaced it.
      const yours = scope.querySelector<HTMLElement>(
        `[data-poll-option="${CSS.escape(result.data.option)}"] [data-poll-yours]`,
      );
      if (yours) {
        yours.tabIndex = -1;
        yours.focus({ preventScroll: true });
      }
      return;
    }
    state = afterRefusal(scope, refusalMessageOf(result), state, button);
  });
}

/** Every vote control of the page. */
export function mountPollVotes(): void {
  for (const scope of document.querySelectorAll<HTMLElement>('[data-poll-vote]')) void mountPollVote(scope);
}
