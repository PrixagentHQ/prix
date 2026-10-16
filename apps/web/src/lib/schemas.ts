import {
  agentPublicSchema,
  agentResponseSchema,
  apiErrorSchema,
  holdsResponseSchema,
  leagueResponseSchema,
  marketPricesResponseSchema,
  marketResponseSchema,
  meResponseSchema,
  modelKeyResponseSchema,
  nonceResponseSchema,
  ownerHoldsSettingSchema,
  pollMeResponseSchema,
  pollStatusResponseSchema,
  pollsResponseSchema,
  pollTallyOutcomeSchema,
  pollVoteResponseSchema,
  providersResponseSchema,
  seasonsResponseSchema,
  sessionResponseSchema,
  telegramWebhookAdminResponseSchema,
  telegramWebhookStateSchema,
} from '@prix/contracts';

/**
 * The contract schemas the page client checks answers with. Only api.ts imports this file, and
 * only on the server, through a dynamic import behind `import.meta.env.SSR`: the build drops it
 * from every browser script, so zod never ships to a visitor. The browser takes the API's
 * answer as it is, because the browser is not where anything is decided.
 */
export const schemas = {
  market: marketResponseSchema,
  marketPrices: marketPricesResponseSchema,
  seasons: seasonsResponseSchema,
  league: leagueResponseSchema,
  agent: agentPublicSchema,
  providers: providersResponseSchema,
  nonce: nonceResponseSchema,
  session: sessionResponseSchema,
  me: meResponseSchema,
  agentResponse: agentResponseSchema,
  modelKey: modelKeyResponseSchema,
  holds: holdsResponseSchema,
  apiError: apiErrorSchema,
  // Phase 6.7, the holders round (docs/contracts/phase-6-holders.md).
  polls: pollsResponseSchema,
  pollMe: pollMeResponseSchema,
  pollStatus: pollStatusResponseSchema,
  pollVote: pollVoteResponseSchema,
  pollTallyOutcome: pollTallyOutcomeSchema,
  ownerHolds: ownerHoldsSettingSchema,
  telegramWebhookAdmin: telegramWebhookAdminResponseSchema,
  telegramWebhookState: telegramWebhookStateSchema,
} as const;
