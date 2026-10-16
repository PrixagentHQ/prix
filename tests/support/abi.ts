/**
 * viem's ABI coder, for the fake chains of the market tests (tests/support/fake-rpc.ts and
 * tests/support/fake-arbitrum.ts).
 *
 * The tests package does not list viem as a dependency (qa does not change dependencies), but
 * packages/market does and its copy is installed. The import goes through that copy, as
 * tests/reputation/viem.ts does, until the operator adds `viem` to tests/package.json; the file then
 * becomes a plain `export { ... } from 'viem'`.
 */
// @ts-expect-error: the file path import has no type declarations next to it; the shape is declared below
import * as viem from '../../packages/market/node_modules/viem/_esm/index.js';

export type Hex = `0x${string}`;

/** A parsed ABI, opaque here: only viem reads it. */
export type Abi = readonly unknown[];

interface Viem {
  parseAbi(signatures: readonly string[]): Abi;
  decodeFunctionData(args: { abi: Abi; data: Hex }): { functionName: string; args: readonly unknown[] | undefined };
  encodeFunctionData(args: { abi: Abi; functionName: string; args?: readonly unknown[] }): Hex;
  encodeFunctionResult(args: { abi: Abi; functionName: string; result: unknown }): Hex;
  decodeFunctionResult(args: { abi: Abi; functionName: string; data: Hex }): unknown;
}

const api = viem as unknown as Viem;

export const parseAbi = (signatures: readonly string[]): Abi => api.parseAbi(signatures);
export const decodeFunctionData = (abi: Abi, data: Hex) => api.decodeFunctionData({ abi, data });
export const encodeFunctionData = (abi: Abi, functionName: string, args?: readonly unknown[]): Hex =>
  args === undefined
    ? api.encodeFunctionData({ abi, functionName })
    : api.encodeFunctionData({ abi, functionName, args });
export const encodeFunctionResult = (abi: Abi, functionName: string, result: unknown): Hex =>
  api.encodeFunctionResult({ abi, functionName, result });
export const decodeFunctionResult = (abi: Abi, functionName: string, data: Hex): unknown =>
  api.decodeFunctionResult({ abi, functionName, data });

/**
 * Every way to batch calls that Multicall2 and Multicall3 offer, and the calls a snapshot makes
 * inside one (docs/CONTRACTS.md sections 5, 15 and 23). A fake chain decodes whichever the market
 * sends and answers each inner call by its target and selector, so it does not depend on how the
 * market lays the calls out.
 */
export const multicallAbi = parseAbi([
  'struct Call { address target; bytes callData; }',
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate(Call[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
  'function aggregate3(Call3[] calls) view returns (Result[] returnData)',
  'function tryAggregate(bool requireSuccess, Call[] calls) view returns (Result[] returnData)',
  'function tryBlockAndAggregate(bool requireSuccess, Call[] calls) view returns (uint256 blockNumber, bytes32 blockHash, Result[] returnData)',
  'function blockAndAggregate(Call[] calls) view returns (uint256 blockNumber, bytes32 blockHash, Result[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getChainId() view returns (uint256 chainid)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
  'function getL1BlockNumber() view returns (uint256 l1BlockNumber)',
]);

/** Chainlink's AggregatorV3Interface, the part a snapshot reads; the sequencer uptime feed has the same shape. */
export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

/** A Stock Token's flag for a feed frozen during a corporate action. */
export const stockTokenAbi = parseAbi(['function oraclePaused() view returns (bool)']);

/** Arbitrum's ArbSys precompile, at 0x…64: the chain's own L2 block number. */
export const arbSysAbi = parseAbi(['function arbBlockNumber() view returns (uint256)']);

export const ARBSYS_ADDRESS = '0x0000000000000000000000000000000000000064';
export const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';
/** Robinhood Chain's L2 Multicall (Arbitrum's Multicall2), the target of the Robinhood read. */
export const L2_MULTICALL_ADDRESS = '0x2cac2d899ecc914d704feaae33ac1bf36277dad1';

/** The four-byte selector of a function of `abi`, lower case. */
export function selectorOf(abi: Abi, functionName: string): string {
  return encodeFunctionData(abi, functionName).slice(0, 10).toLowerCase();
}

export const SELECTOR = {
  latestRoundData: selectorOf(feedAbi, 'latestRoundData'),
  decimals: selectorOf(feedAbi, 'decimals'),
  oraclePaused: selectorOf(stockTokenAbi, 'oraclePaused'),
  arbBlockNumber: selectorOf(arbSysAbi, 'arbBlockNumber'),
  getChainId: selectorOf(multicallAbi, 'getChainId'),
  getCurrentBlockTimestamp: selectorOf(multicallAbi, 'getCurrentBlockTimestamp'),
  getBlockNumber: selectorOf(multicallAbi, 'getBlockNumber'),
  getL1BlockNumber: selectorOf(multicallAbi, 'getL1BlockNumber'),
} as const;

/** One inner call of a multicall, decoded. */
export interface InnerCall {
  target: string;
  callData: Hex;
  selector: string;
}

/** The outer multicall function and its inner calls, or null when `data` is no multicall. */
export function decodeMulticall(data: Hex): { functionName: string; calls: InnerCall[] } | null {
  let decoded: { functionName: string; args: readonly unknown[] | undefined };
  try {
    decoded = decodeFunctionData(multicallAbi, data);
  } catch {
    return null;
  }
  const args = decoded.args ?? [];
  let list: unknown;
  switch (decoded.functionName) {
    case 'aggregate':
    case 'aggregate3':
    case 'blockAndAggregate':
      list = args[0];
      break;
    case 'tryAggregate':
    case 'tryBlockAndAggregate':
      list = args[1];
      break;
    default:
      return null;
  }
  if (!Array.isArray(list)) return null;
  const calls = list.map((item) => {
    const call = item as { target: string; callData: Hex };
    return {
      target: call.target.toLowerCase(),
      callData: call.callData,
      selector: call.callData.slice(0, 10).toLowerCase(),
    };
  });
  return { functionName: decoded.functionName, calls };
}

/** One inner answer: null when the inner call failed. */
export type InnerAnswer = Hex | null;

/**
 * The outer answer of `functionName` for these inner answers, as a node would encode it.
 * `blockNumber` is what the multicall itself reports as the block: on an Arbitrum chain that is
 * `block.number`, the Ethereum block, which is why the market must never use it on Arbitrum One.
 */
export function encodeMulticallResult(functionName: string, answers: readonly InnerAnswer[], blockNumber: bigint): Hex {
  const results = answers.map((answer) =>
    answer === null ? { success: false, returnData: '0x' as Hex } : { success: true, returnData: answer },
  );
  const zeroHash = `0x${'00'.repeat(32)}` as Hex;
  switch (functionName) {
    case 'aggregate':
      return encodeFunctionResult(multicallAbi, 'aggregate', [blockNumber, answers.map((answer) => answer ?? '0x')]);
    case 'aggregate3':
    case 'tryAggregate':
      return encodeFunctionResult(multicallAbi, functionName, results);
    default:
      return encodeFunctionResult(multicallAbi, functionName, [blockNumber, zeroHash, results]);
  }
}

/**
 * The inverse of `encodeMulticallResult`: the inner answers of an outer answer of `functionName` and
 * the block the multicall reported (0 for a function that reports none), or null when `data` is no
 * such answer. A failed inner call is null. A suite that changes one thing about an honest answer
 * (tests/support/wire-faults.ts) decodes it with this and encodes it again.
 */
export function decodeMulticallResult(
  functionName: string,
  data: Hex,
): { blockNumber: bigint; answers: InnerAnswer[] } | null {
  let decoded: unknown;
  try {
    decoded = decodeFunctionResult(multicallAbi, functionName, data);
  } catch {
    return null;
  }
  const fromResults = (list: unknown): InnerAnswer[] | null =>
    Array.isArray(list)
      ? list.map((item) => {
          const result = item as { success: boolean; returnData: Hex };
          return result.success ? result.returnData : null;
        })
      : null;
  switch (functionName) {
    case 'aggregate': {
      const [blockNumber, list] = decoded as [bigint, Hex[]];
      return Array.isArray(list) ? { blockNumber, answers: [...list] } : null;
    }
    case 'aggregate3':
    case 'tryAggregate': {
      const answers = fromResults(decoded);
      return answers === null ? null : { blockNumber: 0n, answers };
    }
    case 'tryBlockAndAggregate':
    case 'blockAndAggregate': {
      const [blockNumber, , list] = decoded as [bigint, Hex, unknown];
      const answers = fromResults(list);
      return answers === null ? null : { blockNumber, answers };
    }
    default:
      return null;
  }
}
