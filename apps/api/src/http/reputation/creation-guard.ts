import type { AgentCreationGuard, ReputationStore } from '@prix/contracts';
import {
  CREATION_PERIOD_DAYS,
  creationPeriod,
  isHouseOwner,
  NEW_AGENTS_PER_DAY,
  NEW_AGENTS_PER_NETWORK_PER_DAY,
  NEW_AGENTS_PER_NETWORK_PER_PERIOD,
  WALLET_SEASONING_SECONDS,
} from '@prix/contracts';
import { ApiFailure, secondsToUtcMidnight } from '../errors.ts';
import { networkKey } from './claim.ts';

const TOO_MANY = 'Too many agents were created from this network today. Try again after 00:00 UTC.';

const DAY_MS = 86_400_000;

function tooManyToday(now: Date): ApiFailure {
  return new ApiFailure('rate_limited', TOO_MANY, null, { 'Retry-After': String(secondsToUtcMidnight(now)) });
}

/** The refusal at the cap of a period: when the next period starts, as a sentence and in seconds. */
function periodRefusal(period: number, now: Date): ApiFailure {
  const nextStart = (period + 1) * CREATION_PERIOD_DAYS * DAY_MS;
  const nextDay = new Date(nextStart).toISOString().slice(0, 10);
  return new ApiFailure(
    'rate_limited',
    `Too many agents were created from this network in the last few weeks. Try again after 00:00 UTC on ${nextDay}.`,
    null,
    { 'Retry-After': String(Math.max(1, Math.ceil((nextStart - now.getTime()) / 1000))) },
  );
}

/**
 * The sybil limits of docs/contracts/phase-2-reputation.md section 8. Wallet seasoning, then three
 * atomic counters (network and day, network and period, everyone and day). The period is the rolling
 * `CREATION_PERIOD_DAYS`-day period of D-109 (docs/CONTRACTS.md section 19): the league has one season
 * that never ends, so a season no longer bounds the cap of a network. When one refuses, the ones
 * already taken are given back. `release` gives back a reservation when the creation did not happen.
 *
 * `houseOwners` is `ApiConfig.houseOwners` (docs/CONTRACTS.md section 17). A house wallet is not
 * counted: no seasoning and no counter, so the agents Prix runs do not spend the allowance of the
 * network they are created from. The list comes from the Worker's configuration and from nothing
 * a request carries. Everything else about creating an agent belongs to the route and applies to
 * a house wallet as to anyone: one agent per wallet, the cap of the division, every validation.
 */
export function createAgentCreationGuard(
  reputation: ReputationStore,
  secret: string,
  houseOwners?: readonly string[],
): AgentCreationGuard {
  return {
    async reserve({ owner, networkSubject, now }) {
      // Nothing was taken, so there is nothing for `release` to give back.
      if (isHouseOwner(houseOwners, owner)) return { keys: [] };

      const nowIso = now.toISOString();
      const day = nowIso.slice(0, 10);

      const first = await reputation.getFirstSignIn(owner);
      const readyAt = first === null ? Number.NaN : Date.parse(first) + WALLET_SEASONING_SECONDS * 1000;
      if (!(now.getTime() >= readyAt)) {
        const wait = Number.isNaN(readyAt)
          ? WALLET_SEASONING_SECONDS
          : Math.max(1, Math.ceil((readyAt - now.getTime()) / 1000));
        throw new ApiFailure(
          'rate_limited',
          `A new wallet can create an agent ${Math.ceil(WALLET_SEASONING_SECONDS / 60)} minutes after its first sign-in. Try again in ${Math.ceil(wait / 60)} minutes.`,
          null,
          { 'Retry-After': String(wait) },
        );
      }

      const net = await networkKey(networkSubject, secret);
      const period = creationPeriod(day);
      const wanted: readonly { key: string; cap: number; refuse: () => ApiFailure }[] = [
        { key: `d:${day}:net:${net}`, cap: NEW_AGENTS_PER_NETWORK_PER_DAY, refuse: () => tooManyToday(now) },
        {
          key: `p:${period}:net:${net}`,
          cap: NEW_AGENTS_PER_NETWORK_PER_PERIOD,
          refuse: () => periodRefusal(period, now),
        },
        { key: `d:${day}:all`, cap: NEW_AGENTS_PER_DAY, refuse: () => tooManyToday(now) },
      ];
      const taken: string[] = [];
      for (const { key, cap, refuse } of wanted) {
        if (await reputation.takeCounter(key, cap, day, nowIso)) {
          taken.push(key);
          continue;
        }
        for (const given of taken) await reputation.giveBackCounter(given);
        throw refuse();
      }
      return { keys: taken };
    },

    async release(reservation) {
      for (const key of reservation.keys) await reputation.giveBackCounter(key);
    },
  };
}
