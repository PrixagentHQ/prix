import type {
  Entitlements,
  EntitlementsPort,
  IsoTime,
  LoungeJoinFacts,
  LoungeJoinRefusal,
  TelegramJoinRequest,
} from '@prix/contracts';
import { LOUNGE_DIRECT_MEMORY_MAX, loungeDirectMessage, loungeJoinDecision } from '@prix/contracts';
import type { LoungeRouteDeps } from './index.ts';

/**
 * Phase 6.8, G: a join request to the lounge, judged in the webhook (docs/contracts/phase-6-holders-2.md
 * section 4.4). The webhook has already checked its secret and parsed the update. In this order, stopping at
 * the first refusal and leaving every later read unread: the lounge and its chat, a bot, the linked wallet,
 * the lounge's rows, the wallet's tier read fresh with the time of its read, the count; then the row and the
 * approval. `loungeJoinDecision` is the one rule; this file only reads in its order.
 *
 * Nothing here trusts the update but the Telegram account's id, which Telegram signs into the update behind
 * the webhook's secret: the wallet is the account's own linked chat, the tier is the token service's.
 * No log line carries a wallet, a Telegram id, a name, a text or a token.
 */

/** A log line of the lounge: the event and a reason or an answer's kind, nothing else. */
function logLounge(event: string, detail: { reason?: string; answer?: string } = {}): void {
  const line = JSON.stringify({ event, ...detail });
  if (event === 'lounge_join_failed') console.error(line);
  else console.log(line);
}

/**
 * The direct messages already sent: one per Telegram user per reason per UTC day, in this isolate's memory,
 * at most LOUNGE_DIRECT_MEMORY_MAX entries. Past days are dropped first, then the oldest entries: a message
 * that is sent twice when the memory overflows costs one more message, never a missed decline.
 */
export function createDirectMemory(max = LOUNGE_DIRECT_MEMORY_MAX) {
  const sent = new Map<string, string>();
  return {
    /** True the first time this user, reason and day are seen; it then remembers them. */
    first(userId: number, reason: LoungeJoinRefusal, day: string): boolean {
      const key = `${userId}:${reason}:${day}`;
      if (sent.has(key)) return false;
      if (sent.size >= max) {
        for (const [entry, entryDay] of sent) if (entryDay !== day) sent.delete(entry);
        while (sent.size >= max) {
          const oldest = sent.keys().next().value;
          if (oldest === undefined) break;
          sent.delete(oldest);
        }
      }
      sent.set(key, day);
      return true;
    },
  };
}
export type DirectMemory = ReturnType<typeof createDirectMemory>;

export interface JoinDeps {
  lounge: LoungeRouteDeps | null;
  entitlements: EntitlementsPort;
  siteOrigin: string;
  memory: DirectMemory;
}

/** Judges one join request and does what the rule says. Never throws past the caller's own catch. */
export async function handleJoinRequest(deps: JoinDeps, request: TelegramJoinRequest, now: IsoTime): Promise<void> {
  const lounge = deps.lounge;
  const facts: LoungeJoinFacts = {
    config: lounge?.config ?? null,
    request: { chat: request.chat, from: request.from },
    linkedWallet: null,
    members: null,
    entitlements: null,
    holdingCheckedAt: null,
    now,
  };

  // 1 and 2. The lounge and its chat, then a bot: nothing is read for either.
  if (lounge === null || facts.config === null || request.chat.id !== facts.config.chatId) return;
  if (request.from.is_bot) return decline(deps, lounge, request, 'bot', now);

  // 3. The wallet linked to this account's private chat, whatever its notes' switch says.
  facts.linkedWallet = await lounge.store.chatWallet(request.from.id);
  if (facts.linkedWallet === null) return decide(deps, lounge, request, facts);
  const wallet = facts.linkedWallet;

  // 4. The lounge's rows: this account's, this wallet's, and the count `full` takes.
  facts.members = await lounge.store.members(request.from.id, wallet, now);
  const byWallet = facts.members.byWallet;
  if (byWallet !== null && byWallet.telegramUserId !== request.from.id) return decide(deps, lounge, request, facts);

  // 5. The gate, read without `cachedOnly`; the gate off stops here, before any freshness read. Then the
  //    tier AND the time of the read it rests on, both from the one `holdingOf` answer: its tier is the
  //    stored row's settled tier (so the hour before a tier rises holds), and an approval needs that read to
  //    be younger than TOKEN_CACHE_SECONDS. The tier is never taken from `entitlementsFor` beside a time
  //    from another read: that answer may come from the isolate's wallet memory of an older row (H2-SEC-1).
  const entitlements: Entitlements = await deps.entitlements.entitlementsFor(wallet);
  facts.entitlements = { gatingOn: entitlements.gatingOn, tier: entitlements.tier };
  if (!entitlements.gatingOn) return decide(deps, lounge, request, facts);
  if (lounge.holding === undefined) return decide(deps, lounge, request, facts);
  const holding = await lounge.holding(wallet);
  facts.entitlements = { gatingOn: holding.gatingOn, tier: holding.tier ?? 0 };
  facts.holdingCheckedAt = holding.checkedAt ?? null;

  // 6 and 7. The count, then the approval: both in the rule.
  return decide(deps, lounge, request, facts);
}

async function decide(
  deps: JoinDeps,
  lounge: LoungeRouteDeps,
  request: TelegramJoinRequest,
  facts: LoungeJoinFacts,
): Promise<void> {
  const decision = loungeJoinDecision(facts);
  if (decision.action === 'ignore') return;
  if (decision.action === 'decline') return decline(deps, lounge, request, decision.reason, facts.now);
  const wallet = facts.linkedWallet;
  if (wallet === null) return;

  // 7. The row first, then the approval. `wallet_taken` here is step 4's refusal, lost in a race.
  const stored = await lounge.store.putMember(request.from.id, wallet, facts.now);
  if (stored === 'wallet_taken') return decline(deps, lounge, request, 'wallet_taken', facts.now);
  const approved = await lounge.port.approveJoin(lounge.config.chatId, request.from.id);
  if (approved.ok) {
    logLounge('lounge_join_approved');
    return;
  }
  // Rejected: Telegram will not let this account in, so the row goes. Anything else may have succeeded:
  // the row stays, and the sweep judges it like any member.
  if (approved.reason === 'rejected') await lounge.store.deleteMember(request.from.id);
  logLounge('lounge_join_failed', { answer: approved.reason });
}

/**
 * A decline: the direct message first, for every reason but a bot and at most once a user, a reason, a day,
 * then the decline whatever the message answered. Telegram lets the bot write to `user_chat_id` only until
 * the request is processed.
 */
async function decline(
  deps: JoinDeps,
  lounge: LoungeRouteDeps,
  request: TelegramJoinRequest,
  reason: LoungeJoinRefusal,
  now: IsoTime,
): Promise<void> {
  const text = loungeDirectMessage(reason, deps.siteOrigin);
  if (text !== null && deps.memory.first(request.from.id, reason, now.slice(0, 10))) {
    try {
      await lounge.port.sendDirect(request.user_chat_id, text);
    } catch {
      // The port never throws by its contract; if one did, the decline still goes out.
    }
  }
  await lounge.port.declineJoin(lounge.config.chatId, request.from.id);
  logLounge('lounge_join_declined', { reason });
}
