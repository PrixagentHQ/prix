import type { DataCaller, DataDeps, DataMeter, MeterOutcome } from '@prix/contracts';
import { DATA_API_PAID_DAILY_CEILING, DataFailure } from '@prix/contracts';
import { secondsToUtcMidnight } from '../errors.ts';

const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

export function createDataMeter(deps: Pick<DataDeps, 'data' | 'config'>): DataMeter {
  const { data, config } = deps;
  /** Set only after D1 refused the ceiling, so it never lets a call through that D1 would refuse. */
  let busyDay: string | null = null;
  /** The same for the paid calls' own bucket. */
  let busyPaidDay: string | null = null;
  const paidCeiling = Math.min(config.paidDailyCeiling ?? DATA_API_PAID_DAILY_CEILING, config.apiDailyCeiling - 1);
  const freeCeiling = Math.max(1, config.apiDailyCeiling - paidCeiling);

  const busy = (now: Date): DataFailure =>
    new DataFailure(
      'api_busy',
      'The API has reached its daily limit for everyone. Nothing was counted against you. Try again after 00:00 UTC.',
      null,
      { 'Retry-After': String(secondsToUtcMidnight(now)) },
    );

  return {
    async admit(caller: DataCaller, now: Date): Promise<MeterOutcome> {
      const day = dayOf(now);
      const owner = caller.owner;
      const limit = caller.entitlements.apiDailyQuota;

      let outcome: MeterOutcome;
      // When the free bucket is spent for the day, a wallet goes on to the paid path or is refused.
      const free = busyDay === day ? null : await data.meterFree(day, owner, limit);
      if (free !== null) {
        // The credit balance is not read on a free call (one more statement); the header shows 0.
        outcome = { kind: 'free', limit, remaining: Math.max(0, limit - free.freeN), creditsMicro: 0 };
      } else {
        if (busyPaidDay === day) throw busy(now);
        const paid = await data.meterPaid(day, owner, config.callPriceMicro, config.paidDailyCap);
        if (paid === null) {
          if (busyDay === day) throw busy(now);
          const where = config.paymentsEnabled ? ' You can buy credits on your account page.' : '';
          throw new DataFailure(
            'quota_exceeded',
            `This wallet used its ${limit} free calls for today, across all its keys.${where} The quota resets at 00:00 UTC.`,
            null,
            { 'Retry-After': String(secondsToUtcMidnight(now)) },
          );
        }
        outcome = { kind: 'paid', limit, remaining: 0, creditsMicro: paid.balanceMicro };
      }

      // Free calls and paid calls count in separate buckets: the free ones cannot use up the paid share.
      const counted =
        outcome.kind === 'free'
          ? (await data.meterGlobal(day, 'api', freeCeiling)) !== null
          : await data.meterCounter(`d:${day}:api_paid`, paidCeiling, now.toISOString());
      if (!counted) {
        await data.refundCall(day, owner, outcome.kind, config.callPriceMicro);
        if (outcome.kind === 'free') busyDay = day;
        else busyPaidDay = day;
        throw busy(now);
      }
      return outcome;
    },

    async refund(caller: DataCaller, outcome: MeterOutcome, now: Date): Promise<void> {
      await data.refundCall(dayOf(now), caller.owner, outcome.kind, config.callPriceMicro);
    },
  };
}
