import { CHAIN_ID, SIWE_STATEMENT } from '@prix/contracts';
import { recoverMessageAddress } from 'viem';
import type { NonceSigner } from './nonce.ts';

/** What a sign-in message must name. All three come from `config.siteOrigin`. */
export interface SiweTarget {
  /** The host of the site, with its port when it has one. */
  domain: string;
  /** The scheme of the site, without the colon. */
  scheme: string;
  /** The origin of the site, exactly. */
  origin: string;
}

export function siweTarget(siteOrigin: string): SiweTarget {
  const url = new URL(siteOrigin);
  if (url.origin !== siteOrigin) {
    throw new Error(
      'config.siteOrigin must be a bare origin in lower case: a scheme and a host, no path, no trailing slash',
    );
  }
  return { domain: url.host, scheme: url.protocol.slice(0, -1), origin: siteOrigin };
}

/** A message is accepted for ten minutes after it was issued. */
const ISSUED_WINDOW_MS = 10 * 60 * 1000;
/** How far ahead of the server a wallet's clock may run. */
const CLOCK_SKEW_MS = 60 * 1000;

/** The fields of a sign-in message, as text, exactly as they stand in it. */
interface SiweFields {
  scheme: string | null;
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string | null;
  notBefore: string | null;
}

const HEADER = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your Ethereum account:$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN = /^\S+$/;
const DIGITS = /^[0-9]+$/;
const NONCE = /^[A-Za-z0-9]{8,}$/;
/** An RFC 3339 date and time, which is what EIP-4361 asks for. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function field(line: string | undefined, label: string, shape: RegExp): string | null {
  if (line === undefined || !line.startsWith(label)) return null;
  const value = line.slice(label.length);
  return shape.test(value) ? value : null;
}

/** The message a wallet shows for these fields, line for line as EIP-4361 writes it. */
function layout(fields: SiweFields): string {
  const scheme = fields.scheme === null ? '' : `${fields.scheme}://`;
  const lines = [
    `${scheme}${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    '',
    fields.statement,
    '',
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ];
  if (fields.expirationTime !== null) lines.push(`Expiration Time: ${fields.expirationTime}`);
  if (fields.notBefore !== null) lines.push(`Not Before: ${fields.notBefore}`);
  return lines.join('\n');
}

/**
 * Reads a message that is in the exact layout of EIP-4361, with a statement, and null for
 * anything else. After "Issued At" only an expiration time and a not-before time may follow,
 * in that order. A request id or a list of resources is refused: signing in grants a session
 * and nothing more, so nothing more may be written into what the wallet signs.
 *
 * Nothing is lenient here. The message is rebuilt from the fields that were read and must be
 * equal, character for character, to what was signed, so the text a wallet showed is exactly
 * the text the checks below read.
 */
export function readSiweMessage(message: string): SiweFields | null {
  const lines = message.split('\n');
  if (lines.length < 10 || lines.length > 12) return null;
  const header = HEADER.exec(lines[0] ?? '');
  if (header === null) return null;
  const domain = header[2];
  const address = lines[1];
  const statement = lines[3];
  if (domain === undefined || address === undefined || !ADDRESS.test(address)) return null;
  if (lines[2] !== '' || statement === undefined || statement === '' || lines[4] !== '') return null;

  const uri = field(lines[5], 'URI: ', TOKEN);
  const version = field(lines[6], 'Version: ', DIGITS);
  const chainId = field(lines[7], 'Chain ID: ', DIGITS);
  const nonce = field(lines[8], 'Nonce: ', NONCE);
  const issuedAt = field(lines[9], 'Issued At: ', DATE_TIME);
  if (uri === null || version === null || chainId === null || nonce === null || issuedAt === null) return null;

  let next = 10;
  const expirationTime = field(lines[next], 'Expiration Time: ', DATE_TIME);
  if (expirationTime !== null) next += 1;
  const notBefore = field(lines[next], 'Not Before: ', DATE_TIME);
  if (notBefore !== null) next += 1;
  if (next !== lines.length) return null;

  const fields: SiweFields = {
    scheme: header[1] ?? null,
    domain,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    notBefore,
  };
  return layout(fields) === message ? fields : null;
}

/** True if the URI names the site: its origin is `siteOrigin`, and it is written with that origin in front. */
function uriIsOfSite(uri: string, origin: string): boolean {
  if (
    uri !== origin &&
    !uri.startsWith(`${origin}/`) &&
    !uri.startsWith(`${origin}?`) &&
    !uri.startsWith(`${origin}#`)
  ) {
    return false;
  }
  try {
    return new URL(uri).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Every sign-in check but the last, in the order of docs/CONTRACTS.md section 15:
 *
 * 1. the message is in the exact layout of EIP-4361, with no request id and no resources;
 * 2. the nonce carries this server's HMAC and has not expired;
 * 3. the domain is the host of the site, the URI's origin is the site's origin, the version is
 *    1, the chain ID is `CHAIN_ID` and the statement is `SIWE_STATEMENT`;
 * 4. `issuedAt` is at most ten minutes old and at most 60 seconds ahead, and the optional
 *    expiration and not-before times allow this moment;
 * 5. the signature recovers to the address in the message.
 *
 * The expensive step, the recovery, comes after everything that is cheap, so a message with an
 * invented nonce never reaches it. Returns the lower-case address, the nonce and the nonce's
 * expiry, or null. It never says which check failed. The caller spends the nonce last.
 */
export async function checkSignIn(
  message: string,
  signature: string,
  target: SiweTarget,
  nonces: NonceSigner,
  now: Date,
  beforeRecovery?: () => Promise<void>,
): Promise<{ address: string; nonce: string; nonceExpiresAt: string } | null> {
  // 1. The layout.
  const fields = readSiweMessage(message);
  if (fields === null) return null;

  // 2. The nonce is ours and has not expired.
  const nonceExpiresAt = await nonces.check(fields.nonce, now);
  if (nonceExpiresAt === null) return null;

  // 3. Domain, URI, version, chain ID and statement. Each is compared whole, never by its start.
  if (fields.domain !== target.domain) return null;
  if (fields.scheme !== null && fields.scheme !== target.scheme) return null;
  if (!uriIsOfSite(fields.uri, target.origin)) return null;
  if (fields.version !== '1' || fields.chainId !== String(CHAIN_ID) || fields.statement !== SIWE_STATEMENT) {
    return null;
  }

  // 4. Issued within the last ten minutes, and not from the future. NaN fails every comparison.
  const at = now.getTime();
  const issuedAt = Date.parse(fields.issuedAt);
  if (!(issuedAt <= at + CLOCK_SKEW_MS) || !(at - issuedAt <= ISSUED_WINDOW_MS)) return null;
  if (fields.expirationTime !== null && !(at < Date.parse(fields.expirationTime))) return null;
  if (fields.notBefore !== null && !(at >= Date.parse(fields.notBefore))) return null;

  // The caller's last check before the expensive step (the count for everyone). It may throw.
  if (beforeRecovery !== undefined) await beforeRecovery();

  // 5. The signature recovers to the address in the message. Ordinary wallet accounts only.
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    return null;
  }
  const address = fields.address.toLowerCase();
  if (recovered.toLowerCase() !== address) return null;
  return { address, nonce: fields.nonce, nonceExpiresAt };
}

/**
 * A signature that always recovers and belongs to nobody: `r` is the x coordinate of the curve's
 * generator, a public constant of secp256k1, and `s` is 1. No key made it and none is stored.
 */
const WARM_SIGNATURE =
  `0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798${'00'.repeat(31)}011b` as const;

/**
 * Runs one signature recovery and throws the result away. The first recovery in a fresh Worker
 * is the slow one, because the curve's tables are built then. The Worker does this when it
 * starts, outside any request, so no sign-in pays for it inside its CPU limit. It reads no
 * secret and uses no randomness. True if the recovery ran to its end. It never throws.
 */
export async function warmSignIn(): Promise<boolean> {
  try {
    await recoverMessageAddress({ message: 'prix warm-up', signature: WARM_SIGNATURE });
    return true;
  } catch {
    return false;
  }
}
