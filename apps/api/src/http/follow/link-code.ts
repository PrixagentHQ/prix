import { LINK_CODE_LENGTH } from '@prix/contracts';

const CODE_BYTES = 24;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 of a link code, in hex. This is all the store ever holds of a code. */
export async function hashLinkCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return toHex(new Uint8Array(digest));
}

/**
 * A new link code: 24 random bytes, base64url, 32 characters. The code goes into the one response
 * that creates it and nowhere else. `hash` is what is stored.
 */
export async function newLinkCode(): Promise<{ code: string; hash: string }> {
  const code = toBase64Url(crypto.getRandomValues(new Uint8Array(CODE_BYTES)));
  if (code.length !== LINK_CODE_LENGTH) throw new Error('link code length');
  return { code, hash: await hashLinkCode(code) };
}

/** Constant time: compares the SHA-256 of both texts, so length and content do not leak. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hashLinkCode(a), hashLinkCode(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
