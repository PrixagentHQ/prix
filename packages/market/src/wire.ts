/**
 * The wire format of the one batched read behind a snapshot. Pure: it builds calldata and decodes
 * the answer, and makes no request. `encodeSnapshotResult` is the inverse of `decodeSnapshotResult`,
 * so a test can answer a fake RPC without a network.
 *
 * One `eth_call` to Robinhood Chain's L2 Multicall carries, in this order:
 *   1. the multicall's own `getCurrentBlockTimestamp()`
 *   2. Multicall3's `getChainId()`, so an endpoint that answers for another chain is caught
 *   3. for every universe entry, in universe order:
 *      the feed's `latestRoundData()`, the feed's `decimals()`, and for a Stock Token only, the
 *      token's `oraclePaused()`. A crypto entry (docs/CONTRACTS.md section 21) has no token, so it has
 *      two calls, not three.
 * `tryBlockAndAggregate(false, calls)` also returns the chain's block number, so no second request is needed.
 */
import type { UniverseToken } from '@prix/contracts';
import { isStockToken } from '@prix/contracts';
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, type Hex, parseAbi } from 'viem';
import type { FeedRead } from './rules.ts';

/**
 * "L2 Multicall" on Robinhood Chain.
 * Source: https://docs.robinhood.com/chain/protocol-contracts, section "Misc", read 2026-10-06.
 * It is Arbitrum's Multicall2: its block number is the chain's own (ArbSys), not the L1 estimate
 * that `block.number` gives on an Arbitrum chain. Checked on chain 2026-10-06, see RESEARCH.md section 2.
 */
export const MULTICALL_ADDRESS = '0x2cac2d899ecc914d704feaae33ac1bf36277dad1';

/** `tryBlockAndAggregate` writes nothing; it is declared `view` here because it is only ever sent as an `eth_call`. */
export const multicallAbi = parseAbi([
  'struct Call { address target; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function tryBlockAndAggregate(bool requireSuccess, Call[] calls) view returns (uint256 blockNumber, bytes32 blockHash, Result[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getChainId() view returns (uint256 chainid)',
]);

/** Chainlink's AggregatorV3Interface, the part a snapshot reads. Read through the feed's proxy. */
export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

/** The Stock Token's flag for a feed frozen during a corporate action. */
export const stockTokenAbi = parseAbi(['function oraclePaused() view returns (bool)']);

/**
 * Multicall3. The L2 Multicall has no getChainId, so the chain ID is asked of Multicall3, as an inner call.
 * Source: https://github.com/mds1/multicall3 (README); Robinhood's docs do not list it. On chain 2026-10-06,
 * getChainId() returned 4663 (RESEARCH.md section 2). On a chain without it the inner call fails and the snapshot is refused.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const CALLS_BEFORE_TOKENS = 2;
const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`;

/** How many inner calls one universe entry makes: three for a Stock Token, two for a crypto asset. */
export function callsFor(token: UniverseToken): number {
  return isStockToken(token) ? 3 : 2;
}

/** The number of inner calls of the batched read for this universe. */
export function snapshotCallCount(universe: readonly UniverseToken[]): number {
  return universe.reduce((sum, token) => sum + callsFor(token), CALLS_BEFORE_TOKENS);
}

/** What the batched read returned, decoded. */
export interface SnapshotReads {
  blockNumber: bigint;
  /** The timestamp of the block the reads were made at, in Unix seconds. Null if that call failed. */
  blockTimestamp: bigint | null;
  /** The chain ID the endpoint reported, or null if that call failed. The caller must refuse anything but 4663. */
  chainId: bigint | null;
  /** One read per universe token, in universe order. */
  reads: FeedRead[];
}

/** The calldata of the one `eth_call`, to send to `MULTICALL_ADDRESS`. */
export function encodeSnapshotCall(universe: readonly UniverseToken[]): Hex {
  const latestRoundData = encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' });
  const decimals = encodeFunctionData({ abi: feedAbi, functionName: 'decimals' });
  const oraclePaused = encodeFunctionData({ abi: stockTokenAbi, functionName: 'oraclePaused' });
  const calls: { target: Hex; callData: Hex }[] = [
    {
      target: MULTICALL_ADDRESS,
      callData: encodeFunctionData({ abi: multicallAbi, functionName: 'getCurrentBlockTimestamp' }),
    },
    { target: MULTICALL3_ADDRESS, callData: encodeFunctionData({ abi: multicallAbi, functionName: 'getChainId' }) },
  ];
  for (const token of universe) {
    calls.push({ target: token.feedAddress as Hex, callData: latestRoundData });
    calls.push({ target: token.feedAddress as Hex, callData: decimals });
    if (isStockToken(token)) calls.push({ target: token.tokenAddress as Hex, callData: oraclePaused });
  }
  return encodeFunctionData({ abi: multicallAbi, functionName: 'tryBlockAndAggregate', args: [false, calls] });
}

interface CallResult {
  success: boolean;
  returnData: Hex;
}

/** Decodes one inner result, or returns null if the call failed, returned nothing or does not decode. */
function decodeInner<T>(result: CallResult | undefined, decode: (data: Hex) => T): T | null {
  if (result === undefined || !result.success || result.returnData === '0x') return null;
  try {
    return decode(result.returnData);
  } catch {
    return null;
  }
}

/**
 * Decodes the answer of the batched read. Throws if the outer answer is not a multicall result of the
 * expected length: the endpoint did not answer the question. An inner call that failed becomes `null`.
 */
export function decodeSnapshotResult(universe: readonly UniverseToken[], data: Hex): SnapshotReads {
  const [blockNumber, , results] = decodeFunctionResult({
    abi: multicallAbi,
    functionName: 'tryBlockAndAggregate',
    data,
  });
  const expected = snapshotCallCount(universe);
  if (results.length !== expected) {
    throw new Error(`Expected ${expected} results from the multicall, got ${results.length}.`);
  }
  const blockTimestamp = decodeInner(results[0], (raw) =>
    decodeFunctionResult({ abi: multicallAbi, functionName: 'getCurrentBlockTimestamp', data: raw }),
  );
  const chainId = decodeInner(results[1], (raw) =>
    decodeFunctionResult({ abi: multicallAbi, functionName: 'getChainId', data: raw }),
  );
  let base = CALLS_BEFORE_TOKENS;
  const reads = universe.map((token): FeedRead => {
    const read = readAt(results, base, isStockToken(token));
    base += callsFor(token);
    return read;
  });
  return { blockNumber, blockTimestamp, chainId, reads };
}

/**
 * The read of one universe entry whose calls start at `base`. A crypto entry has no pause call, and
 * its `oraclePaused` is null: the rules never read it for a crypto entry.
 */
function readAt(results: readonly CallResult[], base: number, stock: boolean): FeedRead {
  return {
    round: decodeInner(results[base], (raw) => {
      const [, answer, , updatedAt] = decodeFunctionResult({
        abi: feedAbi,
        functionName: 'latestRoundData',
        data: raw,
      });
      return { answer, updatedAt };
    }),
    decimals: decodeInner(results[base + 1], (raw) =>
      decodeFunctionResult({ abi: feedAbi, functionName: 'decimals', data: raw }),
    ),
    oraclePaused: stock
      ? decodeInner(results[base + 2], (raw) =>
          decodeFunctionResult({ abi: stockTokenAbi, functionName: 'oraclePaused', data: raw }),
        )
      : null,
  };
}

/**
 * The inverse of `decodeSnapshotResult`: the `eth_call` result a node would return for these reads.
 * For tests and offline checks only; nothing in the product calls it. `universe` gives each read its
 * layout: a crypto entry gets no pause answer, whatever its `oraclePaused` says.
 */
export function encodeSnapshotResult(universe: readonly UniverseToken[], input: SnapshotReads): Hex {
  const failed: CallResult = { success: false, returnData: '0x' };
  const results: CallResult[] = [
    input.blockTimestamp === null
      ? failed
      : {
          success: true,
          returnData: encodeFunctionResult({
            abi: multicallAbi,
            functionName: 'getCurrentBlockTimestamp',
            result: input.blockTimestamp,
          }),
        },
    input.chainId === null
      ? failed
      : {
          success: true,
          returnData: encodeFunctionResult({ abi: multicallAbi, functionName: 'getChainId', result: input.chainId }),
        },
  ];
  for (const [index, read] of input.reads.entries()) {
    const token = universe[index];
    const stock = token === undefined || isStockToken(token);
    results.push(
      read.round === null
        ? failed
        : {
            success: true,
            returnData: encodeFunctionResult({
              abi: feedAbi,
              functionName: 'latestRoundData',
              result: [1n, read.round.answer, read.round.updatedAt, read.round.updatedAt, 1n],
            }),
          },
    );
    results.push(
      read.decimals === null
        ? failed
        : {
            success: true,
            returnData: encodeFunctionResult({ abi: feedAbi, functionName: 'decimals', result: read.decimals }),
          },
    );
    if (!stock) continue;
    results.push(
      read.oraclePaused === null
        ? failed
        : {
            success: true,
            returnData: encodeFunctionResult({
              abi: stockTokenAbi,
              functionName: 'oraclePaused',
              result: read.oraclePaused,
            }),
          },
    );
  }
  return encodeFunctionResult({
    abi: multicallAbi,
    functionName: 'tryBlockAndAggregate',
    result: [input.blockNumber, ZERO_HASH, results],
  });
}
