import type { ChatMessage, CreateHouseModel, ModelFailureCode, ModelResponse } from '@prix/contracts';
import { decisionOutputJsonSchema } from '@prix/contracts';

/**
 * The house model on Workers AI, behind `ModelPort`. docs/CONTRACTS.md sections 2, 6, 10 and 15.
 *
 * Read from developers.cloudflare.com/workers-ai on 2026-10-06:
 * - features/json-mode: `response_format: {type: "json_schema", json_schema: <schema>}`, with
 *   the schema itself as the value, for the models in `JSON_MODE_MODELS` and no others. In JSON
 *   mode `response` can come back as an object.
 * - models/qwen3-30b-a3b-fp8 (sync-output.json): an OpenAI-style answer, with the text in
 *   `choices[0].message.content` and the model's reasoning apart from it in `reasoning_content`.
 * - models/llama-3.2-3b-instruct (sync-output.json): the older shape, `{response, usage}`.
 * - platform/errors: the internal codes and HTTP statuses in `ERRORS` below.
 *
 * Measured on the binding itself on 2026-10-06 (docs/reviews/phase-1-house-model.md):
 * - `choices[0].message.content` holds the text. For the 70B house model a top-level `response`
 *   holds the same answer already parsed into an object.
 * - A reasoning model leaves `content` empty or null when its output limit is spent on thinking.
 *   That is an empty answer, which the validator refuses.
 * - `usage` has `prompt_tokens`, `completion_tokens` and `neurons`, the exact cost of the call.
 *
 * The binding throws on failure. The documentation does not specify the shape of what it
 * throws, so the error is searched for a documented internal code or an HTTP status and
 * nothing else of it is used: no message leaves this file.
 */

interface KnownError {
  code: ModelFailureCode;
  httpStatus: number;
}

/** Internal code to failure, from developers.cloudflare.com/workers-ai/platform/errors/. */
const ERRORS: Readonly<Record<string, KnownError>> = {
  // "You have used up your daily free allocation of 10,000 neurons."
  '3036': { code: 'allocation_exhausted', httpStatus: 429 },
  // "Capacity temporarily exceeded, please try again."
  '3040': { code: 'provider_error', httpStatus: 429 },
  '3007': { code: 'provider_timeout', httpStatus: 408 },
  '3008': { code: 'provider_timeout', httpStatus: 408 },
  '5018': { code: 'provider_rejected', httpStatus: 403 },
  '5016': { code: 'provider_rejected', httpStatus: 403 },
  '3023': { code: 'provider_rejected', httpStatus: 403 },
  '3041': { code: 'provider_rejected', httpStatus: 403 },
  '5035': { code: 'provider_rejected', httpStatus: 403 },
  '3042': { code: 'provider_rejected', httpStatus: 404 },
  '5007': { code: 'provider_error', httpStatus: 400 },
  '5004': { code: 'provider_error', httpStatus: 400 },
  '3039': { code: 'provider_error', httpStatus: 400 },
  '3003': { code: 'provider_error', httpStatus: 400 },
  '5019': { code: 'provider_error', httpStatus: 405 },
  '5005': { code: 'provider_error', httpStatus: 405 },
  '3006': { code: 'provider_error', httpStatus: 413 },
};

/**
 * The models the JSON Mode page lists as supported. A model that is not on it gets no
 * `response_format`: every model's input schema shows the field, so the schema is no evidence
 * that the model honours it, and a request the platform cannot meet fails as a whole.
 */
const JSON_MODE_MODELS: ReadonlySet<string> = new Set([
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3.1-8b-instruct',
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
  '@hf/thebloke/deepseek-coder-6.7b-instruct-awq',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
]);

/** 64 KB. No answer of the house model is read beyond it. docs/CONTRACTS.md section 15. */
const MAX_ANSWER_CHARS = 65_536;

const KNOWN_CODE = new RegExp(`(?<![0-9])(${Object.keys(ERRORS).join('|')})(?![0-9])`);

function failure(code: ModelFailureCode, httpStatus: number | null): ModelResponse {
  return { ok: false, code, httpStatus };
}

function failureForStatus(status: number): ModelResponse {
  if (status === 401 || status === 403 || status === 404) return failure('provider_rejected', status);
  if (status === 408 || status === 504) return failure('provider_timeout', status);
  return failure('provider_error', status);
}

function knownError(code: unknown): KnownError | undefined {
  const key = typeof code === 'number' || typeof code === 'string' ? String(code) : '';
  return Object.hasOwn(ERRORS, key) ? ERRORS[key] : undefined;
}

function classifyError(error: unknown): ModelResponse {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;

  // 1. A documented internal code, as a property or inside the text of the error.
  for (const name of ['code', 'internalCode', 'internal_code']) {
    const known = knownError(fields[name]);
    if (known !== undefined) return failure(known.code, known.httpStatus);
  }
  let text = '';
  try {
    text = typeof error === 'string' ? error : String(fields.message ?? '');
  } catch {
    text = '';
  }
  const match = KNOWN_CODE.exec(text);
  const known = knownError(match?.[1]);
  if (known !== undefined) return failure(known.code, known.httpStatus);
  if (/daily free allocation/i.test(text)) return failure('allocation_exhausted', 429);

  // 2. An HTTP status, if the error carries one.
  for (const name of ['status', 'statusCode', 'httpStatus']) {
    const status = fields[name];
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
      return failureForStatus(status);
    }
  }
  return failure('provider_error', null);
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function readResult(result: unknown): ModelResponse {
  if (typeof result !== 'object' || result === null) return failure('provider_error', null);
  const { response, choices, usage } = result as { response?: unknown; choices?: unknown; usage?: unknown };

  let text: string | null = null;
  if (Array.isArray(choices) && choices.length > 0) {
    // Only `content` is the answer. `reasoning_content` is never read.
    const first = choices[0] as { message?: { content?: unknown } } | null;
    const content = first?.message?.content;
    if (typeof content === 'string') text = content;
    else if (content === null || content === undefined) text = '';
  } else if (typeof response === 'string') {
    text = response;
  } else if (typeof response === 'object' && response !== null) {
    // JSON mode returns the object itself. Its JSON text is what the validator reads.
    text = JSON.stringify(response);
  }
  if (text === null) return failure('provider_error', null);

  const counts = (typeof usage === 'object' && usage !== null ? usage : {}) as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    neurons?: unknown;
  };
  return {
    ok: true,
    text,
    inputTokens: tokenCount(counts.prompt_tokens),
    outputTokens: tokenCount(counts.completion_tokens),
    neurons: neuronCount(counts.neurons),
  };
}

/**
 * The cost Workers AI reports for the call, in neurons. It is a fraction, and it is passed on as
 * it is: the scheduler rounds the sum of a step, not each call. Null when it is not reported, or
 * is not a positive number: a call is never taken to have cost nothing.
 */
function neuronCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Qwen3 reasons before it answers unless it is told not to, and its reasoning is paid for as
 * output tokens. Qwen's own model card documents a soft switch: "/no_think" in a system or
 * user message turns reasoning off for that turn (https://huggingface.co/Qwen/Qwen3-30B-A3B,
 * read on 2026-10-06). Workers AI documents no parameter for it. The switch goes at the end
 * of the system message, so the user message stays the one JSON document of the contract.
 */
function withModelSwitches(modelId: string, messages: readonly ChatMessage[]): ChatMessage[] {
  const copy = messages.map((message) => ({ role: message.role, content: message.content }));
  if (!/qwen3/i.test(modelId)) return copy;
  const system = copy.find((message) => message.role === 'system');
  if (system === undefined) copy.unshift({ role: 'system', content: '/no_think' });
  else system.content = `${system.content}\n\n/no_think`;
  return copy;
}

const TIMED_OUT = Symbol('timed out');

/**
 * The label in a row is `house:` and the model id, so a record says which model decided even
 * after the variable HOUSE_MODEL has moved on. docs/CONTRACTS.md section 15.
 */
export const createHouseModel: CreateHouseModel = (ai, modelId) => ({
  label: `house:${modelId}`,
  async complete(request) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const input: Record<string, unknown> = {
        messages: withModelSwitches(modelId, request.messages),
        max_tokens: request.maxOutputTokens,
      };
      if (request.jsonDecision && JSON_MODE_MODELS.has(modelId)) {
        input.response_format = { type: 'json_schema', json_schema: decisionOutputJsonSchema };
      }

      // The binding takes no abort signal through `WorkersAiLike`, so the call is raced
      // against a timer. A call that loses the race is left to finish and is ignored.
      const run = Promise.resolve().then(() => ai.run(modelId, input));
      run.catch(() => {});
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), request.timeoutMs);
      });
      const result = await Promise.race([run, timeout]);
      if (result === TIMED_OUT) return failure('provider_timeout', null);
      const answer = readResult(result);
      // The same ceiling as an owner's provider: an answer this large is not a decision.
      if (answer.ok && answer.text.length > MAX_ANSWER_CHARS) return failure('provider_error', null);
      return answer;
    } catch (error) {
      return classifyError(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
});
