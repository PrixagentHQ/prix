import type {
  KeyOpener,
  KeySealer,
  MarketPort,
  MarketSnapshot,
  ModelKeyRecord,
  ModelPort,
  ModelRequest,
  ModelResponse,
  RateLimiter,
  RateLimitRule,
} from '@prix/contracts';
import { CHAIN_ID, marketSnapshotSchema, modelKeyAad } from '@prix/contracts';

/**
 * Fakes for the ports of `packages/contracts`. Each follows the comment of its port:
 * the market and the models never throw, a model failure carries a code and a status only,
 * and a sealed key is real AES-256-GCM ciphertext bound to its additional data.
 */

// --- market -------------------------------------------------------------------------------------

/**
 * A `MarketPort` that returns scripted snapshots. `takeSnapshot` never throws: if the script
 * throws, the port answers the way a real market does when every RPC endpoint fails.
 */
export class FakeMarket implements MarketPort {
  readonly calls: string[] = [];

  constructor(private script: (now: Date) => MarketSnapshot) {}

  setScript(script: (now: Date) => MarketSnapshot): void {
    this.script = script;
  }

  async takeSnapshot(now: Date): Promise<MarketSnapshot> {
    this.calls.push(now.toISOString());
    try {
      return marketSnapshotSchema.parse(structuredClone(this.script(now)));
    } catch {
      return {
        takenAt: now.toISOString(),
        chainId: CHAIN_ID,
        blockNumber: 0,
        open: false,
        closedReason: 'rpc_unavailable',
        prices: [],
      };
    }
  }
}

// --- models -------------------------------------------------------------------------------------

export type ModelScript = (request: ModelRequest, callIndex: number) => ModelResponse | Promise<ModelResponse>;

/** A valid model answer with the token counts of a typical decision call. */
export function modelText(
  text: string,
  inputTokens: number | null = 1_600,
  outputTokens: number | null = 120,
): ModelResponse {
  return { ok: true, text, inputTokens, outputTokens };
}

/** The decision JSON of docs/CONTRACTS.md section 6, with targets in percent. */
export function decisionJson(targets: Record<string, number>, reason = 'Holds the strongest names.'): string {
  return JSON.stringify({ targets, reason });
}

/**
 * A `ModelPort` that answers from a script and records every request. `complete` never
 * throws: a script that throws is reported as `provider_error`, with no message.
 */
export class FakeModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  /** The largest number of calls that were in flight at the same moment. */
  maxConcurrent = 0;
  private inFlight = 0;

  constructor(
    readonly label: string,
    private script: ModelScript,
  ) {}

  setScript(script: ModelScript): void {
    this.script = script;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      // A real call always takes at least one turn of the event loop.
      await Promise.resolve();
      return await this.script(request, index);
    } catch {
      return { ok: false, code: 'provider_error', httpStatus: null };
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** The strategy text of a decision request: the `strategy` field of the JSON user message. */
export function strategyOf(request: ModelRequest): string {
  const user = request.messages.find((message) => message.role === 'user');
  if (!user) return '';
  try {
    const parsed = JSON.parse(user.content) as { strategy?: unknown };
    return typeof parsed.strategy === 'string' ? parsed.strategy : '';
  } catch {
    return '';
  }
}

/** The factory the scheduler uses for an owner's model. It records what it was given. */
export class FakeOwnModels {
  readonly built: { keyId: string; provider: string; model: string; apiKey: string }[] = [];
  readonly models: FakeModel[] = [];

  constructor(private script: ModelScript) {}

  readonly factory = (key: ModelKeyRecord, apiKey: string): ModelPort => {
    this.built.push({ keyId: key.id, provider: key.provider, model: key.model, apiKey });
    const model = new FakeModel(`${key.provider}:${key.model}`, (request, index) => this.script(request, index));
    this.models.push(model);
    return model;
  };

  requests(): ModelRequest[] {
    return this.models.flatMap((model) => model.requests);
  }
}

// --- model keys ---------------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A sealer and an opener that share one test secret. The scheme is the one of
 * docs/CONTRACTS.md sections 12 and 15: AES-256-GCM, a fresh 12-byte nonce for every seal, and
 * the additional authenticated data bound to the ciphertext. The sealer binds whatever text
 * its caller passes. The opener rebuilds that text with `modelKeyAad` from the record it is
 * given: id, owner, provider and key version. A row moved to another owner or another
 * provider therefore does not open.
 */
export const TEST_KEY_VERSION = 1;

export function createTestVault(seed = 7): { sealer: KeySealer; opener: KeyOpener; opened: string[] } {
  const secret = new Uint8Array(32).map((_, index) => (index * 31 + seed) % 256);
  const key = crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const opened: string[] = [];
  let counter = 0;
  return {
    opened,
    sealer: {
      keyVersion: TEST_KEY_VERSION,
      async seal(apiKey, aad) {
        counter += 1;
        const iv = new Uint8Array(12);
        new DataView(iv.buffer).setUint32(8, counter);
        const sealed = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
          await key,
          encoder.encode(apiKey),
        );
        return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv), keyVersion: TEST_KEY_VERSION };
      },
    },
    opener: {
      async open(record) {
        try {
          const plain = await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: fromBase64(record.iv),
              additionalData: encoder.encode(modelKeyAad(record)),
            },
            await key,
            fromBase64(record.ciphertext),
          );
          const apiKey = decoder.decode(plain);
          opened.push(record.id);
          return apiKey;
        } catch {
          return null;
        }
      },
    },
  };
}

// --- rate limiter and log -----------------------------------------------------------------------

/** A `RateLimiter` that allows everything until a rule is put on the deny list. */
export class FakeRateLimiter implements RateLimiter {
  readonly asked: { rule: RateLimitRule; subject: string }[] = [];
  readonly denied = new Set<RateLimitRule>();

  async allow(rule: RateLimitRule, subject: string): Promise<boolean> {
    this.asked.push({ rule, subject });
    return !this.denied.has(rule);
  }
}

export interface LogLine {
  event: string;
  data: Record<string, string | number | boolean | null> | undefined;
}

/** Collects the scheduler's structured log, so a test can prove what it never contains. */
export function createLog(): {
  lines: LogLine[];
  log: (event: string, data?: LogLine['data']) => void;
  text(): string;
} {
  const lines: LogLine[] = [];
  return {
    lines,
    log: (event, data) => {
      lines.push({ event, data });
    },
    text: () => JSON.stringify(lines),
  };
}
