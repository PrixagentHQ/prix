import type { ReputationApiDeps, ReputationStore } from '@prix/contracts';
import { openPreviewEntitlements } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import type { Api } from '../support/api.ts';
import { ADMIN_WALLET, HOUSE_MODEL, NONCE_SECRET, SITE_ORIGIN } from '../support/api.ts';

/**
 * A `ReputationStore` of which a test implements only the methods it needs. Any other call fails
 * the test loudly, so a route that reaches for something unexpected is noticed.
 */
export function stubReputation(methods: Partial<Record<keyof ReputationStore, unknown>>): ReputationStore {
  return new Proxy(methods as object, {
    get(target, name) {
      const found = (target as Record<string | symbol, unknown>)[name];
      if (found !== undefined) return found;
      return () => {
        throw new Error(`the stub reputation store has no ${String(name)}`);
      };
    },
  }) as ReputationStore;
}

/** The deps of `createReputationApp`, on top of the Phase 1 test API (sessions, clock, limiter). */
export function reputationDeps(
  api: Api,
  parts: Pick<ReputationApiDeps, 'reputation' | 'verifier'> & Partial<ReputationApiDeps>,
): ReputationApiDeps {
  return {
    store: api.store,
    sim,
    scoring,
    sealer: api.vault.sealer,
    rateLimiter: api.limiter,
    config: {
      siteOrigin: SITE_ORIGIN,
      adminAddresses: [ADMIN_WALLET.address],
      houseModel: HOUSE_MODEL,
      nonceSecret: NONCE_SECRET,
    },
    now: () => api.now(),
    entitlements: openPreviewEntitlements,
    guard: {
      reserve: async () => ({ keys: [] }),
      release: async () => {},
    },
    chainId: 4663,
    ...parts,
  };
}
