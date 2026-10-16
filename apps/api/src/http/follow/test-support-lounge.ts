import type {
  Address,
  ChatLink,
  Entitlements,
  EntitlementsReadOptions,
  FollowStore,
  IsoTime,
  LoungeConfig,
  LoungeMemberRecord,
  LoungeStore,
  SessionRecord,
  Store,
  TelegramLoungePort,
  TelegramSend,
} from '@prix/contracts';
import { entitlementsOfTier, SESSION_COOKIE, SESSION_TTL_SECONDS, TELEGRAM_SECRET_HEADER } from '@prix/contracts';
import { createApp } from '../index.ts';
import { hashToken, newSessionToken } from '../session.ts';
import type { FollowRouteDeps, LoungeRouteDeps } from './index.ts';

/**
 * What the unit tests of the lounge's join requests and of `GET /api/lounge` stand on
 * (docs/contracts/phase-6-holders-2.md sections 4.4 and 4.5): the follow routes' deps with a lounge store, a
 * Telegram port and a token read in memory, each writing to one `trace`. No D1, no Telegram. Nothing here
 * is imported by the Worker.
 */

export const SITE = 'https://prix.test';
export const SECRET = 'webhook-secret-for-tests-only-000';
/** A fake bot token: it must never appear in a log line or an answer. */
export const BOT_TOKEN = '123456:FAKE-TOKEN-NEVER-LOGGED';
export const CHAT_ID = -1001234567890;
export const INVITE = 'https://t.me/+AbCdEfGh12345678';
export const NOW = '2026-10-20T12:00:00.000Z';
export const WALLET = '0x00000000000000000000000000000000000000b1';
export const OTHER_WALLET = '0x00000000000000000000000000000000000000c2';
export const USER = 111_222_333;
export const OTHER_USER = 444_555_666;

export interface LoungeHarness {
  trace: string[];
  config: LoungeConfig;
  /** Private chats linked to wallets: `notify_chats` (chat id is the user id). `enabled` is never read. */
  chats: Map<number, { wallet: Address; enabled: boolean }>;
  members: Map<number, LoungeMemberRecord>;
  /** Rows the `full` count counts. */
  countExtra: { value: number };
  tiers: Map<string, Entitlements>;
  gatingOn: { value: boolean };
  /** The time of the successful read the holding rests on, per wallet; absent is null. */
  checkedAt: Map<string, IsoTime | null>;
  /** What each Telegram call answers, by method; default ok. */
  answers: Partial<Record<keyof TelegramLoungePort, TelegramSend>>;
  /** Every Telegram call with its arguments. */
  calls: { method: keyof TelegramLoungePort; chatId: number; arg: number | string }[];
  putRace: { value: boolean };
  webhook(body: unknown, options?: { secret?: string | null }): Promise<Response>;
  get(path: string, cookie?: string): Promise<Response>;
  signIn(address: string): Promise<string>;
  setNow(iso: string): void;
}

export function loungeHarness(
  options: { lounge?: boolean; holding?: boolean; telegram?: boolean } = {},
): LoungeHarness {
  let now = new Date(NOW);
  const trace: string[] = [];
  const config: LoungeConfig = { chatId: CHAT_ID, inviteUrl: INVITE };
  const chats = new Map<number, { wallet: Address; enabled: boolean }>();
  const members = new Map<number, LoungeMemberRecord>();
  const countExtra = { value: 0 };
  const tiers = new Map<string, Entitlements>();
  const gatingOn = { value: true };
  const checkedAt = new Map<string, IsoTime | null>();
  const answers: LoungeHarness['answers'] = {};
  const calls: LoungeHarness['calls'] = [];
  const putRace = { value: false };
  const sessions = new Map<string, SessionRecord>();

  const store: LoungeStore = {
    async chatWallet(chatId) {
      trace.push('store.chatWallet');
      return chats.get(chatId)?.wallet ?? null;
    },
    async members(userId, wallet) {
      trace.push('store.members');
      const byUser = members.get(userId) ?? null;
      const byWallet = [...members.values()].find((member) => member.wallet === wallet) ?? null;
      return { byUser, byWallet, count: members.size + countExtra.value };
    },
    async putMember(userId, wallet, at) {
      trace.push('store.putMember');
      const taken = [...members.values()].find(
        (member) => member.wallet === wallet && member.telegramUserId !== userId,
      );
      if (putRace.value || taken !== undefined) return 'wallet_taken';
      members.set(userId, { telegramUserId: userId, wallet, joinedAt: at, checkedDay: at.slice(0, 10) });
      return 'stored';
    },
    async deleteMember(userId) {
      trace.push('store.deleteMember');
      return members.delete(userId);
    },
    async listDue() {
      return [];
    },
    async markChecked() {},
  };

  function call(method: keyof TelegramLoungePort) {
    return async (chatId: number, arg: number | string): Promise<TelegramSend> => {
      trace.push(`telegram.${method}`);
      calls.push({ method, chatId, arg });
      return answers[method] ?? { ok: true };
    };
  }
  const port: TelegramLoungePort = {
    approveJoin: call('approveJoin'),
    declineJoin: call('declineJoin'),
    ban: call('ban'),
    unban: call('unban'),
    sendDirect: call('sendDirect') as TelegramLoungePort['sendDirect'],
  };

  const lounge: LoungeRouteDeps = {
    config,
    port,
    store,
    ...(options.holding === false
      ? {}
      : {
          async holding(address: Address) {
            trace.push('token.holding');
            // The tier and its read's time come from the one answer, as `holdingOf` gives them (H2-SEC-1).
            return {
              gatingOn: gatingOn.value,
              tier: (tiers.get(address) ?? entitlementsOfTier(0)).tier,
              checkedAt: checkedAt.get(address) ?? null,
            };
          },
        }),
  };

  const follow = {
    async getChat(address: Address): Promise<ChatLink | null> {
      trace.push('follow.getChat');
      for (const [chatId, chat] of chats) {
        if (chat.wallet === address) return { address, chatId, enabled: chat.enabled, linkedAt: NOW };
      }
      return null;
    },
    async redeemLinkCode() {
      trace.push('follow.redeemLinkCode');
      return { result: 'unknown' };
    },
    async deleteChatById() {
      trace.push('follow.deleteChatById');
    },
  } as unknown as FollowStore;

  const deps: FollowRouteDeps = {
    store: {
      async getSession(tokenHash: string) {
        return sessions.get(tokenHash) ?? null;
      },
    } as unknown as Store,
    sim: {} as FollowRouteDeps['sim'],
    scoring: {} as FollowRouteDeps['scoring'],
    sealer: {} as FollowRouteDeps['sealer'],
    rateLimiter: { allow: async () => true },
    config: {
      siteOrigin: SITE,
      adminAddresses: [],
      houseModel: '@cf/test/house-model',
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: [],
    },
    now: () => new Date(now.getTime()),
    follow,
    feed: {} as FollowRouteDeps['feed'],
    awards: {} as FollowRouteDeps['awards'],
    records: {} as FollowRouteDeps['records'],
    entitlements: {
      async entitlementsFor(address: Address | null, read?: EntitlementsReadOptions) {
        trace.push(`entitlements:${read?.cachedOnly === true ? 'cachedOnly' : 'full'}`);
        const value = (address === null ? undefined : tiers.get(address)) ?? entitlementsOfTier(0);
        return { ...value, gatingOn: gatingOn.value };
      },
    },
    telegram:
      options.telegram === false
        ? null
        : {
            config: { botUsername: 'PrixagentBot', webhookSecret: SECRET },
            port: {
              async sendMessage(chatId: number) {
                trace.push(`telegram.sendMessage:${chatId}`);
                return { ok: true };
              },
              // The first holders wave's two webhook calls (docs/contracts/phase-6-holders.md section 7), which
              // `TelegramPort` carries once both waves are merged. The lounge's cases never reach them.
              async setWebhook() {
                trace.push('telegram.setWebhook');
                return true;
              },
              async getWebhookInfo() {
                trace.push('telegram.getWebhookInfo');
                return null;
              },
            },
          },
    ...(options.lounge === false ? {} : { lounge }),
  };
  const app = createApp(deps, { follow: deps });

  return {
    trace,
    config,
    chats,
    members,
    countExtra,
    tiers,
    gatingOn,
    checkedAt,
    answers,
    calls,
    putRace,
    setNow(iso) {
      now = new Date(iso);
    },
    async signIn(address) {
      const token = newSessionToken();
      const tokenHash = await hashToken(token);
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      sessions.set(tokenHash, { tokenHash, address, createdAt: now.toISOString(), expiresAt });
      return token;
    },
    async webhook(body, request = {}) {
      const headers = new Headers({ 'Content-Type': 'application/json', 'CF-Connecting-IP': '149.154.167.1' });
      const secret = request.secret === undefined ? SECRET : request.secret;
      if (secret !== null) headers.set(TELEGRAM_SECRET_HEADER, secret);
      return app.fetch(
        new Request(`${SITE}/api/telegram/webhook`, { method: 'POST', headers, body: JSON.stringify(body) }),
      );
    },
    async get(path, cookie) {
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
      if (cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${cookie}`);
      return app.fetch(new Request(`${SITE}${path}`, { headers }));
    },
  };
}

/** A join request of `userId` to `chatId`, as Telegram sends it. */
export function joinUpdate(userId: number, fields: { chatId?: number; isBot?: boolean } = {}): unknown {
  return {
    update_id: 1,
    chat_join_request: {
      chat: { id: fields.chatId ?? CHAT_ID, type: 'supergroup', title: 'Prix Community' },
      from: { id: userId, is_bot: fields.isBot ?? false, first_name: 'Someone' },
      user_chat_id: userId,
      date: 1_760_961_600,
      invite_link: { invite_link: INVITE },
    },
  };
}
