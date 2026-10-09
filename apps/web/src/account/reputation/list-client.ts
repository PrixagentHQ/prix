import type {
  ClaimMessageInput,
  ClaimMessageResponse,
  CreateListingInput,
  ListingOwnerResponse,
  ListingStatus,
  MyListingsResponse,
} from '@prix/contracts';

/**
 * The browser's calls of the listing flow: same-origin fetches that carry the session cookie.
 * Under `__PRIX_FIXTURES__` the same calls answer from `list-fixtures.ts`. A call never throws.
 * Answers are read with small hand-written guards: the page does not load the schema library.
 */

export type Failure = { ok: false; status: number; code: string; field: string | null; message: string };
export type Result<T> = { ok: true; data: T } | Failure;

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isText = (value: unknown): value is string => typeof value === 'string';

function failure(status: number, body?: unknown): Failure {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = error && isText(error.code) ? error.code : status === 401 ? 'unauthorized' : 'internal';
  return {
    ok: false,
    status,
    code,
    field: error && isText(error.field) ? error.field : null,
    message: error && isText(error.message) ? error.message : '',
  };
}

async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Result<unknown>> {
  if (FIXTURES) {
    const { fixtureAnswer } = await import('./list-fixtures.ts');
    return fixtureAnswer(new URL(window.location.href), method, path, body);
  }
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return response.ok ? { ok: true, data: json } : failure(response.status, json);
  } catch {
    return failure(502);
  }
}

const unusable = (): Failure => failure(502);

function isOwnerView(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.id) &&
    isText(value.name) &&
    isText(value.wallet) &&
    isText(value.status) &&
    isText(value.syncState) &&
    typeof value.eventCount === 'number'
  );
}

export async function claimMessage(input: ClaimMessageInput): Promise<Result<ClaimMessageResponse>> {
  const answer = await send('POST', '/api/reputation/listings/claim-message', input);
  if (!answer.ok) return answer;
  const data = answer.data;
  const good =
    isRecord(data) && isText(data.message) && isText(data.nonce) && isText(data.issuedAt) && isText(data.expiresAt);
  return good ? { ok: true, data: data as unknown as ClaimMessageResponse } : unusable();
}

export async function createListing(input: CreateListingInput): Promise<Result<ListingOwnerResponse>> {
  const answer = await send('POST', '/api/reputation/listings', input);
  if (!answer.ok) return answer;
  return isRecord(answer.data) && isOwnerView(answer.data.listing)
    ? { ok: true, data: answer.data as unknown as ListingOwnerResponse }
    : unusable();
}

export async function myListings(): Promise<Result<MyListingsResponse>> {
  const answer = await send('GET', '/api/reputation/me/listings');
  if (!answer.ok) return answer;
  const data = answer.data;
  return isRecord(data) &&
    Array.isArray(data.listings) &&
    data.listings.every(isOwnerView) &&
    typeof data.remaining === 'number'
    ? { ok: true, data: data as unknown as MyListingsResponse }
    : unusable();
}

export async function setListingStatus(id: string, status: ListingStatus): Promise<Result<ListingOwnerResponse>> {
  const answer = await send('POST', `/api/reputation/listings/${encodeURIComponent(id)}/status`, { status });
  if (!answer.ok) return answer;
  return isRecord(answer.data) && isOwnerView(answer.data.listing)
    ? { ok: true, data: answer.data as unknown as ListingOwnerResponse }
    : unusable();
}
