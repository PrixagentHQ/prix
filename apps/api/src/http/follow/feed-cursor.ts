import type { FeedCursor, FeedCursorText } from '@prix/contracts';
import { feedCursorBase, formatFeedCursor, parseFeedCursor } from '@prix/contracts';

/**
 * Signed feed cursors. docs/CONTRACTS.md section 20.
 *
 * A cursor is `<tickId>~<agentId>~<signature>`. The signature is the first 80 bits of HMAC-SHA-256
 * over `feedCursorBase(cursor)`, in lower-case base32 (16 characters). The HMAC key is derived from
 * the Worker secret NONCE_SECRET with HKDF-SHA-256 and the label "feed-cursor", so the secret never
 * signs a cursor directly and a cursor MAC can never stand in for a sign-in nonce or a claim nonce.
 *
 * Only cursors this server signed are accepted, so the cache keys of the feeds are page boundaries
 * the API really produced, never text a client invented (security review of 2026-10-08, the newest
 * reads, finding 3). Nothing is stored for a cursor.
 */

const LABEL = 'feed-cursor';
const SIGNATURE_BYTES = 10;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export interface FeedCursorSigner {
  /** The cursor text the API hands out for this page boundary. The same cursor always gets the same text. */
  sign(cursor: FeedCursor): Promise<FeedCursorText>;
  /** The cursor if this server signed the text, null for anything else. */
  verify(text: string): Promise<FeedCursor | null>;
}

/** The bytes of the secret. Throws, without repeating the value, when it is not 32 bytes or more in base64. */
function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
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

/** Lower-case base32 of whole 5-bit groups: 10 bytes are exactly 16 characters. */
function toBase32(bytes: Uint8Array): string {
  let text = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += BASE32[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return text;
}

/** Compares two strings of one length without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/**
 * The derived HMAC key of each secret, imported once per isolate and kept: the secret is configuration
 * and the same for the life of the Worker. Nothing about a request is kept here.
 */
const keys = new Map<string, Promise<CryptoKey>>();

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', secretBytes(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(LABEL) },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (key === undefined) {
    key = deriveKey(secret);
    // A failed import is not kept: the next call tries again.
    void key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

export function createFeedCursorSigner(secret: string): FeedCursorSigner {
  // Checked at once, so a bad secret fails when the routes are built and not on the first cursor.
  secretBytes(secret);

  async function signatureOf(cursor: FeedCursor): Promise<string> {
    const body = new TextEncoder().encode(feedCursorBase(cursor));
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(secret), body));
    return toBase32(mac.subarray(0, SIGNATURE_BYTES));
  }

  return {
    async sign(cursor) {
      return formatFeedCursor(cursor, await signatureOf(cursor));
    },

    async verify(text) {
      const parsed = parseFeedCursor(text);
      if (parsed === null) return null;
      const cursor: FeedCursor = { tickId: parsed.tickId, agentId: parsed.agentId };
      return sameText(await signatureOf(cursor), parsed.signature) ? cursor : null;
    },
  };
}
