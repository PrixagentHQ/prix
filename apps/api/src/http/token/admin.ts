import type { ApiDeps, SessionRecord, TokenApiDeps, TokenConfigResponse, TokenProbeResponse } from '@prix/contracts';
import { TokenReadError, tokenConfigInputSchema, tokenProbeQuerySchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { ApiFailure, failures, json } from '../errors.ts';
import { enforceLimit, requireSession, requireWriter } from '../guard.ts';
import { readInput, readQuery } from '../input.ts';

const CHAIN_DOWN = 'The chain could not be read. Try again.';

/** The admin routes of the token. An admin is a wallet of the server's own set, checked every time. */
export function registerTokenAdminRoutes(
  app: Hono,
  deps: ApiDeps & { token: TokenApiDeps },
  admins: ReadonlySet<string> = new Set(),
): void {
  const { service } = deps.token;

  function requireAdmin(session: SessionRecord): SessionRecord {
    if (!admins.has(session.address)) throw failures.notAdmin();
    return session;
  }

  app.get('/admin/token/config', async (c) => {
    requireAdmin(await requireSession(deps, c.req.raw));
    return json<TokenConfigResponse>({ config: await service.getConfig() }, 200, 'private');
  });

  app.put('/admin/token/config', async (c) => {
    // Admin is checked before the body is read, so a non-admin learns nothing about its shape.
    const session = requireAdmin(await requireWriter(deps, c.req.raw, 2));
    const input = await readInput(tokenConfigInputSchema, c.req.raw);
    const result = await service.saveConfig(input, session.address);
    if (!result.ok) {
      if (result.reason === 'chain_unavailable') throw new ApiFailure('internal', CHAIN_DOWN);
      if (result.reason === 'address_locked') {
        throw failures.invalidInput('The token is fixed once gating has been on.', 'tokenAddress');
      }
      if (result.reason === 'thresholds_locked') {
        throw failures.invalidInput(
          'Gating has been on, so a threshold can only be lowered. Lower it, or leave it as it is.',
          'thresholdsPpm',
        );
      }
      throw failures.invalidInput(
        'This address is not a usable token on Robinhood Chain. Check the address and try again.',
        'tokenAddress',
      );
    }
    console.log(JSON.stringify({ event: 'admin_action', admin: session.address, action: 'token_config', target: '1' }));
    return json<TokenConfigResponse>({ config: result.config }, 200, 'private');
  });

  app.get('/admin/token/probe', async (c) => {
    const session = requireAdmin(await requireSession(deps, c.req.raw));
    // A probe reads the chain, so it is counted per admin wallet as well as per address.
    await enforceLimit(deps, 'write', session.address);
    const { wallet } = readQuery(tokenProbeQuerySchema, c.req.url);
    if ((await service.getConfig()).tokenAddress === null) {
      throw failures.invalidInput('No token is configured yet. Save the token address first.', null);
    }
    try {
      return json<TokenProbeResponse>(await service.probe(wallet), 200, 'private');
    } catch (error) {
      if (error instanceof TokenReadError) throw new ApiFailure('internal', CHAIN_DOWN);
      throw error;
    }
  });
}
