import type { ClaimMessageResponse } from '@prix/contracts';
import { formatDay } from '../../content/format.ts';
import {
  clearOnInput,
  fieldOf,
  fieldValue,
  fill,
  focusFirstInvalid,
  report,
  setBusy,
  setFieldError,
  showMessage,
  wordsOf,
} from '../dom.ts';
import { utf8Hex } from '../siwe.ts';
import { checkAgentName, checkSignature, checkWallet, idOk } from './check.ts';
import type { Failure } from './list-client.ts';
import { claimMessage, createListing, myListings, setListingStatus } from './list-client.ts';

/**
 * The "list my on-chain agent" flow, in the browser: enter the wallet and the name, read the
 * message the server wrote, sign it, send the signature. The wallet is asked for one thing,
 * `personal_sign`, on the exact text the server returned. This script never builds or edits that
 * text, never asks for a transaction, an approval or a chain change, and decides nothing: the
 * API checks every request again.
 */

interface Provider {
  request(call: { method: 'personal_sign'; params: readonly unknown[] }): Promise<unknown>;
}

function findProvider(): Provider | null {
  const injected = (window as { ethereum?: unknown }).ethereum;
  return typeof injected === 'object' && injected !== null && typeof (injected as Provider).request === 'function'
    ? (injected as Provider)
    : null;
}

type Step = 'claim' | 'create' | 'status' | 'load';

function sentence(words: Record<string, string>, step: Step, failure: Failure): string {
  if (failure.status === 502 && navigator.onLine === false) return words.offline ?? '';
  return words[`${step}_${failure.code}`] ?? words[`${step}_other`] ?? '';
}

/** Shows a failed call in the scope's outlet. An ended session gets its own message with the way back in. */
function showFailed(scope: HTMLElement, words: Record<string, string>, step: Step, failure: Failure): void {
  if (failure.code === 'unauthorized' && step !== 'create' && showMessage(scope, 'session')) return;
  showMessage(scope, 'failed', { message: sentence(words, step, failure) });
}

function clearOutlet(scope: HTMLElement): void {
  const outlet = scope.querySelector<HTMLElement>('[data-outlet]');
  outlet?.replaceChildren();
}

function setLocked(field: HTMLElement | null, locked: boolean): void {
  const control = field?.querySelector<HTMLInputElement>('input');
  if (!control) return;
  control.readOnly = locked;
}

export function mountList(): void {
  const page = document.querySelector<HTMLElement>('[data-list-page]');
  const claimFound = page?.querySelector<HTMLFormElement>('form[data-claim]');
  const createFound = page?.querySelector<HTMLFormElement>('form[data-create]');
  const listingsFound = page?.querySelector<HTMLElement>('[data-listings]');
  if (!page || !claimFound || !createFound || !listingsFound) return;
  const claimForm: HTMLFormElement = claimFound;
  const createForm: HTMLFormElement = createFound;
  const listings: HTMLElement = listingsFound;

  const words = wordsOf(page);
  const claimButton = claimForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  const signButton = createForm.querySelector<HTMLButtonElement>('button[data-sign]');
  const pasteButton = createForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  const resetButton = page.querySelector<HTMLButtonElement>('button[data-reset]');
  const copyButton = page.querySelector<HTMLButtonElement>('button[data-copy]');
  const copyStatus = page.querySelector<HTMLElement>('[data-copy-status]');
  const messageBox = page.querySelector<HTMLElement>('[data-message-text]');
  const steps = page.querySelectorAll<HTMLElement>('[data-step]');
  if (!claimButton || !signButton || !pasteButton || !messageBox) return;

  const nameField = fieldOf(claimForm, 'name');
  const walletField = fieldOf(claimForm, 'wallet');
  const signatureField = fieldOf(createForm, 'signature');
  for (const field of [nameField, walletField, signatureField]) if (field) clearOnInput(field);

  let claim: { wallet: string; name: string; response: ClaimMessageResponse } | null = null;

  const showSteps = (shown: boolean): void => {
    for (const step of steps) step.hidden = !shown;
    setLocked(nameField, shown);
    setLocked(walletField, shown);
    claimButton.hidden = shown;
  };

  const reset = (): void => {
    claim = null;
    showSteps(false);
    clearOutlet(claimForm);
    clearOutlet(createForm);
    messageBox.textContent = '';
    if (copyStatus) copyStatus.textContent = '';
    claimForm.querySelector<HTMLInputElement>('input[name="wallet"]')?.focus();
  };
  resetButton?.addEventListener('click', reset);

  // --- step 1: the message ---------------------------------------------------------------------
  claimForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (claimButton.disabled) return;
    clearOutlet(claimForm);
    const name = fieldValue(claimForm, 'name').trim();
    const wallet = fieldValue(claimForm, 'wallet').trim();
    const nameProblem = checkAgentName(name);
    const walletProblem = checkWallet(wallet);
    const wrong = [
      report(nameField, nameProblem ? (words[nameProblem] ?? '') : null),
      report(walletField, walletProblem ? (words[walletProblem] ?? '') : null),
    ];
    if (wrong.includes(true)) {
      focusFirstInvalid(claimForm);
      return;
    }

    setBusy(claimButton, true);
    // The API takes the address in lower case.
    const lower = wallet.toLowerCase();
    const answer = await claimMessage({ wallet: lower, name });
    setBusy(claimButton, false);
    if (!answer.ok) {
      const field = answer.field?.split('.')[0];
      const target =
        answer.code === 'invalid_input'
          ? field === 'wallet'
            ? walletField
            : field === 'name'
              ? nameField
              : null
          : null;
      if (target) {
        setFieldError(target, fill(words.rejected ?? '', { message: answer.message }));
        focusFirstInvalid(claimForm);
      } else if (answer.code === 'name_taken' || answer.code === 'name_not_allowed') {
        if (nameField) setFieldError(nameField, sentence(words, 'claim', answer));
        focusFirstInvalid(claimForm);
      } else {
        showFailed(claimForm, words, 'claim', answer);
      }
      return;
    }
    claim = { wallet: lower, name, response: answer.data };
    // The text is shown exactly as returned, and is what the wallet is asked to sign.
    messageBox.textContent = answer.data.message;
    showSteps(true);
    messageBox.closest<HTMLElement>('[data-step]')?.scrollIntoView({ block: 'nearest' });
    messageBox.focus();
  });

  // --- step 2: copy ------------------------------------------------------------------------------
  copyButton?.addEventListener('click', async () => {
    const say = (value: string): void => {
      if (copyStatus) copyStatus.textContent = value;
    };
    try {
      await navigator.clipboard.writeText(messageBox.textContent ?? '');
      say(words.copied ?? '');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(messageBox);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      say(words.copyFailed ?? '');
    }
  });

  // --- step 4: send the signature ----------------------------------------------------------------
  async function submitSignature(signature: string, button: HTMLButtonElement): Promise<void> {
    if (!claim) return;
    if (Date.now() >= Date.parse(claim.response.expiresAt)) {
      showMessage(createForm as HTMLElement, 'failed', { message: words.expired ?? '' });
      return;
    }
    setBusy(button, true);
    const answer = await createListing({
      wallet: claim.wallet,
      name: claim.name,
      nonce: claim.response.nonce,
      issuedAt: claim.response.issuedAt,
      expiresAt: claim.response.expiresAt,
      signature,
    });
    setBusy(button, false);
    if (!answer.ok) {
      const field = answer.field?.split('.')[0];
      if (answer.code === 'invalid_input' && (field === 'wallet' || field === 'name')) {
        const target = field === 'wallet' ? walletField : nameField;
        if (target) setFieldError(target, fill(words.rejected ?? '', { message: answer.message }));
        showMessage(createForm as HTMLElement, 'failed', { message: words.create_invalid_input ?? '' });
        return;
      }
      showFailed(createForm, words, 'create', answer);
      return;
    }
    const listed = answer.data.listing;
    const stateKey = { backfill: 'syncBackfill', live: 'syncLive', error: 'syncError', too_active: 'syncTooActive' }[
      listed.syncState
    ];
    reset();
    const outlet = showMessage(createForm, 'listed', { name: listed.name, state: words[stateKey] ?? '' });
    outlet?.setAttribute('tabindex', '-1');
    outlet?.focus();
    void loadListings();
  }

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pasteButton.disabled || !claim) return;
    clearOutlet(createForm);
    const signature = fieldValue(createForm, 'signature').trim();
    const problem = checkSignature(signature);
    if (report(signatureField, problem ? (words[problem] ?? '') : null)) {
      focusFirstInvalid(createForm);
      return;
    }
    void submitSignature(signature, pasteButton);
  });

  // personal_sign on the server's text, and nothing else. A wallet that does not hold the
  // account answers with an error, and the page says the connected account must be the agent's.
  signButton.addEventListener('click', async () => {
    if (signButton.disabled || !claim) return;
    clearOutlet(createForm);
    const provider = findProvider();
    if (!provider) {
      showMessage(createForm, 'failed', { message: words.noWallet ?? '' });
      return;
    }
    setBusy(signButton, true);
    let signature: unknown;
    try {
      signature = await provider.request({
        method: 'personal_sign',
        params: [utf8Hex(claim.response.message), claim.wallet],
      });
    } catch (error) {
      setBusy(signButton, false);
      const code = (error as { code?: unknown } | null)?.code;
      const key =
        code === 4001
          ? 'walletDeclined'
          : code === -32002
            ? 'walletPending'
            : code === 4100 || code === -32602
              ? 'walletMismatch'
              : 'walletFailed';
      showMessage(createForm, 'failed', { message: fill(words[key] ?? '', { wallet: claim.wallet }) });
      return;
    }
    setBusy(signButton, false);
    if (typeof signature !== 'string' || checkSignature(signature) !== null) {
      showMessage(createForm, 'failed', { message: words.walletFailed ?? '' });
      return;
    }
    await submitSignature(signature, signButton);
  });

  // --- the person's listings ---------------------------------------------------------------------
  const rows = listings.querySelector<HTMLElement>('[data-rows]');
  const remainingLine = listings.querySelector<HTMLElement>('[data-remaining]');

  function row(item: {
    id: string;
    name: string;
    wallet: string;
    explorerUrl: string;
    status: string;
    syncState: string;
    eventCount: number;
    claimedAt: string;
  }): HTMLElement {
    const li = document.createElement('li');
    li.className = 'listing-row stack-16';
    const head = document.createElement('p');
    head.className = 'body listing-name';
    head.textContent = item.name;
    const facts = document.createElement('dl');
    facts.className = 'listing-facts small';
    const syncKey = { backfill: 'syncBackfill', live: 'syncLive', error: 'syncError', too_active: 'syncTooActive' }[
      item.syncState
    ];
    const pairs: Array<[string, string]> = [
      [words.walletLabel ?? '', item.wallet],
      [
        words.syncLabel ?? '',
        `${item.status === 'active' ? (words.statusActive ?? '') : (words.statusRemoved ?? '')}, ${words[syncKey ?? ''] ?? ''}`,
      ],
      [words.eventsLabel ?? '', String(item.eventCount)],
      [words.claimedLabel ?? '', formatDay(item.claimedAt)],
    ];
    for (const [term, value] of pairs) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      if (term === (words.walletLabel ?? '')) {
        // The address breaks at one fixed point, in the middle, and nowhere else.
        const half = Math.ceil(value.length / 2);
        for (const part of [value.slice(0, half), value.slice(half)]) {
          const span = document.createElement('span');
          span.className = 'addr-half';
          span.textContent = part;
          dd.append(span);
        }
      } else {
        dd.textContent = value;
      }
      facts.append(dt, dd);
    }
    li.append(head, facts);
    if (item.explorerUrl.startsWith('https://')) {
      const link = document.createElement('a');
      link.href = item.explorerUrl;
      link.rel = 'noopener noreferrer';
      link.className = 'small';
      link.textContent = words.explorerLabel ?? '';
      const p = document.createElement('p');
      p.append(link);
      li.append(p);
    }
    if (idOk(item.id)) {
      const removed = item.status === 'removed';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button--secondary';
      button.dataset.id = item.id;
      button.dataset.status = removed ? 'active' : 'removed';
      button.dataset.label = removed ? (words.listAgain ?? '') : (words.remove ?? '');
      button.dataset.busyLabel = removed ? (words.listingAgain ?? '') : (words.removing ?? '');
      button.textContent = button.dataset.label;
      li.append(button);
    }
    return li;
  }

  async function loadListings(): Promise<void> {
    const answer = await myListings();
    if (!rows) return;
    if (!answer.ok) {
      rows.replaceChildren();
      if (remainingLine) remainingLine.textContent = '';
      showFailed(listings as HTMLElement, words, 'load', answer);
      return;
    }
    clearOutlet(listings);
    rows.replaceChildren(...answer.data.listings.map(row));
    if (answer.data.listings.length === 0) showMessage(listings, 'empty');
    if (remainingLine) {
      const count = answer.data.remaining;
      remainingLine.textContent =
        count === 0
          ? (words.remainingNone ?? '')
          : count === 1
            ? (words.remainingOne ?? '')
            : fill(words.remaining ?? '', { count: String(count) });
    }
  }

  rows?.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
    if (!button || button.disabled) return;
    const id = button.dataset.id ?? '';
    const status = button.dataset.status === 'removed' ? 'removed' : 'active';
    if (!idOk(id)) return;
    setBusy(button, true);
    const answer = await setListingStatus(id, status);
    setBusy(button, false);
    if (!answer.ok) {
      showMessage(listings, 'status-failed', { message: sentence(words, 'status', answer) });
      return;
    }
    await loadListings();
  });

  showMessage(listings, 'loading');
  void loadListings();
}
