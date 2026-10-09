import { PUBLIC_RPC_URL, PUBLIC_RPC_URLS, rpcEndpoints } from '@prix/market';
import { describe, expect, it } from 'vitest';

/** The ordered list of RPC endpoints every chain read of the Worker uses (packages/market/RESEARCH.md, section 1). */

describe('the public RPC endpoints', () => {
  it('are the official endpoint, then publicnode, then dRPC', () => {
    expect(PUBLIC_RPC_URLS).toEqual([
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhood-rpc.publicnode.com',
      'https://robinhood.drpc.org',
    ]);
    expect(PUBLIC_RPC_URLS[0]).toBe(PUBLIC_RPC_URL);
  });
});

describe('rpcEndpoints', () => {
  it('is the public list when no keyed endpoint is set', () => {
    expect(rpcEndpoints(undefined)).toEqual([...PUBLIC_RPC_URLS]);
    expect(rpcEndpoints('')).toEqual([...PUBLIC_RPC_URLS]);
    expect(rpcEndpoints('   ')).toEqual([...PUBLIC_RPC_URLS]);
  });

  it('puts a keyed endpoint first and keeps the public order behind it', () => {
    const keyed = 'https://robinhood-mainnet.g.alchemy.com/v2/key';
    expect(rpcEndpoints(` ${keyed} `)).toEqual([keyed, ...PUBLIC_RPC_URLS]);
  });

  it('leaves out a keyed endpoint that is not https or not a URL', () => {
    expect(rpcEndpoints('http://insecure.example')).toEqual([...PUBLIC_RPC_URLS]);
    expect(rpcEndpoints('not a url')).toEqual([...PUBLIC_RPC_URLS]);
  });

  it('does not repeat an endpoint when the keyed one is a public one', () => {
    expect(rpcEndpoints('https://robinhood.drpc.org')).toEqual([
      'https://robinhood.drpc.org',
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhood-rpc.publicnode.com',
    ]);
  });
});
