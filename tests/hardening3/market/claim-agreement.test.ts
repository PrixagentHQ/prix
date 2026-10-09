import { describe, expect, it } from 'vitest';
import { createClaimVerifier } from '../../../apps/api/src/http/reputation/verify-claim.ts';
import { DRPC, down, Endpoints, type Handler, KEYED, OFFICIAL, PUBLICNODE } from './support.ts';

/**
 * A contract-wallet claim grants a listing, so a third-party fallback endpoint that says the
 * signature is valid is believed only when a second independent endpoint says the same
 * (D-110 finding 4). The keyed RPC_URL and the official endpoint are trusted alone.
 */

const WALLET = '0x00000000000000000000000000000000000000c1';
/** Not an ECDSA signature, so the verifier asks the chain. */
const SIGNATURE = '0x1234';
const MAGIC = `0x1626ba7e${'0'.repeat(56)}`;

const contract: Handler = (method) =>
  method === 'eth_getCode' ? { result: '0x6080' } : method === 'eth_call' ? { result: MAGIC } : { result: null };
const noCode: Handler = (method) => (method === 'eth_getCode' ? { result: '0x' } : { result: null });
const rejects: Handler = (method) =>
  method === 'eth_getCode' ? { result: '0x6080' } : { result: `0xffffffff${'0'.repeat(56)}` };

const verify = (e: Endpoints, rpcUrls: string[]) =>
  createClaimVerifier({ contractWallets: true, rpcUrls, fetch: e.fetch }).verify({
    wallet: WALLET,
    message: 'claim',
    signature: SIGNATURE,
  });

describe('the claim check and third-party endpoints', () => {
  it('trusts the keyed endpoint alone', async () => {
    const e = new Endpoints().on(KEYED, contract);
    expect(await verify(e, [KEYED, OFFICIAL, PUBLICNODE, DRPC])).toBe('contract');
    expect(e.methods(OFFICIAL)).toEqual([]);
  });

  it('trusts the official endpoint alone', async () => {
    const e = new Endpoints().on(OFFICIAL, contract);
    expect(await verify(e, [OFFICIAL, PUBLICNODE, DRPC])).toBe('contract');
    expect(e.methods(PUBLICNODE)).toEqual([]);
  });

  it('accepts a third party when a second independent endpoint agrees', async () => {
    const e = new Endpoints().on(OFFICIAL, down).on(PUBLICNODE, contract).on(DRPC, contract);
    expect(await verify(e, [OFFICIAL, PUBLICNODE, DRPC])).toBe('contract');
    expect(e.methods(DRPC)).toEqual(['eth_getCode', 'eth_call']);
  });

  it('refuses when the second endpoint finds no contract', async () => {
    const e = new Endpoints().on(OFFICIAL, down).on(PUBLICNODE, contract).on(DRPC, noCode);
    expect(await verify(e, [OFFICIAL, PUBLICNODE, DRPC])).toBeNull();
  });

  it('refuses when the second endpoint says the signature is not valid', async () => {
    const e = new Endpoints().on(OFFICIAL, down).on(PUBLICNODE, contract).on(DRPC, rejects);
    expect(await verify(e, [OFFICIAL, PUBLICNODE, DRPC])).toBeNull();
  });

  it('refuses when no second endpoint answers', async () => {
    const e = new Endpoints().on(OFFICIAL, down).on(PUBLICNODE, contract).on(DRPC, down);
    expect(await verify(e, [OFFICIAL, PUBLICNODE, DRPC])).toBeNull();
  });

  it('refuses when a third party is the only endpoint', async () => {
    const e = new Endpoints().on(DRPC, contract);
    expect(await verify(e, [DRPC])).toBeNull();
  });
});
