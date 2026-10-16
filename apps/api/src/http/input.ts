import { MAX_BODY_BYTES } from '@prix/contracts';
import { failures } from './errors.ts';

/**
 * The part of a schema from `packages/contracts` that this folder uses. The API validates
 * with the shared schemas only, and needs nothing else from the validation library.
 */
interface Issue {
  readonly code?: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
  readonly keys?: readonly string[];
}

type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly issues: readonly Issue[] } };

export interface Schema<T> {
  safeParse(input: unknown): ParseResult<T>;
}

/** A field name is echoed only if it looks like one. Anything else a client sent stays out of the response. */
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,60}$/;

function fieldOf(issue: Issue): string | null {
  const parts = issue.code === 'unrecognized_keys' ? (issue.keys ?? []).slice(0, 1) : issue.path.map(String);
  const field = parts.join('.');
  return FIELD_NAME.test(field) ? field : null;
}

/**
 * Validates with a shared schema. On failure the response carries the first issue's message
 * and its path. An unknown field has its own sentence, because the library's message for it
 * repeats the field name the client sent.
 */
export function validate<T>(schema: Schema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  if (!issue) throw failures.invalidInput('The request is not valid. Check the fields and try again.', null);
  const message =
    issue.code === 'unrecognized_keys'
      ? 'This request has a field that is not allowed. Remove it and try again.'
      : issue.message;
  throw failures.invalidInput(message, fieldOf(issue));
}

/**
 * How long a whole body may take to arrive, counted from the first read: ten seconds for a body of
 * at most `MAX_BODY_BYTES` (16,384 bytes).
 *
 * From the security review of the server of 2026-10-12: a body that is written a byte at a time and
 * then left open kept its request, and what the request held, for as long as the runtime lets a body
 * stall, before any session. Ten seconds is far more than an honest body of this size needs, which
 * arrives in one piece or a few, and still carries a connection as slow as 13 kbit/s.
 */
export const BODY_DEADLINE_MS = 10_000;

/**
 * Reads at most `MAX_BODY_BYTES` of a body. Null when the body is larger, is not UTF-8, does not
 * arrive whole within `BODY_DEADLINE_MS`, or breaks while it is read: all four are a body this API
 * cannot use, and the caller answers them alike.
 *
 * The size a request declares is checked first. A body that declares none, or declares less than
 * it sends, is counted as it arrives and dropped at the limit. Either way nothing larger than the
 * limit is ever decoded or handed to the JSON parser.
 *
 * No piece is kept. The Workers runtime hands each piece over on a buffer of 4,096 bytes of its own,
 * whatever the piece carries, so a list of one-byte pieces would hold 67 MB for a body inside the
 * limit. Each piece is copied into one buffer, and that buffer starts at the size of the first piece
 * and doubles up to the limit: a small JSON body arrives whole and costs its own size, where a
 * buffer of the limit's size would cost 16,384 bytes for every body.
 *
 * One timer covers the whole body, so pieces that keep coming slowly do not move the deadline. Each
 * read races a promise made for that read alone: raced against one promise that lives as long as the
 * body, every result would stay reachable from that promise, and with it every piece.
 */
export async function readText(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  // Nothing waits for the cancel: one that is slow or fails must not hold the answer, and it frees
  // nothing that the end of the request does not free.
  const drop = (): null => {
    void reader.cancel().catch(() => undefined);
    return null;
  };
  let late = false;
  let wake: (() => void) | null = null;
  const timer = setTimeout(() => {
    late = true;
    wake?.();
  }, BODY_DEADLINE_MS);
  // Empty until the first piece arrives.
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    for (;;) {
      // Asked before every read: a piece that settles its read in the turn in which the timer fires
      // wins that race, and the timer fires once.
      if (late) return drop();
      let next: Awaited<ReturnType<typeof reader.read>> | null;
      try {
        next = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => {
            wake = () => resolve(null);
          }),
        ]);
      } catch {
        // A read that rejects: the client went away or the body broke. Not a fault of this API.
        // Only the read is caught: a fault in the lines below is this API's own and stays a 500.
        return drop();
      }
      if (next === null) return drop();
      if (next.done) break;
      const piece = next.value;
      const end = size + piece.byteLength;
      if (end > MAX_BODY_BYTES) return drop();
      if (end > bytes.byteLength) {
        // The first piece makes a buffer of its own size. After that the buffer doubles, or takes
        // what the piece needs if that is more, and never passes the limit.
        const grown = new Uint8Array(Math.min(MAX_BODY_BYTES, Math.max(bytes.byteLength * 2, end)));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(piece, size);
      size = end;
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size));
  } catch {
    return null;
  }
}

/** Reads a JSON body and validates it. The body is never logged and never echoed. */
export async function readInput<T>(schema: Schema<T>, request: Request): Promise<T> {
  const text = await readText(request);
  if (text === null) {
    throw failures.bodyTooLarge();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw failures.invalidInput('The request body is not valid JSON. Send a JSON object.', null);
  }
  return validate(schema, parsed);
}

/** Validates a query string. A parameter that appears twice is an error, not a guess. */
export function readQuery<T>(schema: Schema<T>, url: string): T {
  const query: Record<string, string> = {};
  for (const [name, value] of new URL(url).searchParams) {
    if (Object.hasOwn(query, name)) {
      throw failures.invalidInput(
        'A query parameter appears twice. Send each parameter once.',
        FIELD_NAME.test(name) ? name : null,
      );
    }
    query[name] = value;
  }
  return validate(schema, query);
}

/** True if a path parameter has the shape of the schema. A route answers 404 when it does not. */
export function matches(schema: Schema<unknown>, value: string | undefined): value is string {
  return value !== undefined && schema.safeParse(value).success;
}
