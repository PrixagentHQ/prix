import type { ApiErrorCode } from '@prix/contracts';
import type { ApiResult } from './api.ts';

/** The HTTP status the API gives each error code (docs/CONTRACTS.md section 8). */
const CODE_STATUS: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  name_taken: 409,
  name_not_allowed: 409,
  owner_has_agent: 409,
  league_full: 409,
  key_limit_reached: 409,
  daily_limit: 503,
  rate_limited: 429,
  internal: 500,
  no_active_season: 503,
};

export function statusForCode(code: ApiErrorCode): number {
  return CODE_STATUS[code];
}

/**
 * The status a page is sent with when the read it depends on failed: the API's own status
 * (404, 500, 503 and the rest), so that an error page is never sent as 200. 200 when the read worked.
 */
export function statusOfRead(result: ApiResult<unknown>): number {
  return result.ok ? 200 : result.status >= 400 ? result.status : 500;
}
