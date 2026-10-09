import {
  DataFailure,
  ERC20_TRANSFER_TOPIC0,
  listPaymentsResponseSchema,
  submitPaymentResponseSchema,
  USDG_ADDRESS,
} from '@prix/contracts';
import { createDataChain } from '@prix/market/data-chain';
import { describe, expect, it } from 'vitest';
import { createPaymentService } from '../../apps/api/src/http/data/payments.ts';
import type { DataHarness } from './support/harness.ts';
import {
  createDataHarness,
  HEAD_BLOCK,
  lc,
  notFoundFacts,
  OTHER_ADDRESS,
  OTHER_CONTRACT,
  PAYMENT_ADDRESS,
  paidFacts,
  TX_A,
  TX_B,
  testWallet,
} from './support/harness.ts';

/** docs/contracts/phase-5-data.md section 8 item 2: payments, replay and rejection. */

const alice = testWallet(601);
const bob = testWallet(602);
const ONE_USDG = 1_000_000;

async function submit(h: DataHarness, cookie: string, txHash: string) {
  return h.send('POST', '/api/data/payments', { cookie, body: { txHash } });
}
async function balance(h: DataHarness, cookie: string): Promise<number> {
  const reply = await h.send('GET', '/api/data/payments', { cookie });
  expect(reply.status).toBe(200);
  return listPaymentsResponseSchema.parse(reply.json).balanceMicro;
}

describe('a payment is credited once', () => {
  it('credits a valid transfer, with the amount read from the chain and not from the client', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    h.chain.facts.set(TX_A, paidFacts(alice.address, 2 * ONE_USDG));
    const reply = await h.send('POST', '/api/data/payments', {
      cookie,
      // The client claims a huge amount: the strict input schema refuses everything but the hash.
      body: { txHash: TX_A, amountMicro: 999_000_000 },
    });
    expect(reply.status).toBe(400);
    const ok = await submit(h, cookie, TX_A);
    expect(ok.status, ok.text).toBe(201);
    const body = submitPaymentResponseSchema.parse(ok.json);
    expect(body.alreadyCredited).toBe(false);
    expect(body.payment.amountMicro).toBe(2 * ONE_USDG);
    expect(await balance(h, cookie)).toBe(2 * ONE_USDG);
  });

  it('the same wallet sending the hash twice gets 200 alreadyCredited and nothing more is added', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG));
    expect((await submit(h, cookie, TX_A)).status).toBe(201);
    const again = await submit(h, cookie, TX_A);
    expect(again.status).toBe(200);
    expect(submitPaymentResponseSchema.parse(again.json).alreadyCredited).toBe(true);
    expect(await balance(h, cookie)).toBe(ONE_USDG);
    expect(h.data.payments.size).toBe(1);
  });

  it('another wallet sending a credited hash gets 409 payment_already_credited and gains nothing', async () => {
    const h = await createDataHarness();
    const aliceCookie = await h.login(alice);
    const bobCookie = await h.login(bob);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG));
    expect((await submit(h, aliceCookie, TX_A)).status).toBe(201);
    // Even a transfer that names Bob as sender cannot take over a hash that was credited to Alice.
    h.chain.facts.set(TX_A, paidFacts(bob.address, ONE_USDG));
    const taken = await submit(h, bobCookie, TX_A);
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe('payment_already_credited');
    expect(await balance(h, bobCookie)).toBe(0);
    expect(await balance(h, aliceCookie)).toBe(ONE_USDG);
  });

  it('five concurrent submissions of one hash credit once', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG));
    const replies = await Promise.all([1, 2, 3, 4, 5].map(() => submit(h, cookie, TX_A)));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(4);
    expect(await balance(h, cookie)).toBe(ONE_USDG);
    expect(h.data.payments.size).toBe(1);
  });

  it('five concurrent submissions from two wallets credit once, to one of them', async () => {
    const h = await createDataHarness();
    const aliceCookie = await h.login(alice);
    const bobCookie = await h.login(bob);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG));
    const replies = await Promise.all([
      submit(h, aliceCookie, TX_A),
      submit(h, bobCookie, TX_A),
      submit(h, aliceCookie, TX_A),
      submit(h, bobCookie, TX_A),
      submit(h, aliceCookie, TX_A),
    ]);
    // Bob is not the sender of the transfer: every one of his submissions is refused.
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await balance(h, aliceCookie)).toBe(ONE_USDG);
    expect(await balance(h, bobCookie)).toBe(0);
  });

  it('the case of the hash does not matter, and the lower-case hash is what reaches the chain and the store', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    const upper = `0x${TX_A.slice(2).toUpperCase()}`;
    h.chain.facts.set(lc(upper), paidFacts(alice.address, ONE_USDG));
    expect((await submit(h, cookie, upper)).status).toBe(201);
    const again = await submit(h, cookie, lc(upper));
    expect(again.status).toBe(200);
    expect(again.json.alreadyCredited).toBe(true);
    expect([...h.data.payments.keys()]).toEqual([lc(upper)]);
    for (const call of h.chain.calls) expect(call.args[0]).toBe(lc(upper));
    expect(await balance(h, cookie)).toBe(ONE_USDG);
  });
});

describe('a payment that cannot be credited is refused with its error', () => {
  async function refused(change: (h: DataHarness) => void, status: number, code: string) {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    change(h);
    const reply = await submit(h, cookie, TX_A);
    expect(reply.status, reply.text).toBe(status);
    expect(reply.json.error.code).toBe(code);
    expect(h.data.payments.size).toBe(0);
    expect(await balance(h, cookie)).toBe(0);
    return reply;
  }

  it('a transaction that failed on the chain is payment_invalid', async () => {
    await refused(
      (h) => h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG, { success: false })),
      422,
      'payment_invalid',
    );
  });

  it('a transfer to another address is payment_invalid', async () => {
    await refused(
      (h) => h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG, { to: OTHER_ADDRESS })),
      422,
      'payment_invalid',
    );
  });

  it('a transfer from another sender is payment_invalid', async () => {
    await refused((h) => h.chain.facts.set(TX_A, paidFacts(bob.address, ONE_USDG)), 422, 'payment_invalid');
  });

  it('a transfer below the minimum is payment_invalid', async () => {
    await refused((h) => h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG - 1)), 422, 'payment_invalid');
  });

  it('several small transfers in one transaction are summed before the minimum applies', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    const facts = paidFacts(alice.address, ONE_USDG / 2);
    facts.transfers.push({ ...(facts.transfers[0] as (typeof facts.transfers)[0]) });
    h.chain.facts.set(TX_A, facts);
    expect((await submit(h, cookie, TX_A)).status).toBe(201);
    expect(await balance(h, cookie)).toBe(ONE_USDG);
  });

  it('a chain whose USDG decimals are not 6 (decimalsOk false) is payment_invalid', async () => {
    await refused(
      (h) => h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG, { decimalsOk: false })),
      422,
      'payment_invalid',
    );
  });

  it('a transaction with no USDG transfer at all is payment_invalid', async () => {
    await refused(
      (h) => h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG, { transfers: [] })),
      422,
      'payment_invalid',
    );
  });

  it('a transaction the chain does not know is payment_pending (409)', async () => {
    await refused((h) => h.chain.facts.set(TX_A, notFoundFacts()), 409, 'payment_pending');
  });

  it('a transaction with too few confirmations is payment_pending, and credits once it has enough', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG, { blockNumber: HEAD_BLOCK - 19 }));
    const early = await submit(h, cookie, TX_A);
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe('payment_pending');
    expect(await balance(h, cookie)).toBe(0);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG, { blockNumber: HEAD_BLOCK - 20 }));
    expect((await submit(h, cookie, TX_A)).status).toBe(201);
  });

  it('a chain failure is 503 chain_unavailable and credits nothing', async () => {
    await refused(
      (h) => {
        h.chain.fail = true;
      },
      503,
      'chain_unavailable',
    );
  });

  it('with payments off the route is 503 unavailable and the chain is not asked', async () => {
    const h = await createDataHarness({ config: { paymentsEnabled: false } });
    const cookie = await h.login(alice);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG));
    const reply = await submit(h, cookie, TX_A);
    expect(reply.status).toBe(503);
    expect(reply.json.error.code).toBe('unavailable');
    expect(h.chain.calls).toHaveLength(0);
    expect(h.data.payments.size).toBe(0);
  });

  it('with no payment address set the route is 503 unavailable', async () => {
    const h = await createDataHarness({ config: { paymentAddress: null } });
    const cookie = await h.login(alice);
    const reply = await submit(h, cookie, TX_A);
    expect(reply.status).toBe(503);
    expect(reply.json.error.code).toBe('unavailable');
  });

  it('a payment needs a session, a JSON body and the site origin', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG));
    expect((await h.send('POST', '/api/data/payments', { body: { txHash: TX_A } })).status).toBe(401);
    const wrongOrigin = await h.send('POST', '/api/data/payments', {
      cookie,
      body: { txHash: TX_A },
      origin: 'https://evil.example',
    });
    expect(wrongOrigin.status).toBe(403);
    expect(h.data.payments.size).toBe(0);
  });

  it('a blocked wallet cannot buy credits', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    await h.data.blockWallet(alice.address, 'test', h.api.now().toISOString());
    h.chain.facts.set(TX_A, paidFacts(alice.address, ONE_USDG));
    expect((await submit(h, cookie, TX_A)).status).toBe(403);
    expect(h.data.payments.size).toBe(0);
  });
});

describe('what the chain reader hands to the policy', () => {
  /** A JSON-RPC endpoint that answers what readPaymentFacts asks, with the logs the test gives. */
  function rpcFetch(logs: { address: string; from: string; to: string; value: bigint }[]): typeof fetch {
    const pad = (hex: string): string => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;
    const receipt = {
      status: '0x1',
      blockNumber: `0x${(HEAD_BLOCK - 100).toString(16)}`,
      logs: logs.map((log) => ({
        address: log.address,
        topics: [ERC20_TRANSFER_TOPIC0, pad(log.from), pad(log.to)],
        data: pad(log.value.toString(16)),
      })),
    };
    return (async (_url: unknown, init?: { body?: string }) => {
      const calls = JSON.parse(init?.body ?? '[]') as { id: number; method: string }[];
      const answers = calls.map((call) => {
        if (call.method === 'eth_getTransactionReceipt') return { jsonrpc: '2.0', id: call.id, result: receipt };
        if (call.method === 'eth_blockNumber') {
          return { jsonrpc: '2.0', id: call.id, result: `0x${HEAD_BLOCK.toString(16)}` };
        }
        return { jsonrpc: '2.0', id: call.id, result: pad('6') };
      });
      return new Response(JSON.stringify(answers), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  async function submitThroughChain(logs: Parameters<typeof rpcFetch>[0]) {
    const h = await createDataHarness();
    const chain = createDataChain({ rpcUrls: ['https://rpc.test'], fetch: rpcFetch(logs) });
    const service = createPaymentService({ data: h.data, chain, config: h.config, now: h.deps.now });
    return { h, run: () => service.submit(alice.address, TX_A) };
  }

  it('a Transfer log from another contract counts for nothing', async () => {
    const { h, run } = await submitThroughChain([
      { address: OTHER_CONTRACT, from: alice.address, to: PAYMENT_ADDRESS, value: 5_000_000n },
    ]);
    await expect(run()).rejects.toMatchObject({ code: 'payment_invalid' });
    expect(h.data.payments.size).toBe(0);
  });

  it('the same log from the USDG contract is credited, so the fixture itself is sound', async () => {
    const { h, run } = await submitThroughChain([
      { address: OTHER_CONTRACT, from: alice.address, to: PAYMENT_ADDRESS, value: 7_000_000n },
      { address: USDG_ADDRESS, from: alice.address, to: PAYMENT_ADDRESS, value: 2_000_000n },
    ]);
    const result = await run();
    expect(result.payment.amountMicro).toBe(2_000_000);
    expect(h.data.payments.size).toBe(1);
  });

  it('is a DataFailure that carries a code, never a raw error', async () => {
    const { run } = await submitThroughChain([]);
    await expect(run()).rejects.toBeInstanceOf(DataFailure);
  });
});

describe('credits pay for calls, one price at a time, and never go below zero', () => {
  it('each paid call takes the call price, and a call that credits cannot cover is refused with nothing taken', async () => {
    const h = await createDataHarness();
    const { secret } = await h.newKey(alice);
    h.entitlements.overrides.set(alice.address, { apiDailyQuota: 1 });
    await h.data.creditPayment({
      txHash: lc(TX_B),
      owner: alice.address,
      amountMicro: 2_500,
      blockNumber: 1,
      creditedAt: h.api.now().toISOString(),
    });
    const call = () => h.send('GET', '/api/v1/seasons', { key: secret });
    expect((await call()).status).toBe(200); // free
    expect((await call()).status).toBe(200); // paid: 1500 left
    expect((await h.data.getCredits(alice.address)).balanceMicro).toBe(1_500);
    const third = await call();
    expect(third.status).toBe(200); // paid: 500 left
    expect(third.headers.get('X-Prix-Credits-Micro')).toBe('500');
    const refused = await call();
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe('quota_exceeded');
    expect((await h.data.getCredits(alice.address)).balanceMicro).toBe(500);
    expect((await h.data.getUsage('2026-10-06', alice.address)).paidN).toBe(2);
  });
});
