import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaimVerifier } from '../../apps/api/src/http/reputation/index.ts';

/**
 * The claim verifier asks the chain only for a contract wallet, and then through the same
 * endpoints as every other chain read, in the same order (`rpcEndpoints` of packages/market):
 * an endpoint that fails hands the read to the next one. Three local JSON-RPC endpoints stand in
 * for the chain, on the ports of this agent (8640 to 8649).
 */

const WALLET = '0x00000000000000000000000000000000000000c1';
/** Not an ECDSA signature, so the verifier asks the chain. */
const SIGNATURE = '0x1234';
const MAGIC_WORD = `0x1626ba7e${'0'.repeat(56)}`;

type Behaviour = 'down' | 'contract' | 'eoa';

interface Endpoint {
  url: string;
  methods: string[];
}

const servers: Server[] = [];
/** Every request, in the order the endpoints received it. */
let hits: string[] = [];

async function endpoint(port: number, behaviour: Behaviour): Promise<Endpoint> {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string };
      methods.push(call.method);
      hits.push(`${port} ${call.method}`);
      if (behaviour === 'down') {
        response.writeHead(503, { 'content-type': 'text/plain', connection: 'close' }).end('unavailable');
        return;
      }
      const result =
        call.method === 'eth_getCode'
          ? behaviour === 'contract'
            ? '0x6080'
            : '0x'
          : call.method === 'eth_call'
            ? MAGIC_WORD
            : null;
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${port}`, methods };
}

afterEach(async () => {
  // A kept-alive connection would reach the server of the previous test on the same port.
  await Promise.all(
    servers.splice(0).map((server) => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      return closed;
    }),
  );
  hits = [];
});

const verify = (rpcUrls: string[]) =>
  createClaimVerifier({ contractWallets: true, rpcUrls }).verify({
    wallet: WALLET,
    message: 'claim',
    signature: SIGNATURE,
  });

describe('the endpoints of the claim verifier', () => {
  it('asks the first endpoint only, when it answers', async () => {
    const first = await endpoint(8640, 'contract');
    const second = await endpoint(8641, 'contract');
    expect(await verify([first.url, second.url])).toBe('contract');
    expect(first.methods).toEqual(['eth_getCode', 'eth_call']);
    expect(second.methods).toEqual([]);
  });

  it('falls through to the next endpoint, in order, when one fails', async () => {
    const first = await endpoint(8640, 'down');
    const second = await endpoint(8641, 'down');
    const third = await endpoint(8642, 'contract');
    expect(await verify([first.url, second.url, third.url])).toBe('contract');
    expect(hits.slice(0, 3)).toEqual(['8640 eth_getCode', '8641 eth_getCode', '8642 eth_getCode']);
    expect(third.methods).toEqual(['eth_getCode', 'eth_call']);
  });

  it('takes the answer of the endpoint that answered: no code is not a contract wallet', async () => {
    const first = await endpoint(8640, 'down');
    const second = await endpoint(8641, 'eoa');
    const third = await endpoint(8642, 'contract');
    expect(await verify([first.url, second.url, third.url])).toBeNull();
    expect(third.methods).toEqual([]);
  });

  it('refuses, and never throws, when every endpoint fails', async () => {
    const first = await endpoint(8640, 'down');
    const second = await endpoint(8641, 'down');
    expect(await verify([first.url, second.url])).toBeNull();
    expect(hits).toEqual(['8640 eth_getCode', '8641 eth_getCode']);
  });
});
