import { ChainUnavailableError } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import { RPC_MAX_RESPONSE_BYTES } from '@prix/market/body';
import { readSnapshot } from '@prix/market/chain';
import { createRpc } from '@prix/market/rpc';
import { encodeSnapshotResult } from '@prix/market/wire';
import { describe, expect, it } from 'vitest';

/**
 * No chain reader of packages/market reads a response body over 256 KB, whether or not the endpoint
 * sends Content-Length (docs/CONTRACTS.md section 20; security review of the newest reads, finding 5).
 * The 22-feed multicall answer (section 21) is a few kilobytes, so the cap never touches an honest answer.
 */

const URL_A = 'https://rpc-a.test';
const URL_B = 'https://rpc-b.test';

/**
 * A body that streams 16 KB at a time up to 4 MB (far past the cap, small enough not to exhaust the
 * test worker's memory when a reader has no cap), and counts what was pulled from it.
 */
function endless(chunkBytes = 16 * 1024): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(chunkBytes));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 4 * 1024 * 1024) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { body, pulled: () => pulled };
}

/** A body that says nothing until read, and records whether anyone read it. */
function untouched(): { body: ReadableStream<Uint8Array>; read: () => boolean } {
  let read = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true;
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
      // No pull of its own to fill a queue: only a reader pulls.
    },
    { highWaterMark: 0 },
  );
  return { body, read: () => read };
}

describe('market body cap: the constant', () => {
  it('is 256 KB', () => {
    expect(RPC_MAX_RESPONSE_BYTES).toBe(256 * 1024);
  });
});

describe('market body cap: the snapshot read', { timeout: 5_000 }, () => {
  it('refuses a body whose Content-Length is over the cap without reading it', async () => {
    const stream = untouched();
    const fetchFn: typeof fetch = async () =>
      new Response(stream.body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(RPC_MAX_RESPONSE_BYTES + 1) },
      });
    const outcome = await readSnapshot(URL_A, UNIVERSE, fetchFn);
    expect(outcome).toEqual({ ok: false, failure: { kind: 'malformed' } });
    expect(stream.read()).toBe(false);
  });

  it('stops reading a body without Content-Length once it passes the cap', async () => {
    const stream = endless();
    const fetchFn: typeof fetch = async () => new Response(stream.body, { status: 200 });
    const outcome = await readSnapshot(URL_A, UNIVERSE, fetchFn);
    expect(outcome).toEqual({ ok: false, failure: { kind: 'malformed' } });
    // At most one chunk past the cap, never the endless rest.
    expect(stream.pulled()).toBeLessThanOrEqual(RPC_MAX_RESPONSE_BYTES + 2 * 16 * 1024);
  });

  it('reads an honest answer for every feed of the universe, far under the cap', async () => {
    // Section 23: 25 symbols, of which the Robinhood read carries 22.
    expect(UNIVERSE).toHaveLength(25);
    const reads = UNIVERSE.map((token) => ({
      round: { answer: 2n ** 255n - 1n, updatedAt: 2n ** 255n - 1n },
      decimals: 255,
      oraclePaused: token.kind === 'stock' ? true : null,
    }));
    const result = encodeSnapshotResult(UNIVERSE, {
      blockNumber: 2n ** 255n,
      blockTimestamp: 2n ** 255n,
      chainId: 4663n,
      reads,
    });
    const answer = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    // Every word at its widest: still a small fraction of the cap.
    expect(answer.length).toBeLessThan(RPC_MAX_RESPONSE_BYTES / 8);
    const fetchFn: typeof fetch = async () =>
      new Response(answer, { status: 200, headers: { 'content-type': 'application/json' } });
    const outcome = await readSnapshot(URL_A, UNIVERSE, fetchFn);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reads.reads).toHaveLength(UNIVERSE.length);
  });

  it('stops reading a body that lies about a small Content-Length', async () => {
    const stream = endless();
    const fetchFn: typeof fetch = async () =>
      new Response(stream.body, { status: 200, headers: { 'content-length': '100' } });
    const outcome = await readSnapshot(URL_A, UNIVERSE, fetchFn);
    expect(outcome.ok).toBe(false);
    expect(stream.pulled()).toBeLessThanOrEqual(RPC_MAX_RESPONSE_BYTES + 2 * 16 * 1024);
  });
});

describe('market body cap: createRpc', { timeout: 5_000 }, () => {
  it('refuses a body whose Content-Length is over the cap without reading it, and does not move on', async () => {
    const stream = untouched();
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(stream.body, {
        status: 200,
        headers: { 'content-length': String(10 * 1024 * 1024) },
      });
    };
    const rpc = createRpc([URL_A, URL_B], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(stream.read()).toBe(false);
    expect(urls).toEqual([URL_A]);
  });

  it('stops reading a body without Content-Length once it passes the cap', async () => {
    const stream = endless();
    const fetchFn: typeof fetch = async () => new Response(stream.body, { status: 200 });
    const rpc = createRpc([URL_A], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(stream.pulled()).toBeLessThanOrEqual(RPC_MAX_RESPONSE_BYTES + 2 * 16 * 1024);
  });

  it('still reads an honest answer under the cap', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x10' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const rpc = createRpc([URL_A], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe('0x10');
  });

  it('reads an answer of exactly the cap', async () => {
    const answer = JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x10' }]);
    const padded = answer + ' '.repeat(RPC_MAX_RESPONSE_BYTES - answer.length);
    const fetchFn: typeof fetch = async () => new Response(padded, { status: 200 });
    const rpc = createRpc([URL_A], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe('0x10');
  });
});
