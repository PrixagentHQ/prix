import type { RateLimiter, RateLimitRule } from '@prix/contracts';

/**
 * The rate limiter of docs/CONTRACTS.md section 15, built from what the Workers free plan offers.
 * It never writes to D1, so a cheap request cannot burn the daily row-write allowance.
 *
 * | Rule             | Per subject                 | For everyone together |
 * |------------------|-----------------------------|-----------------------|
 * | `sign_in`        | 20 a minute per IP address  | none                  |
 * | `sign_in_global` | none                        | 240 a minute          |
 * | `write`          | 20 a minute per wallet      | 120 a minute          |
 * | `read`           | 300 a minute per IP address | none                  |
 *
 * The limits per subject are those of the bindings in wrangler.jsonc (docs/CONTRACTS.md section
 * 16, D-083, D-096); `perMinute` below repeats them, and tests/unit/rate-limit.test.ts compares
 * the two.
 *
 * One mechanism: the Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc), read from the
 * Cloudflare docs on 2026-10-06. It counts in memory at the Cloudflare location that serves the
 * request, adds no network round trip and is not a subrequest. A binding has one limit and a
 * period of 10 or 60 seconds, and the contract names three bindings, one per rule.
 *
 * The global count uses the same binding as its rule. A binding allows `perMinute` calls per key,
 * so `globalShards` keys allow `perMinute * globalShards` calls together: 12 keys of 20 for
 * `sign_in_global`, 6 keys of 20 for `write`. A request takes the first global key that still has room,
 * and is refused when none has. The subject is counted first, so a subject that is over its own
 * limit uses up nothing of what everyone shares.
 *
 * The limiter refuses when it cannot count: a binding that is missing, that throws, or that
 * answers with anything but `{ success: boolean }` refuses the request. There is no fallback
 * counter. A Worker deployed without its bindings answers 429 to everything, which is loud, and
 * safer than a limit that silently is not there.
 *
 * Where this is weak, and what the runbook (infra/README.md) says about it:
 *
 * - Counts are per Cloudflare location and eventually consistent. Cloudflare calls the binding
 *   "permissive" and "not an accurate accounting system". Someone whose requests land in several
 *   locations gets each limit once per location, the global ones included. Treat every number as
 *   a ceiling on abuse, not as an exact quota.
 * - Windows are fixed, not sliding: up to twice a limit can pass across a window boundary.
 * - A request that is refused has still run the Worker, so it still counts against the 100,000
 *   requests a day. Only a rule on the zone, in front of the Worker, can protect that number.
 * - An IP address can be shared by many people, and one person can hold many addresses. IPv6 is
 *   counted per /64, which is what one subscriber line usually gets.
 * - The global count `sign_in_global` lets one busy attacker location shut sign-in for that location
 *   for a minute at a time. That is the price of a ceiling on signature checks.
 */

/** The part of a Rate Limiting binding this file uses. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The bindings `createRateLimiter` reads. The names and limits are set in wrangler.jsonc. */
export interface RateLimitEnv {
  /** 20 per 60 seconds. */
  RATE_SIGN_IN?: RateLimitBinding;
  /** 20 per 60 seconds. */
  RATE_WRITE?: RateLimitBinding;
  /** 300 per 60 seconds. */
  RATE_READ?: RateLimitBinding;
}

interface RuleSpec {
  binding: keyof RateLimitEnv;
  subject: 'ip' | 'wallet' | 'none';
  /** What the binding allows per key per 60 seconds. Must equal `simple.limit` in wrangler.jsonc. */
  perMinute: number;
  /** How many global keys there are. Everyone together gets `perMinute * globalShards` a minute. Zero: no global count. */
  globalShards: number;
}

/** Exported so that the runbook, the Wrangler file and a test can be compared with it. */
export const RATE_LIMIT_RULES: Readonly<Record<RateLimitRule, Readonly<RuleSpec>>> = {
  sign_in: { binding: 'RATE_SIGN_IN', subject: 'ip', perMinute: 20, globalShards: 0 },
  // The count for everyone, taken in verify before the signature is recovered. Shard keys only.
  sign_in_global: { binding: 'RATE_SIGN_IN', subject: 'none', perMinute: 20, globalShards: 12 },
  write: { binding: 'RATE_WRITE', subject: 'wallet', perMinute: 20, globalShards: 6 },
  read: { binding: 'RATE_READ', subject: 'ip', perMinute: 300, globalShards: 0 },
};

const MAX_SUBJECT_LENGTH = 64;
/** What every request without an address is counted as, so that leaving the address out never lifts a limit. */
const NO_ADDRESS = 'unknown';

const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function prefixKey(groups: readonly string[]): string {
  return `${groups.map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The counter key for an IP address, as `CF-Connecting-IP` gives it. IPv4 is used as it is. IPv6
 * is cut to its /64 prefix, so rotating through the addresses of one subscriber line does not
 * reset the count. An IPv4 address written inside an IPv6 one is the IPv4 address.
 *
 * The function gives the same key for an address, for its first four groups alone and for its own
 * result, so it does not matter whether the caller has already cut the address. Text that is not
 * an address is counted as itself: it can only ever share a count, never escape one.
 */
export function ipSubjectKey(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (ip === '' || ip === NO_ADDRESS) return NO_ADDRESS;
  if (IPV4.test(ip)) return ip;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];

  // Its own result, "a:b:c:d::/64", reads as the prefix it is.
  const address = ip.endsWith('::/64') ? ip.slice(0, -3) : ip;
  const halves = address.split('::');
  if (halves.length <= 2) {
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    let groups: string[];
    if (halves.length === 2) {
      // "::" stands for the groups that are left out, and for at least one.
      const missing = 8 - head.length - tail.length;
      groups = missing >= 1 ? [...head, ...new Array<string>(missing).fill('0'), ...tail] : [];
    } else {
      // Four groups and nothing else is a prefix that a caller has already cut.
      groups = head.length === 4 ? [...head, '0', '0', '0', '0'] : head;
    }
    if (groups.length === 8 && groups.every((group) => IPV6_GROUP.test(group))) return prefixKey(groups.slice(0, 4));
  }
  return ip.slice(0, MAX_SUBJECT_LENGTH);
}

/** The counter key of a rule's subject, or null when there is nothing to count by. */
function subjectKey(kind: 'ip' | 'wallet', subject: string): string | null {
  if (kind === 'ip') return `ip:${ipSubjectKey(subject)}`;
  const wallet = subject.trim().toLowerCase();
  // A write always has a wallet. One without is a bug upstream, and is refused.
  return wallet === '' ? null : `wallet:${wallet.slice(0, MAX_SUBJECT_LENGTH)}`;
}

type Unavailable = 'binding_missing' | 'binding_failed' | 'binding_answer_invalid' | 'subject_missing';

/** `env` is the Worker's bindings. Every rule needs its binding: without it the rule refuses every request. */
export function createRateLimiter(env: RateLimitEnv): RateLimiter {
  const reported = new Set<string>();

  /** One line per rule and reason per isolate, so a broken limiter is seen without filling the log. */
  function reportOnce(rule: RateLimitRule, reason: Unavailable): void {
    const id = `${rule}:${reason}`;
    if (reported.has(id)) return;
    reported.add(id);
    console.error(JSON.stringify({ event: 'rate_limit_unavailable', rule, reason }));
  }

  /** True only when the binding counted the call and allowed it. */
  async function count(rule: RateLimitRule, binding: RateLimitBinding, key: string): Promise<boolean> {
    let outcome: unknown;
    try {
      outcome = await binding.limit({ key });
    } catch {
      reportOnce(rule, 'binding_failed');
      return false;
    }
    const success = typeof outcome === 'object' && outcome !== null ? (outcome as { success?: unknown }).success : null;
    if (typeof success !== 'boolean') {
      reportOnce(rule, 'binding_answer_invalid');
      return false;
    }
    return success;
  }

  return {
    async allow(rule, subject) {
      const spec = RATE_LIMIT_RULES[rule];
      const binding = env[spec.binding];
      if (binding === undefined || binding === null || typeof binding.limit !== 'function') {
        reportOnce(rule, 'binding_missing');
        return false;
      }
      if (spec.subject !== 'none') {
        const key = subjectKey(spec.subject, typeof subject === 'string' ? subject : '');
        if (key === null) {
          reportOnce(rule, 'subject_missing');
          return false;
        }
        if (!(await count(rule, binding, key))) return false;
      }
      if (spec.globalShards === 0) return true;
      for (let shard = 0; shard < spec.globalShards; shard += 1) {
        if (await count(rule, binding, `all:${shard}`)) return true;
      }
      return false;
    },
  };
}
