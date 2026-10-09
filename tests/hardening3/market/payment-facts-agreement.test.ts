import { ChainUnavailableError, ERC20_TRANSFER_TOPIC0, USDG_ADDRESS } from '@prix/contracts';
import { createDataChain } from '@prix/market/data-chain';
import { resetPaymentFactsMemory } from '@prix/market/payment-facts';
import { beforeEach, describe, expect, it } from 'vitest';
import { DRPC, down, Endpoints, type Handler, KEYED, OFFICIAL, PUBLICNODE } from './support.ts';

/**
 * The payment facts of the paid data API grant paid calls, so a third-party fallback endpoint is
 * trusted only when a second independent endpoint agrees on the receipt; the decimals check of
 * USDG is cached only once two independent endpoints agreed on it (D-110 finding 4).
 */

const TX = `0x${'ab'.repeat(32)}`;
const pad = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const FROM = '0x00000000000000000000000000000000000000f1';
const TO = '0x00000000000000000000000000000000000000f2';

function chain(options: { value?: bigint; head?: number; decimals?: number } = {}): Handler {
  const { value = 1_000_000n, head = 0x20, decimals = 6 } = options;
  return (method) => {
    if (method === 'eth_blockNumber') return { result: `0x${head.toString(16)}` };
    if (method === 'eth_call') return { result: `0x${decimals.toString(16).padStart(64, '0')}` };
    if (method === 'eth_getTransactionReceipt') {
      return {
        result: {
          status: '0x1',
          blockNumber: '0x10',
          logs: [
            {
              address: USDG_ADDRESS,
              topics: [ERC20_TRANSFER_TOPIC0, pad(FROM), pad(TO)],
              data: `0x${value.toString(16).padStart(64, '0')}`,
            },
          ],
        },
      };
    }
    return { error: { code: -32601, message: 'no' } };
  };
}

const read = (e: Endpoints, urls: string[]) => createDataChain({ rpcUrls: urls, fetch: e.fetch }).readPaymentFacts(TX);

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ChainUnavailableError ? 'chain_unavailable' : 'other';
  }
}

beforeEach(() => resetPaymentFactsMemory());

describe('the payment facts and third-party endpoints', () => {
  it('trusts the keyed endpoint alone', async () => {
    const e = new Endpoints().on(KEYED, chain()).on(OFFICIAL, chain());
    const facts = await read(e, [KEYED, OFFICIAL, PUBLICNODE, DRPC]);
    expect(facts.found).toBe(true);
    expect(facts.transfers).toEqual([{ from: FROM, to: TO, valueMicro: '1000000' }]);
    expect(facts.decimalsOk).toBe(true);
    expect(e.methods(OFFICIAL)).toEqual([]);
  });

  it('accepts a third party when a second independent endpoint agrees, with the lower head', async () => {
    const e = new Endpoints()
      .on(OFFICIAL, down)
      .on(PUBLICNODE, chain({ head: 0x30 }))
      .on(DRPC, chain({ head: 0x22 }));
    const facts = await read(e, [OFFICIAL, PUBLICNODE, DRPC]);
    expect(facts.transfers).toEqual([{ from: FROM, to: TO, valueMicro: '1000000' }]);
    expect(facts.headBlock).toBe(0x22);
  });

  it('fails closed when the second endpoint disagrees on a transfer', async () => {
    const e = new Endpoints()
      .on(OFFICIAL, down)
      .on(PUBLICNODE, chain({ value: 999_000_000n }))
      .on(DRPC, chain());
    expect(await failure(read(e, [OFFICIAL, PUBLICNODE, DRPC]))).toBe('chain_unavailable');
  });

  it('fails closed when no second endpoint answers', async () => {
    const e = new Endpoints().on(OFFICIAL, down).on(PUBLICNODE, chain()).on(DRPC, down);
    expect(await failure(read(e, [OFFICIAL, PUBLICNODE, DRPC]))).toBe('chain_unavailable');
  });

  it('does not cache the decimals check from one endpoint alone', async () => {
    const e = new Endpoints().on(OFFICIAL, chain());
    await read(e, [OFFICIAL]);
    await read(e, [OFFICIAL]);
    expect(e.methods(OFFICIAL).filter((m) => m === 'eth_call')).toHaveLength(2);
  });

  it('does not cache a wrong decimals answer from one endpoint', async () => {
    const liar = new Endpoints().on(OFFICIAL, chain({ decimals: 18 }));
    expect((await read(liar, [OFFICIAL])).decimalsOk).toBe(false);
    const honest = new Endpoints().on(OFFICIAL, chain());
    expect((await read(honest, [OFFICIAL])).decimalsOk).toBe(true);
  });

  it('caches the decimals check once two independent endpoints agree', async () => {
    const e = new Endpoints().on(OFFICIAL, down).on(PUBLICNODE, chain()).on(DRPC, chain());
    await read(e, [OFFICIAL, PUBLICNODE, DRPC]);
    const later = new Endpoints().on(OFFICIAL, chain());
    const facts = await read(later, [OFFICIAL]);
    expect(facts.decimalsOk).toBe(true);
    expect(later.methods(OFFICIAL)).not.toContain('eth_call');
  });
});
