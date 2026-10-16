import { describe, expect, it } from 'vitest';
import {
  ARBSYS_ADDRESS,
  arbSysAbi,
  decodeFunctionResult,
  encodeFunctionData,
  feedAbi,
  type Hex,
  MULTICALL3_ADDRESS,
  multicallAbi,
} from '../support/abi.ts';
import {
  ARB_L1_BLOCK,
  ARB_L2_BLOCK,
  ARB_OFFICIAL,
  ARB_PAIR_TWO,
  ARBITRUM_FEEDS,
  ARBITRUM_SEQUENCER_FEED,
} from '../support/fake-arbitrum.ts';
import { answerOf, NOW_SECONDS, scene } from './support.ts';

/**
 * The fake Arbitrum One answers the read of section 23 the way a node would. The market suites rest
 * on it, so it is checked here with a read built by hand, before any market code reads it.
 */

const latestRoundData = encodeFunctionData(feedAbi, 'latestRoundData');
const decimals = encodeFunctionData(feedAbi, 'decimals');

function arbitrumRead(): Hex {
  const calls = [
    { target: MULTICALL3_ADDRESS, allowFailure: true, callData: encodeFunctionData(multicallAbi, 'getChainId') },
    {
      target: MULTICALL3_ADDRESS,
      allowFailure: true,
      callData: encodeFunctionData(multicallAbi, 'getCurrentBlockTimestamp'),
    },
    { target: ARBSYS_ADDRESS, allowFailure: true, callData: encodeFunctionData(arbSysAbi, 'arbBlockNumber') },
    { target: ARBITRUM_SEQUENCER_FEED, allowFailure: true, callData: latestRoundData },
    { target: ARBITRUM_FEEDS.SOL, allowFailure: true, callData: latestRoundData },
    { target: ARBITRUM_FEEDS.SOL, allowFailure: true, callData: decimals },
  ];
  return encodeFunctionData(multicallAbi, 'aggregate3', [calls]);
}

async function send(url: string, data: Hex, block: string = 'latest') {
  const s = scene();
  const response = await s.rpc.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: MULTICALL3_ADDRESS, data }, block],
    }),
  });
  return { s, body: (await response.json()) as { result?: Hex; error?: unknown } };
}

describe('the fake Arbitrum One', () => {
  it('answers the read of section 23 with chain 42161, the L2 block, the sequencer and the feed', async () => {
    const { s, body } = await send(ARB_OFFICIAL, arbitrumRead());
    expect(body.error).toBeUndefined();
    const results = decodeFunctionResult(multicallAbi, 'aggregate3', body.result as Hex) as {
      success: boolean;
      returnData: Hex;
    }[];
    expect(results.every((result) => result.success)).toBe(true);
    const [chainId, timestamp, l2, sequencer, round, feedDecimals] = results.map((result) => result.returnData);
    expect(decodeFunctionResult(multicallAbi, 'getChainId', chainId as Hex)).toBe(42_161n);
    expect(decodeFunctionResult(multicallAbi, 'getCurrentBlockTimestamp', timestamp as Hex)).toBe(
      BigInt(NOW_SECONDS - 2),
    );
    expect(decodeFunctionResult(arbSysAbi, 'arbBlockNumber', l2 as Hex)).toBe(BigInt(ARB_L2_BLOCK));
    const up = decodeFunctionResult(feedAbi, 'latestRoundData', sequencer as Hex) as bigint[];
    expect(up[1]).toBe(0n);
    expect(up[2]).toBe(BigInt(NOW_SECONDS - 2 - 30 * 86_400));
    const sol = decodeFunctionResult(feedAbi, 'latestRoundData', round as Hex) as bigint[];
    expect(sol[1]).toBe(answerOf(152_880_000));
    expect(sol[3]).toBe(BigInt(NOW_SECONDS - 60));
    expect(decodeFunctionResult(feedAbi, 'decimals', feedDecimals as Hex)).toBe(8);
    expect(s.rpc.arbitrum.requests).toHaveLength(1);
    expect(s.rpc.httpRequests).toHaveLength(0);
  });

  it("gives the Ethereum block as tryBlockAndAggregate's block number, as Arbitrum does", async () => {
    const calls = [{ target: ARBSYS_ADDRESS, callData: encodeFunctionData(arbSysAbi, 'arbBlockNumber') }];
    const { body } = await send(ARB_OFFICIAL, encodeFunctionData(multicallAbi, 'tryBlockAndAggregate', [false, calls]));
    const [block, , results] = decodeFunctionResult(multicallAbi, 'tryBlockAndAggregate', body.result as Hex) as [
      bigint,
      Hex,
      { returnData: Hex }[],
    ];
    expect(block).toBe(BigInt(ARB_L1_BLOCK));
    expect(decodeFunctionResult(arbSysAbi, 'arbBlockNumber', results[0]?.returnData as Hex)).toBe(BigInt(ARB_L2_BLOCK));
  });

  it('answers the pinned block for arbBlockNumber and records the block tag', async () => {
    const { s, body } = await send(ARB_PAIR_TWO, arbitrumRead(), '0x10');
    const results = decodeFunctionResult(multicallAbi, 'aggregate3', body.result as Hex) as { returnData: Hex }[];
    expect(decodeFunctionResult(arbSysAbi, 'arbBlockNumber', results[2]?.returnData as Hex)).toBe(16n);
    expect(s.rpc.arbitrum.requests[0]?.blockTag).toBe('0x10');
  });

  it('refuses a JSON-RPC batch', async () => {
    const s = scene();
    const one = {
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: MULTICALL3_ADDRESS, data: arbitrumRead() }, 'latest'],
    };
    const response = await s.rpc.fetch(ARB_OFFICIAL, {
      method: 'POST',
      body: JSON.stringify([
        { ...one, id: 1 },
        { ...one, id: 2 },
      ]),
    });
    const body = (await response.json()) as { error?: unknown }[];
    expect(body.every((item) => item.error !== undefined)).toBe(true);
    expect(s.rpc.arbitrum.requests[0]?.batch).toBe(true);
  });

  it('does not answer an Arbitrum feed on Robinhood Chain', async () => {
    const s = scene();
    const calls = [{ target: ARBITRUM_FEEDS.SOL, callData: latestRoundData }];
    const response = await s.rpc.fetch('https://rpc-keyed.test', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: '0x2cac2d899ecc914d704feaae33ac1bf36277dad1',
            data: encodeFunctionData(multicallAbi, 'tryBlockAndAggregate', [false, calls]),
          },
          'latest',
        ],
      }),
    });
    const body = (await response.json()) as { result: Hex };
    const [, , results] = decodeFunctionResult(multicallAbi, 'tryBlockAndAggregate', body.result) as [
      bigint,
      Hex,
      { success: boolean }[],
    ];
    expect(results[0]?.success).toBe(false);
  });
});
