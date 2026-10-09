import { AGENT_NAME_MAX, AGENT_NAME_MIN, RESERVED_AGENT_NAMES } from '@prix/contracts/constants';
import { checksumAddress, isAddress } from '../eip55.ts';

/**
 * The checks the listing form makes before it sends anything. They only save the person a
 * round trip: the API checks every request again and decides. Plain code, no schema library.
 * Each returns null for a value that passes, or the key of the sentence that says what is wrong.
 */

const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const RESERVED = new Set(RESERVED_AGENT_NAMES.map(nameKey));
const RESERVED_FRAGMENTS = ['official', 'admin', 'moderator', 'support', 'staff'];

export function checkAgentName(name: string): 'nameShort' | 'nameLong' | 'nameReserved' | 'nameRejected' | null {
  if (name.length < AGENT_NAME_MIN) return 'nameShort';
  if (name.length > AGENT_NAME_MAX) return 'nameLong';
  const key = nameKey(name);
  if (RESERVED.has(key) || key.startsWith('prix') || RESERVED_FRAGMENTS.some((part) => key.includes(part))) {
    return 'nameReserved';
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?$/.test(name)) return 'nameRejected';
  if (/ {2}/.test(name) || key.length < AGENT_NAME_MIN) return 'nameRejected';
  return null;
}

const ZERO = /^0x0{40}$/;

/** An address in any case. A mixed-case address must carry a valid EIP-55 checksum. */
export function checkWallet(
  value: string,
): 'walletMissing' | 'walletRejected' | 'walletChecksum' | 'walletZero' | null {
  if (value === '') return 'walletMissing';
  if (!isAddress(value)) return 'walletRejected';
  if (ZERO.test(value.toLowerCase())) return 'walletZero';
  const body = value.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksumAddress(value) !== value) return 'walletChecksum';
  return null;
}

/** A signature as a wallet or `cast` writes it: 0x and 65 bytes or more, up to the contract's limit. */
export function checkSignature(value: string): 'signatureMissing' | 'signatureRejected' | null {
  if (value === '') return 'signatureMissing';
  return /^0x[0-9a-fA-F]{130,4096}$/.test(value) ? null : 'signatureRejected';
}

/** An id the API issues: twelve characters of a to z and 2 to 7. */
export const idOk = (id: string): boolean => /^[a-z2-7]{12}$/.test(id);
