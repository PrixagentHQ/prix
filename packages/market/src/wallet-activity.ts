import {
  type Address,
  BLOCKS_PER_TIMESTAMP_BATCH,
  type HeadBlock,
  isStockToken,
  type RawTransfer,
  type ReadWindowResult,
  type TokenSymbol,
  type WalletActivityPort,
} from '@prix/contracts';
import { RPC_TIMEOUT_MS } from './chain.ts';
import { UNIVERSE } from './universe.ts';

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Lowercase token address to symbol, for the Stock Tokens of the universe. Wallet activity stays Stock
 * Tokens only (docs/CONTRACTS.md section 21): a crypto entry has no token on this chain to watch.
 */
export const UNIVERSE_TOKEN_BY_ADDRESS: ReadonlyMap<string, TokenSymbol> = new Map(
  UNIVERSE.filter(isStockToken).map((t) => [t.tokenAddress.toLowerCase(), t.symbol as TokenSymbol]),
);

export interface WalletActivityConfig {
  rpcUrls: readonly string[];
  fetch?: typeof fetch;
}

type Rpc = { id: number; result?: unknown; error?: { code?: number; message?: string } };
type Failure = 'window_too_large' | 'rpc_unavailable';

const hexInt = (v: unknown): number | null => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,15}$/.test(v)) return null;
  return Number(BigInt(v));
};

function tooLarge(message: string): boolean {
  return /exceeds limit of 10000|query spans .*blocks/i.test(message);
}

export function createWalletActivityReader(config: WalletActivityConfig): WalletActivityPort {
  const doFetch = config.fetch ?? fetch;

  /** One batched request, endpoints tried in order. Results by request id, or a failure. */
  async function batch(calls: { method: string; params: unknown[] }[]): Promise<Rpc[] | Failure> {
    const body = JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params })));
    for (const url of config.rpcUrls) {
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        const json: unknown = await res.json().catch(() => null);
        const items = Array.isArray(json) ? (json as Rpc[]) : json && typeof json === 'object' ? [json as Rpc] : null;
        if (items?.some((i) => i?.error && tooLarge(String(i.error.message ?? '')))) return 'window_too_large';
        if (!res.ok || !items) continue;
        const byId: Rpc[] = [];
        for (const i of items) if (i && typeof i.id === 'number') byId[i.id] = i;
        const complete = calls.every((_, k) => {
          const item = byId[k];
          return item !== undefined && !item.error && item.result !== undefined;
        });
        if (complete) return byId;
      } catch {
        // try the next endpoint
      }
    }
    return 'rpc_unavailable';
  }

  const topicOf = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;

  function decode(log: unknown, walletTopic: string, direction: 'in' | 'out'): RawTransfer | null {
    if (!log || typeof log !== 'object') return null;
    const l = log as Record<string, unknown>;
    const symbol = typeof l.address === 'string' ? UNIVERSE_TOKEN_BY_ADDRESS.get(l.address.toLowerCase()) : undefined;
    const topics = l.topics;
    if (!symbol || !Array.isArray(topics) || topics.length !== 3) return null;
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
    if (String(topics[direction === 'in' ? 2 : 1]).toLowerCase() !== walletTopic) return null;
    if (typeof l.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(l.data)) return null;
    const block = hexInt(l.blockNumber);
    const logIndex = hexInt(l.logIndex);
    if (block === null || logIndex === null) return null;
    if (typeof l.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(l.transactionHash)) return null;
    return { block, logIndex, txHash: l.transactionHash, symbol, direction, amountWei: BigInt(l.data).toString() };
  }

  return {
    async headBlock(): Promise<HeadBlock | null> {
      const r = await batch([
        { method: 'eth_blockNumber', params: [] },
        { method: 'eth_getBlockByNumber', params: ['latest', false] },
      ]);
      if (typeof r === 'string') return null;
      const number = hexInt(r[0]?.result);
      const block = r[1]?.result as { number?: unknown; timestamp?: unknown } | null;
      const timestamp = hexInt(block?.timestamp);
      const blockNumber = hexInt(block?.number);
      if (number === null || timestamp === null) return null;
      // The block read and the number may differ by one if a block lands between them: trust the block.
      return { number: blockNumber ?? number, timestamp };
    },

    async readTransfers(wallet: Address, fromBlock: number, toBlock: number): Promise<ReadWindowResult> {
      if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
        return { ok: false, reason: 'rpc_unavailable' };
      }
      const w = topicOf(wallet);
      const range = {
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        address: [...UNIVERSE_TOKEN_BY_ADDRESS.keys()],
      };
      const r = await batch([
        { method: 'eth_getLogs', params: [{ ...range, topics: [TRANSFER_TOPIC, null, w] }] },
        { method: 'eth_getLogs', params: [{ ...range, topics: [TRANSFER_TOPIC, w] }] },
      ]);
      if (typeof r === 'string') return { ok: false, reason: r };
      const transfers: RawTransfer[] = [];
      for (const [k, direction] of [
        [0, 'in'],
        [1, 'out'],
      ] as const) {
        const logs = r[k]?.result;
        if (!Array.isArray(logs)) return { ok: false, reason: 'rpc_unavailable' };
        for (const log of logs) {
          const t = decode(log, w, direction);
          if (t) transfers.push(t);
        }
      }
      transfers.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      return { ok: true, transfers, fromBlock, toBlock };
    },

    async blockTimes(blocks: readonly number[]): Promise<Record<number, number> | null> {
      if (blocks.length === 0) return {};
      if (blocks.length > BLOCKS_PER_TIMESTAMP_BATCH) return null;
      if (blocks.some((b) => !Number.isSafeInteger(b) || b < 0)) return null;
      const r = await batch(
        blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, false] })),
      );
      if (typeof r === 'string') return null;
      const out: Record<number, number> = {};
      for (let i = 0; i < blocks.length; i++) {
        const ts = hexInt((r[i]?.result as { timestamp?: unknown } | null)?.timestamp);
        const b = blocks[i];
        if (ts === null || b === undefined) return null;
        out[b] = ts;
      }
      return out;
    },
  };
}
