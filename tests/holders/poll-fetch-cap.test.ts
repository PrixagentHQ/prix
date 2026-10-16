import { type Address, HOLDER_POLLS, POLL_MAX_VOTERS, POLL_TALLY_MAX_FETCHES } from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { encodeTokenResult } from '@prix/market/token-wire';
import { tallyPoll } from '@prix/runtime/social/poll-tally';
import { describe, expect, it } from 'vitest';
import { pollHoldingFor } from '../../apps/api/src/poll-holding.ts';

/**
 * HB1-SEC-1 (docs/contracts/phase-6-holders.md section 5, H2-SEC-4): the tally's fetch cap holds as the entry
 * wires it. `pollHoldingFor` is the builder apps/api/src/index.ts calls for each run: a real chain reader whose
 * `fetch` goes through the run's meter. Here the official endpoint refuses every call, as Robinhood's endpoint
 * refuses Cloudflare (D-131), so each read costs three fetches (refused, a third party's answer, its
 * confirmation), and a full poll of 4,000 voters would need 33.
 */

const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];
const POLL = HOLDER_POLLS[0];
const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
const SUPPLY = 10n ** 27n;
const HEAD = 1_000_000;
const BALANCE_OF = '70a08231';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

interface RpcCall {
  id?: unknown;
  method?: string;
  params?: unknown[];
}

/** Three endpoints behind one fetch: the official one down, the two third parties agreeing. */
function chainFetch(): { fetch: typeof fetch; sent: () => number } {
  let sent = 0;
  const fake: typeof fetch = async (input, init) => {
    sent += 1;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = raw.replace(/\/+$/, '');
    if (url === OFFICIAL || (url !== PUBLICNODE && url !== DRPC)) return new Response('unavailable', { status: 503 });
    const body = JSON.parse(String(init?.body ?? '{}')) as RpcCall | RpcCall[];
    const calls = Array.isArray(body) ? body : [body];
    const answers = calls.map((call) => {
      const [tx, tag] = (call.params ?? []) as [{ data?: string }, string | undefined];
      const data = String(tx?.data ?? '');
      const count = data.split(BALANCE_OF).length - 1;
      const blockNumber = typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : BigInt(HEAD);
      return {
        jsonrpc: '2.0',
        id: call.id,
        result: encodeTokenResult({
          blockNumber,
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
          totalSupply: SUPPLY,
          decimals: 18,
          balances: Array.from({ length: count }, () => 10n ** 23n),
        }),
      };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fake, sent: () => sent };
}

describe('the tally fetch cap as the entry wires it', () => {
  it('fails at read with at most POLL_TALLY_MAX_FETCHES sent when the first endpoint refuses a full poll', async () => {
    if (POLL === undefined) throw new Error('no poll');
    const chain = chainFetch();
    const holding = pollHoldingFor(
      [OFFICIAL, PUBLICNODE, DRPC],
      async () => ({
        token: TOKEN,
        thresholdsPpm: [10, 100, 1_000] as const,
        gatingOn: true,
      }),
      chain.fetch,
    );
    const rows = Array.from({ length: POLL_MAX_VOTERS }, (_, i) => ({
      wallet: wallet(0x1000 + i),
      option: 'index-core',
    }));
    let written = false;
    const polls = {
      async listVoters(_poll: string, after: string | null, _before: string, limit: number) {
        return rows.filter((row) => after === null || row.wallet > after).slice(0, limit);
      },
      async getResults() {
        return [];
      },
      async putResult() {
        written = true;
        return true;
      },
    };
    const close = Date.parse(POLL.closesAt);
    const outcome = await tallyPoll(
      {
        polls,
        holding,
        adminAddresses: [],
        houseOwners: [],
        tallyDelaySeconds: async () => 0,
        social: { async putCursor() {} },
        reputation: {
          async getJobState() {
            return null;
          },
        },
        now: () => new Date(close + 120_000),
        log: () => undefined,
      } as never,
      POLL,
    );
    expect(outcome).toEqual({ outcome: 'failed', step: 'read' });
    expect(chain.sent()).toBeLessThanOrEqual(POLL_TALLY_MAX_FETCHES);
    expect(chain.sent()).toBeGreaterThan(0);
    expect(written).toBe(false);
  });

  it('gives each run a meter of its own', async () => {
    const chain = chainFetch();
    const config = async () => ({ token: TOKEN, thresholdsPpm: [10, 100, 1_000] as const, gatingOn: true });
    const a = pollHoldingFor([OFFICIAL, PUBLICNODE, DRPC], config, chain.fetch);
    const b = pollHoldingFor([OFFICIAL, PUBLICNODE, DRPC], config, chain.fetch);
    const first = (await a.tiersNow([wallet(1)], null)) as { fetches?: number };
    const second = (await b.tiersNow([wallet(2)], null)) as { fetches?: number };
    const again = (await a.tiersNow([wallet(3)], HEAD - 5)) as { fetches?: number };
    expect(first.fetches).toBe(3);
    expect(second.fetches).toBe(3);
    expect(again.fetches).toBe(6);
  });
});
