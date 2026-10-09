import type { TokenService, TokenStepReport } from '@prix/contracts';

/** One run of the token cron trigger. The service never throws; this keeps that true for any fake. */
export async function runTokenStep(service: TokenService, now: Date): Promise<TokenStepReport> {
  try {
    return await service.sweep(now);
  } catch {
    return { action: 'failed', read: 0, paused: 0, resumed: 0 };
  }
}
