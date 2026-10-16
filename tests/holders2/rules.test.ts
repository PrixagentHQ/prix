import type {
  Address,
  HoldersGate,
  LoungeDueMember,
  LoungeJoinFacts,
  RoomAuthorHolder,
  RoomWriterRecord,
} from '@prix/contracts';
import {
  ADVICE_WORDS,
  HOLDERS2_PAGE_WORDS,
  isSocialSafeText,
  LOUNGE_DESCRIPTION,
  LOUNGE_DIRECT_MESSAGES,
  loungeDirectMessage,
  loungeJoinDecision,
  loungeSweepMarks,
  loungeSweepVerdict,
  ROOM_WALLET_DAY_CAP_BY_TIER,
  roomHolderMark,
  roomLeftToday,
  roomTurnRefusal,
  roomWalletDayCap,
  SOCIAL_FORBIDDEN_WORDS,
  storedTierOf,
  TAPE_ROWS,
  TOKEN_STALE_GRACE_SECONDS,
  tapeCacheKey,
  tapeQuerySchema,
  tapeViewOf,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../apps/web/src/content/deck.ts';

/**
 * Phase 6.8, the holders' second wave (docs/contracts/phase-6-holders-2.md): qa's cases 1 and 11, and the
 * pure rules that protect the room's caps, the lounge and the tape from what a client claims.
 */

const TOKEN = `0x${'7'.repeat(40)}` as Address;
const NOW = '2026-10-20T12:00:00.000Z';
const ON: HoldersGate = { gatingOn: true, token: TOKEN };
const row = (tier: number, fields: Partial<RoomAuthorHolder> = {}): RoomAuthorHolder => ({
  tier,
  tokenAddress: TOKEN,
  checkedAt: '2026-10-20T11:00:00.000Z',
  ...fields,
});

describe('case 11: words', () => {
  it('every key of section 7 resolves in the deck to its sentence, word for word', () => {
    for (const [key, sentence] of Object.entries(HOLDERS2_PAGE_WORDS)) {
      expect(deck[key], key).toBe(sentence);
    }
    expect(Object.keys(HOLDERS2_PAGE_WORDS)).toHaveLength(21);
  });

  it('every page sentence, direct message and the group description passes isSocialSafeText', () => {
    const all = [...Object.values(HOLDERS2_PAGE_WORDS), ...Object.values(LOUNGE_DIRECT_MESSAGES), LOUNGE_DESCRIPTION];
    for (const text of all) {
      expect(isSocialSafeText(text), text).toBe(true);
      expect(ADVICE_WORDS.test(text), text).toBe(false);
      expect(SOCIAL_FORBIDDEN_WORDS.test(text), text).toBe(false);
      expect(/verified/i.test(text), text).toBe(false);
    }
  });

  it('the mark says "Holder" and names no tier or figure', () => {
    expect(deck['social.roomHolderMark']).toBe('Holder');
    expect(deck['social.roomHolderMarkLabel']).not.toMatch(/\d/);
  });

  it('the bot sends no direct message for a bot and fills {following} with the site', () => {
    expect(loungeDirectMessage('bot', 'https://prixagent.com')).toBeNull();
    expect(loungeDirectMessage('not_linked', 'https://prixagent.com')).toContain('https://prixagent.com/following');
    expect(deck['tape.scale']).toContain('{count}');
    expect(TAPE_ROWS).toBe(40);
  });
});

describe('a chat message read with a forged tier: the mark is the stored row only', () => {
  it('a row of another token, a stale row and a tier out of range give no mark', () => {
    expect(storedTierOf(row(1), ON, NOW)).toBe(1);
    expect(storedTierOf(row(3, { tokenAddress: `0x${'9'.repeat(40)}` as Address }), ON, NOW)).toBe(0);
    const graceAgo = new Date(Date.parse(NOW) - TOKEN_STALE_GRACE_SECONDS * 1_000).toISOString();
    expect(storedTierOf(row(3, { checkedAt: graceAgo }), ON, NOW)).toBe(0);
    expect(storedTierOf(row(3, { checkedAt: 'not a time' }), ON, NOW)).toBe(0);
    expect(storedTierOf(row(7), ON, NOW)).toBe(0);
    expect(storedTierOf(row(1.5), ON, NOW)).toBe(0);
    expect(storedTierOf(row(3), { gatingOn: false, token: TOKEN }, NOW)).toBe(0);
    expect(storedTierOf(row(3), { gatingOn: true, token: null }, NOW)).toBe(0);
    expect(storedTierOf(null, ON, NOW)).toBe(0);
  });

  it('an admin never carries the mark, tier 0 never does', () => {
    expect(roomHolderMark(true, 3)).toBe(false);
    expect(roomHolderMark(false, 0)).toBe(false);
    expect(roomHolderMark(false, 1)).toBe(true);
  });
});

describe('the caps at each tier, and at a tier drop between two messages', () => {
  const day = '2026-10-20';
  const writer = (count: number): RoomWriterRecord => ({
    address: '0x00000000000000000000000000000000000000b1' as Address,
    lastAt: '2026-10-20T01:00:00.000Z',
    day,
    count,
    mutedAt: null,
    mutedBy: null,
    cutAt: null,
  });

  it('30, 60, 90 and 120 by tier while on; 30 for every tier while the switch or the gate is off', () => {
    expect(ROOM_WALLET_DAY_CAP_BY_TIER).toEqual([30, 60, 90, 120]);
    for (const tier of [0, 1, 2, 3] as const) {
      expect(roomWalletDayCap({ gatingOn: true, tier }, true)).toBe([30, 60, 90, 120][tier]);
      expect(roomWalletDayCap({ gatingOn: true, tier }, false)).toBe(30);
      expect(roomWalletDayCap({ gatingOn: false, tier }, true)).toBe(30);
    }
    // A holding with no tier (an old fake) is tier 0.
    expect(roomWalletDayCap({ gatingOn: true }, true)).toBe(30);
  });

  it('a wallet that wrote 45 at tier 1 is refused wallet_day once its tier drops to 0', () => {
    const at = '2026-10-20T12:00:00.000Z';
    const tierOne = roomWalletDayCap({ gatingOn: true, tier: 1 }, true);
    expect(roomTurnRefusal(writer(45), at, day, tierOne)).toBeNull();
    const dropped = roomWalletDayCap({ gatingOn: true, tier: 0 }, true);
    expect(roomTurnRefusal(writer(45), at, day, dropped)).toBe('day');
    expect(roomLeftToday(writer(45), day, dropped)).toBe(0);
    expect(roomLeftToday(writer(45), day, tierOne)).toBe(15);
  });

  it('each tier is refused exactly at its cap', () => {
    const at = '2026-10-20T12:00:00.000Z';
    for (const tier of [0, 1, 2, 3] as const) {
      const cap = roomWalletDayCap({ gatingOn: true, tier }, true);
      expect(roomTurnRefusal(writer(cap - 1), at, day, cap), `tier ${tier}`).toBeNull();
      expect(roomTurnRefusal(writer(cap), at, day, cap), `tier ${tier}`).toBe('day');
    }
  });
});

describe('the lounge join rule', () => {
  const USER = 111;
  const WALLET = '0x00000000000000000000000000000000000000b1' as Address;
  const base: LoungeJoinFacts = {
    config: { chatId: -1001234567890, inviteUrl: 'https://t.me/+AbCdEfGh12345678' },
    request: {
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: USER, is_bot: false, first_name: 'x' },
    } as LoungeJoinFacts['request'],
    linkedWallet: WALLET,
    members: { byUser: null, byWallet: null, count: 0 },
    entitlements: { gatingOn: true, tier: 1 },
    holdingCheckedAt: '2026-10-20T11:55:00.000Z',
    now: NOW,
  };
  const taken = { telegramUserId: 222, wallet: WALLET, joinedAt: NOW, checkedDay: '2026-10-20' };

  it('refuses an unlinked user, a user under tier 1, and a wallet that let another account in', () => {
    expect(loungeJoinDecision({ ...base, linkedWallet: null })).toEqual({ action: 'decline', reason: 'not_linked' });
    expect(loungeJoinDecision({ ...base, entitlements: { gatingOn: true, tier: 0 } })).toEqual({
      action: 'decline',
      reason: 'below_tier',
    });
    expect(loungeJoinDecision({ ...base, members: { byUser: null, byWallet: taken, count: 1 } })).toEqual({
      action: 'decline',
      reason: 'wallet_taken',
    });
    const bot = { ...base.request, from: { ...base.request.from, is_bot: true } };
    expect(loungeJoinDecision({ ...base, request: bot })).toEqual({ action: 'decline', reason: 'bot' });
    // Another chat (the link was used for a group that is not the lounge) is ignored.
    const other = { ...base.request, chat: { ...base.request.chat, id: -1009999999999 } };
    expect(loungeJoinDecision({ ...base, request: other })).toEqual({ action: 'ignore' });
  });

  it('ignores a request whose holding was not read fresh (a tier drop not yet seen is never approved)', () => {
    expect(loungeJoinDecision({ ...base, holdingCheckedAt: '2026-10-20T10:00:00.000Z' })).toEqual({ action: 'ignore' });
    expect(loungeJoinDecision({ ...base, holdingCheckedAt: null })).toEqual({ action: 'ignore' });
    expect(loungeJoinDecision({ ...base, holdingCheckedAt: '2026-10-20T12:30:00.000Z' })).toEqual({ action: 'ignore' });
    expect(loungeJoinDecision(base)).toEqual({ action: 'approve' });
  });
});

describe('the sweep verdict', () => {
  const member = (fields: Partial<LoungeDueMember>): LoungeDueMember => ({
    telegramUserId: 5,
    wallet: '0x00000000000000000000000000000000000000b1' as Address,
    joinedAt: '2026-10-01T00:00:00.000Z',
    checkedDay: '2026-10-19',
    linkedChatId: 5,
    holder: row(1),
    ...fields,
  });

  it('removes for a passed-on link and for a current row under tier 1, and keeps everything it cannot judge', () => {
    expect(loungeSweepVerdict(member({}), ON, NOW)).toBe('keep');
    expect(loungeSweepMarks(member({}), ON, NOW)).toBe(true);
    expect(loungeSweepVerdict(member({ linkedChatId: 99 }), ON, NOW)).toBe('remove_unlinked');
    expect(loungeSweepVerdict(member({ linkedChatId: null }), ON, NOW)).toBe('remove_unlinked');
    expect(loungeSweepVerdict(member({ holder: row(0) }), ON, NOW)).toBe('remove_below_tier');
    for (const holder of [
      null,
      row(0, { tokenAddress: `0x${'9'.repeat(40)}` as Address }),
      row(0, { checkedAt: '2026-10-10T00:00:00.000Z' }),
    ]) {
      expect(loungeSweepVerdict(member({ holder }), ON, NOW)).toBe('keep');
      expect(loungeSweepMarks(member({ holder }), ON, NOW)).toBe(false);
    }
  });
});

describe('the tape keys and views come from entitlements alone', () => {
  it('two keys, made of the site and the view, and a strict empty query', () => {
    expect(tapeViewOf({ feedDelaySeconds: 0 })).toBe('live');
    expect(tapeViewOf({ feedDelaySeconds: 86_400 })).toBe('delayed');
    const live = tapeCacheKey('https://prixagent.com', 'live');
    const delayed = tapeCacheKey('https://prixagent.com', 'delayed');
    expect(live).not.toBe(delayed);
    expect(live.startsWith('https://prixagent.com')).toBe(true);
    expect(tapeQuerySchema.safeParse({ tier: '1' }).success).toBe(false);
    expect(tapeQuerySchema.safeParse({}).success).toBe(true);
  });
});
