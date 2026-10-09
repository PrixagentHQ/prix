import { PUBLIC_RPC_URLS } from '@prix/market';

/**
 * Several fake JSON-RPC endpoints behind one `fetch`, routed by URL, so one endpoint can lie
 * while another tells the truth. Each handler answers one call; batches and single calls both work.
 * Nothing here touches a network.
 */

export const KEYED = 'https://rpc-keyed.test/v2/secret-key';
export const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];

export type Answer = { result: unknown } | { error: { code: number; message: string } } | 'down';
export type Handler = (method: string, params: unknown[]) => Answer;

interface Call {
  id?: unknown;
  method?: string;
  params?: unknown[];
}

export class Endpoints {
  readonly handlers = new Map<string, Handler>();
  /** Every method each endpoint was asked, in order. */
  readonly asked = new Map<string, string[]>();

  on(url: string, handler: Handler): this {
    this.handlers.set(url, handler);
    return this;
  }

  methods(url: string): string[] {
    return this.asked.get(url) ?? [];
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // viem adds a slash to a bare host; the endpoints are named without it.
    const url = this.handlers.has(raw) ? raw : raw.replace(/\/+$/, '');
    const handler = this.handlers.get(url) ?? (() => 'down' as const);
    const body = JSON.parse(String(init?.body ?? '{}')) as Call | Call[];
    const calls = Array.isArray(body) ? body : [body];
    const log = this.asked.get(url) ?? [];
    this.asked.set(url, log);
    const answers: unknown[] = [];
    for (const call of calls) {
      log.push(String(call.method));
      const answer = handler(String(call.method), call.params ?? []);
      if (answer === 'down') return new Response('unavailable', { status: 503 });
      answers.push({ jsonrpc: '2.0', id: call.id, ...answer });
    }
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

export const down: Handler = () => 'down';
