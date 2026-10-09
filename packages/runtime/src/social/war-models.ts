import type {
  ChatMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  WarEntrant,
  WarModelDeps,
  WorkersAiLike,
} from '@prix/contracts';
import { WAR_BYTES_PER_TOKEN_ESTIMATE, WAR_MAX_OUTPUT_TOKENS, warModelOf } from '@prix/contracts';
import { utf8Length } from '../text.ts';

/**
 * How the war job reaches its models (docs/contracts/phase-6-social.md section 5.3). No input names a
 * model, a provider, a URL or a parameter: an entrant is called only while its model is on the
 * contract's allowlist `WAR_MODELS` with the same provider. Workers AI goes through `createHouseModel`
 * over a wrapper of the AI binding that adds the entrant's `extra`; Groq goes through `createOwnModel`,
 * which holds the one allowlisted URL. The Groq key is passed there and nowhere else.
 */

/** Slack on top of WAR_TIMEOUT_MS before the job stops waiting for an adapter that does not stop itself. */
const TIMEOUT_GUARD_MS = 1_000;

/** The AI binding with the entrant's extra input fields. The job's own fields win over `extra`. */
export function withExtra(ai: WorkersAiLike, extra: Readonly<Record<string, unknown>>): WorkersAiLike {
  return {
    run: (model, input) => ai.run(model, { ...extra, ...input }),
  };
}

export type EntrantModel =
  | { ok: true; port: ModelPort }
  /** `provider_rejected`: the model is no longer on the allowlist. `key_unavailable`: Groq without a key. */
  | { ok: false; code: 'provider_rejected' | 'key_unavailable' };

/** Why an entrant cannot be asked, read before any adapter is built. Null when it can be. */
export function entrantBlock(
  entrant: WarEntrant,
  deps: Pick<WarModelDeps, 'groqApiKey'>,
): 'provider_rejected' | 'key_unavailable' | null {
  const listed = warModelOf(entrant.modelId);
  if (listed === null || listed.provider !== entrant.provider) return 'provider_rejected';
  // A Workers AI entrant without prices could not be held to the neuron caps, so it is never asked.
  if (
    listed.provider === 'workers-ai' &&
    (entrant.inputNeuronsPerMillion === null || entrant.outputNeuronsPerMillion === null)
  )
    return 'provider_rejected';
  if (listed.provider === 'groq' && (deps.groqApiKey === null || deps.groqApiKey.length === 0))
    return 'key_unavailable';
  return null;
}

/** The adapter of one entrant, built at the moment of use, after the reservation. Never throws. */
export function entrantModel(entrant: WarEntrant, deps: WarModelDeps): EntrantModel {
  const listed = warModelOf(entrant.modelId);
  if (listed === null || listed.provider !== entrant.provider) return { ok: false, code: 'provider_rejected' };
  try {
    if (listed.provider === 'workers-ai') {
      return { ok: true, port: deps.createHouseModel(withExtra(deps.ai, entrant.extra), listed.id) };
    }
    const apiKey = deps.groqApiKey;
    if (apiKey === null || apiKey.length === 0) return { ok: false, code: 'key_unavailable' };
    return { ok: true, port: deps.createOwnModel({ provider: 'groq', model: listed.id }, apiKey) };
  } catch {
    return { ok: false, code: 'key_unavailable' };
  }
}

/** The request every entrant gets: the same messages shape, output limit, timeout and JSON mode. */
export function warRequest(messages: ChatMessage[], timeoutMs: number): ModelRequest {
  return { messages, maxOutputTokens: WAR_MAX_OUTPUT_TOKENS, timeoutMs, jsonDecision: true };
}

/** Input tokens of a request, from its size in UTF-8 bytes, as the scheduler estimates them. */
export function estimateInputTokens(request: ModelRequest): number {
  let bytes = 0;
  for (const message of request.messages) bytes += utf8Length(message.content);
  return Math.ceil(bytes / WAR_BYTES_PER_TOKEN_ESTIMATE);
}

function neuronsFor(entrant: WarEntrant, inputTokens: number, outputTokens: number): number {
  const input = entrant.inputNeuronsPerMillion ?? 0;
  const output = entrant.outputNeuronsPerMillion ?? 0;
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The most one call can cost in neurons: the estimated input and every output token. Zero for Groq. */
export function worstNeurons(entrant: WarEntrant, request: ModelRequest): number {
  if (entrant.provider !== 'workers-ai') return 0;
  return Math.ceil(neuronsFor(entrant, estimateInputTokens(request), whole(request.maxOutputTokens)));
}

/**
 * What one call cost: the figure Workers AI reported, else its token counts at the entrant's prices,
 * else the estimate. A timed-out call may have run to the end and is counted in full. Zero for Groq.
 */
export function spentNeurons(entrant: WarEntrant, request: ModelRequest, response: ModelResponse): number {
  if (entrant.provider !== 'workers-ai') return 0;
  if (response.ok) {
    const reported = response.neurons;
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return reported;
    return neuronsFor(
      entrant,
      response.inputTokens ?? estimateInputTokens(request),
      response.outputTokens ?? whole(request.maxOutputTokens),
    );
  }
  if (response.code === 'provider_timeout') {
    return neuronsFor(entrant, estimateInputTokens(request), whole(request.maxOutputTokens));
  }
  return 0;
}

/** One model call that cannot throw and cannot hang. */
export async function callWarModel(model: ModelPort, request: ModelRequest): Promise<ModelResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve().then(() => model.complete(request));
    call.catch(() => {});
    const guard = new Promise<ModelResponse>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, code: 'provider_timeout', httpStatus: null }),
        whole(request.timeoutMs) + TIMEOUT_GUARD_MS,
      );
    });
    const response = await Promise.race([call, guard]);
    if (typeof response !== 'object' || response === null)
      return { ok: false, code: 'provider_error', httpStatus: null };
    if (response.ok && typeof response.text !== 'string')
      return { ok: false, code: 'provider_error', httpStatus: null };
    return response;
  } catch {
    return { ok: false, code: 'provider_error', httpStatus: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
