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

// --- the lean encoding (docs/contracts/phase-6-holders.md section 5, revision 3 HB-1, revision 4 HB3-1) ----------
//
// The same call and the same answer as above, written and read by hand with no viem ABI coder, because viem's
// coder took 15.55 ms for 400 wallets. The bytes are the ABI's own: `encodeTokenCallLean` writes exactly what
// `encodeTokenCall` writes, and `decodeTokenResultLean` answers what `decodeTokenResult` answers (the tests pin
// both). The three leading calls are kept; each `balanceOf` is the selector 0x70a08231 and the address padded
// to 32 bytes, and each answer's first 32-byte word is sliced from the result.

const WORD = 64; // hex characters in one 32-byte word
const BALANCE_OF_SELECTOR = '70a08231';

function word(value: bigint | number): string {
  return value.toString(16).padStart(WORD, '0');
}

/** A call's bytes, length-prefixed and right-padded to whole words, as the ABI writes `bytes`. */
function bytesPart(hex: string): string {
  const padded = hex.padEnd(Math.ceil(hex.length / WORD) * WORD, '0');
  return word(hex.length / 2) + padded;
}

/** The encoded `(address target, bytes callData)` tuple. */
function callTuple(target: string, callData: string): string {
  return word(BigInt(`0x${target}`)) + word(0x40) + bytesPart(callData);
}

const TRY_BLOCK_AND_AGGREGATE_SELECTOR = encodeFunctionData({
  abi: multicallAbi,
  functionName: 'tryBlockAndAggregate',
  args: [false, []],
}).slice(2, 10);
const LEADING_CALL_DATA = [
  encodeFunctionData({ abi: multicallAbi, functionName: 'getCurrentBlockTimestamp' }).slice(2),
  encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }).slice(2),
  encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }).slice(2),
];

/** The calldata of `encodeTokenCall`, written by hand. Used by `readBalances` above TOKEN_SWEEP_BATCH wallets. */
export function encodeTokenCallLean(token: Address, wallets: readonly Address[]): Hex {
  const tokenHex = token.slice(2).toLowerCase();
  const multicall = MULTICALL_ADDRESS.slice(2).toLowerCase();
  const tuples: string[] = [
    callTuple(multicall, LEADING_CALL_DATA[0] ?? ''),
    callTuple(tokenHex, LEADING_CALL_DATA[1] ?? ''),
    callTuple(tokenHex, LEADING_CALL_DATA[2] ?? ''),
  ];
  for (const wallet of wallets) {
    const address = wallet.slice(2).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(address)) throw new Error('Not an address.');
    tuples.push(callTuple(tokenHex, `${BALANCE_OF_SELECTOR}${address.padStart(WORD, '0')}`));
  }
  // The array: its length, then each tuple's offset from the start of the offsets, then the tuples.
  const offsets: string[] = [];
  let at = tuples.length * 32;
  for (const tuple of tuples) {
    offsets.push(word(at));
    at += tuple.length / 2;
  }
  const array = word(tuples.length) + offsets.join('') + tuples.join('');
  return `0x${TRY_BLOCK_AND_AGGREGATE_SELECTOR}${word(0)}${word(0x40)}${array}` as Hex;
}

/** A reader of one hex answer that refuses any read past its end. */
class HexReader {
  constructor(private readonly hex: string) {
    if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error('Not an ABI answer.');
  }

  /** The 32-byte word at a byte offset, as a bigint. */
  wordAt(byte: number): bigint {
    const start = byte * 2;
    if (!Number.isSafeInteger(byte) || byte < 0 || start + WORD > this.hex.length) throw new Error('Answer cut short.');
    return BigInt(`0x${this.hex.slice(start, start + WORD)}`);
  }

  /** An offset or a length: a word that must fit the answer. */
  sizeAt(byte: number): number {
    const value = this.wordAt(byte);
    if (value > BigInt(this.hex.length / 2)) throw new Error('Offset past the answer.');
    return Number(value);
  }

  bytesAt(byte: number, length: number): string {
    const start = byte * 2;
    if (start + length * 2 > this.hex.length) throw new Error('Answer cut short.');
    return this.hex.slice(start, start + length * 2);
  }
}

/** A failed or empty inner answer is null; otherwise its first word, or null when it holds less than a word. */
function firstWord(result: { success: boolean; data: string }): bigint | null {
  if (!result.success || result.data.length < WORD) return null;
  return BigInt(`0x${result.data.slice(0, WORD)}`);
}

/** `decodeTokenResult`, read by hand. Throws when the outer answer is not a multicall result of the expected length. */
export function decodeTokenResultLean(wallets: readonly Address[], data: Hex): TokenReads {
  const reader = new HexReader(data.slice(2).toLowerCase());
  const blockNumber = reader.wordAt(0);
  const arrayAt = reader.sizeAt(64);
  const count = reader.sizeAt(arrayAt);
  const expected = CALLS_BEFORE_WALLETS + wallets.length;
  if (count !== expected) throw new Error(`Expected ${expected} results from the multicall, got ${count}.`);
  const base = arrayAt + 32;
  const results: { success: boolean; data: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const tupleAt = base + reader.sizeAt(base + i * 32);
    const flag = reader.wordAt(tupleAt);
    if (flag > 1n) throw new Error('Not a bool.');
    const bytesAt = tupleAt + reader.sizeAt(tupleAt + 32);
    const length = reader.sizeAt(bytesAt);
    results.push({ success: flag === 1n, data: reader.bytesAt(bytesAt + 32, length) });
  }
  const at = (i: number) => results[i] ?? { success: false, data: '' };
  const decimals = firstWord(at(2));
  return {
    blockNumber,
    blockTimestamp: firstWord(at(0)),
    totalSupply: firstWord(at(1)),
    // viem refuses a uint8 above 255; so does this.
    decimals: decimals === null || decimals > 255n ? null : Number(decimals),
    balances: wallets.map((_wallet, index) => firstWord(at(CALLS_BEFORE_WALLETS + index))),
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
