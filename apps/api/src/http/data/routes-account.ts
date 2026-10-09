import type {
  ApiKeyPublic,
  ApiKeyRecord,
  CreateApiKeyResponse,
  DataCaller,
  DataDeps,
  DataEndpointId,
  EndpointRunner,
  ListApiKeysResponse,
  ListPaymentsResponse,
  PaymentService,
  PricingResponse,
  SessionRecord,
} from '@prix/contracts';
import {
  addressInputSchema,
  createApiKeyInputSchema,
  DATA_KEY_CREATES_DAILY_CEILING,
  DATA_PAYMENT_SUBMISSIONS_PER_DAY,
  DataFailure,
  lowerAddress,
  MAX_API_KEY_CREATES_PER_DAY,
  MAX_API_KEYS_PER_WALLET,
  submitPaymentInputSchema,
  TIER_RULES,
  trustKindSchema,
  USDG_ADDRESS,
  USDG_DECIMALS,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { secondsToUtcMidnight } from '../errors.ts';
import { clientNetwork } from '../guard.ts';
import { readInput } from '../input.ts';
import { hashToken, readSessionToken } from '../session.ts';
import { dataFailures } from './errors.ts';
import { keyRecordOf } from './keys.ts';
import { successResponse } from './routes-v1.ts';
import { readUsage } from './usage.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

function respond(body: unknown, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, 'Cache-Control': cacheControl } });
}

const noContent = (): Response =>
  new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

const TRUST_ENDPOINT: Record<'developers' | 'tokens' | 'wallets', DataEndpointId> = {
  developers: 'developer',
  tokens: 'token',
  wallets: 'wallet',
};

function toPublic(record: ApiKeyRecord): ApiKeyPublic {
  return {
    id: record.id,
    prefix: record.prefix,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedDay: record.lastUsedDay,
    revoked: record.revokedAt !== null,
  };
}

export function registerDataAccountRoutes(
  app: Hono,
  deps: DataDeps,
  parts: { runner: EndpointRunner; payments: PaymentService },
): void {
  const { data, config } = deps;
  const admins = new Set(config.adminAddresses.map((address) => address.toLowerCase()));

  async function requireSession(request: Request): Promise<SessionRecord> {
    const token = readSessionToken(request);
    if (token !== null) {
      const now = deps.now().toISOString();
      const session = await deps.store.getSession(await hashToken(token), now);
      if (session !== null && session.expiresAt > now) return session;
    }
    throw dataFailures.unauthorized();
  }

  /** Origin and JSON type, a session, and the `write` rule of the wallet. */
  async function requireWriter(request: Request): Promise<SessionRecord> {
    const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json' || request.headers.get('origin') !== config.siteOrigin) {
      throw dataFailures.forbiddenOrigin();
    }
    const session = await requireSession(request);
    if (!(await deps.rateLimiter.allow('write', session.address))) throw dataFailures.rateLimited();
    return session;
  }

  async function callerOf(session: SessionRecord): Promise<DataCaller> {
    return {
      keyId: 'session',
      owner: session.address,
      entitlements: await deps.entitlements.entitlementsFor(session.address),
    };
  }

  app.get('/api/data/pricing', async () => {
    const visitor = await deps.entitlements.entitlementsFor(null);
    const payable = config.paymentsEnabled && config.paymentAddress !== null;
    const body: PricingResponse = {
      enabled: config.enabled,
      freeQuotaPerDay: visitor.apiDailyQuota,
      tiers: TIER_RULES.map((rule) => ({
        tier: rule.tier,
        thresholdPpm: rule.thresholdPpm,
        quotaPerDay: rule.apiDailyQuota,
      })),
      gatingOn: visitor.gatingOn,
      paymentsEnabled: payable,
      callPriceMicro: config.callPriceMicro,
      minPaymentMicro: config.minPaymentMicro,
      confirmations: config.confirmations,
      paymentAddress: payable ? config.paymentAddress : null,
      token: { symbol: 'USDG', address: USDG_ADDRESS, decimals: USDG_DECIMALS, chainId: 4663 },
      dailyCeiling: config.apiDailyCeiling,
      mcpPath: '/api/v1/mcp',
    };
    return respond(body, 200, 'public, max-age=60');
  });

  app.get('/api/data/keys', async (c) => {
    const session = await requireSession(c.req.raw);
    const records = await data.listKeys(session.address);
    const body: ListApiKeysResponse = { keys: records.map(toPublic), maxActive: MAX_API_KEYS_PER_WALLET };
    return respond(body, 200, 'no-store');
  });

  app.post('/api/data/keys', async (c) => {
    const session = await requireWriter(c.req.raw);
    const input = await readInput(createApiKeyInputSchema, c.req.raw);
    const now = deps.now();
    const { record, secret } = await keyRecordOf(session.address, input.label, now);
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const outcome = await data.createKey(record, {
      maxActive: MAX_API_KEYS_PER_WALLET,
      maxCreatesToday: MAX_API_KEY_CREATES_PER_DAY,
      maxCreatesAllToday: DATA_KEY_CREATES_DAILY_CEILING,
      dayStart,
    });
    if (outcome === 'blocked') {
      throw new DataFailure(
        'forbidden',
        'This wallet may not create API keys. Write to support if you think this is a mistake.',
      );
    }
    if (outcome === 'key_limit_reached') {
      throw new DataFailure(
        'key_limit_reached',
        `This wallet already has ${MAX_API_KEYS_PER_WALLET} active keys, which is the most it may. Delete one, then create the new key.`,
      );
    }
    if (outcome !== 'created') {
      throw new DataFailure(
        'key_create_limit_reached',
        'The limit of new keys for today is reached. Try again after 00:00 UTC.',
        null,
        { 'Retry-After': String(secondsToUtcMidnight(now)) },
      );
    }
    const body: CreateApiKeyResponse = { key: toPublic(record), secret };
    return respond(body, 201, 'no-store');
  });

  app.delete('/api/data/keys/:id', async (c) => {
    const session = await requireWriter(c.req.raw);
    const id = c.req.param('id');
    // A key id is 12 base32 characters, as `generateApiKey` makes it.
    if (!/^[a-z2-7]{12}$/.test(id)) throw new DataFailure('not_found', 'No key with this id belongs to your wallet.');
    if (!(await data.revokeKey(id, session.address, deps.now().toISOString()))) {
      throw new DataFailure('not_found', 'No key with this id belongs to your wallet.');
    }
    return noContent();
  });

  app.get('/api/data/usage', async (c) => {
    const session = await requireSession(c.req.raw);
    return respond(await readUsage(deps, await callerOf(session), deps.now(), true), 200, 'no-store');
  });

  app.get('/api/data/payments', async (c) => {
    const session = await requireSession(c.req.raw);
    const [rows, credits] = await Promise.all([
      data.listPayments(session.address, 50),
      data.getCredits(session.address),
    ]);
    const body: ListPaymentsResponse = {
      payments: rows.map((row) => ({
        txHash: row.txHash,
        amountMicro: row.amountMicro,
        blockNumber: row.blockNumber,
        creditedAt: row.creditedAt,
      })),
      balanceMicro: credits.balanceMicro,
    };
    return respond(body, 200, 'no-store');
  });

  app.post('/api/data/payments', async (c) => {
    const session = await requireWriter(c.req.raw);
    const input = await readInput(submitPaymentInputSchema, c.req.raw);
    if (!config.paymentsEnabled || config.paymentAddress === null) {
      throw new DataFailure('unavailable', 'Credits are not on sale yet. Try again when payments are switched on.');
    }
    if (await data.isBlocked(session.address)) {
      throw new DataFailure(
        'forbidden',
        'This wallet may not use the API. Write to support if you think this is a mistake.',
      );
    }
    // A daily count per wallet in the database: a wrong or pending hash cannot be sent all day.
    const submitNow = deps.now().toISOString();
    if (
      !(await data.meterCounter(
        `d:${submitNow.slice(0, 10)}:paysub:${session.address}`,
        DATA_PAYMENT_SUBMISSIONS_PER_DAY,
        submitNow,
      ))
    ) {
      throw new DataFailure(
        'daily_limit',
        'This wallet sent many payment hashes today. Try again after 00:00 UTC.',
        null,
        {
          'Retry-After': String(secondsToUtcMidnight(deps.now())),
        },
      );
    }
    const result = await parts.payments.submit(session.address, input.txHash.toLowerCase());
    return respond(result, result.alreadyCredited ? 200 : 201, 'no-store');
  });

  app.get('/api/data/trust/:kind/:address', async (c) => {
    const kind = trustKindSchema.safeParse(c.req.param('kind'));
    if (!kind.success) throw dataFailures.notFound();
    const result = await parts.runner.runPage(
      TRUST_ENDPOINT[kind.data],
      { address: c.req.param('address') },
      clientNetwork(c.req.raw),
    );
    return successResponse(result, 'public, max-age=60');
  });

  async function requireAdmin(request: Request, address: string): Promise<`0x${string}`> {
    const session = await requireWriter(request);
    if (!admins.has(session.address)) throw dataFailures.notAdmin();
    const parsed = addressInputSchema.safeParse(address);
    if (!parsed.success) throw dataFailures.invalid('This is not a wallet address. Check it and try again.', 'address');
    return lowerAddress(address) as `0x${string}`;
  }

  app.post('/api/data/admin/blocks/:address', async (c) => {
    const target = await requireAdmin(c.req.raw, c.req.param('address'));
    await data.blockWallet(target, 'admin', deps.now().toISOString());
    console.log(JSON.stringify({ event: 'admin_action', action: 'data_block', target }));
    return noContent();
  });

  app.delete('/api/data/admin/blocks/:address', async (c) => {
    const target = await requireAdmin(c.req.raw, c.req.param('address'));
    if (!(await data.unblockWallet(target))) throw new DataFailure('not_found', 'This wallet is not blocked.');
    console.log(JSON.stringify({ event: 'admin_action', action: 'data_unblock', target }));
    return noContent();
  });
}
