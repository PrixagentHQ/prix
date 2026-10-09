/**
 * Reads a token's supply and holder balances from Robinhood Chain: one `eth_call` per endpoint tried.
 * The token address always comes from the configuration row, never from a request.
 */
import { type Address, type TokenBalances, type TokenChainReader, TokenReadError } from '@prix/contracts';
import { createPublicClient, http } from 'viem';
import { readWithAgreement } from './agreement.ts';
import { decodeTokenResult, encodeTokenCall } from './token-wire.ts';
import { MULTICALL_ADDRESS } from './wire.ts';

export const TOKEN_RPC_TIMEOUT_MS = 8_000;

/** A block older than this is a stale answer: the same limit as the Phase 1 snapshot. */
const MAX_BLOCK_AGE_SECONDS = 300n;

/** Internal: an endpoint that did not answer usefully, so the next one is tried. */
class Retryable extends Error {}

export function createTokenChainReader(rpcUrls: readonly string[], fetchFn?: typeof fetch): TokenChainReader {
  return {
    async readBalances(token, wallets): Promise<TokenBalances> {
      const callData = encodeTokenCall(token, wallets);
      // A balance grants a tier: a third-party fallback is believed only when a second independent
      // endpoint agrees (`readWithAgreement`, docs/CONTRACTS.md section 20, D-110 finding 4).
      const agreed = await readWithAgreement(rpcUrls, (url) => readFrom(url, wallets, callData, fetchFn), {
        // A transport failure or stale block: try the next endpoint. The message is dropped, it can hold a key.
        movesOn: (error) => !(error instanceof TokenReadError),
        agree: sameBalances,
      });
      if (agreed.ok) return agreed.value;
      if (agreed.reason === 'refused' && agreed.error instanceof TokenReadError) throw agreed.error;
      throw new TokenReadError('rpc_unavailable');
    },
  };
}

/**
 * Two reads agree when supply, decimals and every balance are equal. The block number may differ
 * by the head of each node. Pure.
 */
export function sameBalances(a: TokenBalances, b: TokenBalances): boolean {
  return (
    a.totalSupply === b.totalSupply &&
    a.decimals === b.decimals &&
    a.balances.length === b.balances.length &&
    a.balances.every((balance, index) => balance === b.balances[index])
  );
}

async function readFrom(
  rpcUrl: string,
  wallets: readonly Address[],
  callData: `0x${string}`,
  fetchFn?: typeof fetch,
): Promise<TokenBalances> {
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: TOKEN_RPC_TIMEOUT_MS, ...(fetchFn ? { fetchFn } : {}) }),
  });
  const { data } = await client.call({ to: MULTICALL_ADDRESS, data: callData });
  if (data === undefined) throw new Retryable();

  let reads: ReturnType<typeof decodeTokenResult>;
  try {
    reads = decodeTokenResult(wallets, data);
  } catch {
    // Not a multicall answer: invalid data, so no fall through to the next endpoint.
    throw new TokenReadError('rpc_unavailable');
  }
  if (reads.blockTimestamp === null) throw new Retryable();
  if (BigInt(Math.floor(Date.now() / 1000)) - reads.blockTimestamp > MAX_BLOCK_AGE_SECONDS) throw new Retryable();

  if (reads.totalSupply === null || reads.decimals === null || reads.totalSupply === 0n) {
    throw new TokenReadError('invalid_token');
  }
  const balances: bigint[] = [];
  for (const balance of reads.balances) {
    if (balance === null || balance > reads.totalSupply) throw new TokenReadError('invalid_answer');
    balances.push(balance);
  }
  return { totalSupply: reads.totalSupply, decimals: reads.decimals, balances, blockNumber: reads.blockNumber };
}
