import type {
  DataCaller,
  DataDeps,
  DataEndpointId,
  DataHandlers,
  DataMeter,
  EndpointResult,
  EndpointRunner,
  MeterOutcome,
} from '@prix/contracts';
import { DATA_NOTICE, DATA_PAGE_MISSES_PER_NETWORK, DataFailure, dataEndpoint, dataEnvelope } from '@prix/contracts';
import { secondsToUtcMidnight } from '../errors.ts';
import { type DataCache, dataCacheKey } from './cache.ts';

function invalidInput(error: { issues: readonly { path: readonly PropertyKey[] }[] }): DataFailure {
  const field = error.issues[0]?.path.map(String).join('.') || null;
  return new DataFailure(
    'invalid_input',
    field === null
      ? 'The input is not valid. Check the reference for this endpoint.'
      : `The input is not valid at "${field}". Check the reference for this endpoint.`,
    field,
  );
}

const isServerError = (error: unknown): boolean => !(error instanceof DataFailure) || error.status >= 500;

type Produced = { body: EndpointResult['body']; cache: 'hit' | 'miss' | 'none' };

export function createEndpointRunner(
  deps: Pick<DataDeps, 'data' | 'config' | 'now'>,
  parts: { handlers: DataHandlers; meter: DataMeter; cache: DataCache },
): EndpointRunner {
  const { handlers, meter, cache } = parts;
  // An input that failed with a server error is not read from the chain again for 60 seconds, and a
  // wallet gets at most a few calls given back a day. Both live in this isolate; they only tighten.
  const failedUntil = new Map<string, number>();
  const refunds = new Map<string, number>();
  const MAX_REFUNDS_PER_DAY = 5;

  async function produce(
    id: DataEndpointId,
    input: unknown,
    caller: DataCaller | null,
    delay: number,
    now: Date,
    beforeMiss?: () => Promise<void>,
  ): Promise<Produced> {
    const spec = dataEndpoint(id);
    const key = dataCacheKey(id, input, delay);
    const cached = spec.cacheSeconds > 0 ? await cache.get(key) : null;
    if (cached !== null) return { body: { notice: DATA_NOTICE, data: cached }, cache: 'hit' };
    const failedAt = failedUntil.get(key);
    if (failedAt !== undefined) {
      if (failedAt > now.getTime()) {
        throw new DataFailure('chain_unavailable', 'This lookup failed a moment ago. Try again in a minute.');
      }
      failedUntil.delete(key);
    }
    if (beforeMiss) await beforeMiss();
    const handler = handlers[id] as (i: unknown, c: { caller: DataCaller | null; now: Date }) => Promise<unknown>;
    let data: unknown;
    try {
      data = await handler(input, { caller, now });
    } catch (error) {
      if (isServerError(error)) {
        if (failedUntil.size > 500) failedUntil.clear();
        failedUntil.set(key, now.getTime() + 60_000);
      }
      throw error;
    }
    const checked = dataEnvelope(spec.data).safeParse({ notice: DATA_NOTICE, data });
    if (!checked.success) {
      throw new DataFailure('internal', 'The server produced an answer it could not check. Try again later.');
    }
    if (spec.cacheSeconds > 0) await cache.put(key, data, spec.cacheSeconds);
    return { body: { notice: DATA_NOTICE, data }, cache: spec.cacheSeconds > 0 ? 'miss' : 'none' };
  }

  return {
    async run(id, rawInput, caller) {
      const spec = dataEndpoint(id);
      const parsed = spec.input.safeParse(rawInput);
      if (!parsed.success) throw invalidInput(parsed.error);
      const now = deps.now();
      let outcome: MeterOutcome | null = null;
      if (spec.metered) outcome = await meter.admit(caller, now);
      try {
        const out = await produce(id, parsed.data, caller, caller.entitlements.feedDelaySeconds, now);
        const headers: Record<string, string> = { 'X-Prix-Cache': out.cache === 'hit' ? 'hit' : 'miss' };
        if (outcome !== null) {
          headers['X-Prix-Quota-Limit'] = String(outcome.limit);
          headers['X-Prix-Quota-Remaining'] = String(outcome.remaining);
          headers['X-Prix-Credits-Micro'] = String(outcome.creditsMicro);
        }
        return { status: 200, body: out.body, headers, cache: out.cache };
      } catch (error) {
        const refundKey = `${now.toISOString().slice(0, 10)}:${caller.owner}`;
        const given = refunds.get(refundKey) ?? 0;
        if (outcome !== null && isServerError(error) && given < MAX_REFUNDS_PER_DAY) {
          if (refunds.size > 5000) refunds.clear();
          refunds.set(refundKey, given + 1);
          try {
            await meter.refund(caller, outcome, now);
          } catch {
            // A failed refund must not hide the original error.
          }
        }
        throw error;
      }
    },

    async runPage(id, rawInput, network = 'unknown') {
      const spec = dataEndpoint(id);
      if (!spec.pageSafe) throw new DataFailure('not_found', 'This lookup is not available without a key.');
      const parsed = spec.input.safeParse(rawInput);
      if (!parsed.success) throw invalidInput(parsed.error);
      const now = deps.now();
      const out = await produce(id, parsed.data, null, 0, now, async () => {
        // A network's own daily count of misses comes first, so one network cannot spend the shared one.
        const mine = await deps.data.meterCounter(
          `d:${now.toISOString().slice(0, 10)}:trustmiss:${network.slice(0, 64)}`,
          DATA_PAGE_MISSES_PER_NETWORK,
          now.toISOString(),
        );
        if (!mine) {
          throw new DataFailure(
            'api_busy',
            'This network has used its lookups for today. Try again after 00:00 UTC, or use the API with a key.',
            null,
            { 'Retry-After': String(secondsToUtcMidnight(now)) },
          );
        }
        const counted = await deps.data.meterGlobal(
          now.toISOString().slice(0, 10),
          'page',
          deps.config.pageDailyCeiling,
        );
        if (counted === null) {
          throw new DataFailure(
            'api_busy',
            'The public lookup has reached its daily limit. Try again after 00:00 UTC, or use the API with a key.',
            null,
            { 'Retry-After': String(secondsToUtcMidnight(now)) },
          );
        }
      });
      return {
        status: 200,
        body: out.body,
        headers: { 'X-Prix-Cache': out.cache === 'hit' ? 'hit' : 'miss' },
        cache: out.cache,
      };
    },
  };
}
