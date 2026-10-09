import { CLAIM_HMAC_LABEL, CLAIM_NONCE_RANDOM_LENGTH } from '@prix/contracts';

/**
 * The claim nonce and the network key. docs/contracts/phase-2-reputation.md sections 2, 3 and 7.
 *
 * A claim nonce is `<24 random letters and digits>.<32 hex>`. The hex is the first 32 characters of
 * HMAC-SHA-256 under NONCE_SECRET over the label, the claimant, the wallet, the name key, both times
 * and the random part. Nothing is stored for it.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAC_HEX = 32;
const NETWORK_HEX = 16;

export interface ClaimNonceFields {
  claimant: string;
  wallet: string;
  nameKey: string;
  issuedAt: string;
  expiresAt: string;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function secretBytes(secret: string): Uint8Array {
  try {
    const binary = atob(secret.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    if (bytes.length >= 32) return bytes;
  } catch {
    // Not base64: the throw below says so, without repeating the value.
  }
  throw new Error('config.nonceSecret must be at least 32 random bytes in base64');
}

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      'raw',
      secretBytes(secret) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    keys.set(secret, key);
  }
  return key;
}

async function mac(secret: string, text: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(text));
  return toHex(new Uint8Array(signature));
}

function claimBody(fields: ClaimNonceFields, random: string): string {
  return [
    CLAIM_HMAC_LABEL,
    fields.claimant,
    fields.wallet,
    fields.nameKey,
    fields.issuedAt,
    fields.expiresAt,
    random,
  ].join('|');
}

/** Compares two strings of one length without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function randomPart(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CLAIM_NONCE_RANDOM_LENGTH));
  let text = '';
  for (const byte of bytes) text += ALPHABET[byte % ALPHABET.length];
  return text;
}

export async function createClaimNonce(secret: string, fields: ClaimNonceFields): Promise<string> {
  const random = randomPart();
  const tag = (await mac(secret, claimBody(fields, random))).slice(0, MAC_HEX);
  return `${random}.${tag}`;
}

/** True only for a nonce this server made for exactly these fields. Constant-time compare. */
export async function checkClaimNonce(secret: string, nonce: string, fields: ClaimNonceFields): Promise<boolean> {
  const match = /^([A-Za-z0-9]{24})\.([0-9a-f]{32})$/.exec(nonce);
  if (match === null) return false;
  const expected = (await mac(secret, claimBody(fields, match[1] as string))).slice(0, MAC_HEX);
  return sameText(expected, match[2] as string);
}

/**
 * A network as a counter key part: HMAC-SHA-256 of the client subject (an IPv6 address already by its
 * /64, see `clientSubject`) under NONCE_SECRET, cut to 16 hex. The address itself is never stored.
 */
export async function networkKey(subject: string, secret: string): Promise<string> {
  return (await mac(secret, `prix-network-v1|${subject}`)).slice(0, NETWORK_HEX);
}
