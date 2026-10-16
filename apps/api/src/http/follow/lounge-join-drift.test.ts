import type {
  Address,
  LoungeMemberRecord,
  LoungeStore,
  TelegramLoungePort,
  TokenChainReader,
  TokenConfig,
  TokenHolder,
  TokenStore,
} from '@prix/contracts';
import { entitlementsOfTier, loungeConfig } from '@prix/contracts';
import { createTokenService, resetTokenMemory } from '@prix/runtime/token/service';
import { describe, expect, it } from 'vitest';
import { createDirectMemory, handleJoinRequest } from './lounge-join.ts';

/**
 * A join request judged on the real token service (docs/contracts/phase-6-holders-2.md section 4.4 step 5,
 * finding H2-SEC-1): the tier and the time of the read it rests on come from ONE read. Before the fix the tier
 * came from `entitlementsFor`, which can answer from the isolate's 30-second wallet memory (a stale row's old
 * tier, remembered after a failed chain read), and the time from `holdingOf`, which could be a new read that
 * found the wallet at tier 0: a seller was approved on a fresh time beside a remembered tier.
 */

const TOKEN = `0x${'7'.repeat(40)}` as Address;
const WALLET = `0x${'ab'.repeat(20)}` as Address;
const ONE = 10n ** 18n;
const SUPPLY = 10n ** 27n;
const START = Date.parse('2026-10-16T10:00:00.000Z');
const CHAT = -1001234567890;
const USER = 4242;

function world() {
  resetTokenMemory();
  let clock = START;
  const config: TokenConfig = {
    enabled: true,
    tokenAddress: TOKEN,
    thresholdsPpm: [10, 100, 1000],
    buyUrl: null,
    activatedAt: '2026-10-08T18:37:00.000Z',
    updatedAt: '2026-10-08T18:37:00.000Z',
    updatedBy: 'test',
  } as TokenConfig;
  const rows = new Map<string, TokenHolder>();
  const chain = { balance: 0n, fail: false };
  const store = {
    async getConfig() {
      return structuredClone(config);
    },
    async getHolder(address: string, token: string) {
      const row = rows.get(address);
      return row && row.tokenAddress === token ? { ...row } : null;
    },
    async getHolders(addresses: string[], token: string) {
      return addresses.flatMap((address) => {
        const row = rows.get(address);
        return row && row.tokenAddress === token ? [{ ...row }] : [];
      });
    },
    async putHolders(put: TokenHolder[]) {
      for (const row of put) rows.set(row.address, { ...row });
    },
    async applySlots() {
      return { paused: 0, resumed: 0 };
    },
    async countOwnerAgents() {
      return { total: 0, pausedForSlots: 0 };
    },
  } as unknown as TokenStore;
  const reader: TokenChainReader = {
    async readBalances(_token, wallets) {
      if (chain.fail) throw new Error('429 from both endpoints');
      return { totalSupply: SUPPLY, decimals: 18, balances: wallets.map(() => chain.balance), blockNumber: 1n };
    },
  } as TokenChainReader;
  const service = createTokenService({ store, chain: reader, now: () => new Date(clock), log: () => undefined });
  const calls: string[] = [];
  const members = new Map<number, LoungeMemberRecord>();
  const loungeStore = {
    async chatWallet(id: number) {
      return id === USER ? WALLET : null;
    },
    async members(userId: number, wallet: string) {
      return {
        byUser: members.get(userId) ?? null,
        byWallet: [...members.values()].find((member) => member.wallet === wallet) ?? null,
        count: members.size,
      };
    },
    async putMember(userId: number, wallet: Address, at: string) {
      members.set(userId, { telegramUserId: userId, wallet, joinedAt: at, checkedDay: at.slice(0, 10) });
      return 'stored';
    },
    async deleteMember(userId: number) {
      return members.delete(userId);
    },
    async listDue() {
      return [];
    },
    async markChecked() {},
  } as unknown as LoungeStore;
  const ok = (method: string) => async () => {
    calls.push(method);
    return { ok: true } as const;
  };
  const port = {
    approveJoin: ok('approve'),
    declineJoin: ok('decline'),
    ban: ok('ban'),
    unban: ok('unban'),
    sendDirect: ok('dm'),
  } as unknown as TelegramLoungePort;
  const lounge = loungeConfig({ on: 'on', chatId: String(CHAT), inviteUrl: 'https://t.me/+abcdefgh12' });
  if (lounge === null) throw new Error('the lounge config did not parse');
  const join = () =>
    handleJoinRequest(
      {
        lounge: { config: lounge, port, store: loungeStore, holding: (address) => service.holdingOf(address) },
        entitlements: service,
        siteOrigin: 'https://prixagent.com',
        memory: createDirectMemory(),
      },
      { chat: { id: CHAT, type: 'supergroup' }, from: { id: USER, is_bot: false }, user_chat_id: USER, date: 1 },
      new Date(clock).toISOString(),
    );
  return {
    service,
    chain,
    rows,
    calls,
    join,
    advance(seconds: number) {
      clock += seconds * 1000;
    },
    /** A stored tier 1 row read `ageSeconds` ago, of a wallet that has since sold everything. */
    seedTier1(ageSeconds: number) {
      rows.set(WALLET, {
        address: WALLET,
        balance: (20_000n * ONE).toString(),
        totalSupply: SUPPLY.toString(),
        decimals: 18,
        tier: 1,
        maxAgents: entitlementsOfTier(1).maxAgents,
        tokenAddress: TOKEN,
        checkedAt: new Date(clock - ageSeconds * 1000).toISOString(),
        riseTier: null,
        riseSince: null,
      } as TokenHolder);
    },
  };
}

describe('a join decides the tier and its freshness on one read', () => {
  it('declines a seller whose stored row is 20 hours old, with the direct message first', async () => {
    const w = world();
    w.seedTier1(20 * 3600);
    await w.join();
    expect(w.calls).toEqual(['dm', 'decline']);
  });

  it('never approves a seller after one failed chain read left the old tier in the wallet memory', async () => {
    const w = world();
    w.seedTier1(20 * 3600);
    w.chain.fail = true;
    expect((await w.service.entitlementsFor(WALLET)).tier).toBe(1);
    w.chain.fail = false;
    w.advance(10);
    await w.join();
    expect(w.calls).not.toContain('approve');
    expect(w.calls).toEqual(['dm', 'decline']);
    expect(w.rows.get(WALLET)?.tier).toBe(0);
  });

  it('never approves a second request after the first failed its read', async () => {
    const w = world();
    w.seedTier1(20 * 3600);
    w.chain.fail = true;
    await w.join();
    expect(w.calls).toEqual([]);
    w.chain.fail = false;
    w.advance(5);
    await w.join();
    expect(w.calls).not.toContain('approve');
    expect(w.calls).toEqual(['dm', 'decline']);
  });

  it('still approves a holder whose fresh read shows tier 1', async () => {
    const w = world();
    w.seedTier1(60);
    w.chain.balance = 20_000n * ONE;
    await w.join();
    expect(w.calls).toEqual(['approve']);
  });
});
