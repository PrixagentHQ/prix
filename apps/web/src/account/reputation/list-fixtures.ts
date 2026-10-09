import type { Result } from './list-client.ts';

/**
 * Answers of the listing flow for a build with PRIX_FIXTURES=1 (add `?fixture=signed-in` for the session). `?rep=<name>` on the page
 * URL picks the state: ok (default), empty, unauthorized, wallet, name-taken, forbidden,
 * rate-limited, failed, and create-unauthorized, create-forbidden, create-rate-limited for the
 * last step. Never part of a production build.
 */

const WALLET = '0x00000000000000000000000000000000000000aa';
const NOW = '2026-10-06T12:00:00.000Z';

function view(id: string, name: string, wallet: string, status: 'active' | 'removed', syncState: string) {
  return {
    id,
    name,
    wallet,
    explorerUrl: `https://explorer.mainnet.chain.robinhood.com/address/${wallet}`,
    verified: false,
    status,
    hidden: false,
    claimedAt: NOW,
    syncState,
    syncedAt: syncState === 'live' ? NOW : null,
    eventCount: syncState === 'live' ? 14 : 0,
    estimated: true,
  };
}

const state = { listings: [view('abcdefghijkl', 'Fixture Wallet', WALLET, 'active', 'live')] };

const fail = (status: number, code: string, field: string | null = null): Result<never> => ({
  ok: false,
  status,
  code,
  field,
  message: field ? 'That wallet is already listed.' : 'Fixture failure.',
});

export async function fixtureAnswer(
  url: URL,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
): Promise<Result<unknown>> {
  const name = url.searchParams.get('rep') ?? 'ok';
  const input = (body ?? {}) as Record<string, unknown>;
  if (path.endsWith('/me/listings')) {
    if (name === 'unauthorized') return fail(401, 'unauthorized');
    if (name === 'failed') return fail(500, 'internal');
    return { ok: true, data: { listings: name === 'empty' ? [] : state.listings, remaining: 2 } };
  }
  if (path.endsWith('/claim-message')) {
    if (name === 'unauthorized') return fail(401, 'unauthorized');
    if (name === 'wallet') return fail(409, 'invalid_input', 'wallet');
    if (name === 'name-taken') return fail(409, 'name_taken');
    if (name === 'forbidden') return fail(403, 'forbidden');
    if (name === 'rate-limited') return fail(429, 'rate_limited');
    const nonce = `${'a'.repeat(24)}.${'0'.repeat(32)}`;
    return {
      ok: true,
      data: {
        message: `Prix listing claim\n\nI control the wallet ${String(input.wallet)} and ask Prix to list it as the on-chain agent "${String(input.name)}".\n\nChain ID: 4663\nNonce: ${nonce}`,
        nonce,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };
  }
  if (path.endsWith('/status')) {
    const id = path.split('/').slice(-2)[0] ?? '';
    const found = state.listings.find((item) => item.id === id);
    if (!found) return fail(404, 'not_found');
    found.status = input.status === 'removed' ? 'removed' : 'active';
    return { ok: true, data: { listing: found } };
  }
  if (method === 'POST') {
    if (name === 'create-unauthorized') return fail(401, 'unauthorized');
    if (name === 'create-forbidden') return fail(403, 'forbidden');
    if (name === 'create-rate-limited') return fail(429, 'rate_limited');
    const created = view('zzzzzzzzzzzz', String(input.name), String(input.wallet), 'active', 'backfill');
    state.listings = [created, ...state.listings];
    return { ok: true, data: { listing: created } };
  }
  return fail(404, 'not_found');
}
