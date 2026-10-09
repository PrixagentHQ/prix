import type { Address, ApiKeyRecord, Authenticator, DataCaller, DataDeps } from '@prix/contracts';
import { DATA_KEY_PATTERN, DATA_KEY_PREFIX, DATA_KEY_SHOWN_CHARS, DataFailure } from '@prix/contracts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 32 random bytes as 52 base32 characters (the last character carries four zero padding bits). */
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function generateApiKey(): { id: string; secret: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const idBytes = new Uint8Array(8);
  crypto.getRandomValues(idBytes);
  return { id: base32(idBytes).slice(0, 12), secret: `${DATA_KEY_PREFIX}${base32(bytes)}` };
}

/** SHA-256 of the whole key, lower-case hex. */
export async function hashApiKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The only place the Authorization header is read. */
export function readBearerKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function keyRecordOf(
  owner: Address,
  label: string,
  now: Date,
): Promise<{ record: ApiKeyRecord; secret: string }> {
  const { id, secret } = generateApiKey();
  return {
    secret,
    record: {
      id,
      owner,
      keyHash: await hashApiKey(secret),
      prefix: secret.slice(0, DATA_KEY_SHOWN_CHARS),
      label,
      createdAt: now.toISOString(),
      lastUsedDay: null,
      revokedAt: null,
    },
  };
}

const INVALID_KEY_MESSAGE =
  'This key is not valid. Check that you copied the whole key, or create a new one on your account page.';

export function createAuthenticator(deps: Pick<DataDeps, 'data' | 'entitlements' | 'now'>): Authenticator {
  return {
    async authenticate(request: Request): Promise<DataCaller> {
      const secret = readBearerKey(request);
      if (secret === null) {
        throw new DataFailure(
          'missing_key',
          'Send your key as the header "Authorization: Bearer <key>". Create one on your account page.',
        );
      }
      if (!DATA_KEY_PATTERN.test(secret)) throw new DataFailure('invalid_key', INVALID_KEY_MESSAGE);
      const found = await deps.data.authenticateKey(await hashApiKey(secret));
      if (found === null) throw new DataFailure('invalid_key', INVALID_KEY_MESSAGE);
      const entitlements = await deps.entitlements.entitlementsFor(found.owner);
      const day = deps.now().toISOString().slice(0, 10);
      if (found.lastUsedDay !== day) {
        try {
          await deps.data.markKeyUsed(found.keyId, day);
        } catch {
          // A missed last-used mark never fails a call.
        }
      }
      return { keyId: found.keyId, owner: found.owner, entitlements };
    },
  };
}
