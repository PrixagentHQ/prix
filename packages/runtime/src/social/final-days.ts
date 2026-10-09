import type { FinalDay, SocialStore, UtcDay } from '@prix/contracts';

/**
 * Final days (docs/contracts/phase-6-social.md section 4.3): a UTC day with a day_prices row while no
 * tick is processing. The tape and the managers act on final days only, one day per run, and a day
 * without prices is never invented: the store simply does not return it.
 */
export interface NextFinalDay {
  day: FinalDay;
  /** True when another final day follows it, so the job answers `more`. */
  more: boolean;
}

/** The oldest final day after `afterDay` (the first one when null), in one read. Null when there is none. */
export async function nextFinalDay(
  social: Pick<SocialStore, 'listFinalDays'>,
  afterDay: UtcDay | null,
): Promise<NextFinalDay | null> {
  const days = (await social.listFinalDays(afterDay, 2))
    .filter((final) => afterDay === null || final.day > afterDay)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const first = days[0];
  if (first === undefined) return null;
  return { day: first, more: days.length > 1 };
}
