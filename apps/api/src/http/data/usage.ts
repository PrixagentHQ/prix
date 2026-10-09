import type { DataCaller, DataDeps, DataUsage } from '@prix/contracts';

const HISTORY_DAYS = 30;

/** The one reader behind GET /api/v1/me and GET /api/data/usage, so the two cannot disagree. */
export async function readUsage(
  deps: DataDeps,
  caller: DataCaller,
  now: Date,
  withHistory: boolean,
): Promise<DataUsage> {
  const { data, config } = deps;
  const day = now.toISOString().slice(0, 10);
  const [counts, credits, history] = await Promise.all([
    data.getUsage(day, caller.owner),
    data.getCredits(caller.owner),
    withHistory ? data.listUsage(caller.owner, HISTORY_DAYS) : Promise.resolve([]),
  ]);
  const quota = caller.entitlements.apiDailyQuota;
  return {
    address: caller.owner,
    tier: caller.entitlements.tier,
    gatingOn: caller.entitlements.gatingOn,
    quotaPerDay: quota,
    usedFree: counts.freeN,
    usedPaid: counts.paidN,
    remainingFree: Math.max(0, quota - counts.freeN),
    creditsMicro: credits.balanceMicro,
    callPriceMicro: config.callPriceMicro,
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
    paymentsEnabled: config.paymentsEnabled && config.paymentAddress !== null,
    history: history.map((row) => ({ day: row.day, free: row.freeN, paid: row.paidN })),
  };
}
