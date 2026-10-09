import type {
  AgentPatch,
  AgentRecord,
  AgentResponse,
  ApiDeps,
  MeResponse,
  ModelKeyRecord,
  ModelKeyResponse,
  Store,
} from '@prix/contracts';
import {
  agentNameKey,
  createAgentInputSchema,
  createModelKeyInputSchema,
  idSchema,
  MAX_AGENTS_OPEN,
  MAX_AGENTS_PRO,
  MAX_MODEL_KEYS_PER_WALLET,
  MAX_PROMPT_CHANGES_PER_DAY,
  modelKeyAad,
  newId,
  openPreviewEntitlements,
  updateAgentInputSchema,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { isBlockedName } from './blocked-names.ts';
import { failures, json, noContent } from './errors.ts';
import { requireSession, requireWriter } from './guard.ts';
import { matches, readInput } from './input.ts';
import { latestDecision, toModelKeyPublic, toOwnerView } from './views.ts';

/**
 * A model key that a request names must be the signed-in wallet's own. The store is asked for
 * the key of this owner, so the answer is the same for a key that does not exist and for
 * someone else's.
 */
async function requireOwnKey(store: Store, id: string, owner: string): Promise<void> {
  if ((await store.getModelKey(id, owner)) === null) throw failures.modelKeyNotFound();
}

/** The routes of a signed-in wallet: its own agent and its own keys, and nobody else's. */
export function registerAccountRoutes(app: Hono, deps: ApiDeps, admins: ReadonlySet<string>): void {
  const { store, sim, scoring, sealer } = deps;

  app.get('/me', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const now = deps.now().toISOString();
    const [agent, keys] = await Promise.all([
      store.getAgentByOwner(session.address),
      store.listModelKeys(session.address),
    ]);
    const lastDecision = agent === null ? null : await latestDecision(store, agent.id, now);
    return json<MeResponse>(
      {
        address: session.address,
        isAdmin: admins.has(session.address),
        agent: agent === null ? null : toOwnerView(agent, lastDecision),
        modelKeys: keys.map(toModelKeyPublic),
      },
      200,
      'private',
    );
  });

  app.post('/agents', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 8);
    const input = await readInput(createAgentInputSchema, c.req.raw);
    if (isBlockedName(input.name)) throw failures.nameNotAllowed();

    const now = deps.now().toISOString();
    const season = await store.getActiveSeason(now);
    if (season === null) throw failures.noActiveSeason();
    if (input.modelKeyId !== undefined) await requireOwnKey(store, input.modelKeyId, session.address);

    // Everything but the name, the prompt, the division and the key is decided here. The
    // owner is the signed-in wallet, and the agent starts like every other agent.
    const agent: AgentRecord = {
      id: newId(),
      owner: session.address,
      name: input.name,
      nameKey: agentNameKey(input.name),
      division: input.division,
      prompt: input.prompt,
      promptPublic: false,
      summary: null,
      summaryStatus: 'pending',
      modelKeyId: input.modelKeyId ?? null,
      status: 'active',
      pausedReason: null,
      hidden: false,
      createdAt: now,
      updatedAt: now,
      // A round whose prices were already known when the agent was created does not use it.
      strategyChangedAt: now,
      promptChangeDay: null,
      promptChangeCount: 0,
    };
    // The wallet's slots come from the server's own entitlements, never from the request.
    const { maxAgents } = await (deps.entitlements ?? openPreviewEntitlements).entitlementsFor(session.address);
    // The store counts the division and inserts in one batch, so two requests cannot both take the last place.
    const outcome = await store.createAgent(
      agent,
      season.id,
      sim.newPortfolio(),
      scoring.initialStats(),
      input.division === 'pro' ? MAX_AGENTS_PRO : MAX_AGENTS_OPEN,
      maxAgents,
    );
    if (outcome === 'owner_has_agent') throw failures.ownerHasAgent();
    if (outcome === 'name_taken') throw failures.nameTaken();
    if (outcome === 'league_full') throw failures.leagueFull();
    return json<AgentResponse>({ agent: toOwnerView(agent, null) }, 201, 'private');
  });

  app.patch('/agents/:id', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 2);
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw failures.agentNotFound();
    let agent = await store.getAgent(id);
    if (agent === null) throw failures.agentNotFound();
    if (agent.owner !== session.address) {
      // A hidden agent does not exist for anyone but its owner.
      throw agent.hidden ? failures.agentNotFound() : failures.notYourAgent();
    }
    const input = await readInput(updateAgentInputSchema, c.req.raw);
    // Read again once if a concurrent request moved the counters this decision was based on.
    for (let round = 0; ; round++) {
      const at = deps.now();
      const now = at.toISOString();
      const patch: AgentPatch = {};
      // Set when the prompt or the key changes and when the agent is resumed. The scheduler gives
      // a round that started before this instant a `changed_this_round` row instead of a decision,
      // so a strategy cannot be edited after the round's prices are known.
      let strategyChanged = false;

      if (input.name !== undefined && input.name !== agent.name) {
        if (isBlockedName(input.name)) throw failures.nameNotAllowed();
        patch.name = input.name;
        patch.nameKey = agentNameKey(input.name);
      }
      if (input.prompt !== undefined && input.prompt !== agent.prompt) {
        // Counted per UTC day on the agent's own record. Nothing a client sends says which day it
        // is or how many changes there were.
        const today = now.slice(0, 10);
        const changesToday = agent.promptChangeDay === today ? agent.promptChangeCount : 0;
        if (changesToday >= MAX_PROMPT_CHANGES_PER_DAY) throw failures.promptChangeLimit(at);
        patch.prompt = input.prompt;
        patch.promptChangeDay = today;
        patch.promptChangeCount = changesToday + 1;
        // The public summary described the old prompt. It is written again for the new one.
        patch.summary = null;
        patch.summaryStatus = 'pending';
        strategyChanged = true;
      }
      if (input.promptPublic !== undefined && input.promptPublic !== agent.promptPublic) {
        patch.promptPublic = input.promptPublic;
      }

      let status = agent.status;
      let pausedReason = agent.pausedReason;
      if (input.modelKeyId !== undefined) {
        // First whose key it is: a `modelKeyId` that is not the wallet's is 404 for every agent,
        // so the answer never says more about a key than that this wallet does not have it.
        await requireOwnKey(store, input.modelKeyId, session.address);
        if (agent.division !== 'pro') {
          throw failures.invalidInput('A Pro agent needs a model key. An Open agent must not have one.', 'modelKeyId');
        }
        if (input.modelKeyId !== agent.modelKeyId) {
          patch.modelKeyId = input.modelKeyId;
          strategyChanged = true;
        }
        // Naming a key is what an agent paused for a removed key or a refused key was waiting for.
        if (status === 'paused' && (pausedReason === 'key_removed' || pausedReason === 'key_failing')) {
          status = 'active';
          pausedReason = null;
        }
      }
      if (input.paused === true && status === 'active') {
        status = 'paused';
        pausedReason = 'owner';
      }
      // An owner lifts only a pause the owner set. A pause by an admin, or for a key, stays.
      if (input.paused === false && status === 'paused' && pausedReason === 'owner') {
        status = 'active';
        pausedReason = null;
      }
      if (agent.status === 'paused' && status === 'active') {
        // A wallet never runs more agents than its slots; the oldest agents keep them.
        const { maxAgents } = await (deps.entitlements ?? openPreviewEntitlements).entitlementsFor(session.address);
        const mine = await store.listAgentsByOwner(session.address);
        const self = agent.id;
        const running = mine.filter((a) => a.id !== self && a.status === 'active').length;
        if (running >= maxAgents) throw failures.ownerHasAgent();
      }
      if (status !== agent.status || pausedReason !== agent.pausedReason) {
        patch.status = status;
        patch.pausedReason = pausedReason;
        if (agent.status === 'paused' && status === 'active') strategyChanged = true;
      }
      if (strategyChanged) patch.strategyChangedAt = now;

      let updated = agent;
      if (Object.keys(patch).length > 0) {
        const expect =
          patch.prompt !== undefined
            ? { promptChangeDay: agent.promptChangeDay, promptChangeCount: agent.promptChangeCount }
            : undefined;
        const outcome = await store.updateAgent(agent.id, patch, now, expect);
        if (outcome === 'changed') {
          if (round >= 1) throw failures.internal();
          const fresh = await store.getAgent(agent.id);
          if (fresh === null || fresh.owner !== session.address) throw failures.agentNotFound();
          agent = fresh;
          continue;
        }
        if (outcome === 'name_taken') throw failures.nameTaken();
        if (outcome === 'not_found') throw failures.agentNotFound();
        updated = { ...agent, ...patch, updatedAt: now };
      }
      return json<AgentResponse>(
        { agent: toOwnerView(updated, await latestDecision(store, agent.id, now)) },
        200,
        'private',
      );
    }
  });

  app.post('/model-keys', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 3);
    // The provider is one of the allowlist or the request is refused. No field names a URL.
    const input = await readInput(createModelKeyInputSchema, c.req.raw);

    const id = newId();
    const owner = session.address;
    // The key is sealed before anything is stored. It is bound to this row, this owner, this
    // provider and this key version, so a ciphertext moved to another row, or a row pointed at
    // another provider, does not open. From here on only the last four characters exist outside
    // the ciphertext.
    const keyVersion = sealer.keyVersion;
    const sealed = await sealer.seal(input.apiKey, modelKeyAad({ id, owner, provider: input.provider, keyVersion }));
    // A sealer that wrote another version than it announced has bound the key to a text nobody can rebuild.
    if (sealed.keyVersion !== keyVersion) throw new Error('the sealer changed its key version while sealing');
    const record: ModelKeyRecord = {
      id,
      owner,
      provider: input.provider,
      model: input.model,
      last4: input.apiKey.slice(-4),
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      keyVersion,
      createdAt: deps.now().toISOString(),
    };
    // The store counts the wallet's keys and inserts in one statement.
    if ((await store.putModelKey(record, MAX_MODEL_KEYS_PER_WALLET)) === 'key_limit_reached') {
      throw failures.keyLimitReached();
    }
    return json<ModelKeyResponse>({ modelKey: toModelKeyPublic(record) }, 201, 'private');
  });

  app.delete('/model-keys/:id', async (c) => {
    const session = await requireWriter(deps, c.req.raw, 3);
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw failures.modelKeyNotFound();
    // The store deletes the row only if it is this wallet's. In the same batch the agent that
    // used the key is paused and its `modelKeyId` becomes null.
    const deleted = await store.deleteModelKey(id, session.address, deps.now().toISOString());
    if (!deleted) throw failures.modelKeyNotFound();
    return noContent();
  });
}
