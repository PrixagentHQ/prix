import { clearMessage, setBusy, showMessage, wordsOf } from '../dom.ts';

/**
 * Browser push for the follow notes. The browser is asked for permission only after a click.
 * A subscription is the address a push service gave this browser; it goes to the API and is
 * kept nowhere here: no storage, no cookie. Every word was rendered by the server.
 */

const SERVICE_WORKER = '/sw.js';

type Offer = { kind: 'offered'; key: string } | { kind: 'absent' } | { kind: 'failed' };

async function readKey(): Promise<Offer> {
  try {
    const response = await fetch('/api/push/key', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return { kind: 'absent' };
    if (!response.ok) return { kind: 'failed' };
    const body = (await response.json()) as { key?: unknown; publicKey?: unknown };
    const key = typeof body.key === 'string' ? body.key : body.publicKey;
    return typeof key === 'string' && key !== '' ? { kind: 'offered', key } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

async function send(method: 'POST' | 'DELETE', endpoint: string): Promise<boolean> {
  try {
    const response = await fetch('/api/push/subscriptions', {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The VAPID key arrives as base64url; the browser wants the bytes. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function canPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function mountPush(): Promise<void> {
  const card = document.querySelector<HTMLElement>('[data-push]');
  const button = card?.querySelector<HTMLButtonElement>('[data-push-toggle]');
  const status = card?.querySelector<HTMLElement>('[data-push-status]');
  if (!card || !button || !status) return;
  const words = wordsOf(card);
  const scope = button.closest<HTMLElement>('[data-scope]') ?? card;

  // The site does not offer push: the card stays hidden.
  let offer = await readKey();
  if (offer.kind === 'absent') return;

  const render = (on: boolean): void => {
    button.dataset.on = on ? 'true' : 'false';
    button.dataset.label = on ? words.turnOff : words.turnOn;
    button.dataset.busyLabel = on ? words.turnOffBusy : words.turnOnBusy;
    button.textContent = button.dataset.label ?? '';
    status.textContent = on ? (words.on ?? '') : (words.off ?? '');
  };
  const noButton = (message: string): void => {
    button.hidden = true;
    status.textContent = '';
    showMessage(scope, message);
  };

  card.hidden = false;

  if (!canPush()) {
    noButton('unsupported');
    return;
  }

  let registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER).catch(() => undefined);
  let current = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;

  if (Notification.permission === 'denied' && !current) {
    noButton('denied');
    return;
  }
  render(current !== null);

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    clearMessage(scope);
    setBusy(button, true);
    const on = button.dataset.on === 'true';
    let ok = false;
    let denied = false;
    try {
      if (on) {
        const subscription = current ?? (await registration?.pushManager.getSubscription()) ?? null;
        if (subscription) {
          const endpoint = subscription.endpoint;
          await subscription.unsubscribe();
          ok = await send('DELETE', endpoint);
        } else {
          ok = true;
        }
        if (ok) current = null;
      } else {
        // The one place the browser is asked: this click.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          // A dismissed prompt is not a failure: nothing changes and nothing is shown.
          denied = permission === 'denied';
          if (!denied) {
            setBusy(button, false);
            return;
          }
        } else {
          if (offer.kind !== 'offered') offer = await readKey();
          if (offer.kind === 'offered') {
            registration = await navigator.serviceWorker.register(SERVICE_WORKER);
            await navigator.serviceWorker.ready;
            const subscription =
              (await registration.pushManager.getSubscription()) ??
              (await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: keyBytes(offer.key),
              }));
            ok = await send('POST', subscription.endpoint);
            if (ok) current = subscription;
            else await subscription.unsubscribe().catch(() => false);
          }
        }
      }
    } catch {
      ok = false;
    }
    setBusy(button, false);
    if (denied) {
      noButton('denied');
      return;
    }
    if (!ok) {
      showMessage(scope, 'failed');
      return;
    }
    render(!on);
    button.focus({ preventScroll: true });
  });
}
