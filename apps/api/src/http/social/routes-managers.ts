import type {
  CreateManagerInput,
  ManagerBookRow,
  ManagerDetailResponse,
  ManagerListResponse,
  ManagerPolicy,
  ManagerRebalance,
  ManagerRecord,
  ManagerRow,
  MyManagersResponse,
  SocialAgentRecord,
  SocialApiDeps,
} from '@prix/contracts';
import {
  agentNameKey,
  agentNameSchema,
  BPS,
  CREATION_PERIOD_DAYS,
  createManagerInputSchema,
  creationPeriod,
  idSchema,
  MANAGER_CREATE_WRITE_ROWS,
  MANAGER_EXTRA_CREATIONS_PER_PERIOD,
  MANAGER_POLICY_WRITE_ROWS,
  MANAGER_REBALANCES_SHOWN,
  MANAGER_STATUS_WRITE_ROWS,
  MANAGERS_CREATED_PER_DAY,
  MAX_MANAGERS_TOTAL,
  managerNameSchema,
  maxManagersFor,
  NEW_MANAGERS_PER_NETWORK_PER_DAY,
  NEW_MANAGERS_PER_NETWORK_PER_PERIOD,
  newId,
  openPreviewEntitlements,
  patchManagerInputSchema,
  SOCIAL_PAGE_SIZE,
  setManagerHiddenInputSchema,
  socialPageQuerySchema,
  WALLET_SEASONING_SECONDS,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { isBlockedName } from '../blocked-names.ts';
import { ApiFailure, failures, json, noContent, secondsToUtcMidnight } from '../errors.ts';
import { clientNetwork, requireSession, requireWriter } from '../guard.ts';
import { matches, readInput, readQuery, type Schema } from '../input.ts';
import { networkKey } from '../reputation/claim.ts';
import { currentSeason } from '../views.ts';
import { adminOr404, audit, dayOf, refOf, socialFailures } from './shared.ts';

/**
 * Paper managers: a signed-in wallet holds 2 to 5 public agents at weights, valued daily at their
 * published end-of-day values. Section 5.5. The server decides eligibility, slots, the day a policy
 * takes effect and every figure; a request names agents and weights and nothing else.
 */

/** The most managers one wallet's own list shows: every active or paused one, then the newest closed ones. */
const MY_MANAGERS_SHOWN = 12;

const slotLimit = () =>
  new ApiFailure(
    'forbidden',
    'This wallet uses all of its paper manager slots. Close or pause one, or see the token page for more slots.',
  );
/** The first UTC day of the next rolling period (D-109), and the seconds until it starts. */
function nextPeriod(at: Date, today: string): { day: string; seconds: number } {
  const start = (creationPeriod(today) + 1) * CREATION_PERIOD_DAYS * 86_400_000;
  return {
    day: new Date(start).toISOString().slice(0, 10),
    seconds: Math.max(1, Math.ceil((start - at.getTime()) / 1000)),
  };
}

const walletPeriodLimit = (at: Date, today: string) =>
  new ApiFailure(
    'forbidden',
    `This wallet has created as many paper managers in this ${CREATION_PERIOD_DAYS}-day period as it may. Edit one of them instead, or create one after ${nextPeriod(at, today).day} 00:00 UTC.`,
  );
/** The sentence of the Phase 2 creation guard, for paper managers. */
const networkDayLimit = (at: Date) =>
  new ApiFailure(
    'rate_limited',
    'Too many paper managers were created from this network today. Try again after 00:00 UTC.',
    null,
    { 'Retry-After': String(secondsToUtcMidnight(at)) },
  );
const networkPeriodLimit = (at: Date, today: string) => {
  const next = nextPeriod(at, today);
  return new ApiFailure(
    'rate_limited',
    `Too many paper managers were created from this network in this ${CREATION_PERIOD_DAYS}-day period. Try again after ${next.day} 00:00 UTC.`,
    null,
    { 'Retry-After': String(next.seconds) },
  );
};
/**
 * Wallet seasoning, as agent creation checks it (docs/contracts/phase-2-reputation.md section 8): a
 * wallet creates a paper manager only `WALLET_SEASONING_SECONDS` after its first sign-in. Checked before
 * any counter is taken, so a refused wallet spends nothing (contract 6.1).
 */
async function requireSeasoned(deps: SocialApiDeps, address: string, at: Date): Promise<void> {
  const first = await deps.reputation.getFirstSignIn(address);
  const readyAt = first === null ? Number.NaN : Date.parse(first) + WALLET_SEASONING_SECONDS * 1000;
  if (at.getTime() >= readyAt) return;
  const wait = Number.isNaN(readyAt)
    ? WALLET_SEASONING_SECONDS
    : Math.max(1, Math.ceil((readyAt - at.getTime()) / 1000));
  throw new ApiFailure(
    'rate_limited',
    `A new wallet can create a paper manager ${Math.ceil(WALLET_SEASONING_SECONDS / 60)} minutes after its first sign-in. Try again in ${Math.ceil(wait / 60)} minutes.`,
    null,
    { 'Retry-After': String(wait) },
  );
}
const everyoneDayLimit = (at: Date) =>
  new ApiFailure(
    'rate_limited',
    'Prix has opened as many paper managers today as it opens in a day. Try again after 00:00 UTC.',
    null,
    { 'Retry-After': String(secondsToUtcMidnight(at)) },
  );

/**
 * The body of POST /social/managers, read with `createManagerInputSchema`. A name that is a valid
 * name in shape but uses a word a paper manager may not use (the manager list, the Phase 6 word rules
 * of `managerNameSchema`, the abuse list) is answered as a blocked word, 409 `name_not_allowed`,
 * before the schema would answer it 400 (section 6; security review 6, finding 7).
 */
const createManagerInput: Schema<CreateManagerInput> = {
  safeParse(input: unknown) {
    const name = typeof input === 'object' && input !== null ? (input as { name?: unknown }).name : undefined;
    if (
      typeof name === 'string' &&
      matches(agentNameSchema, name) &&
      (!matches(managerNameSchema, name) || isBlockedName(name))
    ) {
      throw failures.nameNotAllowed();
    }
    return createManagerInputSchema.safeParse(input);
  },
};
const closedManager = () =>
  failures.invalidInput('This paper manager is closed. A closed manager keeps its record and never changes.', 'status');

function holdsSlot(manager: ManagerRecord): boolean {
  return manager.status === 'active' || manager.status === 'paused';
}

/** 400 unless every agent is public, active and has a portfolio in the season. Nothing tells which one failed or why. */
async function checkEligible(deps: SocialApiDeps, targets: Record<string, number>, seasonId: string): Promise<void> {
  const results = await Promise.all(
    Object.keys(targets).map(async (id) => {
      const agent = await deps.store.getAgent(id);
      if (agent === null || agent.hidden || agent.status !== 'active') return false;
      return (await deps.store.getPortfolio(id, seasonId)) !== null;
    }),
  );
  if (!results.every(Boolean)) {
    throw failures.invalidInput(
      'Every agent of a paper manager must be public, active and in the league. Choose other agents.',
      'targetsBps',
    );
  }
}

async function slotsFor(deps: SocialApiDeps, address: string): Promise<number> {
  return maxManagersFor(await (deps.entitlements ?? openPreviewEntitlements).entitlementsFor(address));
}

function rowOf(
  manager: ManagerRecord,
  policy: ManagerPolicy,
  book: ManagerBookRow | null,
  seasonId: string | null,
): ManagerRow {
  return {
    id: manager.id,
    name: manager.name,
    status: manager.status,
    schedule: policy.schedule,
    agentCount: Object.keys(policy.targetsBps).length,
    createdAt: manager.createdAt,
    season:
      book === null || seasonId === null
        ? null
        : {
            seasonId,
            returnBps: book.stats.seasonReturnBps,
            maxDrawdownBps: book.stats.maxDrawdownBps,
            volMilliBps: book.volMilliBps,
            valuedDays: book.stats.tradingDays,
            equityMicro: book.stats.equityMicro,
          },
  };
}

/** A share in basis points, rounded down, in BigInt because the product can pass the safe range. */
function shareBps(part: number, whole: number): number {
  return whole <= 0 ? 0 : Number((BigInt(part) * BigInt(BPS)) / BigInt(whole));
}

/** A rebalance with every line of an agent that is no longer public taken out. */
function rebalancePublic(rebalance: ManagerRebalance, shown: ReadonlySet<string>): ManagerRebalance {
  const targetsBps: Record<string, number> = {};
  for (const [id, bps] of Object.entries(rebalance.targetsBps)) if (shown.has(id)) targetsBps[id] = bps;
  return {
    day: rebalance.day,
    reason: rebalance.reason,
    policyVersion: rebalance.policyVersion,
    targetsBps,
    fills: rebalance.fills.filter((fill) => shown.has(fill.agentId)),
    exited: rebalance.exited.filter((id) => shown.has(id)),
    equityBeforeMicro: rebalance.equityBeforeMicro,
    equityAfterMicro: rebalance.equityAfterMicro,
    costMicro: rebalance.costMicro,
  };
}

/** The page of one paper manager. An agent that is no longer public is named by nothing: no id, no name, no figure. */
async function detailOf(
  deps: SocialApiDeps,
  manager: ManagerRecord,
  policy: ManagerPolicy,
): Promise<ManagerDetailResponse> {
  const { social, sim } = deps;
  const season = await currentSeason(deps.store, deps.now().toISOString());
  const [bookRow, rebalances] =
    season === null
      ? [null, []]
      : await Promise.all([
          social.getManagerBook(manager.id, season.id),
          social.listManagerRebalances(manager.id, season.id, MANAGER_REBALANCES_SHOWN),
        ]);
  const book = bookRow?.book ?? null;
  const ids = [...new Set([...Object.keys(policy.targetsBps), ...Object.keys(book?.holdings ?? {})])];
  const records = ids.length === 0 ? [] : await social.listAgentRecords(ids);
  const visible = new Map<string, SocialAgentRecord>();
  for (const record of records) if (!record.hidden) visible.set(record.id, record);

  // Valued at each agent's last value, with the paper engine's own arithmetic.
  const values: Record<string, number> = {};
  let equity = book?.cashMicro ?? 0;
  for (const [id, units] of Object.entries(book?.holdings ?? {})) {
    const price = book?.lastValue[id];
    if (price === undefined || units <= 0) continue;
    values[id] = sim.valuePortfolio({ cashMicro: 0, holdings: { [id]: units } }, { [id]: price });
    equity += values[id] ?? 0;
  }
  const exited = new Set(rebalances.flatMap((rebalance) => rebalance.exited));

  const allocation: ManagerDetailResponse['allocation'] = ids.map((id) => {
    const record = visible.get(id);
    const held = values[id] !== undefined;
    const state =
      book === null || (book.missingDays[id] ?? 0) > 0
        ? 'no_point_today'
        : !held && exited.has(id)
          ? 'exited'
          : 'valued';
    return {
      agent: record === undefined ? null : refOf(deps, record),
      targetBps: policy.targetsBps[id] ?? 0,
      // A line of an agent that is no longer public carries no figure of it.
      currentBps: record === undefined ? 0 : shareBps(values[id] ?? 0, equity),
      state,
    };
  });

  const shown = new Set(visible.keys());
  return {
    manager: { ...rowOf(manager, policy, bookRow, season?.id ?? null), policyVersion: manager.policyVersion },
    allocation,
    cashBps: book === null ? BPS : shareBps(book.cashMicro, equity),
    lastRebalanceDay: book?.lastRebalanceDay ?? null,
    daily: bookRow?.stats.daily ?? [],
    rebalances: rebalances.slice(0, MANAGER_REBALANCES_SHOWN).map((rebalance) => rebalancePublic(rebalance, shown)),
  };
}

async function latestPolicy(deps: SocialApiDeps, manager: ManagerRecord): Promise<ManagerPolicy> {
  const policy = await deps.social.getLatestPolicy(manager.id);
  if (policy === null) throw new Error('a paper manager has no policy');
  return policy;
}

export function registerManagerRoutes(app: Hono, deps: SocialApiDeps): void {
  const { store, social, reputation } = deps;

  app.get('/social/managers', async (c) => {
    const { page } = readQuery(socialPageQuerySchema, c.req.url);
    const season = await currentSeason(store, deps.now().toISOString());
    const rows =
      season === null ? [] : await social.listManagers(season.id, SOCIAL_PAGE_SIZE + 1, (page - 1) * SOCIAL_PAGE_SIZE);
    return json<ManagerListResponse>(
      {
        seasonId: season?.id ?? null,
        page,
        hasMore: rows.length > SOCIAL_PAGE_SIZE,
        managers: rows
          .slice(0, SOCIAL_PAGE_SIZE)
          .filter((row) => !row.manager.hidden)
          .map((row) => rowOf(row.manager, row.policy, row.book, season?.id ?? null)),
      },
      200,
      'public',
    );
  });

  app.get('/social/managers/:id', async (c) => {
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw socialFailures.managerNotFound();
    const manager = await social.getManager(id);
    if (manager === null || manager.hidden) throw socialFailures.managerNotFound();
    return json<ManagerDetailResponse>(await detailOf(deps, manager, await latestPolicy(deps, manager)), 200, 'public');
  });

  app.get('/social/me/managers', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const today = dayOf(deps.now().toISOString());
    const [owned, max, season] = await Promise.all([
      social.listManagersByOwner(session.address),
      slotsFor(deps, session.address),
      currentSeason(store, deps.now().toISOString()),
    ]);
    const used = owned.filter(holdsSlot).length;
    const listed = [
      ...owned.filter(holdsSlot),
      ...owned.filter((manager) => !holdsSlot(manager)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    ].slice(0, MY_MANAGERS_SHOWN);
    const managers = await Promise.all(
      listed.map(async (manager) => {
        const [policy, book] = await Promise.all([
          latestPolicy(deps, manager),
          season === null ? Promise.resolve(null) : social.getManagerBook(manager.id, season.id),
        ]);
        return {
          ...rowOf(manager, policy, book, season?.id ?? null),
          hidden: manager.hidden,
          targetsBps: { ...policy.targetsBps },
          changedToday: policy.version > 1 && policy.setDay === today,
        };
      }),
    );
    return json<MyManagersResponse>({ slots: { used, max }, managers }, 200, 'private');
  });

  app.post('/social/managers', async (c) => {
    const session = await requireWriter(deps, c.req.raw, MANAGER_CREATE_WRITE_ROWS);
    const input = await readInput(createManagerInput, c.req.raw);
    const at = deps.now();
    const now = at.toISOString();
    const today = dayOf(now);
    const season = await store.getActiveSeason(now);
    if (season === null) throw failures.noActiveSeason();
    await checkEligible(deps, input.targetsBps, season.id);

    await requireSeasoned(deps, session.address, at);
    const max = await slotsFor(deps, session.address);
    // The per-network limits of agent creation (section 5.5; security review 6, finding 2): the network
    // is the keyed hash of the client address, an IPv6 address by its /48, as the Phase 2 guard keys it.
    const period = creationPeriod(today);
    const net = await networkKey(clientNetwork(c.req.raw), deps.config.nonceSecret);
    const wanted: readonly { key: string; cap: number; refuse: () => ApiFailure }[] = [
      {
        key: `p:${period}:mgr:${session.address}`,
        cap: max + MANAGER_EXTRA_CREATIONS_PER_PERIOD,
        refuse: () => walletPeriodLimit(at, today),
      },
      { key: `d:${today}:mgrnet:${net}`, cap: NEW_MANAGERS_PER_NETWORK_PER_DAY, refuse: () => networkDayLimit(at) },
      {
        key: `p:${period}:mgrnet:${net}`,
        cap: NEW_MANAGERS_PER_NETWORK_PER_PERIOD,
        refuse: () => networkPeriodLimit(at, today),
      },
      { key: `d:${today}:mgrnew`, cap: MANAGERS_CREATED_PER_DAY, refuse: () => everyoneDayLimit(at) },
    ];
    const taken: string[] = [];
    const manager: ManagerRecord = {
      id: newId(),
      owner: session.address,
      name: input.name,
      nameKey: agentNameKey(input.name),
      status: 'active',
      hidden: false,
      policyVersion: 1,
      createdAt: now,
      createdDay: today,
      updatedAt: now,
    };
    const policy: ManagerPolicy = {
      managerId: manager.id,
      version: 1,
      targetsBps: { ...input.targetsBps },
      schedule: input.schedule,
      setAt: now,
      setDay: today,
    };
    try {
      for (const { key, cap, refuse } of wanted) {
        if (!(await reputation.takeCounter(key, cap, today, now))) throw refuse();
        taken.push(key);
      }
      const outcome = await social.createManager(manager, policy, { maxForOwner: max, maxTotal: MAX_MANAGERS_TOTAL });
      if (outcome === 'owner_limit') throw slotLimit();
      if (outcome === 'name_taken') {
        throw new ApiFailure(
          'name_taken',
          'Another paper manager or agent already uses this name. Choose a different name.',
        );
      }
      if (outcome === 'full') {
        throw new ApiFailure(
          'league_full',
          'Prix holds as many paper managers as it can run right now. Try again later.',
        );
      }
    } catch (error) {
      // Nothing was created, so the counts taken for it are given back.
      for (const key of taken) await reputation.giveBackCounter(key);
      throw error;
    }
    // The manager exists from here on: a failed read of its page keeps every count of its creation.
    return json<ManagerDetailResponse>(await detailOf(deps, manager, policy), 201, 'private');
  });

  app.patch('/social/managers/:id', async (c) => {
    const session = await requireWriter(
      deps,
      c.req.raw,
      Math.max(MANAGER_POLICY_WRITE_ROWS, MANAGER_STATUS_WRITE_ROWS),
    );
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw socialFailures.managerNotFound();
    const input = await readInput(patchManagerInputSchema, c.req.raw);
    const manager = await social.getManager(id);
    // Another wallet's manager is answered like an unknown one: the owner is never told to anyone.
    if (manager === null || manager.owner !== session.address) throw socialFailures.managerNotFound();
    if (manager.status === 'closed') throw closedManager();

    const at = deps.now();
    const now = at.toISOString();
    const today = dayOf(now);
    const overSlots = async () => {
      const [owned, max] = await Promise.all([
        social.listManagersByOwner(session.address),
        slotsFor(deps, session.address),
      ]);
      return owned.filter(holdsSlot).length > max;
    };

    if ('policy' in input) {
      const season = await store.getActiveSeason(now);
      if (season === null) throw failures.noActiveSeason();
      // A fallen tier is enforced here, on resume and on create, and nowhere else.
      if (await overSlots()) throw slotLimit();
      const latest = await latestPolicy(deps, manager);
      const changeLimit = () =>
        new ApiFailure(
          'rate_limited',
          'This paper manager’s weights have already been changed today. Change them again after 00:00 UTC.',
          'policy',
          { 'Retry-After': String(secondsToUtcMidnight(at)) },
        );
      if (latest.version > 1 && latest.setDay === today) throw changeLimit();
      await checkEligible(deps, input.policy.targetsBps, season.id);
      // Takes effect at the first final day after today, so a change never trades at prices already known.
      const stored = await social.putPolicy(
        {
          managerId: manager.id,
          version: manager.policyVersion + 1,
          targetsBps: { ...input.policy.targetsBps },
          schedule: input.policy.schedule,
          setAt: now,
          setDay: today,
        },
        now,
      );
      if (stored === 'changed') throw changeLimit();
    } else if (input.status !== manager.status) {
      if (input.status === 'active' && (await overSlots())) throw slotLimit();
      if (!(await social.setManagerStatus(manager.id, session.address, input.status, now))) {
        throw socialFailures.managerNotFound();
      }
    }

    const fresh = await social.getManager(manager.id);
    if (fresh === null) throw socialFailures.managerNotFound();
    return json<ManagerDetailResponse>(await detailOf(deps, fresh, await latestPolicy(deps, fresh)), 200, 'private');
  });
}

/** The pages of the manager list whose cached copy an admin hide deletes. */
const FORGOTTEN_LIST_PAGES = 3;

/**
 * After an admin hide or show of a paper manager, deletes the cached read of that manager and pages 1
 * to 3 of the manager list at this location, under the keys the entry's cache gives them (the path
 * alone, or the path and `page`), so a hidden manager is not served from here for another 30 seconds.
 * Other locations keep their 30 seconds. A cache that fails never fails the request.
 */
async function forgetManager(siteOrigin: string, id: string): Promise<void> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache === undefined) return;
  const keys = [`${siteOrigin}/api/social/managers/${id}`, `${siteOrigin}/api/social/managers`];
  for (let page = 1; page <= FORGOTTEN_LIST_PAGES; page += 1)
    keys.push(`${siteOrigin}/api/social/managers?page=${page}`);
  await Promise.all(keys.map((key) => cache.delete(key).catch(() => false)));
}

/** The admin backstop: hide or show a paper manager. Anyone but an admin gets the generic 404. */
export function registerManagerAdminRoutes(app: Hono, deps: SocialApiDeps): void {
  app.post('/social/admin/managers/:id/hidden', async (c) => {
    const admin = await adminOr404(deps, c.req.raw);
    await requireWriter(deps, c.req.raw, MANAGER_STATUS_WRITE_ROWS);
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw socialFailures.managerNotFound();
    const input = await readInput(setManagerHiddenInputSchema, c.req.raw);
    if (!(await deps.social.setManagerHidden(id, input.hidden, deps.now().toISOString()))) {
      throw socialFailures.managerNotFound();
    }
    audit(admin, input.hidden ? 'hide_manager' : 'unhide_manager', id);
    await forgetManager(deps.config.siteOrigin, id);
    return noContent();
  });
}
