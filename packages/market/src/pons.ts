import {
  type Address,
  ChainUnavailableError,
  type LaunchScan,
  PONS_FACTORIES,
  PONS_TOKEN_LAUNCHED_TOPIC0,
  type PonsLaunch,
} from '@prix/contracts';
import { keccak256, toBytes } from 'viem';
import type { Rpc } from './rpc.ts';

const SIGNATURE = 'TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)';
/** Chunk sizes tried in turn. The public endpoint allows 99,000 blocks per filtered query (proof run, 2026-10-06). */
const CHUNK_SIZES = [Math.floor(10_000_000 / 4), 500_000, 99_000];
const FACTORY_ADDRESSES = PONS_FACTORIES.map((f) => f.address);
const FIRST_BLOCK = Math.min(...PONS_FACTORIES.map((f) => f.startBlock));

/** The topic0 of TokenLaunched, computed from the signature, to compare with PONS_TOKEN_LAUNCHED_TOPIC0. */
export function ponsLaunchedTopic(): string {
  return keccak256(toBytes(SIGNATURE));
}

const pad = (a: Address) => `0x${'0'.repeat(24)}${a.slice(2)}`;
const hex = (n: number) => `0x${n.toString(16)}`;
const tail = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

interface RawLog {
  address: string;
  topics: string[];
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

function parse(logs: unknown): PonsLaunch[] {
  if (!Array.isArray(logs)) throw new ChainUnavailableError();
  const out: PonsLaunch[] = [];
  for (const l of logs as RawLog[]) {
    if (!l || !Array.isArray(l.topics) || l.topics.length < 3) throw new ChainUnavailableError();
    const blockNumber = Number(l.blockNumber);
    const logIndex = Number(l.logIndex);
    if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(logIndex)) throw new ChainUnavailableError();
    out.push({
      factory: String(l.address).toLowerCase(),
      token: tail(l.topics[1] as string),
      deployer: tail(l.topics[2] as string),
      blockNumber,
      txHash: String(l.transactionHash).toLowerCase(),
      logIndex,
    });
  }
  return out;
}

const newestFirst = (a: PonsLaunch, b: PonsLaunch) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex;

async function head(rpc: Rpc): Promise<number> {
  const n = Number(await rpc.call('eth_blockNumber', []));
  if (!Number.isSafeInteger(n)) throw new ChainUnavailableError();
  return n;
}

function filter(from: number, to: number | 'latest', topics: (string | null)[]) {
  return { address: FACTORY_ADDRESSES, fromBlock: hex(from), toBlock: to === 'latest' ? 'latest' : hex(to), topics };
}

/** One wide getLogs; if refused, up to 4 chunks of the newest blocks, trying smaller chunks down to 99,000. */
async function scan(
  rpc: Rpc,
  topics: (string | null)[],
): Promise<{ launches: PonsLaunch[]; from: number; to: number }> {
  try {
    const launches = parse(await rpc.call('eth_getLogs', [filter(FIRST_BLOCK, 'latest', topics)]));
    return { launches, from: FIRST_BLOCK, to: await head(rpc) };
  } catch (e) {
    if (!(e instanceof ChainUnavailableError)) throw new ChainUnavailableError();
  }
  const to = await head(rpc);
  for (const size of CHUNK_SIZES) {
    const ranges: [number, number][] = [];
    for (let i = 0, end = to; i < 4 && end >= FIRST_BLOCK; i++, end -= size) {
      ranges.push([Math.max(FIRST_BLOCK, end - size + 1), end]);
    }
    try {
      const results = await rpc.batch(
        ranges.map(([f, t]) => ({ method: 'eth_getLogs', params: [filter(f, t, topics)] })),
      );
      return { launches: results.flatMap(parse), from: ranges[ranges.length - 1]?.[0] ?? FIRST_BLOCK, to };
    } catch {
      // try the next, smaller size
    }
  }
  throw new ChainUnavailableError();
}

export async function readLaunchesByDeployer(rpc: Rpc, deployer: Address, limit: number): Promise<LaunchScan> {
  const { launches, from, to } = await scan(rpc, [PONS_TOKEN_LAUNCHED_TOPIC0, null, pad(deployer)]);
  launches.sort(newestFirst);
  return { launches: launches.slice(0, limit), total: launches.length, scannedFromBlock: from, scannedToBlock: to };
}

export async function readLaunchOfToken(rpc: Rpc, token: Address): Promise<PonsLaunch | null> {
  const { launches } = await scan(rpc, [PONS_TOKEN_LAUNCHED_TOPIC0, pad(token)]);
  launches.sort(newestFirst);
  return launches[0] ?? null;
}
