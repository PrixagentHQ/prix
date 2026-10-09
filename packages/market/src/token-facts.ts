import { type Address, ChainUnavailableError, type TokenBasics } from '@prix/contracts';
import { decodeFunctionResult, encodeFunctionData, type Hex, parseAbi } from 'viem';
import type { Rpc } from './rpc.ts';
import { MULTICALL_ADDRESS, multicallAbi } from './wire.ts';

const erc20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
]);
/** EIP-1967 implementation slot. */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MINT = '40c10f19';
const PAUSE = '8456cb59';

type Inner = { success: boolean; returnData: Hex } | undefined;

function read(r: Inner, fn: 'name' | 'symbol' | 'decimals' | 'totalSupply' | 'owner' | 'balanceOf'): unknown {
  if (!r?.success || r.returnData === '0x') return null;
  try {
    return decodeFunctionResult({ abi: erc20, functionName: fn, data: r.returnData });
  } catch {
    return null;
  }
}

const TEXT_MAX = 64;
/** Token text is chosen by the deployer: strip control and format characters, then cut it. */
const text = (v: unknown) => {
  if (typeof v !== 'string') return null;
  const head = v
    .slice(0, TEXT_MAX * 4)
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(head).slice(0, TEXT_MAX).join('');
};
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const big = (v: unknown) => (typeof v === 'bigint' ? v.toString() : null);

export async function readTokenBasics(rpc: Rpc, token: Address, holder: Address | null): Promise<TokenBasics> {
  const target = token as Hex;
  const names = ['name', 'symbol', 'decimals', 'totalSupply', 'owner'] as const;
  const calls = names.map((n) => ({ target, callData: encodeFunctionData({ abi: erc20, functionName: n }) }));
  if (holder) {
    calls.push({
      target,
      callData: encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [holder as Hex] }),
    });
  }
  const data = encodeFunctionData({ abi: multicallAbi, functionName: 'tryBlockAndAggregate', args: [false, calls] });
  const [mc, code, slot] = await rpc.batch([
    { method: 'eth_call', params: [{ to: MULTICALL_ADDRESS, data }, 'latest'] },
    { method: 'eth_getCode', params: [token, 'latest'] },
    { method: 'eth_getStorageAt', params: [token, IMPL_SLOT, 'latest'] },
  ]);
  if (typeof mc !== 'string' || typeof code !== 'string' || typeof slot !== 'string') throw new ChainUnavailableError();
  let block: bigint;
  let results: readonly NonNullable<Inner>[];
  try {
    const [b, , r] = decodeFunctionResult({ abi: multicallAbi, functionName: 'tryBlockAndAggregate', data: mc as Hex });
    block = b;
    results = r;
    if (results.length !== calls.length) throw new Error('length');
  } catch {
    throw new ChainUnavailableError();
  }
  const bytes = code.toLowerCase().replace(/^0x/, '');
  const implRaw = slot.replace(/^0x/, '').padStart(64, '0').slice(24).toLowerCase();
  const owner = str(read(results[4], 'owner'));
  const decimals = read(results[2], 'decimals');
  return {
    isContract: bytes.length > 0,
    codeSizeBytes: Math.floor(bytes.length / 2),
    name: text(read(results[0], 'name')),
    symbol: text(read(results[1], 'symbol')),
    decimals: typeof decimals === 'number' ? decimals : null,
    totalSupply: big(read(results[3], 'totalSupply')),
    owner: owner ? owner.toLowerCase() : null,
    proxyImplementation: /^0+$/.test(implRaw) ? null : `0x${implRaw}`,
    hasMintSelector: bytes.includes(MINT),
    hasPauseSelector: bytes.includes(PAUSE),
    holderBalance: holder ? big(read(results[5], 'balanceOf')) : null,
    readAtBlock: Number(block),
  };
}
