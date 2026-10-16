import type { Address, PollHoldingReader } from '@prix/contracts';
import { createTokenChainReader } from '@prix/market/token-balances';
import { createPollFetchMeter, createPollHoldingReader } from '@prix/runtime';

/** The configuration the poll's holding reader reads at each `tiersNow`: the token service's own row. */
export type PollHoldingConfig = () => Promise<{
  token: Address | null;
  thresholdsPpm: readonly [number, number, number];
  gatingOn: boolean;
}>;

/**
 * One tally run's holding reader (docs/contracts/phase-6-holders.md section 5, H2-SEC-4; finding HB1-SEC-1).
 * A new `PollFetchMeter` and a new chain reader whose `fetch` goes through it, handed to a new
 * `createPollHoldingReader` with the same meter: so the run's fetches are counted, `tiersNow` reports them, and
 * a fetch past POLL_TALLY_MAX_FETCHES is refused before it is sent. Call it once for each run (each invocation
 * of the social step, each request of the admin route), never in the isolate's cached wiring: a meter shared by
 * two runs at once would count them together.
 */
export function pollHoldingFor(
  rpcUrls: readonly string[],
  config: PollHoldingConfig,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): PollHoldingReader {
  const meter = createPollFetchMeter(fetchFn);
  return createPollHoldingReader({ chain: createTokenChainReader(rpcUrls, meter.fetch), config, meter });
}
