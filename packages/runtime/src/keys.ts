import type { CreateKeyOpener, CreateKeySealer } from '@prix/contracts';
import { modelKeyAad } from '@prix/contracts';
import { fromBase64, toBase64, utf8 } from './text.ts';

/**
 * Sealing and opening model keys. docs/CONTRACTS.md sections 12 and 15.
 *
 * AES-256-GCM through Web Crypto and a fresh 12-byte nonce for every seal. The additional
 * authenticated data is `modelKeyAad(record)`: the record's id, owner, provider and key
 * version. A ciphertext copied to another row or another owner does not open, and neither does
 * one whose row now names another provider, so a key can only ever travel to the company it
 * was stored for. Nothing here logs, and no error carries a key or a secret.
 */

const NONCE_BYTES = 12;
const SECRET_BYTES = 32;
const TAG_BITS = 128;

function importSecret(secretBase64: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> | null {
  const secret = typeof secretBase64 === 'string' ? fromBase64(secretBase64.trim()) : null;
  if (secret === null || secret.length !== SECRET_BYTES) return null;
  return crypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, [usage]);
}

/**
 * The sealing half. The API gets this one and has no way to open what it seals.
 *
 * The caller builds the AAD from the record it is about to store, and the record's key version
 * is part of it, so the sealer says which version it writes before it seals: `keyVersion`.
 */
export const createKeySealer: CreateKeySealer = (secretBase64, keyVersion) => {
  let imported: Promise<CryptoKey> | null | undefined;

  return {
    keyVersion,
    async seal(apiKey, aad) {
      if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
        throw new Error('The key version must be a positive integer.');
      }
      if (imported === undefined) imported = importSecret(secretBase64, 'encrypt');
      if (imported === null) {
        throw new Error('KEY_ENCRYPTION_KEY must be 32 random bytes in base64.');
      }
      const key = await imported;
      const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: TAG_BITS },
        key,
        utf8(apiKey),
      );
      return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv), keyVersion };
    },
  };
};

/** The opening half. Only the scheduler gets one, and it opens a key at the moment of a model call. */
export const createKeyOpener: CreateKeyOpener = (secretsByVersion) => {
  const imported = new Map<number, Promise<CryptoKey> | null>();

  function secretFor(version: number): Promise<CryptoKey> | null {
    const known = imported.get(version);
    if (known !== undefined) return known;
    const secret = Object.hasOwn(secretsByVersion, version) ? secretsByVersion[version] : undefined;
    const key = secret === undefined ? null : importSecret(secret, 'decrypt');
    imported.set(version, key);
    return key;
  }

  return {
    async open(record) {
      try {
        const secret = secretFor(record.keyVersion);
        if (secret === null) return null;
        const iv = fromBase64(record.iv);
        const ciphertext = fromBase64(record.ciphertext);
        if (iv === null || iv.length !== NONCE_BYTES || ciphertext === null) return null;
        const opened = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: utf8(modelKeyAad(record)), tagLength: TAG_BITS },
          await secret,
          ciphertext,
        );
        // Both options are spelled out: the Workers types have no default for either.
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(opened);
      } catch {
        // Wrong secret, wrong row, wrong owner, wrong provider or damaged data. The reason is not reported.
        return null;
      }
    },
  };
};
