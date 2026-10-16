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
 * What a refused vote leaves on the control. A refusal that a state of the control already says (signed out,
 * below the amount, tiers off, closed) turns the control to that state; one that another press could pass
 * (too many requests, full, a fault) keeps the buttons and says why in the outlet; one that no press can pass
 * (not open yet, an unknown option) takes the buttons away and says why in the outlet.
 */
export function afterRefusal(scope: HTMLElement, message: RefusalMessage, state: ControlState): ControlState {
  const turnsTo: Partial<Record<RefusalMessage, ControlState>> = {
    session: { kind: 'signIn' },
    needTokens: { kind: 'needTokens' },
    gateOff: { kind: 'gateOff' },
    refusedClosed: { kind: 'closed' },
  };
  const next = turnsTo[message];
  if (next) {
    apply(scope, next);
    return next;
  }
  showMessage(scope, message);
  if (keepsButtons(message)) return state;
  showChoice(scope, false, null);
  showState(scope, 'none');
  return { kind: 'closed' };
}

/** One control: read the wallet's state once, then vote on a press. `send` is for tests. */
export async function mountPollVote(scope: HTMLElement, send?: PollTransport): Promise<void> {
  const pollId = scope.dataset.pollVote;
  if (!pollId) return;
  let state = controlStateOf(pollId, await fetchPollMe(send));
  apply(scope, state);

  scope.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLButtonElement>('button[data-poll-vote-button]');
    if (!button || !scope.contains(button) || button.disabled || state.kind !== 'vote') return;
    const option = button.dataset.pollVoteButton;
    if (!option) return;
    clearMessage(scope);
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
    state = afterRefusal(scope, refusalMessageOf(result), state);
  });
}

/** Every vote control of the page. */
export function mountPollVotes(): void {
  for (const scope of document.querySelectorAll<HTMLElement>('[data-poll-vote]')) void mountPollVote(scope);
}
