import type { PollTallyOutcome, TelegramWebhookAdminResponse, TelegramWebhookState } from '@prix/contracts';
import type { AdminCall, AdminTransport } from './admin-client.ts';

/**
 * Fixtures for /admin/holders, reached only when the site is built with PRIX_FIXTURES=1. `?holdersfixture=<name>`
 * selects the state:
 *
 *   quiet          the watch has seen nothing; the webhook is set; a tally answers `done` (the default)
 *   moved          the watch saw the webhook moved; a tally answers `already`
 *   webhook-error  setting the webhook answers a Telegram error in its last field; a tally answers `open`
 *   tally-failed   a tally answers `failed` at the step `read`
 *   waiting        a tally answers `waiting`
 *   fail           every call answers 500
 *
 * No fixture holds a secret or a token: the fields are what the API would answer, with a placeholder address.
 */

const NAMES = ['quiet', 'moved', 'webhook-error', 'tally-failed', 'waiting', 'fail'] as const;
type Name = (typeof NAMES)[number];

function known(name: string): name is Name {
  return (NAMES as readonly string[]).includes(name);
}

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, field: null } }, { status });
}

function webhook(name: Name): TelegramWebhookAdminResponse {
  return {
    url: 'https://prixagent.com/api/telegram/webhook',
    pendingUpdateCount: 0,
    lastErrorMessage: name === 'webhook-error' ? 'Wrong response from the webhook: 502 Bad Gateway' : null,
  };
}

function watch(name: Name): TelegramWebhookState {
  return name === 'moved' ? { moved: true, movedAt: '2026-10-16T13:13:02.000Z' } : { moved: false, movedAt: null };
}

function tally(name: Name): PollTallyOutcome {
  if (name === 'moved') return { outcome: 'already', step: null };
  if (name === 'webhook-error') return { outcome: 'open', step: null };
  if (name === 'tally-failed') return { outcome: 'failed', step: 'read' };
  if (name === 'waiting') return { outcome: 'waiting', step: null };
  return { outcome: 'done', step: null };
}

/** A transport that answers from fixtures. `pageUrl` is the page being rendered or the page the script runs on. */
export function createHoldersAdminFixtureTransport(pageUrl: URL): AdminTransport {
  const name = (pageUrl.searchParams.get('holdersfixture') ?? 'quiet').trim();
  return async (call: AdminCall) => {
    if (!known(name)) return failure(500, 'internal', `Unknown holders fixture: ${name}`);
    if (name === 'fail') return failure(500, 'internal', 'The fixture is set to fail every call.');
    if (call.path === '/api/admin/telegram/webhook') {
      return Response.json(call.method === 'POST' ? webhook(name) : watch(name));
    }
    if (call.method === 'POST' && /^\/api\/admin\/polls\/[a-z0-9-]+\/tally$/.test(call.path)) {
      return Response.json(tally(name));
    }
    return failure(404, 'not_found', 'Not found.');
  };
}
