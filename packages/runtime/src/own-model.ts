import type { CreateOwnModel, ModelFailureCode, ModelRequest, ModelResponse } from '@prix/contracts';
import { providerEndpoint } from './providers.ts';

/**
 * An owner's model on an allowlisted provider, behind `ModelPort`. docs/CONTRACTS.md
 * sections 6, 12 and 15.
 *
 * The key goes to one place only: the fixed URL of the provider in `providers.ts`, in the
 * Authorization header. It is never put in a URL, a body, a log or an error. A failure is a
 * code and an HTTP status: the provider's own message is never read, because it can echo
 * part of a key.
 *
 * A redirect is never followed. The request is sent with `redirect: 'manual'`, and a 3xx answer
 * is then a failure like any other status outside 200 to 299. Read on 2026-10-06 from
 * developers.cloudflare.com/workers/runtime-apis/request: with `manual`, "the 3xx redirect
 * response will be returned to the caller as-is". The page lists the mode `error` as well but
 * does not say what it does on Workers, so the documented mode is the one used.
 *
 * At most 64 KB of an answer is read. A longer answer is dropped and is a failure.
 */

/** 64 KB. docs/CONTRACTS.md section 15. */
const MAX_ANSWER_BYTES = 65_536;

function failure(code: ModelFailureCode, httpStatus: number | null): ModelResponse {
  return { ok: false, code, httpStatus };
}

/** 401, 403 and 404 mean the key or the model name is wrong. Every other status is a provider error. */
function failureForStatus(status: number): ModelResponse {
  if (status === 401 || status === 403 || status === 404) return failure('provider_rejected', status);
  return failure('provider_error', status >= 100 && status <= 599 ? status : null);
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** The text of the first choice. A provider may send it as a string or as a list of text parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const { type, text: partText } = part as { type?: unknown; text?: unknown };
    if ((type === undefined || type === 'text') && typeof partText === 'string') text += partText;
  }
  return text;
}

function readChatCompletion(value: unknown): ModelResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const { choices, usage } = value as { choices?: unknown; usage?: unknown };
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } } | null;
  if (typeof first !== 'object' || first === null || typeof first.message !== 'object' || first.message === null) {
    return null;
  }
  const counts = (typeof usage === 'object' && usage !== null ? usage : {}) as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  return {
    ok: true,
    // Only the answer is read. Reasoning fields, where a provider sends them, are ignored.
    text: contentText(first.message.content),
    inputTokens: tokenCount(counts.prompt_tokens),
    outputTokens: tokenCount(counts.completion_tokens),
  };
}

/** Lets go of a body that will not be read. */
function drop(response: Response): void {
  try {
    response.body?.cancel().catch(() => {});
  } catch {
    // Nothing to release.
  }
}

/**
 * The body as text, read chunk by chunk and never past `MAX_ANSWER_BYTES`. Null when the body
 * is longer than that: reading stops there and the rest is cancelled.
 */
async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
    drop(response);
    return null;
  }
  const body = response.body;
  if (body === null || body === undefined) return '';

  const reader = body.getReader();
  const bytes = new Uint8Array(MAX_ANSWER_BYTES);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) continue;
    if (length + value.byteLength > MAX_ANSWER_BYTES) {
      reader.cancel().catch(() => {});
      return null;
    }
    bytes.set(value, length);
    length += value.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
}

export const createOwnModel: CreateOwnModel = (key, apiKey, fetchImpl) => {
  const provider = key.provider;
  const model = key.model;
  // The global fetch must be called as a plain function, not as a detached reference.
  const send: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));

  async function exchange(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const endpoint = providerEndpoint(provider);
    if (endpoint === null) return failure('provider_error', null);

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      [endpoint.maxTokensField]: request.maxOutputTokens,
    };
    if (request.jsonDecision && endpoint.jsonObjectMode) body.response_format = { type: 'json_object' };

    const response = await send(endpoint.chatCompletionsUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      // Never followed: the key goes to the allowlisted host and nowhere else.
      redirect: 'manual',
    });

    const status = response.status;
    if (status < 200 || status > 299) {
      // The body of an error, and of a redirect, is dropped unread.
      drop(response);
      return failureForStatus(status);
    }

    const raw = await readCapped(response);
    if (raw === null) return failure('provider_error', status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return failure('provider_error', status);
    }
    return readChatCompletion(parsed) ?? failure('provider_error', status);
  }

  /** One call with its time limit. The limit covers the answer's body too, not only its headers. */
  async function call(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<ModelResponse>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(failure('provider_timeout', null));
      }, request.timeoutMs);
    });
    // A failure after the limit is the limit, whatever the transport called it.
    const work = exchange(request, controller.signal).catch(() =>
      timedOut ? failure('provider_timeout', null) : failure('provider_error', null),
    );
    try {
      return await Promise.race([work, limit]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    label: `${provider}:${model}`,
    async complete(request) {
      try {
        return await call(request);
      } catch {
        return failure('provider_error', null);
      }
    },
  };
};
