import { createApi } from '../lib/api.ts';
import { clearMessage, errorSentences, sentenceFor, setBusy, showMessage } from './dom.ts';
import { isAddress } from './eip55.ts';
import { isAccountSignature, signInMessage, utf8Hex } from './siwe.ts';

/**
 * Signing in, in the browser. The wallet is the browser's injected provider, with no wallet
 * kit, and it is asked for exactly two things: which account to use (`eth_requestAccounts`)
 * and one signature on the sign-in message (`personal_sign`). Nothing here asks for the
 * chain, a chain switch, a transaction or an approval, and nothing may be added that does:
 * the chain is named in the signed message and the server checks it.
 */

interface WalletProvider {
  request(call: { method: 'eth_requestAccounts' | 'personal_sign'; params?: readonly unknown[] }): Promise<unknown>;
}

function isProvider(value: unknown): value is WalletProvider {
  return typeof value === 'object' && value !== null && typeof (value as { request?: unknown }).request === 'function';
}

/** A wallet that announced itself (EIP-6963), for a browser where none sits on `window.ethereum`. */
let announced: WalletProvider | null = null;

function findWallet(): WalletProvider | null {
  const injected = (window as { ethereum?: unknown }).ethereum;
  return isProvider(injected) ? injected : announced;
}

/** The message for a wallet's refusal. A wallet's own error text is never shown. */
function refusal(error: unknown, declined: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001) return declined;
  // The wallet already has a request open, usually its own unlock screen.
  if (code === -32002) return 'pending';
  return 'wallet-error';
}

async function signIn(panel: HTMLElement, say: (step: string | null) => void): Promise<boolean> {
  const wallet = findWallet();
  if (!wallet) {
    showMessage(panel, 'no-wallet');
    return false;
  }
  const api = createApi();
  const fail = (name: string, slots?: Record<string, string>): false => {
    say(null);
    showMessage(panel, name, slots);
    return false;
  };

  say('account');
  let accounts: unknown;
  try {
    accounts = await wallet.request({ method: 'eth_requestAccounts' });
  } catch (error) {
    return fail(refusal(error, 'account-declined'));
  }
  const address: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!isAddress(address)) return fail('account-declined');

  const request = await api.nonce();
  if (!request.ok) return fail('start-failed', { message: sentenceFor(errorSentences(panel), request) });

  const message = signInMessage(address, request.data, new Date());
  say('sign');
  let signature: unknown;
  try {
    signature = await wallet.request({ method: 'personal_sign', params: [utf8Hex(message), address] });
  } catch (error) {
    return fail(refusal(error, 'declined'));
  }
  if (!isAccountSignature(signature)) {
    // Hex of another length is how a contract wallet signs. Anything else is a wallet fault.
    const hex = typeof signature === 'string' && /^0x[0-9a-fA-F]+$/.test(signature);
    return fail(hex ? 'contract-wallet' : 'wallet-error');
  }
  if (Date.now() >= Date.parse(request.data.expiresAt)) return fail('expired');

  say('check');
  const session = await api.verify({ message, signature });
  if (session.ok) return true;
  // The API never says which check failed. A refused signature gets the page's own sentence.
  if (session.error.code === 'unauthorized' || session.error.code === 'invalid_input') return fail('failed');
  return fail('check-failed', { message: sentenceFor(errorSentences(panel), session) });
}

/** Wires the sign-in panel the server rendered, if the page has one. */
export function mountSignIn(): void {
  const panel = document.querySelector<HTMLElement>('[data-sign-in]');
  const button = panel?.querySelector<HTMLButtonElement>('[data-sign-in-button]');
  const status = panel?.querySelector<HTMLElement>('[data-sign-in-status]');
  if (!panel || !button || !status) return;
  const outlet = panel.querySelector<HTMLElement>('[data-outlet]');

  const say = (step: string | null): void => {
    status.textContent = step ? (status.dataset[step] ?? '') : '';
  };

  // Says that no wallet was found, and takes the message back if one turns up late.
  const lookForWallet = (): void => {
    if (findWallet()) {
      button.removeAttribute('aria-disabled');
      if (outlet?.dataset.showing === 'no-wallet') clearMessage(panel);
    } else if (!button.disabled && !outlet?.dataset.showing) {
      button.setAttribute('aria-disabled', 'true');
      showMessage(panel, 'no-wallet');
    }
  };
  window.addEventListener('eip6963:announceProvider', (event) => {
    const provider = (event as CustomEvent<{ provider?: unknown } | undefined>).detail?.provider;
    if (!announced && isProvider(provider)) announced = provider;
    lookForWallet();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  window.addEventListener('ethereum#initialized', lookForWallet, { once: true });
  // A wallet may inject itself after the page's own scripts have run.
  const later = (): void => {
    window.setTimeout(lookForWallet, 400);
  };
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });

  button.addEventListener('click', async () => {
    // Without a wallet the button cannot work: it looks off, stays focusable and says why.
    if (!findWallet()) {
      button.setAttribute('aria-disabled', 'true');
      showMessage(panel, 'no-wallet');
      return;
    }
    clearMessage(panel);
    setBusy(button, true);
    let signedIn = false;
    try {
      signedIn = await signIn(panel, say);
    } catch {
      say(null);
      showMessage(panel, 'wallet-error');
    }
    if (signedIn) {
      // The button keeps naming the wait until the next page arrives.
      window.location.assign(panel.dataset.next ?? '/account');
      return;
    }
    setBusy(button, false);
  });
}
