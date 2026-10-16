import {
  type Address,
  type CreatePollHoldingReader,
  computeTier,
  POLL_TALLY_MAX_FETCHES,
  type PollHoldingReader,
  type PollTiersRead,
  type TokenChainReader,
  TokenReadError,
} from '@prix/contracts';

/**
 * The holders' poll tally's one way to the chain (docs/contracts/phase-6-holders.md section 5, revision 4
 * HB3-4): `PollHoldingReader.tiersNow(wallets, atBlock)` is one `TokenChainReader.readBalances` (one Multicall3
 * `eth_call` under the two-endpoint agreement), each tier by `computeTier` at the configured thresholds. It
 * has no store: the hold before a tier rises does not apply (a vote already waited its hour) and no row of
 * `token_holders` is ever written. `atBlock` null reads at the head with no block tag; a number is passed as
 * the read's block tag. A read that fails throws.
 *
 * Its fetches are reported to the run (H2-SEC-4, "engine-runtime's choice of how, inside poll-holding.ts"):
 * the fetches happen inside the chain reader, which the entry builds, so the entry routes that reader's
 * `fetch` through a `PollFetchMeter` of this file and hands the same meter to this reader. A head read
 * (`atBlock` null) starts a run, since every tally or prune run starts with exactly one; from then on the
 * meter refuses, without sending it, every fetch past POLL_TALLY_MAX_FETCHES, so the read throws and the run
 * fails at `read`; and each answer carries `fetches`, the run's count so far, which `tallyPoll` checks before
 * it asks for another read. Build one meter and one reader for each run (each invocation of the social step,
 * each request of the admin route): a meter shared by two runs at once would count them together.
 */

/** A `fetch` that counts and caps a run's outbound requests. */
export interface PollFetchMeter {
  /** The counted fetch: hand it to `createTokenChainReader` as its `fetchFn`. */
  fetch: typeof fetch;
  /** Starts a run: the count goes back to zero. */
  startRun(): void;
  /** Fetches sent in the current run, refused ones not included. */
  spent(): number;
}

/** What `tiersNow` answers when a meter counts its fetches. */
export type MeteredPollTiersRead = PollTiersRead & {
  /** The run's fetches so far, this read's included; absent when no meter was given. */
  fetches?: number;
};

export interface MeteredPollHoldingReader extends PollHoldingReader {
  tiersNow(wallets: readonly Address[], atBlock: number | null): Promise<MeteredPollTiersRead>;
}

/** Thrown by the meter's fetch past the cap; carries nothing, so no URL can reach a log. */
export class PollFetchCapReached extends Error {
  constructor() {
    super('The tally run has spent its fetches.');
    this.name = 'PollFetchCapReached';
  }
}

/**
 * A meter of at most `max` fetches a run (POLL_TALLY_MAX_FETCHES unless a test says otherwise). A fetch past
 * the cap is refused before anything is sent: it rejects with `PollFetchCapReached`.
 */
export function createPollFetchMeter(
  fetchFn: typeof fetch = fetch,
  max: number = POLL_TALLY_MAX_FETCHES,
): PollFetchMeter {
  let count = 0;
  const counted = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (count >= max) return Promise.reject(new PollFetchCapReached());
    count += 1;
    return fetchFn(input, init);
  }) as typeof fetch;
  return {
    fetch: counted,
    startRun() {
      count = 0;
    },
    spent: () => count,
  };
}

export interface PollHoldingReaderDeps {
  chain: TokenChainReader;
  config: () => Promise<{
    token: Address | null;
    thresholdsPpm: readonly [number, number, number];
    gatingOn: boolean;
  }>;
  /** The meter the chain reader's fetch goes through; absent, no count is reported. */
  meter?: PollFetchMeter;
}

export const createPollHoldingReader = ((deps: PollHoldingReaderDeps): MeteredPollHoldingReader => ({
  async tiersNow(wallets, atBlock) {
    if (atBlock === null) deps.meter?.startRun();
    const config = await deps.config();
    const token = config.token;
    if (!config.gatingOn || token === null) {
      // Gating off or no token: the tally waits, and nothing is read from the chain.
      return withCount({ gatingOn: false, tiers: wallets.map(() => 0 as const), blockNumber: 0 }, deps.meter);
    }
    const read =
      atBlock === null
        ? await deps.chain.readBalances(token, wallets)
        : await deps.chain.readBalances(token, wallets, atBlock);
    if (read.balances.length !== wallets.length) throw new TokenReadError('invalid_answer');
    const blockNumber = Number(read.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new TokenReadError('invalid_answer');
    const tiers = read.balances.map((balance) => computeTier(balance, read.totalSupply, config.thresholdsPpm));
    return withCount({ gatingOn: true, tiers, blockNumber }, deps.meter);
  },
})) satisfies CreatePollHoldingReader;

function withCount(read: PollTiersRead, meter: PollFetchMeter | undefined): MeteredPollTiersRead {
  return meter === undefined ? read : { ...read, fetches: meter.spent() };
}
