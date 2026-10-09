/**
 * The lookup page's client: one same-origin GET to /api/data/trust/:kind/:address and a few hand-written
 * guards for exactly the fields the page shows. It imports no zod and nothing from @prix/contracts
 * (docs/CONTRACTS.md section 15). The server has already checked the answer against the contract; these
 * guards only keep the page from drawing something it did not expect.
 *
 * Nothing here computes a score, a grade or a verdict. A fact is shown as the API gave it.
 */

export type TrustKind = 'developers' | 'tokens' | 'wallets';

export const TRUST_KINDS: readonly TrustKind[] = ['tokens', 'developers', 'wallets'];

export interface TrustLabels {
  method: string;
  scanned: string;
  scannedValue: string;
  factories: string;
  launchCount: string;
  launch: string;
  launchValue: string;
  readAt: string;
  isContract: string;
  codeSize: string;
  bytes: string;
  name: string;
  symbol: string;
  decimals: string;
  totalSupply: string;
  owner: string;
  proxy: string;
  mint: string;
  pause: string;
  ponsLaunch: string;
  ponsValue: string;
  deployerHolding: string;
  bps: string;
  agent: string;
  agentValue: string;
  rank: string;
  listed: string;
  verified: string;
  yes: string;
  no: string;
  none: string;
  unreadable: string;
  unranked: string;
}

export interface Fact {
  label: string;
  value: string;
}

export interface TrustView {
  notice: string;
  method: string;
  facts: Fact[];
  observations: string[];
  blindSpots: string[];
}

export type TrustOutcome =
  | { ok: true; view: TrustView }
  /** `code` is a code of dataErrorSchema, or null when the answer could not be read at all. */
  | { ok: false; status: number; code: string | null };

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/** For a count: a number, or a decimal string the API sends for a large one. */
const figure = (value: unknown): string | undefined =>
  isNumber(value) ? String(value) : isString(value) && /^\d+$/.test(value) ? value : undefined;

const fill = (template: string, slots: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => slots[name] ?? match);

function observationTexts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (!isDict(item) || !isString(item.text)) return undefined;
    out.push(item.text);
  }
  return out;
}

function launchLine(value: unknown, labels: TrustLabels): string | undefined {
  if (!isDict(value) || !isString(value.token)) return undefined;
  const block = figure(value.blockNumber);
  if (block === undefined) return undefined;
  return fill(labels.launchValue, { token: value.token, block });
}

function yesNo(value: unknown, labels: TrustLabels): string | undefined {
  return typeof value === 'boolean' ? (value ? labels.yes : labels.no) : undefined;
}

function developerFacts(data: Dict, labels: TrustLabels): Fact[] | undefined {
  const from = figure(data.scannedFromBlock);
  const to = figure(data.scannedToBlock);
  const found = figure(data.launchCount);
  if (from === undefined || to === undefined || found === undefined) return undefined;
  if (!isStringArray(data.factoriesScanned) || !Array.isArray(data.launches)) return undefined;
  const facts: Fact[] = [
    { label: labels.scanned, value: fill(labels.scannedValue, { from, to }) },
    { label: labels.factories, value: String(data.factoriesScanned.length) },
    { label: labels.launchCount, value: found },
  ];
  for (const launch of data.launches) {
    const line = launchLine(launch, labels);
    if (line === undefined) return undefined;
    facts.push({ label: labels.launch, value: line });
  }
  return facts;
}

function tokenFacts(data: Dict, labels: TrustLabels): Fact[] | undefined {
  const readAt = figure(data.readAtBlock);
  const size = figure(data.codeSizeBytes);
  const contract = yesNo(data.isContract, labels);
  const mint = yesNo(data.hasMintSelector, labels);
  const pause = yesNo(data.hasPauseSelector, labels);
  if (readAt === undefined || size === undefined || contract === undefined) return undefined;
  if (mint === undefined || pause === undefined) return undefined;
  const readText = (value: unknown): string | undefined =>
    value === null ? labels.unreadable : isString(value) ? value : undefined;
  const address = (value: unknown): string | undefined =>
    value === null ? labels.none : isString(value) ? value : undefined;
  const name = readText(data.name);
  const symbol = readText(data.symbol);
  const supply = readText(data.totalSupply);
  const owner = address(data.owner);
  const proxy = address(data.proxyImplementation);
  const decimals =
    data.decimals === null ? labels.unreadable : isNumber(data.decimals) ? String(data.decimals) : undefined;
  if ([name, symbol, supply, owner, proxy, decimals].includes(undefined)) return undefined;
  const facts: Fact[] = [
    { label: labels.readAt, value: readAt },
    { label: labels.isContract, value: contract },
    { label: labels.codeSize, value: fill(labels.bytes, { n: size }) },
    { label: labels.name, value: name as string },
    { label: labels.symbol, value: symbol as string },
    { label: labels.decimals, value: decimals as string },
    { label: labels.totalSupply, value: supply as string },
    { label: labels.owner, value: owner as string },
    { label: labels.proxy, value: proxy as string },
    { label: labels.mint, value: mint },
    { label: labels.pause, value: pause },
  ];
  if (data.ponsLaunch === null) {
    facts.push({ label: labels.ponsLaunch, value: labels.no });
  } else if (isDict(data.ponsLaunch) && isString(data.ponsLaunch.deployer)) {
    const block = figure(data.ponsLaunch.blockNumber);
    if (block === undefined) return undefined;
    facts.push({
      label: labels.ponsLaunch,
      value: fill(labels.ponsValue, { deployer: data.ponsLaunch.deployer, block }),
    });
  } else {
    return undefined;
  }
  if (data.deployerHoldingBps !== null) {
    const bps = figure(data.deployerHoldingBps);
    if (bps === undefined) return undefined;
    facts.push({ label: labels.deployerHolding, value: fill(labels.bps, { n: bps }) });
  }
  return facts;
}

function walletFacts(data: Dict, labels: TrustLabels): Fact[] | undefined {
  if (!Array.isArray(data.agents)) return undefined;
  const facts: Fact[] = [];
  for (const agent of data.agents) {
    if (!isDict(agent) || !isString(agent.name) || !isString(agent.division)) return undefined;
    const rank = agent.rank === null ? labels.unranked : isNumber(agent.rank) ? String(agent.rank) : undefined;
    if (rank === undefined) return undefined;
    facts.push({ label: labels.agent, value: fill(labels.agentValue, { name: agent.name, division: agent.division }) });
    facts.push({ label: labels.rank, value: rank });
    if (agent.listing === null) {
      facts.push({ label: labels.listed, value: labels.no });
    } else if (isDict(agent.listing)) {
      facts.push({
        label: labels.listed,
        value: isString(agent.listing.listedAt) ? agent.listing.listedAt : labels.yes,
      });
      const badge = yesNo(agent.listing.verifiedBadge, labels);
      if (badge === undefined) return undefined;
      facts.push({ label: labels.verified, value: badge });
    } else {
      return undefined;
    }
  }
  return facts;
}

/** Turns an answer body into what the page shows, or undefined when it is not what the page expects. */
export function readTrustBody(kind: TrustKind, body: unknown, labels: TrustLabels): TrustView | undefined {
  if (!isDict(body) || !isString(body.notice) || !isDict(body.data)) return undefined;
  const data = body.data;
  if (!isString(data.method) || !isStringArray(data.blindSpots)) return undefined;
  const observations = observationTexts(data.observations);
  if (observations === undefined) return undefined;
  const facts =
    kind === 'developers'
      ? developerFacts(data, labels)
      : kind === 'tokens'
        ? tokenFacts(data, labels)
        : walletFacts(data, labels);
  if (facts === undefined) return undefined;
  return { notice: body.notice, method: data.method, facts, observations, blindSpots: data.blindSpots };
}

/** The code of an error answer, or null when the body is not one. */
export function readErrorCode(body: unknown): string | null {
  if (!isDict(body) || !isDict(body.error) || !isString(body.error.code)) return null;
  return body.error.code;
}

export const isAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

/** Never throws. The fixture branch is dropped from a production build. */
export async function lookupTrust(kind: TrustKind, address: string, labels: TrustLabels): Promise<TrustOutcome> {
  let status: number;
  let body: unknown;
  try {
    if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
      const { answerFixture } = await import('./trust-fixtures.ts');
      const answer = answerFixture(kind, address, new URL(window.location.href));
      status = answer.status;
      body = answer.body;
    } else {
      const response = await fetch(`/api/data/trust/${kind}/${encodeURIComponent(address.toLowerCase())}`, {
        method: 'GET',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });
      status = response.status;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
    }
  } catch {
    return { ok: false, status: 0, code: null };
  }
  if (status >= 200 && status < 300) {
    const view = readTrustBody(kind, body, labels);
    return view ? { ok: true, view } : { ok: false, status, code: null };
  }
  return { ok: false, status, code: readErrorCode(body) };
}
