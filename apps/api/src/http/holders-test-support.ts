import type {
  Address,
  ApiError,
  Entitlements,
  EntitlementsReadOptions,
  FollowApiDeps,
  IsoTime,
  KeySealer,
  OwnerHoldsStore,
  PollApiDeps,
  PollResultRecord,
  PollStore,
  PollTallyOutcome,
  PollVoter,
  RateLimitRule,
  ScoringEngine,
  SessionRecord,
  SimEngine,
  Store,
  TelegramWebhookAdminResponse,
} from '@prix/contracts';
import { entitlementsOfTier, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@prix/contracts';
import type { AppExtras } from './index.ts';
import { createApp } from './index.ts';
import { hashToken, newSessionToken } from './session.ts';

/**
 * What the unit tests of the holders round's routes stand on (docs/contracts/phase-6-holders.md): a poll store
 * and an owner-holds store in memory that keep the rules of their ports, the few ports of the API the routes
 * reach, and one list, `trace`, that every fake writes to, so that a test reads the order of a request's
 * steps and what a refusal left. No D1, no Worker. Nothing here is imported by the Worker.
 */

export const SITE = 'https://prix.test';
export const START = '2026-10-18T12:00:00.000Z';
export const ADMIN_AS_CONFIGURED = '0x00000000000000000000000000000000000009A1';
export const ADMIN = ADMIN_AS_CONFIGURED.toLowerCase();
export const HOUSE = '0x00000000000000000000000000000000000000a7';
export const HOLDER = '0x00000000000000000000000000000000000000b1';
export const OTHER = '0x00000000000000000000000000000000000000c2';

/** A poll store in memory with the batch's rules: the old count down, the row, the new count up, the cap inside. */
export class MemoryPollStore implements PollStore {
  readonly votes = new Map<string, { option: string; at: string }>();
  readonly counts = new Map<string, number>();
  readonly results: PollResultRecord[] = [];
  constructor(private readonly trace: string[]) {}

  private key(pollId: string, wallet: string): string {
    return `${pollId}|${wallet}`;
  }
  private countKey(pollId: string, option: string): string {
    return `${pollId}|${option}`;
  }

  async putVote(pollId: string, wallet: Address, option: string, at: IsoTime, maxVoters: number) {
    this.trace.push(`polls.putVote:${option}`);
    const previous = this.votes.get(this.key(pollId, wallet));
    if (previous === undefined) {
      let sum = 0;
      for (const [key, votes] of this.counts) if (key.startsWith(`${pollId}|`)) sum += votes;
      if (sum >= maxVoters) return 'full' as const;
    } else {
      const old = this.countKey(pollId, previous.option);
      this.counts.set(old, (this.counts.get(old) ?? 0) - 1);
    }
    this.votes.set(this.key(pollId, wallet), { option, at });
    const next = this.countKey(pollId, option);
    this.counts.set(next, (this.counts.get(next) ?? 0) + 1);
    return 'stored' as const;
  }

  async getVote(pollId: string, wallet: Address) {
    this.trace.push('polls.getVote');
    return this.votes.get(this.key(pollId, wallet))?.option ?? null;
  }

  async castCounts(pollId: string) {
    this.trace.push(`polls.castCounts:${pollId}`);
    const out: Record<string, number> = {};
    for (const [key, votes] of this.counts) {
      const [poll, option] = key.split('|');
      if (poll === pollId && option !== undefined) out[option] = votes;
    }
    return out;
  }

  async listVoters(): Promise<PollVoter[]> {
    throw new Error('not reached by a route');
  }

  async getResults(pollIds: readonly string[]) {
    this.trace.push(`polls.getResults:${pollIds.join(',')}`);
    return this.results.filter((result) => pollIds.includes(result.pollId));
  }

  async putResult(): Promise<boolean> {
    throw new Error('not reached by a route');
  }
  async deleteVotes(): Promise<number> {
    throw new Error('not reached by a route');
  }
  async pruneVoters(): Promise<number> {
    throw new Error('not reached by a route');
  }

  ledger(): unknown {
    return { votes: [...this.votes.entries()].sort(), counts: [...this.counts.entries()].sort() };
  }
}

export class MemoryOwnerHoldsStore implements OwnerHoldsStore {
  readonly shown = new Map<string, boolean>();
  fail = false;
  constructor(private readonly trace: string[]) {}
  async getShowHolds(wallet: Address) {
    this.trace.push('ownerHolds.get');
    if (this.fail) throw new Error('no such column: show_holds 0x00000000000000000000000000000000000000b1');
    return this.shown.get(wallet) ?? false;
  }
  async setShowHolds(wallet: Address, show: boolean, at: IsoTime) {
    this.trace.push(`ownerHolds.set:${show}:${at}`);
    this.shown.set(wallet, show);
  }
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks it against a schema
  json: any;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
  /** Headers set last, as they are. */
  headers?: Record<string, string>;
}

export interface HarnessOptions {
  pollsEnabled?: boolean;
  /** Whether the entry hands `polls` to the app at all. Default true. */
  pollsGiven?: boolean;
  /** Whether `ApiDeps.ownerHolds` is given. Default true. */
  ownerHoldsGiven?: boolean;
  /** Whether `extras.token` is given (the owner-holds routes live with the token routes). Default true. */
  tokenGiven?: boolean;
  /** The follow extras: when given, the follow routes are mounted with the admins' set. */
  telegram?: {
    botUsername: string;
    setOk: boolean;
    info: TelegramWebhookAdminResponse | null;
  } | null;
  followGiven?: boolean;
  watchMovedAt?: IsoTime | null;
}

export interface Harness {
  trace: string[];
  polls: MemoryPollStore;
  ownerHolds: MemoryOwnerHoldsStore;
  spent: { walletWrites: number; rows: number };
  limiter: { denied: Set<RateLimitRule> };
  /** What the port of the tiers answers, by wallet in lower case; a wallet not named is tier 0. */
  tiers: Map<string, Entitlements>;
  asked: { address: string | null; options: EntitlementsReadOptions | undefined }[];
  entitlementsFail: { value: boolean };
  tally: { outcome: PollTallyOutcome; asked: string[]; throws: boolean };
  tierOnePpm: { value: number };
  telegramCalls: { set: unknown[]; info: number; sent: { chatId: number; text: string }[] };
  watch: { movedAt: IsoTime | null; cleared: number };
  logs: string[];
  setNow(iso: string): void;
  fetch(method: string, path: string, options?: RequestOptions): Promise<Reply>;
  signIn(address: string): Promise<string>;
  ledger(): unknown;
}

export function errorOf(reply: Reply): ApiError['error'] {
  return (reply.json as ApiError).error;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  let now = new Date(START);
  const trace: string[] = [];
  const polls = new MemoryPollStore(trace);
  const ownerHolds = new MemoryOwnerHoldsStore(trace);
  const spent = { walletWrites: 0, rows: 0 };
  const limiter = { denied: new Set<RateLimitRule>() };
  const tiers = new Map<string, Entitlements>();
  const asked: Harness['asked'] = [];
  const entitlementsFail = { value: false };
  const tally: Harness['tally'] = { outcome: { outcome: 'done', step: null }, asked: [], throws: false };
  const tierOnePpm = { value: 10 };
  const telegramCalls: Harness['telegramCalls'] = { set: [], info: 0, sent: [] };
  const watch = { movedAt: options.watchMovedAt ?? null, cleared: 0 };
  const logs: string[] = [];
  const sessions = new Map<string, SessionRecord>();

  const store: Partial<Store> = {
    async getSession(tokenHash) {
      trace.push('store.getSession');
      return sessions.get(tokenHash) ?? null;
    },
    async spendWalletWrite() {
      trace.push('store.spendWalletWrite');
      spent.walletWrites += 1;
      return true;
    },
    async spendApiWrites(_day, rows) {
      trace.push(`store.spendApiWrites:${rows}`);
      spent.rows += rows;
      return true;
    },
  };

  const entitlements = {
    async entitlementsFor(address: string | null, read?: EntitlementsReadOptions) {
      trace.push(`entitlements:${read?.cachedOnly === true ? 'cachedOnly' : 'full'}`);
      asked.push({ address, options: read });
      if (entitlementsFail.value) throw new Error('entitlements failed');
      return tiers.get((address ?? '').toLowerCase()) ?? entitlementsOfTier(0);
    },
  };

  const base = {
    store: store as Store,
    sim: {} as SimEngine,
    scoring: {} as ScoringEngine,
    sealer: {} as KeySealer,
    rateLimiter: {
      async allow(rule: RateLimitRule, subject: string) {
        trace.push(`limiter:${rule}:${subject}`);
        return !limiter.denied.has(rule);
      },
    },
    config: {
      siteOrigin: SITE,
      adminAddresses: [ADMIN_AS_CONFIGURED],
      houseModel: '@cf/test/house-model',
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: [HOUSE],
    },
    now: () => {
      trace.push('clock');
      return new Date(now.getTime());
    },
    entitlements,
    ...(options.ownerHoldsGiven === false ? {} : { ownerHolds }),
  };

  const pollDeps: PollApiDeps = {
    ...base,
    polls,
    pollsEnabled: options.pollsEnabled ?? true,
    async tierOnePpm() {
      trace.push('tierOnePpm');
      return tierOnePpm.value;
    },
    async tally(poll) {
      trace.push(`tally:${poll.id}`);
      tally.asked.push(poll.id);
      if (tally.throws) throw new Error('tally threw 0x00000000000000000000000000000000000000b1');
      return tally.outcome;
    },
  };

  const extras: AppExtras = {};
  if (options.pollsGiven !== false) extras.polls = pollDeps;
  if (options.tokenGiven !== false) {
    extras.token = {
      service: {} as never,
    } as AppExtras['token'];
  }
  if (options.followGiven === true) {
    const telegram = options.telegram ?? null;
    const follow: FollowApiDeps = {
      ...base,
      follow: {
        async getChat() {
          trace.push('follow.getChat');
          return null;
        },
        async putLinkCode() {
          trace.push('follow.putLinkCode');
        },
        async redeemLinkCode() {
          trace.push('follow.redeemLinkCode');
          return { result: 'linked', address: HOLDER };
        },
      } as unknown as FollowApiDeps['follow'],
      feed: {} as FollowApiDeps['feed'],
      awards: {} as FollowApiDeps['awards'],
      records: {} as FollowApiDeps['records'],
      telegram:
        telegram === null
          ? null
          : {
              config: { botUsername: telegram.botUsername, webhookSecret: 'secret-of-the-webhook-0123456789abcdef' },
              port: {
                async sendMessage(chatId: number, text: string) {
                  telegramCalls.sent.push({ chatId, text });
                  return { ok: true };
                },
                async setWebhook(input) {
                  trace.push('telegram.setWebhook');
                  telegramCalls.set.push(input);
                  return telegram.setOk;
                },
                async getWebhookInfo() {
                  trace.push('telegram.getWebhookInfo');
                  telegramCalls.info += 1;
                  return telegram.info;
                },
              },
            },
      webhookWatch: {
        async movedAt() {
          trace.push('watch.movedAt');
          return watch.movedAt;
        },
        async markMoved(at: IsoTime) {
          watch.movedAt = at;
        },
        async clear() {
          trace.push('watch.clear');
          watch.cleared += 1;
          watch.movedAt = null;
        },
      },
    };
    extras.follow = follow;
  }

  const app = createApp(base, extras);

  return {
    trace,
    polls,
    ownerHolds,
    spent,
    limiter,
    tiers,
    asked,
    entitlementsFail,
    tally,
    tierOnePpm,
    telegramCalls,
    watch,
    logs,
    setNow(iso) {
      now = new Date(iso);
    },
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
      const origin = request.origin === undefined ? (changes ? SITE : null) : request.origin;
      if (origin !== null) headers.set('Origin', origin);
      const usual = changes ? 'application/json' : null;
      const type = request.contentType === undefined ? usual : request.contentType;
      if (type !== null) headers.set('Content-Type', type);
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
      const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
      const response = await app.fetch(new Request(`${SITE}${path}`, { method, headers, body }));
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, headers: response.headers, text, json };
    },
    async signIn(address) {
      const sessionToken = newSessionToken();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      const tokenHash = await hashToken(sessionToken);
      sessions.set(tokenHash, { tokenHash, address, createdAt: now.toISOString(), expiresAt });
      return sessionToken;
    },
    ledger() {
      return { spent: { ...spent }, polls: polls.ledger(), shown: [...ownerHolds.shown.entries()] };
    },
  };
}

/** The steps of a request without the entry's own `read` rule by address, the session reads and the clock. */
export function stepsOf(trace: readonly string[]): string[] {
  return trace.filter(
    (step) => !step.startsWith('limiter:read:203.0.113.9') && step !== 'store.getSession' && step !== 'clock',
  );
}
