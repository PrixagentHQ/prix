import { modelKeyAad } from '@prix/contracts';
import { createKeyOpener, createKeySealer } from '@prix/runtime';
import { describe, expect, it } from 'vitest';
import { testAddress, testId } from '../support/fixtures.ts';

/**
 * Sealing of model keys, docs/CONTRACTS.md section 12: AES-256-GCM through Web Crypto, a
 * fresh 12-byte nonce for every seal, and additional authenticated data that binds a
 * ciphertext to its row and its owner. The secrets below are fixtures made from a counter.
 */

function fixtureSecret(seed: number): string {
  const bytes = new Uint8Array(32).map((_, index) => (index * 17 + seed * 29 + 3) % 256);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const SECRET = fixtureSecret(1);
const OTHER_SECRET = fixtureSecret(2);
const API_KEY = 'fixture-key-Zq7Lm2Xv9Rt4Kp8Wn3Bc6Hy1Jd5Fg0As';
const row = { id: testId('key', 1), owner: testAddress(1), provider: 'openai' as const };

/** Seals as the API does: the sealer says its version, the caller builds the AAD from it. */
async function sealed(apiKey = API_KEY, target = row, secret = SECRET, version = 1) {
  const sealer = createKeySealer(secret, version);
  const result = await sealer.seal(apiKey, modelKeyAad({ ...target, keyVersion: sealer.keyVersion }));
  return { ...target, ...result };
}

describe('createKeySealer', () => {
  it('returns ciphertext, a 12-byte nonce and the key version, all as text', async () => {
    const record = await sealed();
    expect(record.keyVersion).toBe(1);
    expect(fromBase64(record.iv)).toHaveLength(12);
    // AES-GCM adds a 16-byte tag and no padding.
    expect(fromBase64(record.ciphertext)).toHaveLength(API_KEY.length + 16);
  });

  it('never leaves the key readable in what it returns', async () => {
    const record = await sealed();
    const text = JSON.stringify(record);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(btoa(API_KEY));
    expect(new TextDecoder().decode(fromBase64(record.ciphertext))).not.toContain(API_KEY.slice(0, 8));
  });

  it('uses a fresh nonce for every seal, so the same key never gives the same ciphertext', async () => {
    const sealer = createKeySealer(SECRET, 1);
    const aad = modelKeyAad({ ...row, keyVersion: sealer.keyVersion });
    const results = await Promise.all(Array.from({ length: 200 }, () => sealer.seal(API_KEY, aad)));
    expect(new Set(results.map((result) => result.iv)).size).toBe(200);
    expect(new Set(results.map((result) => result.ciphertext)).size).toBe(200);
  });

  it('is AES-256-GCM with the additional data of the contract: Web Crypto alone can open it', async () => {
    const record = await sealed();
    const key = await crypto.subtle.importKey('raw', fromBase64(SECRET), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(record.iv),
        additionalData: new TextEncoder().encode(`${row.id}:${row.owner}:${row.provider}:1`),
      },
      key,
      fromBase64(record.ciphertext),
    );
    expect(new TextDecoder().decode(plain)).toBe(API_KEY);
  });

  it('stamps the version it was given', async () => {
    expect((await sealed(API_KEY, row, OTHER_SECRET, 7)).keyVersion).toBe(7);
  });

  it.each([
    ['empty', ''],
    ['16 bytes, which would silently be AES-128', btoa('a'.repeat(16))],
    ['24 bytes, which would silently be AES-192', btoa('a'.repeat(24))],
    ['31 bytes', btoa('a'.repeat(31))],
    ['33 bytes', btoa('a'.repeat(33))],
    ['not base64', 'not base64 at all !!'],
  ])('refuses a secret that is %s instead of sealing with a weak key', async (_why, secret) => {
    await expect(async () =>
      createKeySealer(secret, 1).seal(API_KEY, modelKeyAad({ ...row, keyVersion: 1 })),
    ).rejects.toBeDefined();
  });
});

describe('createKeyOpener', () => {
  it('opens what the sealer sealed', async () => {
    const record = await sealed();
    expect(await createKeyOpener({ 1: SECRET }).open(record)).toBe(API_KEY);
  });

  it('opens keys of every length a key may have, and keys with unusual characters', async () => {
    const opener = createKeyOpener({ 1: SECRET });
    for (const apiKey of ['a'.repeat(16), 'b'.repeat(300), 'k3y_with-symbols.~!@#$%^&*()+=/?']) {
      expect(await opener.open(await sealed(apiKey))).toBe(apiKey);
    }
  });

  it('returns null for a ciphertext moved to another row', async () => {
    const record = await sealed();
    expect(await createKeyOpener({ 1: SECRET }).open({ ...record, id: testId('key', 2) })).toBeNull();
  });

  it('returns null for a ciphertext moved to another owner', async () => {
    const record = await sealed();
    expect(await createKeyOpener({ 1: SECRET }).open({ ...record, owner: testAddress(2) })).toBeNull();
  });

  it('returns null for a ciphertext moved to another provider, so the key never goes to another company', async () => {
    const record = await sealed();
    expect(await createKeyOpener({ 1: SECRET }).open({ ...record, provider: 'anthropic' })).toBeNull();
  });

  it('returns null with the wrong secret', async () => {
    const record = await sealed();
    expect(await createKeyOpener({ 1: OTHER_SECRET }).open(record)).toBeNull();
  });

  it('returns null for a version it has no secret for', async () => {
    const record = await sealed();
    expect(await createKeyOpener({ 2: SECRET }).open(record)).toBeNull();
    expect(await createKeyOpener({}).open(record)).toBeNull();
  });

  it('returns null, and never throws, for damaged data', async () => {
    const record = await sealed();
    const opener = createKeyOpener({ 1: SECRET });
    const bytes = fromBase64(record.ciphertext);
    bytes[0] = (bytes[0] as number) ^ 1;
    const flipped = btoa(String.fromCharCode(...bytes));
    for (const damaged of [
      { ...record, ciphertext: flipped },
      { ...record, ciphertext: record.ciphertext.slice(0, -8) },
      { ...record, ciphertext: '' },
      { ...record, ciphertext: 'not base64 !!' },
      { ...record, iv: '' },
      { ...record, iv: btoa('short') },
      { ...record, iv: 'not base64 !!' },
    ]) {
      expect(await opener.open(damaged)).toBeNull();
    }
  });

  it('keeps old keys readable after the secret is rotated', async () => {
    const old = await sealed(API_KEY, row, SECRET, 1);
    const fresh = await sealed(
      'fixture-key-after-rotation-0123456789',
      { id: testId('key', 3), owner: row.owner, provider: 'openai' as const },
      OTHER_SECRET,
      2,
    );
    const opener = createKeyOpener({ 1: SECRET, 2: OTHER_SECRET });
    expect(await opener.open(old)).toBe(API_KEY);
    expect(await opener.open(fresh)).toBe('fixture-key-after-rotation-0123456789');
  });
});
