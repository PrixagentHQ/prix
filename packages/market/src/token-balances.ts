/**
 * Reads a token's supply and holder balances from Robinhood Chain: one `eth_call` per endpoint tried.
 * No redirect is followed (`./redirect.ts`): an endpoint that answers with one failed.
 * The token address always comes from the configuration row, never from a request.
 */
import {
  type Address,
  TOKEN_SWEEP_BATCH,
  type TokenBalances,
  type TokenChainReader,
  TokenReadError,
} from '@prix/contracts';
import { createPublicClient, http } from 'viem';
import { readWithAgreement } from './agreement.ts';
import { withoutRedirects } from './redirect.ts';
import { decodeTokenResult, decodeTokenResultLean, encodeTokenCall, encodeTokenCallLean } from './token-wire.ts';
import { MULTICALL_ADDRESS } from './wire.ts';

export const TOKEN_RPC_TIMEOUT_MS = 8_000;

/** A block older than this is a stale answer: the same limit as the Phase 1 snapshot. */
const MAX_BLOCK_AGE_SECONDS = 300n;

/** Internal: an endpoint that did not answer usefully, so the next one is tried. */
class Retryable extends Error {}

export function createTokenChainReader(rpcUrls: readonly string[], fetchFn?: typeof fetch): TokenChainReader {
  return {
    async readBalances(token, wallets, atBlock): Promise<TokenBalances> {
      // Above TOKEN_SWEEP_BATCH wallets (the holders' tally reads 400 at once) the call is written and read by
      // hand: viem's ABI coder took 15.55 ms for 400 wallets (docs/contracts/phase-6-holders.md section 5, HB-1).
      const lean = wallets.length > TOKEN_SWEEP_BATCH;
      const callData = lean ? encodeTokenCallLean(token, wallets) : encodeTokenCall(token, wallets);
      const decode = lean ? decodeTokenResultLean : decodeTokenResult;
      // The holders' tally reads every page of a run at one block (section 5, H-SEC-3): the block is sent as the
      // tag of each endpoint's eth_call, so both endpoints of the agreement read the same block. Absent: latest.
      const blockNumber = atBlock === undefined ? undefined : BigInt(atBlock);
      // A balance grants a tier: a third-party fallback is believed only when a second independent
      // endpoint agrees (`readWithAgreement`, docs/CONTRACTS.md section 20, D-110 finding 4).
      const agreed = await readWithAgreement(
        rpcUrls,
        (url) => readFrom(url, wallets, callData, decode, blockNumber, fetchFn),
        {
          // A transport failure or stale block: try the next endpoint. The message is dropped, it can hold a key.
          movesOn: (error) => !(error instanceof TokenReadError),
          agree: sameBalances,
        },
      );
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
  decode: typeof decodeTokenResult,
  blockNumber: bigint | undefined,
  fetchFn?: typeof fetch,
): Promise<TokenBalances> {
  // viem reads the body of an answer before it looks at the status, so the redirect is refused in
  // the `fetch` it is given: one request, nothing followed, and a failure that tries the next endpoint.
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: TOKEN_RPC_TIMEOUT_MS, fetchFn: withoutRedirects(fetchFn) }),
  });
  const { data } = await client.call(
    blockNumber === undefined
      ? { to: MULTICALL_ADDRESS, data: callData }
      : { to: MULTICALL_ADDRESS, data: callData, blockNumber },
  );
  if (data === undefined) throw new Retryable();

  let reads: ReturnType<typeof decodeTokenResult>;
  try {
    reads = decode(wallets, data);
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
