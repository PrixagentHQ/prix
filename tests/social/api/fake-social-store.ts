import type {
  AgentId,
  DnaProfile,
  FinalDay,
  JobCursor,
  LineageMember,
  LineageRow,
  ManagerBookRow,
  ManagerListRow,
  ManagerPolicy,
  ManagerRebalance,
  ManagerRecord,
  ManagerStatus,
  RankTapeDay,
  Rivalry,
  RivalryDayResult,
  RivalryEvent,
  SocialAgentRecord,
  SocialStore,
  Store,
  StoredRivalryView,
  WarEntrant,
  WarPatch,
  WarRecord,
  WarRow,
} from '@prix/contracts';

/**
 * An in-memory SocialStore for the route tests of api-core. Agents are read from the Phase 1 store,
 * so hiding an agent there hides it here. Only what the routes call is implemented with care; the
 * job methods throw, because no route may call them.
 */
export class FakeSocialStore implements SocialStore {
  readonly dna = new Map<string, DnaProfile>();
  readonly lineage = new Map<string, LineageRow>();
  readonly rivalries: Rivalry[] = [];
  readonly events: RivalryEvent[] = [];
  readonly tapeDays = new Map<string, number>();
  readonly wars = new Map<string, WarRecord>();
  readonly entrants = new Map<string, WarEntrant[]>();
  readonly warRows = new Map<string, WarRow[]>();
  readonly managers = new Map<string, ManagerRecord>();
  readonly policies = new Map<string, ManagerPolicy[]>();
  readonly books = new Map<string, ManagerBookRow>();
  readonly rebalances = new Map<string, ManagerRebalance[]>();
  readonly agentNames = new Set<string>();
  readonly calls: string[] = [];

  constructor(private readonly store: Store) {}

  private async record(id: string): Promise<SocialAgentRecord | null> {
    const agent = await this.store.getAgent(id);
    if (agent === null) return null;
    return {
      id: agent.id,
      name: agent.name,
      owner: agent.owner,
      division: agent.division,
      hidden: agent.hidden,
      createdAt: agent.createdAt,
    };
  }

  private async visible(id: string): Promise<SocialAgentRecord | null> {
    const record = await this.record(id);
    return record === null || record.hidden ? null : record;
  }

  // shared
  async listFinalDays(): Promise<FinalDay[]> {
    throw new Error('not for routes');
  }
  async putCursor(_cursor: JobCursor): Promise<void> {
    throw new Error('not for routes');
  }
  async listAgentRecords(ids: readonly AgentId[]): Promise<SocialAgentRecord[]> {
    this.calls.push('listAgentRecords');
    const out: SocialAgentRecord[] = [];
    for (const id of ids) {
      const record = await this.record(id);
      if (record !== null) out.push(record);
    }
    return out;
  }

  // DNA
  async listDnaAgents(): Promise<never[]> {
    throw new Error('not for routes');
  }
  async listEndOfDay(): Promise<never> {
    throw new Error('not for routes');
  }
  async putDnaProfiles(): Promise<void> {
    throw new Error('not for routes');
  }
  async getDna(agentId: AgentId): Promise<DnaProfile | null> {
    return this.dna.get(agentId) ?? null;
  }

  // forks
  async putLineage(row: LineageRow): Promise<'stored' | 'exists'> {
    this.calls.push('putLineage');
    if (this.lineage.has(row.agentId)) return 'exists';
    this.lineage.set(row.agentId, { ...row });
    return 'stored';
  }
  async getLineage(agentId: AgentId): Promise<LineageRow | null> {
    return this.lineage.get(agentId) ?? null;
  }
  async countChildren(parentId: AgentId): Promise<number> {
    let n = 0;
    for (const row of this.lineage.values()) if (row.parentId === parentId && (await this.visible(row.agentId))) n++;
    return n;
  }
  private async members(rows: LineageRow[], limit: number, offset: number): Promise<LineageMember[]> {
    const out: LineageMember[] = [];
    for (const row of rows) {
      const agent = await this.visible(row.agentId);
      if (agent === null) continue;
      const parent = await this.visible(row.parentId);
      out.push({ agent, depth: row.depth, parentId: parent === null ? null : row.parentId });
    }
    return out.slice(offset, offset + limit);
  }
  async listChildren(parentId: AgentId, limit: number, offset: number): Promise<LineageMember[]> {
    const rows = [...this.lineage.values()]
      .filter((row) => row.parentId === parentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return this.members(rows, limit, offset);
  }
  async countFamily(rootId: AgentId): Promise<number> {
    let n = 0;
    for (const row of this.lineage.values()) if (row.rootId === rootId && (await this.visible(row.agentId))) n++;
    return n;
  }
  async listFamily(rootId: AgentId, limit: number, offset: number): Promise<LineageMember[]> {
    const rows = [...this.lineage.values()]
      .filter((row) => row.rootId === rootId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return this.members(rows, limit, offset);
  }

  // tape and rivalries
  async writeTape(): Promise<void> {
    throw new Error('not for routes');
  }
  async listTape(): Promise<RankTapeDay[]> {
    throw new Error('not for routes');
  }
  async countTapeDays(seasonId: string, division: string): Promise<number> {
    return this.tapeDays.get(`${seasonId}|${division}`) ?? 0;
  }
  async listActiveRivalries(): Promise<Rivalry[]> {
    throw new Error('not for routes');
  }
  async applyRivalryDay(_result: RivalryDayResult): Promise<void> {
    throw new Error('not for routes');
  }
  private async view(rivalry: Rivalry): Promise<StoredRivalryView | null> {
    const [agentA, agentB] = await Promise.all([this.visible(rivalry.agentA), this.visible(rivalry.agentB)]);
    return agentA === null || agentB === null ? null : { rivalry, agentA, agentB };
  }
  async listRivalries(seasonId: string, division: string, limit: number, offset: number) {
    const out: StoredRivalryView[] = [];
    for (const rivalry of this.rivalries) {
      if (rivalry.seasonId !== seasonId || rivalry.division !== division) continue;
      const view = await this.view(rivalry);
      if (view !== null) out.push(view);
    }
    return out.slice(offset, offset + limit);
  }
  async listAgentRivalries(agentId: string, seasonId: string) {
    const out: StoredRivalryView[] = [];
    for (const rivalry of this.rivalries) {
      if (rivalry.seasonId !== seasonId || rivalry.status !== 'active') continue;
      if (rivalry.agentA !== agentId && rivalry.agentB !== agentId) continue;
      const view = await this.view(rivalry);
      if (view !== null) out.push(view);
    }
    return out;
  }
  async getRivalry(seasonId: string, agentA: string, agentB: string, eventLimit: number) {
    const rivalry = this.rivalries.find((r) => r.seasonId === seasonId && r.agentA === agentA && r.agentB === agentB);
    if (rivalry === undefined) return null;
    const view = await this.view(rivalry);
    if (view === null) return null;
    const events = this.events
      .filter((e) => e.seasonId === seasonId && e.agentA === agentA && e.agentB === agentB)
      .reverse()
      .slice(0, eventLimit);
    return { view, events };
  }

  // wars
  async createWar(war: Omit<WarRecord, 'number'>, entrants: readonly WarEntrant[]) {
    this.calls.push('createWar');
    if ([...this.wars.values()].some((w) => w.status === 'scheduled' || w.status === 'running')) {
      return { result: 'war_open' as const };
    }
    const number = this.wars.size + 1;
    this.wars.set(war.id, { ...war, number });
    this.entrants.set(
      war.id,
      entrants.map((entrant) => ({ ...entrant })),
    );
    return { result: 'created' as const, number };
  }
  async getOpenWar(): Promise<WarRecord | null> {
    return [...this.wars.values()].find((w) => w.status === 'scheduled' || w.status === 'running') ?? null;
  }
  async getWar(id: string): Promise<WarRecord | null> {
    return this.wars.get(id) ?? null;
  }
  async listWars(limit: number, offset: number): Promise<WarRecord[]> {
    return [...this.wars.values()].sort((a, b) => b.number - a.number).slice(offset, offset + limit);
  }
  async listWarEntrants(warId: string): Promise<WarEntrant[]> {
    return this.entrants.get(warId) ?? [];
  }
  async listWarRows(warId: string): Promise<WarRow[]> {
    return this.warRows.get(warId) ?? [];
  }
  async getDailyTickOf(): Promise<null> {
    throw new Error('not for routes');
  }
  async getWarNeurons(): Promise<number> {
    throw new Error('not for routes');
  }
  async reserveWarNeurons(): Promise<boolean> {
    throw new Error('not for routes');
  }
  async adjustWarNeurons(): Promise<void> {
    throw new Error('not for routes');
  }
  async writeWarDay(): Promise<boolean> {
    throw new Error('not for routes');
  }
  async updateWar(id: string, patch: WarPatch): Promise<void> {
    this.calls.push('updateWar');
    const war = this.wars.get(id);
    if (war !== undefined) this.wars.set(id, { ...war, ...patch });
  }

  // managers
  async createManager(
    manager: ManagerRecord,
    policy: ManagerPolicy,
    limits: { maxForOwner: number; maxTotal: number },
  ): Promise<'created' | 'owner_limit' | 'name_taken' | 'full'> {
    this.calls.push('createManager');
    const owned = [...this.managers.values()].filter((m) => m.owner === manager.owner && m.status !== 'closed');
    if (owned.length >= limits.maxForOwner) return 'owner_limit';
    // MAX_MANAGERS_TOTAL counts open managers only: active or paused and not hidden (contract 6.1).
    const open = [...this.managers.values()].filter((m) => m.status !== 'closed' && !m.hidden);
    if (open.length >= limits.maxTotal) return 'full';
    if (
      [...this.managers.values()].some((m) => m.nameKey === manager.nameKey) ||
      this.agentNames.has(manager.nameKey)
    ) {
      return 'name_taken';
    }
    this.managers.set(manager.id, { ...manager });
    this.policies.set(manager.id, [{ ...policy }]);
    return 'created';
  }
  async getManager(id: string): Promise<ManagerRecord | null> {
    return this.managers.get(id) ?? null;
  }
  async listManagersByOwner(owner: string): Promise<ManagerRecord[]> {
    return [...this.managers.values()].filter((m) => m.owner === owner);
  }
  async getLatestPolicy(managerId: string): Promise<ManagerPolicy | null> {
    return this.policies.get(managerId)?.at(-1) ?? null;
  }
  async putPolicy(policy: ManagerPolicy, now: string): Promise<'stored' | 'changed'> {
    this.calls.push('putPolicy');
    const manager = this.managers.get(policy.managerId);
    if (manager === undefined || policy.version !== manager.policyVersion + 1) return 'changed';
    this.policies.get(policy.managerId)?.push({ ...policy });
    this.managers.set(manager.id, { ...manager, policyVersion: policy.version, updatedAt: now });
    return 'stored';
  }
  async setManagerStatus(id: string, owner: string | null, status: ManagerStatus, now: string): Promise<boolean> {
    this.calls.push('setManagerStatus');
    const manager = this.managers.get(id);
    if (manager === undefined || (owner !== null && manager.owner !== owner) || manager.status === 'closed')
      return false;
    this.managers.set(id, { ...manager, status, updatedAt: now });
    return true;
  }
  async setManagerHidden(id: string, hidden: boolean, now: string): Promise<boolean> {
    this.calls.push('setManagerHidden');
    const manager = this.managers.get(id);
    if (manager === undefined) return false;
    this.managers.set(id, { ...manager, hidden, updatedAt: now });
    return true;
  }
  async listManagersToValue(): Promise<never[]> {
    throw new Error('not for routes');
  }
  async agentValuesOn(): Promise<Record<string, number | null>> {
    throw new Error('not for routes');
  }
  async applyManagerDays(): Promise<void> {
    throw new Error('not for routes');
  }
  async listManagers(seasonId: string, limit: number, offset: number): Promise<ManagerListRow[]> {
    const out: ManagerListRow[] = [];
    for (const manager of [...this.managers.values()].reverse()) {
      if (manager.hidden) continue;
      const policy = this.policies.get(manager.id)?.at(-1);
      if (policy === undefined) continue;
      out.push({ manager, policy, book: this.books.get(`${manager.id}|${seasonId}`) ?? null });
    }
    return out.slice(offset, offset + limit);
  }
  async getManagerBook(managerId: string, seasonId: string): Promise<ManagerBookRow | null> {
    return this.books.get(`${managerId}|${seasonId}`) ?? null;
  }
  async listManagerRebalances(managerId: string, seasonId: string, limit: number): Promise<ManagerRebalance[]> {
    return (this.rebalances.get(`${managerId}|${seasonId}`) ?? []).slice(0, limit);
  }
}
