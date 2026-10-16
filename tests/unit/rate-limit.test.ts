import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOM_PICTURE_RATE_BINDING, ROOM_PICTURE_RATE_NAMESPACE, ROOM_PICTURE_RATE_PER_MINUTE } from '@prix/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { RateLimitBinding } from '../../apps/api/src/rate-limit.ts';
import { createRateLimiter, ipSubjectKey, RATE_LIMIT_RULES } from '../../apps/api/src/rate-limit.ts';

/** The real limiter against a fake Rate Limiting binding (security review, minor finding on the limiter). */

function binding(answer: (key: string) => unknown = () => ({ success: true })) {
  const keys: string[] = [];
  const fake: RateLimitBinding = {
    limit: async ({ key }) => {
      keys.push(key);
      return answer(key) as { success: boolean };
    },
  };
  return { fake, keys };
}

describe('the rate limiter', () => {
  it('refuses when its binding is missing, and when it throws or answers with something else', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await createRateLimiter({}).allow('read', '203.0.113.1')).toBe(false);
      const throwing: RateLimitBinding = {
        limit: async () => {
          throw new Error('binding down');
        },
      };
      expect(await createRateLimiter({ RATE_READ: throwing }).allow('read', '203.0.113.1')).toBe(false);
      const odd = binding(() => ({ success: 'yes' }));
      expect(await createRateLimiter({ RATE_READ: odd.fake }).allow('read', '203.0.113.1')).toBe(false);
    } finally {
      quiet.mockRestore();
    }
  });

  it('refuses a write that has no wallet to count by, without asking the binding', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fake, keys } = binding();
    expect(await createRateLimiter({ RATE_WRITE: fake }).allow('write', '  ')).toBe(false);
    expect(keys).toEqual([]);
    quiet.mockRestore();
  });

  it('counts an IPv4 address as it is, and an IPv6 address by its /64', async () => {
    const v4 = binding();
    await createRateLimiter({ RATE_READ: v4.fake }).allow('read', '203.0.113.9');
    expect(v4.keys).toEqual(['ip:203.0.113.9']);

    const full = ipSubjectKey('2001:db8:aaaa:bbbb:1:2:3:4');
    expect(ipSubjectKey('2001:0DB8:aaaa:bbbb:ffff:ffff:ffff:ffff')).toBe(full);
    expect(ipSubjectKey('2001:db8:aaaa:bbbb::1')).toBe(full);
    expect(ipSubjectKey('2001:db8:aaaa:bbbb::')).toBe(full);
    expect(ipSubjectKey('2001:db8:aaaa:cccc::1')).not.toBe(full);
    expect(ipSubjectKey(full)).toBe(full);
    expect(ipSubjectKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipSubjectKey('')).toBe('unknown');
  });

  it('counts the subject before the shards, and refuses when every shard is full', async () => {
    const open = binding();
    expect(await createRateLimiter({ RATE_WRITE: open.fake }).allow('write', '0xAbC')).toBe(true);
    expect(open.keys).toEqual(['wallet:0xabc', 'all:0']);

    const full = binding((key) => ({ success: key.startsWith('wallet:') }));
    expect(await createRateLimiter({ RATE_WRITE: full.fake }).allow('write', '0xabc')).toBe(false);
    expect(full.keys.filter((key) => key.startsWith('all:')).length).toBeGreaterThan(1);

    const subjectFull = binding(() => ({ success: false }));
    expect(await createRateLimiter({ RATE_WRITE: subjectFull.fake }).allow('write', '0xabc')).toBe(false);
    expect(subjectFull.keys).toEqual(['wallet:0xabc']);
  });
});

describe('the rules and the Wrangler bindings', () => {
  /** `{ name, simple: { limit, period } }` of each entry of `ratelimits` in apps/api/wrangler.jsonc. */
  function bindings(): Map<string, { limit: number; period: number }> {
    const text = readFileSync(path.join(import.meta.dirname, '..', '..', 'apps', 'api', 'wrangler.jsonc'), 'utf8');
    const found = new Map<string, { limit: number; period: number }>();
    const entry = /"name":\s*"(RATE_\w+)"[^}]*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/g;
    for (const match of text.matchAll(entry)) {
      found.set(String(match[1]), { limit: Number(match[2]), period: Number(match[3]) });
    }
    return found;
  }

  it('gives every rule the limit its binding enforces, per 60 seconds', () => {
    const configured = bindings();
    // The three rules of the limiter, and since Phase 6.4 the `picture` rule of the two bytes routes of
    // the room's pictures, which is a binding of its own (docs/contracts/phase-6-pictures.md section 14).
    expect([...configured.keys()].sort()).toEqual(
      ['RATE_READ', 'RATE_SIGN_IN', 'RATE_WRITE', ROOM_PICTURE_RATE_BINDING].sort(),
    );
    for (const spec of Object.values(RATE_LIMIT_RULES)) {
      expect(configured.get(spec.binding)).toEqual({ limit: spec.perMinute, period: 60 });
    }
  });

  it('gives the picture rule the limit of the contract, in 60 seconds, in a namespace of its own', () => {
    expect(ROOM_PICTURE_RATE_BINDING).toBe('RATE_PICTURE');
    expect(bindings().get(ROOM_PICTURE_RATE_BINDING)).toEqual({ limit: ROOM_PICTURE_RATE_PER_MINUTE, period: 60 });
    const text = readFileSync(path.join(import.meta.dirname, '..', '..', 'apps', 'api', 'wrangler.jsonc'), 'utf8');
    const namespaces = [...text.matchAll(/"name":\s*"(RATE_\w+)",\s*"namespace_id":\s*"(\d+)"/g)].map((match) => [
      match[1],
      match[2],
    ]);
    expect(namespaces.find(([name]) => name === ROOM_PICTURE_RATE_BINDING)?.[1]).toBe(ROOM_PICTURE_RATE_NAMESPACE);
    // No two rules share a namespace: a count of one is never a count of another.
    expect(new Set(namespaces.map(([, id]) => id)).size).toBe(namespaces.length);
  });

  it('allows what the contract says per subject: sign-in 20, write 20, read 300 a minute', () => {
    expect(RATE_LIMIT_RULES.sign_in.perMinute).toBe(20);
    expect(RATE_LIMIT_RULES.write.perMinute).toBe(20);
    expect(RATE_LIMIT_RULES.read.perMinute).toBe(300);
  });
});
