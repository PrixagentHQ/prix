/**
 * The two-endpoint rule of docs/CONTRACTS.md section 20, for the reads that grant something: the
 * token balances of the tier sweep, the payment facts of the paid data API and the contract-wallet
 * claim check (D-110, finding 4). The same rule the snapshot follows in `market.ts`:
 *
 * - Endpoints are tried in order. One that fails in a way that may pass elsewhere (the caller's
 *   `movesOn`) hands the read to the next; any other failure ends the read, closed.
 * - An answer from the keyed `RPC_URL` or the official endpoint is taken alone.
 * - An answer from a third-party fallback (`isThirdPartyEndpoint`) is taken only when the next
 *   endpoint on another host that answers says the same (`agree`). If it disagrees, or none
 *   answers, the read fails closed.
 *
 * Pure apart from the `read` it is given. Never logs and never carries a URL.
 */
import { endpointHost, isThirdPartyEndpoint } from './chain.ts';

export interface AgreementRule<T> {
  /** True when a failure of one endpoint is worth asking the next about (a transport failure). */
  movesOn(error: unknown): boolean;
  /** True when two answers say the same thing. */
  agree(a: T, b: T): boolean;
  /**
   * True when a third party's answer needs a second endpoint. Defaults to always. An answer that
   * grants nothing (a refusal) may be taken alone.
   */
  needsConfirmation?(value: T): boolean;
}

export type Agreed<T> =
  | {
      ok: true;
      value: T;
      /** The answer of the independent endpoint that agreed, or null when one was taken alone. */
      confirmation: T | null;
    }
  | { ok: false; reason: 'unavailable' | 'disagreed' | 'unconfirmed' }
  /** The first endpoint that answered refused: its error, for the caller to pass on (it grants nothing). */
  | { ok: false; reason: 'refused'; error: unknown };

type One<T> = { ok: true; value: T } | { ok: false; movesOn: boolean; error: unknown };

async function once<T>(read: (url: string) => Promise<T>, url: string, rule: AgreementRule<T>): Promise<One<T>> {
  try {
    return { ok: true, value: await read(url) };
  } catch (error) {
    let movesOn = false;
    try {
      movesOn = rule.movesOn(error) === true;
    } catch {
      movesOn = false;
    }
    return { ok: false, movesOn, error };
  }
}

/**
 * True when two endpoints may confirm each other: both are URLs, on different hosts. Pure.
 */
export function independent(a: string, b: string): boolean {
  const hostA = endpointHost(a);
  const hostB = endpointHost(b);
  return hostA !== null && hostB !== null && hostA !== hostB;
}

/**
 * Reads through `urls` under the two-endpoint rule. Never throws: the caller turns a failure into
 * its own error. `confirmation` is non-null exactly when two independent endpoints agreed, which
 * is what a caller checks before it caches anything from the answer.
 */
export async function readWithAgreement<T>(
  urls: readonly string[],
  read: (url: string) => Promise<T>,
  rule: AgreementRule<T>,
): Promise<Agreed<T>> {
  for (let first = 0; first < urls.length; first++) {
    const url = urls[first] as string;
    const answer = await once(read, url, rule);
    if (!answer.ok) {
      if (answer.movesOn) continue;
      return { ok: false, reason: 'refused', error: answer.error };
    }
    if (!isThirdPartyEndpoint(url)) return { ok: true, value: answer.value, confirmation: null };
    let needs = true;
    try {
      needs = rule.needsConfirmation ? rule.needsConfirmation(answer.value) !== false : true;
    } catch {
      needs = true;
    }
    if (!needs) return { ok: true, value: answer.value, confirmation: null };

    for (let second = first + 1; second < urls.length; second++) {
      const secondUrl = urls[second] as string;
      if (!independent(url, secondUrl)) continue;
      const check = await once(read, secondUrl, rule);
      if (!check.ok) {
        if (check.movesOn) continue;
        return { ok: false, reason: 'unconfirmed' };
      }
      let same = false;
      try {
        same = rule.agree(answer.value, check.value) === true;
      } catch {
        same = false;
      }
      return same ? { ok: true, value: answer.value, confirmation: check.value } : { ok: false, reason: 'disagreed' };
    }
    return { ok: false, reason: 'unconfirmed' };
  }
  return { ok: false, reason: 'unavailable' };
}
