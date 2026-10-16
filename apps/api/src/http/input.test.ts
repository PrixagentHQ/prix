import type {
  ApiDeps,
  Authenticator,
  DataDeps,
  EndpointRunner,
  KeySealer,
  ScoringEngine,
  SimEngine,
  Store,
} from '@prix/contracts';
import { MAX_BODY_BYTES } from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMcp } from './data/mcp.ts';
import { createApp } from './index.ts';
import { BODY_DEADLINE_MS, readText } from './input.ts';

/**
 * The reader of a request body (input.ts), and its two callers: `readInput`, through the sign-in route
 * as the first route a stranger reaches with a body, and the MCP route, which reads its body itself.
 * No D1, no Worker: a body is a stream this file builds, and the clock is Vitest's.
 *
 * Run: pnpm exec vitest run --config apps/api/src/http/vitest.config.ts
 */

const SITE = 'https://prix.test';
/** The deadline as the task states it, written out here so that the tests do not follow the code. */
const TEN_SECONDS = 10_000;
/**
 * What the Workers runtime allocates for each piece of a request body, whatever the piece carries:
 * measured in workerd by the security review of 2026-10-12, where 3,000 one-byte pieces came on
 * 3,000 buffers of 4,096 bytes.
 */
const STORE_BYTES = 4_096;

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A POST with a body that is a stream, as a body without a declared size reaches the Worker. */
function post(
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
  path = '/api/siwe/verify',
): Request {
  // Node asks for `duplex` when a body is a stream; the Workers runtime does not know the field.
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' };
  return new Request(`${SITE}${path}`, init);
}

interface Source {
  readonly stream: ReadableStream<Uint8Array>;
  /** How many times the reader asked for a piece. */
  asked(): number;
  /** How many times the reader cancelled the body. */
  cancelled(): number;
}

/**
 * A body that hands over one piece for each read and then ends, stays silent or breaks. Nothing is
 * queued ahead of a read, so `asked` counts the reads.
 */
function source(pieces: readonly Uint8Array[], then: 'end' | 'silence' | 'break' = 'end'): Source {
  let asked = 0;
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const piece = pieces[asked];
        asked += 1;
        if (piece !== undefined) {
          controller.enqueue(piece);
          return undefined;
        }
        if (then === 'end') {
          controller.close();
          return undefined;
        }
        if (then === 'break') {
          controller.error(new Error('the connection broke'));
          return undefined;
        }
        // Silence: the piece never comes, as when a client stops writing and keeps the connection.
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled += 1;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, asked: () => asked, cancelled: () => cancelled };
}

interface Watched<T> {
  settled: boolean;
  value: T | undefined;
}

/** What a promise has come to so far, read without waiting for it. */
function watch<T>(promise: Promise<T>): Watched<T> {
  const watched: Watched<T> = { settled: false, value: undefined };
  void promise.then((value) => {
    watched.settled = true;
    watched.value = value;
  });
  return watched;
}

/** The bytes of every buffer the process still holds after a collection. Needs `--expose-gc`. */
function heldBufferBytes(): number {
  const runtime: { gc?: () => void; process?: { memoryUsage(): { arrayBuffers: number } } } = globalThis;
  if (runtime.gc === undefined || runtime.process === undefined) {
    throw new Error('This test collects before it measures: run it with apps/api/src/http/vitest.config.ts.');
  }
  // Twice: the second collection ends the freeing that the first one started.
  runtime.gc();
  runtime.gc();
  return runtime.process.memoryUsage().arrayBuffers;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readText: what it holds', () => {
  it('holds one buffer and one piece when a body at the limit arrives a byte at a time', async () => {
    // One body through the same path first, so that what the platform allocates once, for its first
    // request and its first stream, is not counted against the reader.
    expect(await readText(post(source([bytesOf('{}')]).stream))).toBe('{}');
    // Then the instrument: it sees a buffer of a piece's size, and nothing else.
    const empty = heldBufferBytes();
    const probe = new Uint8Array(STORE_BYTES);
    expect(heldBufferBytes() - empty).toBe(STORE_BYTES);

    const expected = Array.from({ length: MAX_BODY_BYTES }, (_, at) => String.fromCharCode(97 + (at % 26))).join('');
    const body = bytesOf(expected);
    let sent = 0;
    let held = -1;
    let before = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent === body.byteLength) {
            // Every piece was handed over and taken, and the reader asks for the next one: what it
            // still holds of them now, it held to the end.
            held = heldBufferBytes() - before;
            controller.close();
            return;
          }
          // As the runtime hands a trickled body over: one byte, a view on a buffer of its own.
          const piece = new Uint8Array(new ArrayBuffer(STORE_BYTES), 0, 1);
          piece[0] = body[sent] ?? 0;
          sent += 1;
          controller.enqueue(piece);
        },
      },
      { highWaterMark: 0 },
    );

    const request = post(stream);
    before = heldBufferBytes();

    expect(await readText(request)).toBe(expected);
    expect(sent).toBe(MAX_BODY_BYTES);
    // Measured: 20,480, which is the buffer at the limit and the piece in hand.
    expect(held).toBeGreaterThanOrEqual(0);
    expect(held).toBeLessThanOrEqual(MAX_BODY_BYTES + STORE_BYTES);
    expect(probe.byteLength).toBe(STORE_BYTES);
  });

  it('holds no buffer for a body that has sent no byte', async () => {
    expect(await readText(post(source([bytesOf('{}')]).stream))).toBe('{}');
    // A turn of the loop, so that what the first body left is freed before the measuring starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers();
    const body = source([], 'silence');
    const request = post(body.stream);
    const before = heldBufferBytes();

    const answer = watch(readText(request));
    // The reader has asked for its first piece and waits: one millisecond before the deadline, not a
    // byte has come.
    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(body.asked()).toBe(1);
    expect(answer.settled).toBe(false);
    // Measured: 0, or a few bytes under when something older is freed meanwhile. A buffer of the
    // limit's size made ahead of the first piece would be 16,384 here, for every request that opens
    // a body and writes nothing.
    const held = heldBufferBytes() - before;
    expect(Math.abs(held)).toBeLessThan(STORE_BYTES);

    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ settled: true, value: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readText: the deadline', () => {
  it('is ten seconds', () => {
    expect(BODY_DEADLINE_MS).toBe(TEN_SECONDS);
  });

  it('cuts a body that stalls: null at ten seconds, the reader cancelled, no timer left', async () => {
    vi.useFakeTimers();
    const body = source([bytesOf('{"message":')], 'silence');
    const answer = watch(readText(post(body.stream)));

    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(answer.settled).toBe(false);
    expect(body.cancelled()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ settled: true, value: null });
    expect(body.cancelled()).toBe(1);
    expect(body.asked()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts the ten seconds from the start of the read, not from the last piece', async () => {
    vi.useFakeTimers();
    let cancelled = 0;
    // A byte every three seconds: no wait between two pieces is long, and the body would take hours.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (cancelled === 0) controller.enqueue(bytesOf(' '));
              resolve();
            }, 3_000);
          });
        },
        cancel() {
          cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const answer = watch(readText(post(stream)));

    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(answer.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ settled: true, value: null });
    expect(cancelled).toBe(1);
  });

  it('is not lost to a piece that arrives in the same turn as the timer', async () => {
    vi.useFakeTimers();
    let cancelled = 0;
    const hand: { over: ((piece: Uint8Array) => void) | null } = { over: null };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          hand.over = (piece) => controller.enqueue(piece);
        },
        cancel() {
          cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const answer = watch(readText(post(stream)));
    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(answer.settled).toBe(false);

    // The piece settles the read, then the timer fires, and nothing runs between the two: the read
    // wins its race. The body then goes silent, and the deadline has already passed.
    hand.over?.(bytesOf('{'));
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(answer).toEqual({ settled: true, value: null });
    expect(cancelled).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs on one timer for the whole body, and on none once the body is read', async () => {
    vi.useFakeTimers();
    const timers: number[] = [];
    const pieces = ['{"a":', '"b",', '"c":', '"d"}'].map(bytesOf);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          timers.push(vi.getTimerCount());
          const piece = pieces[sent];
          sent += 1;
          if (piece === undefined) controller.close();
          else controller.enqueue(piece);
        },
      },
      { highWaterMark: 0 },
    );

    expect(await readText(post(stream))).toBe('{"a":"b","c":"d"}');
    // Four pieces and the end: one timer at each of the five reads, never one more.
    expect(timers).toEqual([1, 1, 1, 1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readText: a body it refuses', () => {
  const piece = () => new Uint8Array(STORE_BYTES).fill(0x20);

  it('refuses a body as soon as it passes the limit and asks for nothing more', async () => {
    vi.useFakeTimers();
    // Four pieces are the limit to the byte. The fifth passes it; three more are never asked for.
    const body = source([piece(), piece(), piece(), piece(), piece(), piece(), piece(), piece()]);

    expect(await readText(post(body.stream))).toBeNull();
    expect(body.asked()).toBe(5);
    expect(body.cancelled()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for the cancel of a body it refuses', async () => {
    let cancelled = 0;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent += 1;
          controller.enqueue(piece());
        },
        // A cancel that never ends, as one that waits for a client that has stopped answering.
        cancel() {
          cancelled += 1;
          return new Promise<void>(() => undefined);
        },
      },
      { highWaterMark: 0 },
    );
    const answer = watch(readText(post(stream)));

    await vi.waitFor(() => expect(cancelled).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answer).toEqual({ settled: true, value: null });
    expect(sent).toBe(5);
  });

  it('answers null when the cancel of a body it refuses fails', async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent += 1;
          controller.enqueue(piece());
        },
        cancel() {
          throw new Error('the cancel failed');
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readText(post(stream))).resolves.toBeNull();
    expect(sent).toBe(5);
  });

  it('answers null when a read rejects, and leaves no timer', async () => {
    vi.useFakeTimers();
    const body = source([bytesOf('{"message":')], 'break');

    await expect(readText(post(body.stream))).resolves.toBeNull();
    expect(body.asked()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a declared size over the limit without touching the body or starting a timer', async () => {
    vi.useFakeTimers();
    const body = source([bytesOf('{}')]);

    expect(await readText(post(body.stream, { 'Content-Length': String(MAX_BODY_BYTES + 1) }))).toBeNull();
    expect(body.asked()).toBe(0);
    expect(body.cancelled()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a body that is not UTF-8, and leaves no timer', async () => {
    vi.useFakeTimers();
    const body = source([bytesOf('{"a":"'), new Uint8Array([0xff, 0xfe]), bytesOf('"}')]);

    expect(await readText(post(body.stream))).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readText: a body it reads', () => {
  it('reads a small JSON body that arrives whole', async () => {
    const text = JSON.stringify({ message: 'prix.test wants you to sign in', signature: `0x${'ab'.repeat(65)}` });

    expect(await readText(post(source([bytesOf(text)]).stream))).toBe(text);
  });

  it('reads a body cut inside a character and across every growth of its buffer', async () => {
    // Characters of one, two, three and four bytes, cut every seven bytes: no cut respects a character,
    // and the body passes every size a growing buffer can have on the way to 9,000 bytes.
    const text = 'aé€😀'.repeat(900);
    const whole = bytesOf(text);
    expect(whole.byteLength).toBe(9_000);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < whole.byteLength; at += 7) pieces.push(whole.slice(at, at + 7));

    expect(await readText(post(source(pieces).stream))).toBe(text);
  });

  it('reads a body of exactly the limit and refuses one byte more', async () => {
    const atLimit = 'a'.repeat(MAX_BODY_BYTES);
    const half = MAX_BODY_BYTES / 2;

    expect(await readText(post(source([bytesOf(atLimit.slice(0, half)), bytesOf(atLimit.slice(half))]).stream))).toBe(
      atLimit,
    );
    expect(await readText(post(source([bytesOf(atLimit), bytesOf('a')]).stream))).toBeNull();
  });

  it('answers an empty string for no body and for an empty one', async () => {
    expect(await readText(post(null))).toBe('');
    expect(await readText(post(source([]).stream))).toBe('');
    expect(await readText(post(source([new Uint8Array(0)]).stream))).toBe('');
  });
});

describe('POST /api/siwe/verify', () => {
  const REFUSED = {
    error: {
      code: 'invalid_input',
      message: 'The request body is too large or is not text. Send a small JSON object.',
      field: null,
    },
  };

  /** The app with ports that write down every use of them. The store answers nothing: no refused body reaches it. */
  function world() {
    const trace: string[] = [];
    const store = new Proxy({} as Store, {
      get: (_target, name) => async () => {
        trace.push(`store.${String(name)}`);
        throw new Error('A request whose body is refused does not reach the store.');
      },
    });
    const deps: ApiDeps = {
      store,
      // The sign-in route reaches none of these three ports.
      sim: {} as SimEngine,
      scoring: {} as ScoringEngine,
      sealer: {} as KeySealer,
      rateLimiter: {
        async allow(rule, subject) {
          trace.push(`limiter:${rule}:${subject}`);
          return true;
        },
      },
      config: {
        siteOrigin: SITE,
        adminAddresses: [],
        houseModel: '@cf/test/house-model',
        nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        houseOwners: [],
      },
      now: () => new Date('2026-10-20T12:00:00.000Z'),
    };
    return { trace, app: createApp(deps) };
  }

  const verify = (body: ReadableStream<Uint8Array>): Request =>
    post(body, { 'CF-Connecting-IP': '203.0.113.9', Origin: SITE, 'Content-Type': 'application/json' });

  const read = async (response: Response) => ({
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.json(),
  });

  it('answers a body that stalls as it answers one that is not text, and spends nothing more', async () => {
    vi.useFakeTimers();
    // What a malformed body gets and spends: the `sign_in` rule of the address, and nothing else.
    const malformed = world();
    const reference = await read(await malformed.app.fetch(verify(source([new Uint8Array([0xff, 0xfe])]).stream)));
    expect(reference.status).toBe(400);
    expect(reference.body).toEqual(REFUSED);
    expect(malformed.trace).toEqual(['limiter:sign_in:203.0.113.9']);

    const stalled = world();
    const body = source([bytesOf('{"message":"')], 'silence');
    const answer = watch(stalled.app.fetch(verify(body.stream)));
    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(answer.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(answer.settled).toBe(true);
    expect(answer.value === undefined ? null : await read(answer.value)).toEqual(reference);
    expect(stalled.trace).toEqual(malformed.trace);
    expect(body.cancelled()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers 400, not 500, when the read of the body fails, and writes no error line', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, trace } = world();

    const answer = await read(await app.fetch(verify(source([bytesOf('{"message":"')], 'break').stream)));

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual(REFUSED);
    expect(trace).toEqual(['limiter:sign_in:203.0.113.9']);
    expect(logged).not.toHaveBeenCalled();
  });

  it('answers a body past the limit as before', async () => {
    const { app, trace } = world();
    const body = source([new Uint8Array(MAX_BODY_BYTES).fill(0x20), bytesOf(' ')]);

    const answer = await read(await app.fetch(verify(body.stream)));

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual(REFUSED);
    expect(trace).toEqual(['limiter:sign_in:203.0.113.9']);
    expect(body.cancelled()).toBe(1);
  });

  it('answers a body that arrives a byte at a time on what it says', async () => {
    const { app, trace } = world();
    // Valid JSON that the schema refuses for one field: the answer names it, so every byte was read.
    const text = JSON.stringify({ message: 5, signature: `0x${'ab'.repeat(65)}` });
    const pieces = [...bytesOf(text)].map((byte) => new Uint8Array([byte]));

    const answer = await read(await app.fetch(verify(source(pieces).stream)));

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: { code: 'invalid_input', field: 'message' } });
    expect(trace).toEqual(['limiter:sign_in:203.0.113.9']);
  });
});

describe('POST /api/v1/mcp', () => {
  /** What this route answers to every body that is not one JSON-RPC request, whatever is wrong with it. */
  const REFUSED = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Send one JSON-RPC 2.0 request object.' },
  };

  // A body that is refused reaches neither the authenticator nor a tool: both ports are empty, so a
  // call of either would throw and the test would fail.
  const call = (body: ReadableStream<Uint8Array>): Promise<Response> =>
    handleMcp(post(body, {}, '/api/v1/mcp'), { config: { siteOrigin: SITE } } as DataDeps, {
      authenticator: {} as Authenticator,
      runner: {} as EndpointRunner,
    });

  const read = async (response: Response) => ({
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.json(),
  });

  it('answers a body that stalls as it answers one that is not text or is too long', async () => {
    vi.useFakeTimers();
    const reference = await read(await call(source([new Uint8Array([0xff, 0xfe])]).stream));
    expect(reference.status).toBe(400);
    expect(reference.body).toEqual(REFUSED);
    const tooLong = source([new Uint8Array(MAX_BODY_BYTES).fill(0x20), bytesOf(' ')]);
    expect(await read(await call(tooLong.stream))).toEqual(reference);

    const body = source([bytesOf('{"jsonrpc":"2.0",')], 'silence');
    const answer = watch(call(body.stream));
    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(answer.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(answer.settled).toBe(true);
    expect(answer.value === undefined ? null : await read(answer.value)).toEqual(reference);
    expect(body.cancelled()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers the same 400, and does not throw, when the read of the body fails', async () => {
    const reference = await read(await call(source([new Uint8Array([0xff, 0xfe])]).stream));

    const answer = await read(await call(source([bytesOf('{"jsonrpc":"2.0",')], 'break').stream));

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual(REFUSED);
    expect(answer).toEqual(reference);
  });
});
