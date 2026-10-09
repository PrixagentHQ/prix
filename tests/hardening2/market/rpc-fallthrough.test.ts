import { ChainUnavailableError } from '@prix/contracts';
import { createRpc } from '@prix/market/rpc';
import { describe, expect, it } from 'vitest';

/**
 * When `createRpc` (the data API's chain reads) moves to the next endpoint (docs/CONTRACTS.md
 * section 20; security review of the newest reads, finding 5). Only a failure that may pass moves
 * on: a transport failure, HTTP 429, a 5xx, or a timeout. A JSON-RPC refusal would come back the
 * same from every endpoint and only spends the rate limits the price read depends on, so it ends
 * the read with ChainUnavailableError and nothing more is sent.
 */

const A = 'https://rpc-a.test';
const B = 'https://rpc-b.test';
const C = 'https://rpc-c.test';

type Answer = Response | Error;

function ok(result: unknown = '0x10'): Response {
  return new Response(JSON.stringify([{ jsonrpc: '2.0', id: 1, result }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function refusal(code: number, message = 'refused'): Response {
  return new Response(JSON.stringify([{ jsonrpc: '2.0', id: 1, error: { code, message } }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers each endpoint with its scripted answer; an endpoint without one answers `ok()`. */
function scripted(answers: Record<string, Answer>): { fetchFn: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) return ok();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchFn, asked };
}

describe('createRpc: a failure that may pass moves to the next endpoint', () => {
  const moving: [string, Answer][] = [
    ['HTTP 429', new Response('slow down', { status: 429 })],
    ['HTTP 500', new Response('oops', { status: 500 })],
    ['HTTP 502', new Response('bad gateway', { status: 502 })],
    ['HTTP 503', new Response('unavailable', { status: 503 })],
    ['a lost connection', new TypeError('fetch failed')],
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['an aborted request', new DOMException('This operation was aborted', 'AbortError')],
  ];

  it.each(moving)('after %s, asks the next endpoint and returns its answer', async (_name, answer) => {
    const { fetchFn, asked } = scripted({ [A]: answer });
    const rpc = createRpc([A, B, C], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).resolves.toBe('0x10');
    expect(asked).toEqual([A, B]);
  });

  it('throws ChainUnavailableError when every endpoint fails that way, after one request each', async () => {
    const { fetchFn, asked } = scripted({
      [A]: new Response('', { status: 429 }),
      [B]: new TypeError('fetch failed'),
      [C]: new Response('', { status: 503 }),
    });
    const rpc = createRpc([A, B, C], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(asked).toEqual([A, B, C]);
  });
});

describe('createRpc: a refusal does not move to the next endpoint', () => {
  const stopping: [string, Answer][] = [
    ['a JSON-RPC range that is too wide (-32005)', refusal(-32005, 'query returned more than 10000 results')],
    ['a JSON-RPC server error (-32000)', refusal(-32000, 'block range too large')],
    ['a JSON-RPC internal error (-32603)', refusal(-32603)],
    ['a JSON-RPC invalid params (-32602)', refusal(-32602)],
    ['a revert (3)', refusal(3, 'execution reverted')],
    ['an HTTP 400', new Response('bad request', { status: 400 })],
    ['an HTTP 403', new Response('forbidden', { status: 403 })],
    ['an unreadable body', new Response('{"jsonrpc":', { status: 200 })],
    ['a single answer where a batch was asked', new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}')],
    ['a batch without the answer to the call', new Response('[{"jsonrpc":"2.0","id":7,"result":"0x1"}]')],
  ];

  it.each(stopping)('after %s, throws ChainUnavailableError and asks no other endpoint', async (_name, answer) => {
    const { fetchFn, asked } = scripted({ [A]: answer });
    const rpc = createRpc([A, B, C], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(asked).toEqual([A]);
  });

  it('stops on a refusal of one call inside a batch, even when the others answered', async () => {
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: '0x1' },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'header not found' } },
    ]);
    const { fetchFn, asked } = scripted({ [A]: new Response(body, { status: 200 }) });
    const rpc = createRpc([A, B], fetchFn);
    await expect(
      rpc.batch([
        { method: 'eth_blockNumber', params: [] },
        { method: 'eth_getTransactionReceipt', params: ['0x00'] },
      ]),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(asked).toEqual([A]);
  });

  it('stops after a transient failure is followed by a refusal on the next endpoint', async () => {
    const { fetchFn, asked } = scripted({ [A]: new Response('', { status: 429 }), [B]: refusal(-32005) });
    const rpc = createRpc([A, B, C], fetchFn);
    await expect(rpc.call('eth_blockNumber', [])).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(asked).toEqual([A, B]);
  });
});

describe('createRpc: what it keeps', () => {
  it('sends nothing for a method that is not a read', async () => {
    const { fetchFn, asked } = scripted({});
    const rpc = createRpc([A], fetchFn);
    await expect(rpc.call('eth_sendRawTransaction', ['0x00'])).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(asked).toEqual([]);
  });

  it('answers an empty batch with nothing and sends nothing', async () => {
    const { fetchFn, asked } = scripted({});
    const rpc = createRpc([A], fetchFn);
    await expect(rpc.batch([])).resolves.toEqual([]);
    expect(asked).toEqual([]);
  });

  it('never puts an endpoint URL in what it throws', async () => {
    const keyed = 'https://rpc-keyed.test/v2/secret-key';
    const { fetchFn } = scripted({ [keyed]: refusal(-32602) });
    const rpc = createRpc([keyed], fetchFn);
    const error = await rpc.call('eth_blockNumber', []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect(String((error as Error).message)).not.toContain('secret-key');
    expect(JSON.stringify(error)).not.toContain('secret-key');
  });
});
