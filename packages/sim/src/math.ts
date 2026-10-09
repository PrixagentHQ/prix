import { BPS, MICRO } from '@prix/contracts';

/**
 * Integer arithmetic for the engine. docs/CONTRACTS.md section 7 defines the units:
 * micro-USD, micro-shares, micro-USD per share and basis points, all integers.
 *
 * Everything here works on BigInt. A product of two stored numbers can leave the safe
 * integer range, so the engine converts its input once, computes in BigInt, and converts
 * the result back through `toAmount`, which refuses a number that is not a safe integer.
 * Every operand of a division is zero or positive, so BigInt division is a floor.
 */

/** `M`: one USD in micro-USD, and one share in micro-shares. */
export const M = BigInt(MICRO);
/** `B`: one hundred percent in basis points. */
export const B = BigInt(BPS);

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** `value(units, price) = floor(units * price / M)`, in micro-USD. */
export function valueAt(units: bigint, price: bigint): bigint {
  return (units * price) / M;
}

/** `floor(amount * bps / B)` for an amount that is zero or positive. */
export function floorBps(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / B;
}

/** `ceil(amount * bps / B)` for an amount that is zero or positive. */
export function ceilBps(amount: bigint, bps: bigint): bigint {
  return (amount * bps + B - 1n) / B;
}

export function minOf(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Ascending symbol order: plain code unit order, the same on every machine and in every locale. */
export function compareSymbols(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A symbol as it may appear in an error message. */
export function label(symbol: string): string {
  return symbol.slice(0, 20);
}

/** Reads a stored amount. Throws unless it is a safe integer that is zero or positive. */
export function fromAmount(value: unknown, what: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`@prix/sim: ${what} must be a safe integer that is zero or positive`);
  }
  return BigInt(value);
}

/** Converts a result back to a number. Throws unless it is a safe integer that is zero or positive. */
export function toAmount(value: bigint, what: string): number {
  if (value < 0n) {
    throw new Error(`@prix/sim: ${what} would be negative`);
  }
  if (value > MAX_SAFE) {
    throw new Error(`@prix/sim: ${what} would not be a safe integer`);
  }
  return Number(value);
}
