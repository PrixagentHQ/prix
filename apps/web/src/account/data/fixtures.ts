import type { Answer, Send } from './data-client.ts';

/**
 * What /api/data would answer, for reviewing the page before the API is deployed. Reached only
 * when the site is built or served with PRIX_FIXTURES=1. `&data=<name>` on the page URL picks
 * a state (the sign-in is the Phase 1 `?fixture=signed-in`, whose list does not know these names): `?fixture=signed-in&data=keys`. The names below are written with their data- prefix.
 *
 *   data-empty         no keys, no calls, payments off
 *   data-keys          two keys (one revoked), a week of calls, payments on, one payment
 *   data-pending       as data-keys, and a submitted hash answers payment_pending
 *   data-invalid       as data-keys, and a submitted hash answers payment_invalid
 *   data-credited      as data-keys, and a submitted hash is credited
 *   data-payments-off  keys and usage, payments off
 *   data-gated         as data-keys, with the token tiers on and tier 2
 *   data-fail          every read answers 500
 *   data-limited       creating a key answers 429, revoking answers 403
 */

const ADDRESS = '0x1111111111111111111111111111111111111111';
const PAYMENT_ADDRESS = '0x2222222222222222222222222222222222222222';
const USDG = '0x3333333333333333333333333333333333333333';
const NOTICE = 'Prix data is a simulation record and not investment advice.';

interface KeyRow {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
  lastUsedDay: string | null;
  revoked: boolean;
}

function day(offset: number): string {
  return new Date(Date.UTC(2026, 9, 6 - offset)).toISOString().slice(0, 10);
}

export function createFixtureSend(raw: string): Send {
  const names = new Set(raw.split(',').map((name) => name.trim()));
  const has = (name: string): boolean => names.has(name);
  const populated =
    has('data-keys') ||
    has('data-pending') ||
    has('data-invalid') ||
    has('data-credited') ||
    has('data-payments-off') ||
    has('data-gated');
  const paymentsOn = populated && !has('data-payments-off');
  const gated = has('data-gated');

  const keys: KeyRow[] = populated
    ? [
        {
          id: 'k1',
          prefix: 'prix_abcdefg',
          label: 'Backtest script',
          createdAt: '2026-10-01T09:00:00.000Z',
          lastUsedDay: day(0),
          revoked: false,
        },
        {
          id: 'k2',
          prefix: 'prix_hijklmn',
          label: 'Old laptop',
          createdAt: '2026-09-20T09:00:00.000Z',
          lastUsedDay: day(9),
          revoked: true,
        },
      ]
    : [];
  const payments: {
    txHash: string;
    amountMicro: number;
    blockNumber: number;
    creditedAt: string;
  }[] =
    populated && paymentsOn
      ? [
          {
            txHash: `0x${'a'.repeat(64)}`,
            amountMicro: 5_000_000,
            blockNumber: 1234,
            creditedAt: '2026-10-04T12:00:00.000Z',
          },
        ]
      : [];
  let balance = payments.reduce((sum, payment) => sum + payment.amountMicro, 0);
  let next = 3;

  const ok = (status: number, data: unknown): Answer => ({ status, body: { notice: NOTICE, data } });
  const err = (status: number, code: string, message = 'fixture'): Answer => ({
    status,
    body: { error: { code, message, field: null } },
  });

  return async (method, path, body) => {
    if (has('data-fail') && method === 'GET') return err(500, 'internal');
    if (method === 'GET' && path === '/api/data/keys') return ok(200, { keys: [...keys], maxActive: 5 });
    if (method === 'GET' && path === '/api/data/usage') {
      return ok(200, {
        address: ADDRESS,
        tier: gated ? 2 : 0,
        gatingOn: gated,
        quotaPerDay: gated ? 2000 : 50,
        usedFree: populated ? 18 : 0,
        usedPaid: populated ? 4 : 0,
        remainingFree: populated ? (gated ? 1982 : 32) : 50,
        creditsMicro: balance,
        callPriceMicro: 1000,
        resetsAt: '2026-10-07T00:00:00.000Z',
        paymentsEnabled: paymentsOn,
        history: populated
          ? [0, 1, 2, 4, 5].map((offset) => ({ day: day(offset), free: 50 - offset * 7, paid: offset === 0 ? 4 : 0 }))
          : [],
      });
    }
    if (method === 'GET' && path === '/api/data/pricing') {
      return ok(200, {
        enabled: true,
        freeQuotaPerDay: 50,
        tiers: [],
        gatingOn: gated,
        paymentsEnabled: paymentsOn,
        callPriceMicro: 1000,
        minPaymentMicro: 5_000_000,
        confirmations: 12,
        paymentAddress: paymentsOn ? PAYMENT_ADDRESS : null,
        token: { symbol: 'USDG', address: USDG, decimals: 6, chainId: 4663 },
        dailyCeiling: 10000,
        mcpPath: '/api/v1/mcp',
      });
    }
    if (method === 'GET' && path === '/api/data/payments') {
      return ok(200, { payments: [...payments].reverse(), balanceMicro: balance });
    }
    if (method === 'POST' && path === '/api/data/keys') {
      if (has('data-limited')) return err(429, 'key_create_limit_reached');
      const label = (body as { label?: string } | undefined)?.label ?? 'Key';
      const row: KeyRow = {
        id: `k${next++}`,
        prefix: 'prix_zzzzzzz',
        label,
        createdAt: '2026-10-06T10:00:00.000Z',
        lastUsedDay: null,
        revoked: false,
      };
      keys.unshift(row);
      return ok(201, { key: row, secret: `prix_${'q7'.repeat(26)}` });
    }
    if (method === 'DELETE' && path.startsWith('/api/data/keys/')) {
      if (has('data-limited')) return err(403, 'forbidden');
      const row = keys.find((key) => key.id === decodeURIComponent(path.split('/').pop() ?? ''));
      if (!row || row.revoked) return err(404, 'not_found');
      row.revoked = true;
      return { status: 204, body: null };
    }
    if (method === 'POST' && path === '/api/data/payments') {
      if (!paymentsOn) return err(503, 'unavailable');
      if (has('data-pending')) return err(409, 'payment_pending');
      if (has('data-invalid')) return err(422, 'payment_invalid');
      const txHash = String((body as { txHash?: string } | undefined)?.txHash ?? '').toLowerCase();
      const before = payments.find((payment) => payment.txHash === txHash);
      if (before) return ok(200, { payment: before, balanceMicro: balance, alreadyCredited: true });
      const payment = { txHash, amountMicro: 5_000_000, blockNumber: 1300, creditedAt: '2026-10-06T10:05:00.000Z' };
      payments.push(payment);
      balance += payment.amountMicro;
      return ok(201, { payment, balanceMicro: balance, alreadyCredited: false });
    }
    return err(404, 'not_found');
  };
}
