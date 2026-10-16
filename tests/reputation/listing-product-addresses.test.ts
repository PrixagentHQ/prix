import { isStockToken, SESSION_COOKIE } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import { describe, expect, it } from 'vitest';
import { createClaimVerifier, createReputationApp } from '../../apps/api/src/http/reputation/index.ts';
import { createApi, SITE_ORIGIN } from '../support/api.ts';
import { testWallet } from '../support/eth.ts';
import { ARBITRUM_FEEDS } from '../support/fake-arbitrum.ts';
import { reputationDeps, stubReputation } from './support.ts';

/**
 * The addresses of the product itself are never listed (docs/CONTRACTS.md section 21): the zero
 * address, every Stock Token, and every feed of the universe, crypto feeds included. A crypto asset
 * has no token on the chain, but its feed proxy is still Prix's own reference and not an agent wallet.
 */

const PRODUCT_REFUSAL = /belongs to Prix itself/;

async function harness() {
  const api = createApi();
  const reputation = stubReputation({
    getListingByWallet: async () => null,
    nameKeyTaken: async () => false,
    takeCounter: async () => true,
    getListing: async () => null,
    getListedAgent: async () => null,
    listListingsByClaimant: async () => [],
  });
  const app = createReputationApp(
    reputationDeps(api, {
      reputation,
      verifier: createClaimVerifier({ contractWallets: false, rpcUrls: ['http://127.0.0.1:9'] }),
    }),
  );
  const wallet = testWallet(1);
  const client = await api.signedIn(wallet);
  const cookie = client.cookie as string;
  return async (address: string) => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Origin: SITE_ORIGIN,
      'CF-Connecting-IP': '203.0.113.78',
      Cookie: `${SESSION_COOKIE}=${cookie}`,
    });
    const response = await app.fetch(
      new Request(`${SITE_ORIGIN}/api/reputation/listings/claim-message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ wallet: address, name: 'Feed Wallet' }),
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks fields of it
    return { status: response.status, json: (await response.json()) as any };
  };
}

const CRYPTO = UNIVERSE.filter((entry) => !isStockToken(entry));
const STOCKS = UNIVERSE.filter(isStockToken);

describe('the addresses of the product cannot be listed', () => {
  it('the universe has the crypto assets this test covers', () => {
    expect(CRYPTO.map((entry) => entry.symbol).sort()).toEqual(['BNB', 'BTC', 'ETH', 'HYPE', 'SOL']);
  });

  // Section 23, rule 12: the three Arbitrum One feeds too, by the addresses the contract gives,
  // whatever the universe holds.
  for (const [symbol, feed] of Object.entries(ARBITRUM_FEEDS)) {
    it(`the ${symbol} feed proxy on Arbitrum One (section 23)`, async () => {
      const claimMessage = await harness();
      const reply = await claimMessage(feed);
      expect(reply.status, JSON.stringify(reply.json)).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
      expect(reply.json.error.field).toBe('wallet');
      expect(reply.json.error.message).toMatch(PRODUCT_REFUSAL);
    });
  }

  for (const asset of CRYPTO) {
    it(`the ${asset.symbol} feed proxy`, async () => {
      const claimMessage = await harness();
      const reply = await claimMessage(asset.feedAddress.toLowerCase());
      expect(reply.status, JSON.stringify(reply.json)).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
      expect(reply.json.error.field).toBe('wallet');
      expect(reply.json.error.message).toMatch(PRODUCT_REFUSAL);
    });
  }

  it('every Stock Token, every Stock Token feed and the zero address', async () => {
    const claimMessage = await harness();
    const addresses = [`0x${'0'.repeat(40)}`, ...STOCKS.flatMap((token) => [token.tokenAddress, token.feedAddress])];
    for (const address of addresses) {
      const reply = await claimMessage(address);
      expect(reply.status, address).toBe(400);
      expect(reply.json.error.message, address).toMatch(PRODUCT_REFUSAL);
    }
  });

  it('an ordinary wallet is still given a claim message', async () => {
    const claimMessage = await harness();
    const reply = await claimMessage(testWallet(2).address);
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  });
});
