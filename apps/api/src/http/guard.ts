import type { ApiDeps, RateLimitRule, SessionRecord } from '@prix/contracts';
import { API_WRITE_ROWS_PER_DAY, MAX_BODY_BYTES, WALLET_WRITES_PER_DAY } from '@prix/contracts';
import { failures } from './errors.ts';
import { hashToken, readSessionToken } from './session.ts';

/** How long a client is told to wait. Every rule of docs/CONTRACTS.md section 15 counts per minute. */
const RETRY_AFTER_SECONDS = 60;

/**
 * The /64 network of an IPv6 address, written as an address (`2001:db8:0:1::`), so the limiter
 * still receives an IP address. One home or one server usually holds the whole /64, so counting
 * single addresses would let it start a new count at will.
 */
function ipv6Network(address: string, groupCount = 4): string {
  const [head = '', tail, extra] = address.split('::');
  if (extra !== undefined) return address;
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const gap = Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = tail === undefined ? left : [...left, ...gap, ...right];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return address;
  const network = groups.slice(0, groupCount).map((group) => group.replace(/^0+(?=.)/, ''));
  return `${network.join(':')}::`;
}

/**
 * Who a request is counted against when it has no wallet: `CF-Connecting-IP` and nothing else.
 * Cloudflare sets it on every request from the internet and a client cannot override it. No
 * other header is read, because every other header is the client's to write. A request without
 * it is counted with every other such request, so leaving the header out never lifts a limit.
 */
export function clientSubject(request: Request): string {
  const address = request.headers.get('cf-connecting-ip')?.trim().toLowerCase();
  if (!address || address.length > 64) return 'unknown';
  // An IPv4 address written inside an IPv6 one keeps all of itself.
  return address.includes(':') && !address.includes('.') ? ipv6Network(address) : address;
}

/**
 * The network of a request for the limits on creating agents, claiming wallets and the public
 * trust lookup: an IPv4 address, or the /48 of an IPv6 one. A cheap server comes with a /48 or a
 * /56, which is hundreds of /64 networks, so counting /64 would not hold one actor to one count.
 */
export function clientNetwork(request: Request): string {
  const address = request.headers.get('cf-connecting-ip')?.trim().toLowerCase();
  if (!address || address.length > 64) return 'unknown';
  return address.includes(':') && !address.includes('.') ? ipv6Network(address, 3) : address;
}

/** Refuses with 429 when the limiter says no. The limiter itself refuses when it cannot count. */
export async function enforceLimit(deps: ApiDeps, rule: RateLimitRule, subject: string): Promise<void> {
  if (!(await deps.rateLimiter.allow(rule, subject))) throw failures.rateLimited(RETRY_AFTER_SECONDS);
}

/**
 * A body that says it is larger than `MAX_BODY_BYTES` is refused before anything reads it, on
 * every route, including the ones that take no body. A body that does not say its size is
 * counted while it is read (input.ts).
 */
export function assertBodyDeclaredSmall(request: Request): void {
  const declared = request.headers.get('content-length');
  if (declared === null) return;
  if (!/^\d{1,15}$/.test(declared.trim()) || Number(declared) > MAX_BODY_BYTES) throw failures.bodyTooLarge();
}

/**
 * A request that changes state must carry the JSON content type, even when it has no body, and
 * come from the site. A form in another site cannot send either, and a script in another site
 * cannot send the first without a preflight, which this API never answers: it sends no CORS
 * headers at all.
 */
export function assertFromSite(deps: ApiDeps, request: Request): void {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json' || request.headers.get('origin') !== deps.config.siteOrigin) {
    throw failures.badRequestOrigin();
  }
}

/** The session of a request, or null. The store sees only the hash of the token. */
export async function readSession(deps: ApiDeps, request: Request): Promise<SessionRecord | null> {
  const token = readSessionToken(request);
  if (token === null) return null;
  const now = deps.now().toISOString();
  const session = await deps.store.getSession(await hashToken(token), now);
  if (session === null || session.expiresAt <= now) return null;
  return session;
}

export async function requireSession(deps: ApiDeps, request: Request): Promise<SessionRecord> {
  const session = await readSession(deps, request);
  if (session === null) throw failures.unauthorized();
  return session;
}

/**
 * The gate of every route that changes something for a signed-in wallet: the request comes
 * from the site, the wallet is signed in, and the wallet is inside the `write` limit. Storing a
 * key and deleting one use the same rule as every other write.
 */
export async function requireWriter(deps: ApiDeps, request: Request, rows: number): Promise<SessionRecord> {
  assertFromSite(deps, request);
  const session = await requireSession(deps, request);
  await enforceLimit(deps, 'write', session.address);
  const day = deps.now().toISOString().slice(0, 10);
  // The wallet's own count first, then the day's rows. A refusal writes nothing further.
  if (!(await deps.store.spendWalletWrite(session.address, day, WALLET_WRITES_PER_DAY))) {
    throw failures.dailyLimit(deps.now());
  }
  await spendDay(deps, rows);
  return session;
}

/** Takes `rows` from the day's budget for API writes. 503 `daily_limit` when it would pass the maximum. */
export async function spendDay(deps: ApiDeps, rows: number): Promise<void> {
  const day = deps.now().toISOString().slice(0, 10);
  if (!(await deps.store.spendApiWrites(day, rows, API_WRITE_ROWS_PER_DAY))) throw failures.dailyLimit(deps.now());
}
