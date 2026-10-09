/**
 * The mixed-case form of a wallet address (EIP-55), which a Sign-In with Ethereum message
 * must carry: a wallet shows its own sign-in screen, with its check of the site's address,
 * only for a message it can parse, and its parser rejects an address in lower case.
 *
 * The form needs Keccak-256, which Web Crypto does not have, and the site adds no dependency
 * for one hash. This is the algorithm of FIPS 202 with Keccak's original padding, written for
 * one short input. It hashes an address and nothing secret.
 */

const MASK = (1n << 64n) - 1n;
const RATE = 136;

/** The 24 round constants of Keccak-f[1600], as its specification generates them. */
function roundConstants(): bigint[] {
  const constants: bigint[] = [];
  let bit = 1;
  for (let round = 0; round < 24; round += 1) {
    let constant = 0n;
    for (let j = 0; j < 7; j += 1) {
      if (bit & 1) constant ^= 1n << BigInt(2 ** j - 1);
      bit = bit & 0x80 ? ((bit << 1) ^ 0x171) & 0xff : bit << 1;
    }
    constants.push(constant);
  }
  return constants;
}

function rotate(lane: bigint, by: number): bigint {
  const shift = BigInt(by % 64);
  return shift === 0n ? lane : ((lane << shift) | (lane >> (64n - shift))) & MASK;
}

/** One permutation of the 25 lanes, in place. Lane (x, y) is at index x + 5y. */
function permute(lanes: bigint[], constants: readonly bigint[]): void {
  const lane = (index: number): bigint => lanes[index] ?? 0n;
  for (const constant of constants) {
    // Theta.
    const parity = [0, 1, 2, 3, 4].map((x) => lane(x) ^ lane(x + 5) ^ lane(x + 10) ^ lane(x + 15) ^ lane(x + 20));
    for (let x = 0; x < 5; x += 1) {
      const mix = (parity[(x + 4) % 5] ?? 0n) ^ rotate(parity[(x + 1) % 5] ?? 0n, 1);
      for (let y = 0; y < 25; y += 5) lanes[x + y] = lane(x + y) ^ mix;
    }
    // Rho and pi: walk the lanes in the order the specification names them.
    let x = 1;
    let y = 0;
    let moving = lane(1);
    for (let step = 0; step < 24; step += 1) {
      const next = y + 5 * ((2 * x + 3 * y) % 5);
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const held = lane(next);
      lanes[next] = rotate(moving, ((step + 1) * (step + 2)) / 2);
      moving = held;
    }
    // Chi.
    for (let row = 0; row < 25; row += 5) {
      const before = [0, 1, 2, 3, 4].map((column) => lane(row + column));
      for (let column = 0; column < 5; column += 1) {
        const second = before[(column + 1) % 5] ?? 0n;
        const third = before[(column + 2) % 5] ?? 0n;
        lanes[row + column] = (before[column] ?? 0n) ^ (~second & MASK & third);
      }
    }
    // Iota.
    lanes[0] = lane(0) ^ constant;
  }
}

/** Keccak-256 of `input`, as 64 lower-case hex characters. */
export function keccak256Hex(input: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const constants = roundConstants();
  const lanes: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let index = 0; index < RATE; index += 1) {
      const byte = BigInt(padded[offset + index] ?? 0);
      const at = index >> 3;
      lanes[at] = (lanes[at] ?? 0n) ^ (byte << BigInt(8 * (index & 7)));
    }
    permute(lanes, constants);
  }

  let hex = '';
  for (let index = 0; index < 32; index += 1) {
    const byte = Number(((lanes[index >> 3] ?? 0n) >> BigInt(8 * (index & 7))) & 0xffn);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** True for text that is an address in any case: 0x and 40 hex characters. */
export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** "0x7a3f…" becomes "0x7A3f…": a letter is a capital where the hash of the address says so. */
export function checksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(new TextEncoder().encode(lower));
  let mixed = '0x';
  for (let index = 0; index < lower.length; index += 1) {
    const character = lower[index] ?? '';
    mixed += Number.parseInt(hash[index] ?? '0', 16) >= 8 ? character.toUpperCase() : character;
  }
  return mixed;
}
