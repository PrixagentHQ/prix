import {
  ChainUnavailableError,
  ERC20_TRANSFER_TOPIC0,
  type PaymentFacts,
  USDG_ADDRESS,
  USDG_DECIMALS,
  type UsdgTransfer,
} from '@prix/contracts';
import { decodeFunctionResult, encodeFunctionData, type Hex, parseAbi } from 'viem';
import { readWithAgreement } from './agreement.ts';
import { ChainTransientError, createRpc, type Rpc } from './rpc.ts';

const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
/**
 * True once two independent endpoints agreed that USDG has `USDG_DECIMALS`, for the life of the
 * isolate. Never cached false, and never cached from one endpoint alone (D-110 finding 4).
 */
let decimalsOk: true | null = null;

interface Log {
  address: string;
  topics: string[];
  data: string;
}

const tail = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

/** What one endpoint said: the facts, and the decimals of USDG when they were asked (null when not). */
export interface EndpointPaymentFacts {
  facts: Omit<PaymentFacts, 'decimalsOk'>;
  decimals: number | null;
}

/** Forgets the decimals check of this isolate. For tests. */
export function resetPaymentFactsMemory(): void {
  decimalsOk = null;
}

/** One endpoint's answer. Throws ChainUnavailableError (ChainTransientError for a transport failure). */
async function readFrom(rpc: Rpc, txHash: string, askDecimals: boolean): Promise<EndpointPaymentFacts> {
  const calls = [
    { method: 'eth_getTransactionReceipt', params: [txHash] as unknown[] },
    { method: 'eth_blockNumber', params: [] as unknown[] },
  ];
  if (askDecimals) {
    const data = encodeFunctionData({ abi: decimalsAbi, functionName: 'decimals' });
    calls.push({ method: 'eth_call', params: [{ to: USDG_ADDRESS, data }, 'latest'] });
  }
  const [receipt, headRaw, dec] = await rpc.batch(calls);
  const headBlock = Number(headRaw);
  if (!Number.isSafeInteger(headBlock)) throw new ChainUnavailableError();
  let decimals: number | null = null;
  if (askDecimals) {
    try {
      decimals = Number(decodeFunctionResult({ abi: decimalsAbi, functionName: 'decimals', data: dec as Hex }));
    } catch {
      throw new ChainUnavailableError();
    }
  }
  if (receipt === null) {
    return { facts: { found: false, success: null, blockNumber: null, headBlock, transfers: [] }, decimals };
  }
  const r = receipt as { status?: string; blockNumber?: string; logs?: Log[] };
  const blockNumber = Number(r?.blockNumber);
  if (typeof r !== 'object' || !Array.isArray(r.logs) || !Number.isSafeInteger(blockNumber)) {
    throw new ChainUnavailableError();
  }
  const transfers: UsdgTransfer[] = [];
  for (const l of r.logs) {
    if (String(l.address).toLowerCase() !== USDG_ADDRESS) continue;
    if (l.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC0 || l.topics.length !== 3) continue;
    let value: bigint;
    try {
      value = BigInt(l.data);
    } catch {
      throw new ChainUnavailableError();
    }
    transfers.push({
      from: tail(l.topics[1] as string),
      to: tail(l.topics[2] as string),
      valueMicro: value.toString(),
    });
  }
  return { facts: { found: true, success: r.status === '0x1', blockNumber, headBlock, transfers }, decimals };
}

/**
 * Two endpoints agree when they say the same about the transaction and the decimals: found,
 * status, block and every USDG transfer, in order. The head may differ by the lag of a node. Pure.
 */
export function samePaymentFacts(a: EndpointPaymentFacts, b: EndpointPaymentFacts): boolean {
  const x = a.facts;
  const y = b.facts;
  return (
    a.decimals === b.decimals &&
    x.found === y.found &&
    x.success === y.success &&
    x.blockNumber === y.blockNumber &&
    x.transfers.length === y.transfers.length &&
    x.transfers.every((t, i) => {
      const u = y.transfers[i];
      return u !== undefined && t.from === u.from && t.to === u.to && t.valueMicro === u.valueMicro;
    })
  );
}

/**
 * The facts of one payment, read endpoint by endpoint. A payment grants paid calls, so a
 * third-party fallback endpoint is believed only when a second independent endpoint agrees
 * (`readWithAgreement`, docs/CONTRACTS.md section 20, D-110 finding 4); the lower of the two heads
 * is kept, so no confirmation is counted that both have not seen. The decimals check of USDG rides
 * in the same batch until two independent endpoints agreed on it, and only then is cached: one
 * endpoint alone, even the official one, answers for its own request only.
 * Throws ChainUnavailableError and nothing else.
 */
export async function readPaymentFacts(
  urls: readonly string[],
  txHash: string,
  fetchFn?: typeof fetch,
): Promise<PaymentFacts> {
  const askDecimals = decimalsOk !== true;
  const agreed = await readWithAgreement(urls, (url) => readFrom(createRpc([url], fetchFn), txHash, askDecimals), {
    movesOn: (error) => error instanceof ChainTransientError,
    agree: samePaymentFacts,
  });
  if (!agreed.ok) throw new ChainUnavailableError();
  const { facts, decimals } = agreed.value;
  let ok = decimalsOk === true;
  if (askDecimals) {
    ok = decimals === USDG_DECIMALS;
    if (ok && agreed.confirmation !== null) decimalsOk = true;
  }
  const headBlock =
    agreed.confirmation === null ? facts.headBlock : Math.min(facts.headBlock, agreed.confirmation.facts.headBlock);
  return { ...facts, headBlock, decimalsOk: ok };
}
