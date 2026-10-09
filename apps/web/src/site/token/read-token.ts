// The server read of GET /api/token, through the API service binding. Server side only.
import { type TokenInfoResponse, tokenInfoResponseSchema } from '@prix/contracts';
import type { ApiContext } from '../../lib/api.ts';

export type TokenRead = { ok: true; info: TokenInfoResponse } | { ok: false; status: number };

const reads = new WeakMap<Request, Promise<TokenRead>>();

async function fetchToken(context: ApiContext): Promise<TokenRead> {
  try {
    if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
      const { tokenFixtureFor } = await import('./fixtures.ts');
      return { ok: true, info: tokenFixtureFor(context.url) };
    }
    const { createServerTransport } = await import('../../lib/api-server.ts');
    const response = await createServerTransport(context)({ method: 'GET', path: '/api/token' });
    if (!response.ok) return { ok: false, status: response.status >= 400 ? response.status : 502 };
    const parsed = tokenInfoResponseSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, info: parsed.data } : { ok: false, status: 502 };
  } catch {
    return { ok: false, status: 502 };
  }
}

/** The answer with its status, read once per request so the route file and the page share one call. */
export function readTokenResult(context: ApiContext): Promise<TokenRead> {
  const earlier = reads.get(context.request);
  if (earlier) return earlier;
  const answer = fetchToken(context);
  reads.set(context.request, answer);
  return answer;
}

export async function readTokenInfo(context: ApiContext): Promise<TokenInfoResponse | null> {
  const result = await readTokenResult(context);
  return result.ok ? result.info : null;
}

const CACHE_MS = 60_000;
let cached: { at: number; info: TokenInfoResponse | null } | undefined;

/** For the layout footer: the last answer is kept 60 seconds. Never throws; null on a failure. */
export async function readTokenInfoCached(context: ApiContext): Promise<TokenInfoResponse | null> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.info;
  try {
    const info = await readTokenInfo(context);
    cached = { at: now, info };
    return info;
  } catch {
    return null;
  }
}
