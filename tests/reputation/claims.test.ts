import type { ApiApp, ListingRecord } from '@prix/contracts';
import {
  agentNameKey,
  buildClaimMessage,
  CHAIN_ID,
  CHAIN_METHOD,
  CLAIM_TTL_SECONDS,
  SESSION_COOKIE,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createClaimVerifier, createReputationApp } from '../../apps/api/src/http/reputation/index.ts';
import type { Api } from '../support/api.ts';
import { createApi, SITE_ORIGIN } from '../support/api.ts';
import { testWallet } from '../support/eth.ts';
import { reputationDeps, stubReputation } from './support.ts';
import type { TestAccount } from './viem.ts';
import { newWallet } from './viem.ts';

/**
 * Acceptance line 3 of docs/SPEC.md section 9: a forged listing claim is refused. A signature from
 * another key, a changed name, another claimant, an expired nonce and a reused nonce are all
 * refused; the correct claim is accepted. Real viem wallets sign; the verifier is the real one with
 * contract wallets off, so no network is ever asked.
 */

const NAME = 'Alpha Wallet';

interface Harness {
  api: Api;
  app: ApiApp;
  listings: Map<string, ListingRecord>;
  /** A cookie for a signed-in Prix account. */
  signIn(n: number): Promise<{ cookie: string; address: string }>;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks fields of it
  post(path: string, body: unknown, cookie: string | null, ip?: string): Promise<{ status: number; json: any }>;
}

function harness(): Harness {
  const api = createApi();
  const listings = new Map<string, ListingRecord>();
  const reputation = stubReputation({
    getListingByWallet: async (wallet: string) =>
      [...listings.values()].find((l) => l.wallet.toLowerCase() === wallet.toLowerCase()) ?? null,
    nameKeyTaken: async (key: string) => [...listings.values()].some((l) => l.nameKey === key),
    takeCounter: async () => true,
    createListing: async (listing: ListingRecord) => {
      if ([...listings.values()].some((l) => l.wallet.toLowerCase() === listing.wallet.toLowerCase())) {
        return 'wallet_listed';
      }
      listings.set(listing.id, listing);
      return 'created';
    },
    getListing: async (id: string) => listings.get(id) ?? null,
    getListedAgent: async () => null,
    listListingsByClaimant: async (claimant: string) => [...listings.values()].filter((l) => l.claimant === claimant),
  });
  const app = createReputationApp(
    reputationDeps(api, {
      reputation,
      verifier: createClaimVerifier({ contractWallets: false, rpcUrls: ['http://127.0.0.1:9'] }),
    }),
  );
  return {
    api,
    app,
    listings,
    async signIn(n) {
      const wallet = testWallet(n);
      const client = await api.signedIn(wallet);
      return { cookie: client.cookie as string, address: wallet.address };
    },
    async post(path, body, cookie, ip = '203.0.113.77') {
      const headers = new Headers({ 'Content-Type': 'application/json', Origin: SITE_ORIGIN, 'CF-Connecting-IP': ip });
      if (cookie !== null) headers.set('Cookie', `${SESSION_COOKIE}=${cookie}`);
      const response = await app.fetch(
        new Request(`${SITE_ORIGIN}/api/reputation${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
      );
      const text = await response.text();
      return { status: response.status, json: text.length > 0 ? JSON.parse(text) : null };
    },
  };
}

interface Issued {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

async function issue(h: Harness, cookie: string, wallet: string, name = NAME): Promise<Issued> {
  const reply = await h.post('/listings/claim-message', { wallet, name }, cookie);
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return reply.json as Issued;
}

function submitBody(wallet: string, issued: Issued, signature: string, name = NAME) {
  return { wallet, name, nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, signature };
}

/** The wallet signs, the claimant submits. */
async function claim(h: Harness, cookie: string, agent: TestAccount, signer: TestAccount = agent) {
  const issued = await issue(h, cookie, agent.address);
  const signature = await signer.signMessage({ message: issued.message });
  return { issued, signature, reply: await h.post('/listings', submitBody(agent.address, issued, signature), cookie) };
}

describe('the claim message', () => {
  it('is written by the server, from its own fields, in the one layout of the contract', async () => {
    const h = harness();
    const { cookie, address } = await h.signIn(1);
    const agent = newWallet();
    const issued = await issue(h, cookie, agent.address);
    expect(issued.message).toBe(
      buildClaimMessage({
        wallet: agent.address as `0x${string}`,
        name: NAME,
        claimant: address as `0x${string}`,
        nonce: issued.nonce,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
        chainId: CHAIN_ID,
      }),
    );
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt)).toBe(CLAIM_TTL_SECONDS * 1000);
  });
});

describe('a correct claim', () => {
  it('is accepted, stored with its signature, and listed as estimated', async () => {
    const h = harness();
    const { cookie, address } = await h.signIn(1);
    const agent = newWallet();
    const { reply, signature, issued } = await claim(h, cookie, agent);
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);
    expect(reply.json.listing.recordMethod).toBe(CHAIN_METHOD);
    expect(reply.json.listing.estimated).toBe(true);
    expect(h.listings.size).toBe(1);
    const stored = [...h.listings.values()][0] as ListingRecord;
    expect(stored.wallet).toBe(agent.address);
    expect(stored.claimant).toBe(address);
    expect(stored.signature).toBe(signature);
    expect(stored.signatureKind).toBe('eoa');
    expect(stored.message).toBe(issued.message);
    expect(stored.nameKey).toBe(agentNameKey(NAME));
  });

  it('is accepted up to the last second before it expires', async () => {
    const h = harness();
    const { cookie } = await h.signIn(1);
    const agent = newWallet();
    const issued = await issue(h, cookie, agent.address);
    const signature = await agent.signMessage({ message: issued.message });
    h.api.advance((CLAIM_TTL_SECONDS - 1) * 1000);
    expect((await h.post('/listings', submitBody(agent.address, issued, signature), cookie)).status).toBe(201);
  });
});

describe('a forged claim is refused and nothing is stored', () => {
  it('a signature from another key', async () => {
    const h = harness();
    const { cookie } = await h.signIn(1);
    const agent = newWallet();
    const thief = newWallet();
    const { reply } = await claim(h, cookie, agent, thief);
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe('unauthorized');
    expect(h.listings.size).toBe(0);
  });

  it('a signature over a message that is not the server message', async () => {
    const h = harness();
    const { cookie, address } = await h.signIn(1);
    const agent = newWallet();
    const issued = await issue(h, cookie, agent.address);
    // The wallet signed the same claim for another chain: the server rebuilds its own text.
    const other = buildClaimMessage({
      wallet: agent.address as `0x${string}`,
      name: NAME,
      claimant: address as `0x${string}`,
      nonce: issued.nonce,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      chainId: 1,
    });
    const signature = await agent.signMessage({ message: other });
    expect((await h.post('/listings', submitBody(agent.address, issued, signature), cookie)).status).toBe(401);
    expect(h.listings.size).toBe(0);
  });

  it('a changed name', async () => {
    const h = harness();
    const { cookie, address } = await h.signIn(1);
    const agent = newWallet();
    const issued = await issue(h, cookie, agent.address);
    // The wallet signs a message for the new name, built exactly as the server would.
    const message = buildClaimMessage({
      wallet: agent.address as `0x${string}`,
      name: 'Beta Wallet',
      claimant: address as `0x${string}`,
      nonce: issued.nonce,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      chainId: CHAIN_ID,
    });
    const signature = await agent.signMessage({ message });
    const reply = await h.post('/listings', submitBody(agent.address, issued, signature, 'Beta Wallet'), cookie);
    expect(reply.status).toBe(400);
    expect(reply.json.error.field).toBe('nonce');
    expect(h.listings.size).toBe(0);
  });

  it('a changed wallet', async () => {
    const h = harness();
    const { cookie } = await h.signIn(1);
    const agent = newWallet();
    const other = newWallet();
    const issued = await issue(h, cookie, agent.address);
    const signature = await other.signMessage({ message: issued.message });
    const reply = await h.post('/listings', submitBody(other.address, issued, signature), cookie);
    expect(reply.status).toBe(400);
    expect(h.listings.size).toBe(0);
  });

  it('another claimant: the claim of one account cannot be submitted by another', async () => {
    const h = harness();
    const first = await h.signIn(1);
    const second = await h.signIn(2);
    const agent = newWallet();
    const issued = await issue(h, first.cookie, agent.address);
    const signature = await agent.signMessage({ message: issued.message });
    const reply = await h.post('/listings', submitBody(agent.address, issued, signature), second.cookie);
    expect(reply.status).toBe(400);
    expect(reply.json.error.field).toBe('nonce');
    expect(h.listings.size).toBe(0);
  });

  it('a nonce the server did not issue', async () => {
    const h = harness();
    const { cookie } = await h.signIn(1);
    const agent = newWallet();
    const issued = await issue(h, cookie, agent.address);
    const forged = { ...issued, nonce: `${'A'.repeat(24)}.${'0'.repeat(32)}` };
    const signature = await agent.signMessage({ message: issued.message });
    const reply = await h.post('/listings', submitBody(agent.address, forged, signature), cookie);
    expect(reply.status).toBe(400);
    expect(h.listings.size).toBe(0);
  });

  it('an expired claim', async () => {
    const h = harness();
    const { cookie } = await h.signIn(1);
    const agent = newWallet();
    const issued = await issue(h, cookie, agent.address);
    const signature = await agent.signMessage({ message: issued.message });
    h.api.advance(CLAIM_TTL_SECONDS * 1000 + 1_000);
    const reply = await h.post('/listings', submitBody(agent.address, issued, signature), cookie);
    expect(reply.status).toBe(400);
    expect(reply.json.error.field).toBe('expiresAt');
    expect(h.listings.size).toBe(0);
  });

  it('a claim with a longer validity than the server gives', async () => {
    const h = harness();
    const { cookie } = await h.signIn(1);
    const agent = newWallet();
    const issued = await issue(h, cookie, agent.address);
    const longer = { ...issued, expiresAt: new Date(Date.parse(issued.expiresAt) + 86_400_000).toISOString() };
    const signature = await agent.signMessage({ message: issued.message });
    const reply = await h.post('/listings', submitBody(agent.address, longer, signature), cookie);
    expect(reply.status).toBe(400);
    expect(h.listings.size).toBe(0);
  });

  it('a reused claim: the second submission of the same signed claim', async () => {
    const h = harness();
    const { cookie } = await h.signIn(1);
    const agent = newWallet();
    const { issued, signature, reply } = await claim(h, cookie, agent);
    expect(reply.status).toBe(201);
    const again = await h.post('/listings', submitBody(agent.address, issued, signature), cookie);
    expect(again.status).toBe(409);
    expect(again.json.error.field).toBe('wallet');
    expect(h.listings.size).toBe(1);
  });

  it('a signed-out visitor', async () => {
    const h = harness();
    const agent = newWallet();
    const reply = await h.post(
      '/listings',
      submitBody(
        agent.address,
        { message: '', nonce: `${'A'.repeat(24)}.${'0'.repeat(32)}`, issuedAt: '', expiresAt: '' },
        `0x${'1'.repeat(130)}`,
      ),
      null,
    );
    expect(reply.status).toBe(401);
    expect(h.listings.size).toBe(0);
  });
});
