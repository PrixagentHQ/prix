import type { NonceResponse } from '@prix/contracts';
import { checksumAddress } from './eip55.ts';

/**
 * The Sign-In with Ethereum message (EIP-4361), in the one layout the API accepts
 * (docs/CONTRACTS.md section 15). Every line but the address and the time it was issued comes
 * from the API's own answer, so the page decides nothing about what is signed.
 *
 * The expiry is the server's: a wallet shows it, and the API refuses a message signed after it.
 */
export function signInMessage(address: string, request: NonceResponse, issuedAt: Date): string {
  return [
    `${request.domain} wants you to sign in with your Ethereum account:`,
    checksumAddress(address),
    '',
    request.statement,
    '',
    `URI: ${request.uri}`,
    'Version: 1',
    `Chain ID: ${request.chainId}`,
    `Nonce: ${request.nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${request.expiresAt}`,
  ].join('\n');
}

/** The bytes of a text as 0x and hex: the form in which `personal_sign` takes a message. */
export function utf8Hex(text: string): string {
  let hex = '0x';
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** A signature an ordinary wallet account makes: 65 bytes. A contract wallet answers with something else. */
export function isAccountSignature(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);
}
