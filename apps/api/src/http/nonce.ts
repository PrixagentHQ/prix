import { NONCE_TTL_SECONDS } from '@prix/contracts';

/**
 * The sign-in nonce. docs/CONTRACTS.md section 15.
 *
 * A nonce is stateless: issuing one writes nothing, so nobody can spend the database's daily
 * writes by asking for nonces. It is 56 characters of lower-case hex, which is inside the
 * alphabet a Sign-In with Ethereum message allows:
 *
 *   16 characters   8 random bytes
 *    8 characters   the expiry, in whole seconds since 1970
 *   32 characters   the first 16 bytes of HMAC-SHA-256 over the 24 characters before them
 *
 * The HMAC key is the Worker secret `NONCE_SECRET` and is used for nothing else. A nonce that
 * this server did not issue, or that has expired, is refused before any signature is recovered.
 * That a nonce is used once is the store's job (`useNonce`), and the last check of a sign-in.
 */

const RANDOM_HEX = 16;
const EXPIRY_HEX = 8;
const MAC_HEX = 32;
const NONCE_SHAPE = new RegExp(`^[0-9a-f]{${RANDOM_HEX + EXPIRY_HEX + MAC_HEX}}$`);

/** What the HMAC covers, with a label in front so the secret never signs anything that could pass for something else. */
const MAC_LABEL = 'prix:siwe-nonce:v1:';

export interface NonceSigner {
  /** A new nonce. Writes nothing. */
  issue(now: Date): Promise<{ nonce: string; expiresAt: string }>;
  /** The expiry of a nonce that this server issued and that has not expired. Null for anything else. */
  check(nonce: string, now: Date): Promise<string | null>;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The bytes of the secret. Throws, without repeating the value, when it is not 32 bytes or more in base64. */
function secretBytes(secret: string): ArrayBuffer {
  let binary: string;
  try {
    binary = atob(secret.trim());
  } catch {
    binary = '';
  }
  if (binary.length < 32) throw new Error('config.nonceSecret must be at least 32 random bytes in base64');
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/** Compares two strings of one length without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function createNonceSigner(secret: string): NonceSigner {
  const raw = secretBytes(secret);
  // Imported on first use and kept: the key is the same for the life of the Worker.
  let imported: Promise<CryptoKey> | null = null;

  async function mac(body: string): Promise<string> {
    imported ??= crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', await imported, new TextEncoder().encode(MAC_LABEL + body));
    return toHex(new Uint8Array(signature)).slice(0, MAC_HEX);
  }

  return {
    async issue(now) {
      const expirySeconds = Math.floor(now.getTime() / 1000) + NONCE_TTL_SECONDS;
      const body =
        toHex(crypto.getRandomValues(new Uint8Array(RANDOM_HEX / 2))) +
        expirySeconds.toString(16).padStart(EXPIRY_HEX, '0');
      return { nonce: body + (await mac(body)), expiresAt: new Date(expirySeconds * 1000).toISOString() };
    },

    async check(nonce, now) {
      if (!NONCE_SHAPE.test(nonce)) return null;
      const body = nonce.slice(0, RANDOM_HEX + EXPIRY_HEX);
      if (!sameText(await mac(body), nonce.slice(RANDOM_HEX + EXPIRY_HEX))) return null;
      // Only now is the expiry something this server wrote.
      const expiryMs = Number.parseInt(body.slice(RANDOM_HEX), 16) * 1000;
      if (!(now.getTime() < expiryMs)) return null;
      return new Date(expiryMs).toISOString();
    },
  };
}
