/**
 * The wire format of the batched reads behind a snapshot: one for Robinhood Chain, one for Arbitrum
 * One (docs/CONTRACTS.md section 23). Pure: it builds calldata and decodes the answer, and makes no
 * request. `encodeSnapshotResult` is the inverse of `decodeSnapshotResult` and `encodeArbitrumResult`
 * of `decodeArbitrumResult`, so a test can answer a fake RPC without a network. The one thing it
 * remembers is the calldata it last encoded for each chain (`snapshotCalldata`, `arbitrumCalldata`),
 * which changes how often the encoding is done and never what comes out.
 *
 * One `eth_call` to Robinhood Chain's L2 Multicall carries, in this order:
 *   1. the multicall's own `getCurrentBlockTimestamp()`
 *   2. Multicall3's `getChainId()`, so an endpoint that answers for another chain is caught
 *   3. for every universe entry whose feed is on Robinhood Chain (`feedChainOf`), in universe order:
 *      the feed's `latestRoundData()`, the feed's `decimals()`, and for a Stock Token only, the
 *      token's `oraclePaused()`. A crypto entry (docs/CONTRACTS.md section 21) has no token, so it has
 *      two calls, not three. An entry whose feed is on another chain has none here.
 * `tryBlockAndAggregate(false, calls)` also returns the chain's block number, so no second request is needed.
 *
 * The Arbitrum read is described at `encodeArbitrumCall`.
 */
import type { UniverseToken } from '@prix/contracts';
import { ARBITRUM_CHAIN_ID, CHAIN_ID, feedChainOf, isStockToken } from '@prix/contracts';
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

/**
 * How many inner calls one universe entry makes in the Robinhood read: three for a Stock Token, two
 * for a crypto asset with its feed on Robinhood Chain, none for an entry whose feed is on another chain.
 */
export function callsFor(token: UniverseToken): number {
  if (feedChainOf(token) !== CHAIN_ID) return 0;
  return isStockToken(token) ? 3 : 2;
}

/** A read that was not made: an entry of the other chain, or a call that failed. */
const NOT_READ: FeedRead = { round: null, decimals: null, oraclePaused: null };

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
  /**
   * One read per universe token, in universe order. An entry whose feed is on another chain is not
   * part of this read: its read is all null and nothing uses it.
   */
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
    if (feedChainOf(token) !== CHAIN_ID) continue;
    calls.push({ target: token.feedAddress as Hex, callData: latestRoundData });
    calls.push({ target: token.feedAddress as Hex, callData: decimals });
    if (isStockToken(token)) calls.push({ target: token.tokenAddress as Hex, callData: oraclePaused });
  }
  return encodeFunctionData({ abi: multicallAbi, functionName: 'tryBlockAndAggregate', args: [false, calls] });
}

/** A read's calldata, kept with everything of the question that went into it. */
interface KeptCalldata {
  key: string;
  data: Hex;
}

let keptSnapshotCall: KeptCalldata | null = null;

/**
 * `encodeSnapshotCall(universe)`, the same bytes, encoded once and kept: every request of a universe
 * carries the same calldata, and encoding it for each cost 0.70 ms of an alarm's 10 ms of CPU, eight
 * times in the worst step (tools/perf/stage2-tick.mjs, 2026-10-09). The calldata last encoded is kept
 * with what it was encoded from: for every entry, whether it is read on Robinhood Chain, its feed
 * address, and for a Stock Token its token address. It is returned only while the universe given
 * still says exactly that, so a universe with other content, or the same array changed in place, is
 * encoded again. Throws what `encodeSnapshotCall` throws, and then keeps nothing.
 */
export function snapshotCalldata(universe: readonly UniverseToken[]): Hex {
  const key = JSON.stringify(
    universe.map((token) => {
      if (feedChainOf(token) !== CHAIN_ID) return null;
      return isStockToken(token) ? [token.feedAddress, token.tokenAddress] : [token.feedAddress];
    }),
  );
  if (keptSnapshotCall !== null && keptSnapshotCall.key === key) return keptSnapshotCall.data;
  const data = encodeSnapshotCall(universe);
  keptSnapshotCall = { key, data };
  return data;
}

interface CallResult {
  success: boolean;
  returnData: Hex;
}

const WORD_BYTES = 32;
const WORD_HEX = 2 * WORD_BYTES;
/** `latestRoundData()` returns five words. Every other call of the two reads returns one. */
const ROUND_BYTES = 5 * WORD_BYTES;
/** In a `tryBlockAndAggregate` answer the result array starts after three head words: block number, block hash, its own offset. */
const RESULTS_OFFSET = 3 * WORD_BYTES;
/** One result around its return data: the success flag, the offset of the bytes, their length. */
const RESULT_OVERHEAD_BYTES = 3 * WORD_BYTES;

/**
 * How many times its honest size an answer may have. The honest size is that of an answer whose inner
 * calls all succeeded. A failed call carries its revert data instead, which may be longer than the
 * answer it replaces: twice the honest size still holds an answer in which every inner call reverted
 * with a reason of one word (`Error(string)`, 128 bytes padded).
 */
export const RESULT_SIZE_HEADROOM = 2;

/**
 * The bytes of a `tryBlockAndAggregate` answer of `calls` results carrying `dataBytes` of return data
 * in all, each a whole number of words: the three head words, the array length, one offset per result,
 * then the results.
 */
function multicallResultBytes(calls: number, dataBytes: number): number {
  return RESULTS_OFFSET + WORD_BYTES + calls * (WORD_BYTES + RESULT_OVERHEAD_BYTES) + dataBytes;
}

/**
 * The most bytes the Robinhood read's `eth_call` result may have for this universe:
 * `RESULT_SIZE_HEADROOM` times the answer in which every inner call succeeded (13,504 bytes for the 25
 * entries of 2026-10-09, so 27,008). Pure.
 */
export function snapshotResultMaxBytes(universe: readonly UniverseToken[]): number {
  const dataBytes = universe.reduce(
    (sum, token) =>
      feedChainOf(token) !== CHAIN_ID ? sum : sum + ROUND_BYTES + WORD_BYTES + (isStockToken(token) ? WORD_BYTES : 0),
    CALLS_BEFORE_TOKENS * WORD_BYTES,
  );
  return RESULT_SIZE_HEADROOM * multicallResultBytes(snapshotCallCount(universe), dataBytes);
}

/** Why an `eth_call` result cannot be the answer of a batched read; `multicallResultProblem` says which. */
export type MulticallResultProblem = 'too_long' | 'wrong_layout' | 'wrong_count' | 'aliased';

/**
 * The word at `byteOffset` of an ABI answer, as a number. Null when the answer does not hold that
 * word, when it is not hex, or when it is 2^32 or more: no offset, count or length of these answers
 * comes near that.
 */
function smallWordAt(data: string, byteOffset: number): number | null {
  const start = 2 + 2 * byteOffset;
  const end = start + WORD_HEX;
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || end > data.length) return null;
  for (let index = start; index < end - 8; index++) {
    if (data.charCodeAt(index) !== 48) return null;
  }
  const low = data.slice(end - 8, end);
  return /^[0-9a-fA-F]{8}$/.test(low) ? Number.parseInt(low, 16) : null;
}

/**
 * Checks, before anything decodes it, that an `eth_call` result can be the `tryBlockAndAggregate`
 * answer of a read of `expectedCalls` inner calls: null, or the first problem found. Pure, and it
 * never throws. It reads `1 + 3 * expectedCalls` words of the answer and copies none of it, so its
 * cost depends on the read, never on what the endpoint sent.
 *
 * - `too_long`: more than `maxBytes` bytes.
 * - `wrong_layout`: the result array does not start where the encoding of this return type puts it,
 *   or a word that locates a result is missing or absurd.
 * - `wrong_count`: the array-length word is not `expectedCalls`.
 * - `aliased`: the results together claim more bytes than the answer holds after its offsets, which
 *   only results that share their bytes can do.
 *
 * Why it exists (security review of the second-chain read, 2026-10-09): viem copies the `bytes` of
 * every result into a new string before the result count can be checked, and nothing in the encoding
 * stops many results from pointing at one large blob. An answer of 133 KB, half the body cap, with 200
 * results of 60,000 bytes each cost 2.3 s of CPU and 366 MB of heap to decode; a Worker has 128 MB.
 * With the count and the length alone, 66 results sharing one blob of 26 KB still cost the Robinhood
 * read about 130 ms and 33 MB (measured with scripts/read-hardening-check.mjs), hence `aliased`.
 */
export function multicallResultProblem(
  data: string,
  expectedCalls: number,
  maxBytes: number,
): MulticallResultProblem | null {
  if (typeof data !== 'string' || !data.startsWith('0x')) return 'wrong_layout';
  const totalBytes = (data.length - 2) / 2;
  if (!(totalBytes <= maxBytes)) return 'too_long';
  if (!Number.isSafeInteger(expectedCalls) || expectedCalls < 0) return 'wrong_count';
  if (smallWordAt(data, 2 * WORD_BYTES) !== RESULTS_OFFSET) return 'wrong_layout';
  const lengthAt = RESULTS_OFFSET;
  if (data.length < 2 + 2 * (lengthAt + WORD_BYTES)) return 'wrong_layout';
  if (smallWordAt(data, lengthAt) !== expectedCalls) return 'wrong_count';

  // Offsets of the results count from here, the word after the array length, as viem counts them.
  const base = lengthAt + WORD_BYTES;
  let claimed = 0;
  for (let index = 0; index < expectedCalls; index++) {
    const resultOffset = smallWordAt(data, base + index * WORD_BYTES);
    if (resultOffset === null) return 'wrong_layout';
    const resultAt = base + resultOffset;
    // A result is (bool success, bytes returnData): the second word is the offset of the bytes.
    const bytesOffset = smallWordAt(data, resultAt + WORD_BYTES);
    if (bytesOffset === null) return 'wrong_layout';
    const length = smallWordAt(data, resultAt + bytesOffset);
    if (length === null) return 'wrong_layout';
    claimed += RESULT_OVERHEAD_BYTES + Math.ceil(length / WORD_BYTES) * WORD_BYTES;
  }
  return claimed > totalBytes - base - expectedCalls * WORD_BYTES ? 'aliased' : null;
}

/** Throws when `multicallResultProblem` finds one: the endpoint did not answer the question. */
function assertMulticallResult(data: Hex, expectedCalls: number, maxBytes: number): void {
  const problem = multicallResultProblem(data, expectedCalls, maxBytes);
  if (problem !== null) throw new Error(`Not the answer of the multicall: ${problem}.`);
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
 * An answer that `multicallResultProblem` refuses (too long for this universe, not the expected number
 * of results, results that share their bytes) throws before anything is decoded.
 */
export function decodeSnapshotResult(universe: readonly UniverseToken[], data: Hex): SnapshotReads {
  const expected = snapshotCallCount(universe);
  assertMulticallResult(data, expected, snapshotResultMaxBytes(universe));
  const [blockNumber, , results] = decodeFunctionResult({
    abi: multicallAbi,
    functionName: 'tryBlockAndAggregate',
    data,
  });
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
    if (feedChainOf(token) !== CHAIN_ID) return NOT_READ;
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
    // An entry of another chain has no answer in this read, whatever its read says.
    if (token !== undefined && feedChainOf(token) !== CHAIN_ID) continue;
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

/**
 * ArbSys, the Arbitrum system precompile. Its `arbBlockNumber()` is the L2 block number, the block a
 * snapshot names: on Arbitrum, `block.number` (and so Multicall3's block number) is an estimate of the
 * Ethereum block. Source: https://docs.arbitrum.io/arbitrum-essentials/precompiles/reference (where
 * /build-decentralized-apps/precompiles/reference redirects), "ArbSys 0x64", read 2026-10-09.
 */
export const ARBSYS_ADDRESS = '0x0000000000000000000000000000000000000064';

export const arbSysAbi = parseAbi(['function arbBlockNumber() view returns (uint256)']);

/** The Arbitrum read's calls before the feeds: chain ID, block time, ArbSys block, sequencer round. */
const ARBITRUM_CALLS_BEFORE_FEEDS = 4;

/** The entries whose feed is read on Arbitrum One, in universe order. */
export function arbitrumEntries(universe: readonly UniverseToken[]): UniverseToken[] {
  return universe.filter((token) => feedChainOf(token) === ARBITRUM_CHAIN_ID);
}

/** The number of inner calls of the Arbitrum read for this universe. */
export function arbitrumCallCount(universe: readonly UniverseToken[]): number {
  return ARBITRUM_CALLS_BEFORE_FEEDS + 2 * arbitrumEntries(universe).length;
}

/**
 * The most bytes the Arbitrum read's `eth_call` result may have for this universe:
 * `RESULT_SIZE_HEADROOM` times the answer in which every inner call succeeded (2,240 bytes for the
 * three Arbitrum feeds of 2026-10-09, so 4,480). Pure.
 */
export function arbitrumResultMaxBytes(universe: readonly UniverseToken[]): number {
  // Chain ID, block time and ArbSys block are one word each; the sequencer round is five.
  const dataBytes =
    (ARBITRUM_CALLS_BEFORE_FEEDS - 1) * WORD_BYTES +
    ROUND_BYTES +
    arbitrumEntries(universe).length * (ROUND_BYTES + WORD_BYTES);
  return RESULT_SIZE_HEADROOM * multicallResultBytes(arbitrumCallCount(universe), dataBytes);
}

/** The sequencer uptime feed's `latestRoundData()`, the two fields that matter. */
export interface SequencerRound {
  /** 0 while the sequencer is up, 1 while it is down. */
  answer: bigint;
  /** Unix seconds when the current status began; 0 when the feed is not initialised. */
  startedAt: bigint;
}

/** What the Arbitrum read returned, decoded. Null marks a call that failed or did not decode. */
export interface ArbitrumReads {
  /**
   * Multicall3's `block.number`: on Arbitrum, the Ethereum block. Decoded only so that nothing
   * mistakes it for the chain's block; the snapshot never uses it.
   */
  l1BlockNumber: bigint;
  /** Multicall3's `getChainId()`. The caller must refuse anything but 42161. */
  chainId: bigint | null;
  /** Multicall3's `getCurrentBlockTimestamp()`: the time of the L2 block the read was made at. */
  blockTimestamp: bigint | null;
  /** `ArbSys.arbBlockNumber()`: the L2 block the read was made at, the one a snapshot names. */
  l2BlockNumber: bigint | null;
  /** The sequencer uptime feed's newest round. */
  sequencer: SequencerRound | null;
  /**
   * One read per universe token, in universe order. An entry whose feed is not on Arbitrum is not
   * part of this read: its read is all null and nothing uses it. `oraclePaused` is always null.
   */
  reads: FeedRead[];
}

/**
 * The calldata of the one Arbitrum `eth_call`, to send to `MULTICALL3_ADDRESS` (docs/CONTRACTS.md
 * section 23): `tryBlockAndAggregate(false, calls)` carrying, in this order,
 *   1. Multicall3's `getChainId()`
 *   2. Multicall3's `getCurrentBlockTimestamp()`
 *   3. `ArbSys.arbBlockNumber()`, the L2 block
 *   4. the sequencer uptime feed's `latestRoundData()`
 *   5. for every universe entry whose feed is on Arbitrum, in universe order, the feed's
 *      `latestRoundData()` and `decimals()`.
 * One request, never a JSON-RPC batch. The outer block number (Multicall3's `block.number`) is the
 * Ethereum block on Arbitrum and is never used.
 */
export function encodeArbitrumCall(universe: readonly UniverseToken[], sequencerFeed: string): Hex {
  const latestRoundData = encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' });
  const decimals = encodeFunctionData({ abi: feedAbi, functionName: 'decimals' });
  const calls: { target: Hex; callData: Hex }[] = [
    { target: MULTICALL3_ADDRESS, callData: encodeFunctionData({ abi: multicallAbi, functionName: 'getChainId' }) },
    {
      target: MULTICALL3_ADDRESS,
      callData: encodeFunctionData({ abi: multicallAbi, functionName: 'getCurrentBlockTimestamp' }),
    },
    { target: ARBSYS_ADDRESS, callData: encodeFunctionData({ abi: arbSysAbi, functionName: 'arbBlockNumber' }) },
    { target: sequencerFeed as Hex, callData: latestRoundData },
  ];
  for (const token of arbitrumEntries(universe)) {
    calls.push({ target: token.feedAddress as Hex, callData: latestRoundData });
    calls.push({ target: token.feedAddress as Hex, callData: decimals });
  }
  return encodeFunctionData({ abi: multicallAbi, functionName: 'tryBlockAndAggregate', args: [false, calls] });
}

let keptArbitrumCall: KeptCalldata | null = null;

/**
 * `encodeArbitrumCall(universe, sequencerFeed)`, the same bytes, encoded once and kept, as
 * `snapshotCalldata` keeps the Robinhood read's. What it is kept with: the sequencer feed and the feed
 * address of every entry read on Arbitrum, in universe order. Throws what `encodeArbitrumCall` throws,
 * and then keeps nothing.
 */
export function arbitrumCalldata(universe: readonly UniverseToken[], sequencerFeed: string): Hex {
  const key = JSON.stringify([sequencerFeed, arbitrumEntries(universe).map((token) => token.feedAddress)]);
  if (keptArbitrumCall !== null && keptArbitrumCall.key === key) return keptArbitrumCall.data;
  const data = encodeArbitrumCall(universe, sequencerFeed);
  keptArbitrumCall = { key, data };
  return data;
}

/**
 * Decodes the answer of the Arbitrum read. Throws if the outer answer is not a multicall result of
 * the expected length: the endpoint did not answer the question. An inner call that failed is null.
 * An answer that `multicallResultProblem` refuses (too long for this universe, not the expected number
 * of results, results that share their bytes) throws before anything is decoded.
 */
export function decodeArbitrumResult(universe: readonly UniverseToken[], data: Hex): ArbitrumReads {
  const expected = arbitrumCallCount(universe);
  assertMulticallResult(data, expected, arbitrumResultMaxBytes(universe));
  const [l1BlockNumber, , results] = decodeFunctionResult({
    abi: multicallAbi,
    functionName: 'tryBlockAndAggregate',
    data,
  });
  if (results.length !== expected) {
    throw new Error(`Expected ${expected} results from the multicall, got ${results.length}.`);
  }
  const chainId = decodeInner(results[0], (raw) =>
    decodeFunctionResult({ abi: multicallAbi, functionName: 'getChainId', data: raw }),
  );
  const blockTimestamp = decodeInner(results[1], (raw) =>
    decodeFunctionResult({ abi: multicallAbi, functionName: 'getCurrentBlockTimestamp', data: raw }),
  );
  const l2BlockNumber = decodeInner(results[2], (raw) =>
    decodeFunctionResult({ abi: arbSysAbi, functionName: 'arbBlockNumber', data: raw }),
  );
  const sequencer = decodeInner(results[3], (raw): SequencerRound => {
    const [, answer, startedAt] = decodeFunctionResult({ abi: feedAbi, functionName: 'latestRoundData', data: raw });
    return { answer, startedAt };
  });
  let base = ARBITRUM_CALLS_BEFORE_FEEDS;
  const reads = universe.map((token): FeedRead => {
    if (feedChainOf(token) !== ARBITRUM_CHAIN_ID) return NOT_READ;
    const read = readAt(results, base, false);
    base += 2;
    return read;
  });
  return { l1BlockNumber, chainId, blockTimestamp, l2BlockNumber, sequencer, reads };
}

/**
 * The inverse of `decodeArbitrumResult`: the `eth_call` result a node would return for these reads.
 * For tests and offline checks only; nothing in the product calls it. `input.reads` is one read per
 * universe entry, in universe order; the reads of entries not on Arbitrum are skipped. A round is
 * encoded with `startedAt` equal to `updatedAt`.
 */
export function encodeArbitrumResult(universe: readonly UniverseToken[], input: ArbitrumReads): Hex {
  const failed: CallResult = { success: false, returnData: '0x' };
  const ok = (returnData: Hex): CallResult => ({ success: true, returnData });
  const results: CallResult[] = [
    input.chainId === null
      ? failed
      : ok(encodeFunctionResult({ abi: multicallAbi, functionName: 'getChainId', result: input.chainId })),
    input.blockTimestamp === null
      ? failed
      : ok(
          encodeFunctionResult({
            abi: multicallAbi,
            functionName: 'getCurrentBlockTimestamp',
            result: input.blockTimestamp,
          }),
        ),
    input.l2BlockNumber === null
      ? failed
      : ok(encodeFunctionResult({ abi: arbSysAbi, functionName: 'arbBlockNumber', result: input.l2BlockNumber })),
    input.sequencer === null
      ? failed
      : ok(
          encodeFunctionResult({
            abi: feedAbi,
            functionName: 'latestRoundData',
            result: [1n, input.sequencer.answer, input.sequencer.startedAt, input.sequencer.startedAt, 1n],
          }),
        ),
  ];
  for (const [index, token] of universe.entries()) {
    if (feedChainOf(token) !== ARBITRUM_CHAIN_ID) continue;
    const read = input.reads[index] ?? NOT_READ;
    results.push(
      read.round === null
        ? failed
        : ok(
            encodeFunctionResult({
              abi: feedAbi,
              functionName: 'latestRoundData',
              result: [1n, read.round.answer, read.round.updatedAt, read.round.updatedAt, 1n],
            }),
          ),
    );
    results.push(
      read.decimals === null
        ? failed
        : ok(encodeFunctionResult({ abi: feedAbi, functionName: 'decimals', result: read.decimals })),
    );
  }
  return encodeFunctionResult({
    abi: multicallAbi,
    functionName: 'tryBlockAndAggregate',
    result: [input.l1BlockNumber, ZERO_HASH, results],
  });
}
