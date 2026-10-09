import type { ProviderId } from '@prix/contracts';

/**
 * Where an owner's key may be sent. docs/CONTRACTS.md section 12.
 *
 * This table is the only place in the product that holds a model URL. Each entry is one fixed
 * chat-completions URL, read from the provider's own documentation on the day in `readOn`,
 * with the page it was read from beside it. No function here or anywhere else takes a URL:
 * a caller names a provider id from the allowlist and nothing more.
 */
export interface ProviderEndpoint {
  /** The one URL a key of this provider is ever sent to. */
  readonly chatCompletionsUrl: string;
  /** The page of the provider's own documentation that states the URL. */
  readonly sourceUrl: string;
  /** The UTC day the page was read. */
  readonly readOn: string;
  /** The request field that limits the answer's length, as that provider documents it. */
  readonly maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /** True where the provider documents `response_format: {"type": "json_object"}` for this endpoint. */
  readonly jsonObjectMode: boolean;
  /** What the documentation says that an owner or the operator should know. */
  readonly note: string;
}

export const PROVIDER_ENDPOINTS: Readonly<Record<ProviderId, ProviderEndpoint>> = Object.freeze({
  openai: {
    chatCompletionsUrl: 'https://api.openai.com/v1/chat/completions',
    sourceUrl: 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create',
    readOn: '2026-10-06',
    maxTokensField: 'max_completion_tokens',
    jsonObjectMode: true,
    note: 'The reference shows the full URL with a Bearer key. max_tokens is deprecated in favor of max_completion_tokens, which counts reasoning tokens too.',
  },
  anthropic: {
    chatCompletionsUrl: 'https://api.anthropic.com/v1/chat/completions',
    sourceUrl: 'https://platform.claude.com/docs/en/api/openai-sdk',
    readOn: '2026-10-06',
    maxTokensField: 'max_tokens',
    jsonObjectMode: false,
    note: 'The page gives the base URL https://api.anthropic.com/v1/ for the OpenAI SDK, which appends chat/completions. Anthropic calls this layer a way to test and compare, not a production solution, and it ignores response_format.',
  },
  google: {
    chatCompletionsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    readOn: '2026-10-06',
    maxTokensField: 'max_tokens',
    jsonObjectMode: false,
    note: 'The page shows the full URL with a Bearer key and says OpenAI compatibility is still in beta. It names neither token-limit field and does not document json_object.',
  },
  openrouter: {
    chatCompletionsUrl: 'https://openrouter.ai/api/v1/chat/completions',
    sourceUrl: 'https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request',
    readOn: '2026-10-06',
    maxTokensField: 'max_completion_tokens',
    jsonObjectMode: true,
    note: 'The reference shows the full URL with a Bearer key. max_tokens is deprecated in favor of max_completion_tokens.',
  },
  groq: {
    chatCompletionsUrl: 'https://api.groq.com/openai/v1/chat/completions',
    sourceUrl: 'https://console.groq.com/docs/api-reference',
    readOn: '2026-10-06',
    maxTokensField: 'max_completion_tokens',
    jsonObjectMode: true,
    note: 'The reference shows the full URL with a Bearer key. max_tokens is deprecated in favor of max_completion_tokens.',
  },
  xai: {
    chatCompletionsUrl: 'https://api.x.ai/v1/chat/completions',
    sourceUrl: 'https://docs.x.ai/developers/rest-api-reference/inference/chat-completions',
    readOn: '2026-10-06',
    maxTokensField: 'max_completion_tokens',
    jsonObjectMode: false,
    note: 'xAI documents this endpoint as the legacy predecessor of its Responses API, with no end date. The page does not spell out the response_format variants, so none is sent.',
  },
});

/** The endpoint of an allowlisted provider. Null for anything that is not on the list. */
export function providerEndpoint(provider: ProviderId): ProviderEndpoint | null {
  return Object.hasOwn(PROVIDER_ENDPOINTS, provider) ? PROVIDER_ENDPOINTS[provider] : null;
}
