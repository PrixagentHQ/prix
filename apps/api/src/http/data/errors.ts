import {
  ChainUnavailableError,
  DATA_ERROR_STATUS,
  DailyLimitError,
  type DataError,
  DataFailure,
} from '@prix/contracts';
import { ApiFailure, secondsToUtcMidnight } from '../errors.ts';

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

/** The error answer. No CORS header is ever added. A message is written by hand, never taken from a request. */
export function dataErrorResponse(failure: DataFailure, now: Date = new Date()): Response {
  const body: DataError = { error: { code: failure.code, message: failure.message, field: failure.field } };
  const headers: Record<string, string> = { ...BASE_HEADERS, ...failure.headers };
  if (headers['Retry-After'] === undefined) {
    if (failure.code === 'rate_limited') headers['Retry-After'] = '60';
    else if (failure.code === 'quota_exceeded' || failure.code === 'api_busy' || failure.code === 'daily_limit') {
      headers['Retry-After'] = String(secondsToUtcMidnight(now));
    }
  }
  return new Response(JSON.stringify(body), { status: DATA_ERROR_STATUS[failure.code], headers });
}

/** Anything thrown becomes a failure the caller may see. The log line carries the kind of error, never its text. */
export function toDataFailure(error: unknown): DataFailure {
  if (error instanceof DataFailure) return error;
  // A shared helper of Phase 1 (body reading) throws its own failure type: only a bad input passes through.
  if (error instanceof ApiFailure && error.code === 'invalid_input') {
    return new DataFailure('invalid_input', error.message, error.field);
  }
  if (error instanceof DailyLimitError) {
    return new DataFailure(
      'daily_limit',
      'Prix has used up a daily limit of its hosting. Nothing was lost. Try again after 00:00 UTC.',
    );
  }
  if (error instanceof ChainUnavailableError) {
    return new DataFailure('chain_unavailable', 'The chain could not be read right now. Try again in a minute.');
  }
  console.error(JSON.stringify({ event: 'data_api_error', error: error instanceof Error ? error.name : 'unknown' }));
  return new DataFailure('internal', 'Something went wrong on our side. Try again in a moment.');
}

export const dataFailures = {
  notFound: () => new DataFailure('not_found', 'There is no such route. Check the address and the method.'),
  forbiddenOrigin: () =>
    new DataFailure(
      'forbidden',
      'This request was refused. Send it from the Prix site, with the JSON content type, and try again.',
    ),
  notAdmin: () => new DataFailure('forbidden', 'This wallet is not an admin. Sign in with an admin wallet.'),
  unauthorized: () => new DataFailure('unauthorized', 'You are not signed in. Sign in with your wallet and try again.'),
  rateLimited: () => new DataFailure('rate_limited', 'Too many requests. Wait a minute and try again.'),
  invalid: (message: string, field: string | null = null) => new DataFailure('invalid_input', message, field),
};
