/**
 * The wire format of the one batched read behind a token balance check. Pure: it builds calldata and
 * decodes the answer, and makes no request. `encodeTokenResult` is the inverse of `decodeTokenResult`,
 * so a test can answer a fake RPC without a network.
 *
 * One `eth_call` to the L2 Multicall carries, in this order:
 *   1. the multicall's own `getCurrentBlockTimestamp()`
 *   2. the token's `totalSupply()`
 *   3. the token's `decimals()`
 *   4. the token's `balanceOf(wallet)`, for every wallet, in the order given
 */

import type { Address } from '@prix/contracts';
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, type Hex, parseAbi } from 'viem';
import { MULTICALL_ADDRESS, multicallAbi } from './wire.ts';

/** The part of ERC-20 a balance check reads. */
export const erc20Abi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

/** What the batched read returned, decoded. A failed inner call is `null`. */
export interface TokenReads {
  blockNumber: bigint;
  /** The timestamp of the block the reads were made at, in Unix seconds. */
  blockTimestamp: bigint | null;
  totalSupply: bigint | null;
  decimals: number | null;
  /** One balance per wallet asked about, in the same order. */
  balances: readonly (bigint | null)[];
}

const CALLS_BEFORE_WALLETS = 3;

/** The calldata of the one `eth_call`, to send to `MULTICALL_ADDRESS`. */
export function encodeTokenCall(token: Address, wallets: readonly Address[]): Hex {
  const calls: { target: Hex; callData: Hex }[] = [
    {
      target: MULTICALL_ADDRESS,
      callData: encodeFunctionData({ abi: multicallAbi, functionName: 'getCurrentBlockTimestamp' }),
    },
    { target: token as Hex, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }) },
    { target: token as Hex, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) },
  ];
  for (const wallet of wallets) {
    calls.push({
      target: token as Hex,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [wallet as Hex] }),
    });
  }
  return encodeFunctionData({ abi: multicallAbi, functionName: 'tryBlockAndAggregate', args: [false, calls] });
}

interface CallResult {
  success: boolean;
  returnData: Hex;
}

function decodeInner<T>(result: CallResult | undefined, decode: (data: Hex) => T): T | null {
  if (result === undefined || !result.success || result.returnData === '0x') return null;
  try {
    return decode(result.returnData);
  } catch {
    return null;
  }
}

/**
 * Decodes the answer. Throws if the outer answer is not a multicall result of the expected length.
 * An inner call that failed becomes `null`.
 */
export function decodeTokenResult(wallets: readonly Address[], data: Hex): TokenReads {
  const [blockNumber, , results] = decodeFunctionResult({
    abi: multicallAbi,
    functionName: 'tryBlockAndAggregate',
    data,
  });
  const expected = CALLS_BEFORE_WALLETS + wallets.length;
  if (results.length !== expected) {
    throw new Error(`Expected ${expected} results from the multicall, got ${results.length}.`);
  }
  return {
    blockNumber,
    blockTimestamp: decodeInner(results[0], (raw) =>
      decodeFunctionResult({ abi: multicallAbi, functionName: 'getCurrentBlockTimestamp', data: raw }),
    ),
    totalSupply: decodeInner(results[1], (raw) =>
      decodeFunctionResult({ abi: erc20Abi, functionName: 'totalSupply', data: raw }),
    ),
    decimals: decodeInner(results[2], (raw) =>
      decodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', data: raw }),
    ),
    balances: wallets.map((_wallet, index) =>
      decodeInner(results[CALLS_BEFORE_WALLETS + index], (raw) =>
        decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: raw }),
      ),
    ),
  };
}

/** The inverse of `decodeTokenResult`: the `eth_call` result a node would return. For tests and offline checks only. */
export function encodeTokenResult(input: TokenReads): Hex {
  const failed: CallResult = { success: false, returnData: '0x' };
  const ok = (returnData: Hex): CallResult => ({ success: true, returnData });
  const results: CallResult[] = [
    input.blockTimestamp === null
      ? failed
      : ok(
          encodeFunctionResult({
            abi: multicallAbi,
            functionName: 'getCurrentBlockTimestamp',
            result: input.blockTimestamp,
          }),
        ),
    input.totalSupply === null
      ? failed
      : ok(encodeFunctionResult({ abi: erc20Abi, functionName: 'totalSupply', result: input.totalSupply })),
    input.decimals === null
      ? failed
      : ok(encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: input.decimals })),
    ...input.balances.map((balance) =>
      balance === null
        ? failed
        : ok(encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: balance })),
    ),
  ];
  return encodeFunctionResult({
    abi: multicallAbi,
    functionName: 'tryBlockAndAggregate',
    result: [input.blockNumber, `0x${'00'.repeat(32)}`, results],
  });
}
