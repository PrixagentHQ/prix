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
 * Reads at most `MAX_BODY_BYTES` of a body. Null when the body is larger or is not UTF-8.
 *
 * The size a request declares is checked first. A body that declares none, or declares less than
 * it sends, is counted as it arrives and dropped at the limit. Either way nothing larger than the
 * limit is ever decoded or handed to the JSON parser.
 */
export async function readText(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
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
