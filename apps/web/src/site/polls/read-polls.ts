// The server reads of the holders' poll (docs/contracts/phase-6-holders.md sections 4.4 to 4.6). Server
// side only, through the API service binding. Neither read throws.
//
//   pollsIsOn(context)   GET /api/polls/status: 'on' while POLLS_ENABLED is on, 'off' for its 404, 'failed'
//                        for anything else. An isolate keeps the answer a minute (ten seconds when it
//                        failed), as the site keeps the room's probe.
//   readPolls(context)   GET /api/polls, parsed with `pollsResponseSchema`, read once a request so that the
//                        route file and the page share one call.
//
// In a fixture build both answer from ./fixtures.ts by `?state=` (see there); nothing is kept.
import { type PollsResponse, pollStatusResponseSchema, pollsResponseSchema } from '@prix/contracts';
import type { ApiContext } from '../../lib/api.ts';

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;
export const PROBE_KEEP_MS = 60_000;
export const PROBE_FAILED_KEEP_MS = 10_000;

export type PollsSwitch = 'on' | 'off' | 'failed';
export type PollsRead = { ok: true; data: PollsResponse } | { ok: false; status: number };

async function get(context: ApiContext, path: string): Promise<Response> {
  const { createServerTransport } = await import('../../lib/api-server.ts');
  return createServerTransport(context)({ method: 'GET', path });
}

/** What the status read's answer says of the switch. */
export async function switchOfResponse(response: Response): Promise<PollsSwitch> {
  if (response.status === 404) return 'off';
  if (!response.ok) return 'failed';
  try {
    return pollStatusResponseSchema.safeParse(await response.json()).success ? 'on' : 'failed';
  } catch {
    return 'failed';
  }
}

export interface ProbeSlot {
  kept?: { at: number; value: PollsSwitch };
}

/** The kept answer while it is fresh (a minute, ten seconds when it failed), or a new one from `ask`. */
export async function probe(slot: ProbeSlot, now: number, ask: () => Promise<PollsSwitch>): Promise<PollsSwitch> {
  const kept = slot.kept;
  if (kept && now - kept.at < (kept.value === 'failed' ? PROBE_FAILED_KEEP_MS : PROBE_KEEP_MS)) return kept.value;
  let value: PollsSwitch;
  try {
    value = await ask();
  } catch {
    value = 'failed';
  }
  slot.kept = { at: now, value };
  return value;
}

/** Whether the holders' poll is on. The page /polls is the site's 404 on 'off'; nothing links to it then. */
export async function pollsIsOn(context: ApiContext): Promise<PollsSwitch> {
  if (FIXTURES) {
    const { pollsFixtureSwitch } = await import('./fixtures.ts');
    return pollsFixtureSwitch(context.url);
  }
  const memory = globalThis as { __prixPollsOn?: ProbeSlot };
  memory.__prixPollsOn ??= {};
  return probe(memory.__prixPollsOn, Date.now(), async () => switchOfResponse(await get(context, '/api/polls/status')));
}

const reads = new WeakMap<Request, Promise<PollsRead>>();

async function fetchPolls(context: ApiContext): Promise<PollsRead> {
  try {
    if (FIXTURES) {
      const { pollsFixtureRead } = await import('./fixtures.ts');
      return pollsFixtureRead(context.url);
    }
    const response = await get(context, '/api/polls');
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status >= 400 ? response.status : 502 };
    }
    const parsed = pollsResponseSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502 };
  } catch {
    return { ok: false, status: 502 };
  }
}

/** GET /api/polls, once a request. */
export function readPolls(context: ApiContext): Promise<PollsRead> {
  const earlier = reads.get(context.request);
  if (earlier) return earlier;
  const answer = fetchPolls(context);
  reads.set(context.request, answer);
  return answer;
}
