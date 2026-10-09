/** Small text and byte helpers. Web APIs only, so they run in Workers, Node and browsers. */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(text);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

/** The length of a text in UTF-8 bytes. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Null when the text is not base64. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * One line of plain text for a public page, cleaned the way `parseDecisionOutput` cleans a
 * reason: every control and format character removed, including the ones that reorder text or
 * hide it, whitespace collapsed, ends trimmed.
 */
export function publicLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A scheme with an authority, such as `https://`. */
const SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
/** A host written the old way, such as `www.example`. */
const WWW = /(?<![\p{L}\p{N}])www\./iu;
/**
 * A name shaped like a host: labels joined by dots, ending in a label of two or more letters.
 * "example.com", "t.me" and "name.eth" match. "U.S.", "e.g.", "BRK.B" and "0.5" do not.
 */
const HOST = /(?<![\p{L}\p{N}.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?![\p{L}\p{N}-])/u;
/** `0x` and hex digits: an address, a transaction, or the start of one that was shortened. */
const HEX = /0x[0-9a-f]{4,}/i;

/** True when a text carries something a reader could follow: a link, a host name or an address. */
export function hasLinkOrAddress(text: string): boolean {
  return SCHEME.test(text) || WWW.test(text) || HOST.test(text) || HEX.test(text);
}
