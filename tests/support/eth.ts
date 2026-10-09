/**
 * A test wallet: just enough Ethereum to sign a Sign-In with Ethereum message.
 *
 * It is written out here because the tests package has no Ethereum library of its own and
 * `qa` does not change dependencies. It is for tests only: the nonce of a signature is
 * derived from the key and the message, which is fine for fixed test keys and nothing else.
 * tests/unit/support.eth.test.ts checks it against published vectors.
 */

// --- keccak-256 -----------------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
/** Rotation offsets, indexed [x][y]. */
const ROTATIONS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(value: bigint, shift: number): bigint {
  if (shift === 0) return value;
  const n = BigInt(shift);
  return ((value << n) | (value >> (64n - n))) & MASK64;
}

function keccakF(state: bigint[]): void {
  const at = (x: number, y: number): bigint => state[x + 5 * y] as bigint;
  for (const constant of ROUND_CONSTANTS) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x += 1) c.push(at(x, 0) ^ at(x, 1) ^ at(x, 2) ^ at(x, 3) ^ at(x, 4));
    for (let x = 0; x < 5; x += 1) {
      const d = (c[(x + 4) % 5] as bigint) ^ rotl(c[(x + 1) % 5] as bigint, 1);
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = at(x, y) ^ d;
    }
    const b: bigint[] = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(at(x, y), (ROTATIONS[x] as number[])[y] as number);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const here = b[x + 5 * y] as bigint;
        const next = b[((x + 1) % 5) + 5 * y] as bigint;
        const after = b[((x + 2) % 5) + 5 * y] as bigint;
        state[x + 5 * y] = here ^ (~next & MASK64 & after);
      }
    }
    state[0] = (state[0] as bigint) ^ constant;
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = (padded[input.length] as number) | 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] as number) | 0x80;

  const state: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1)
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte] as number);
      state[lane] = (state[lane] as bigint) ^ value;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    let value = state[lane] as bigint;
    for (let byte = 0; byte < 8; byte += 1) {
      out[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

// --- bytes ----------------------------------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function bigToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function bytesToBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

const utf8 = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))));
}

// --- secp256k1 ------------------------------------------------------------------------------------

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

type Point = { x: bigint; y: bigint } | null;

function mod(value: bigint, modulus: bigint): bigint {
  const rest = value % modulus;
  return rest >= 0n ? rest : rest + modulus;
}

function inverse(value: bigint, modulus: bigint): bigint {
  let [a, b] = [mod(value, modulus), modulus];
  let [x, y] = [1n, 0n];
  while (b !== 0n) {
    const quotient = a / b;
    [a, b] = [b, a - quotient * b];
    [x, y] = [y, x - quotient * y];
  }
  return mod(x, modulus);
}

function add(a: Point, b: Point): Point {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x && mod(a.y + b.y, P) === 0n) return null;
  const slope =
    a.x === b.x ? mod(3n * a.x * a.x * inverse(2n * a.y, P), P) : mod((b.y - a.y) * inverse(b.x - a.x, P), P);
  const x = mod(slope * slope - a.x - b.x, P);
  return { x, y: mod(slope * (a.x - x) - a.y, P) };
}

function multiply(scalar: bigint, point: Point): Point {
  let result: Point = null;
  let addend = point;
  let rest = scalar;
  while (rest > 0n) {
    if (rest & 1n) result = add(result, addend);
    addend = add(addend, addend);
    rest >>= 1n;
  }
  return result;
}

export interface TestWallet {
  /** Lower case, the way the product stores and compares an address. */
  address: string;
  /** With the EIP-55 checksum, the way a wallet writes it into a sign-in message. */
  checksumAddress: string;
  /** An EIP-191 `personal_sign` signature: 65 bytes as 0x-prefixed hex. */
  signMessage(message: string): Promise<string>;
}

function checksum(address: string): string {
  const hex = address.slice(2);
  const hash = toHex(keccak256(utf8.encode(hex)));
  let out = '0x';
  for (let i = 0; i < hex.length; i += 1) {
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? (hex[i] as string).toUpperCase() : hex[i];
  }
  return out;
}

export function walletFromPrivateKey(privateKey: bigint): TestWallet {
  if (privateKey <= 0n || privateKey >= N) throw new Error('walletFromPrivateKey: key out of range');
  const publicKey = multiply(privateKey, { x: GX, y: GY });
  if (publicKey === null) throw new Error('walletFromPrivateKey: no public key');
  const publicBytes = new Uint8Array(64);
  publicBytes.set(bigToBytes(publicKey.x, 32), 0);
  publicBytes.set(bigToBytes(publicKey.y, 32), 32);
  const address = `0x${toHex(keccak256(publicBytes).slice(12))}`;

  return {
    address,
    checksumAddress: checksum(address),
    async signMessage(message: string): Promise<string> {
      const body = utf8.encode(message);
      const prefix = utf8.encode(`\x19Ethereum Signed Message:\n${body.length}`);
      const data = new Uint8Array(prefix.length + body.length);
      data.set(prefix, 0);
      data.set(body, prefix.length);
      const digest = keccak256(data);
      const z = bytesToBig(digest);

      const seed = new Uint8Array(64);
      seed.set(bigToBytes(privateKey, 32), 0);
      seed.set(digest, 32);
      const k = mod(bytesToBig(new Uint8Array(await crypto.subtle.digest('SHA-256', seed))), N - 1n) + 1n;

      const point = multiply(k, { x: GX, y: GY });
      if (point === null) throw new Error('signMessage: no point');
      const r = mod(point.x, N);
      let s = mod(inverse(k, N) * (z + r * privateKey), N);
      let recovery = Number(point.y & 1n);
      if (r === 0n || s === 0n || point.x >= N) throw new Error('signMessage: degenerate signature');
      if (s > N / 2n) {
        s = N - s;
        recovery ^= 1;
      }
      return `0x${toHex(bigToBytes(r, 32))}${toHex(bigToBytes(s, 32))}${(27 + recovery).toString(16)}`;
    },
  };
}

/** A test wallet derived from a small number, so no key is written in the repository. */
export function testWallet(n: number): TestWallet {
  const key = bytesToBig(keccak256(utf8.encode(`prix test wallet ${n}`)));
  return walletFromPrivateKey(mod(key, N - 1n) + 1n);
}

// --- Sign-In with Ethereum ------------------------------------------------------------------------

export interface SiweFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version?: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  /** Optional in EIP-4361. The API refuses a message that carries one. */
  requestId?: string;
  /** Optional in EIP-4361. The API refuses a message that carries any. */
  resources?: readonly string[];
}

/** An EIP-4361 message, line for line as the standard writes it. */
export function siweMessage(fields: SiweFields): string {
  const lines = [
    `${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    '',
    fields.statement,
    '',
    `URI: ${fields.uri}`,
    `Version: ${fields.version ?? '1'}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ];
  if (fields.expirationTime !== undefined) lines.push(`Expiration Time: ${fields.expirationTime}`);
  if (fields.notBefore !== undefined) lines.push(`Not Before: ${fields.notBefore}`);
  if (fields.requestId !== undefined) lines.push(`Request ID: ${fields.requestId}`);
  if (fields.resources !== undefined) {
    lines.push('Resources:');
    for (const resource of fields.resources) lines.push(`- ${resource}`);
  }
  return lines.join('\n');
}
