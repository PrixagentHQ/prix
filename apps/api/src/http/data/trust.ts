import type {
  Address,
  DataDeps,
  DataHandlers,
  DeveloperLookup,
  Observation,
  PonsLaunch,
  TokenBasics,
  TokenFacts,
  WalletAgentRecord,
  WalletRecord,
} from '@prix/contracts';
import {
  DEVELOPER_LAUNCHES_MAX,
  lowerAddress,
  PONS_FACTORIES,
  TRUST_BLIND_SPOTS,
  TRUST_METHODS,
} from '@prix/contracts';
import { currentSeason } from '../views.ts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The facts of a token as plain statements. Pure, so the observations are testable without a chain.
 * `address` is the token's own address; it falls back to the launch's token when omitted.
 */
export function describeToken(
  basics: TokenBasics,
  launch: PonsLaunch | null,
  address: Address = launch?.token ?? ZERO_ADDRESS,
): TokenFacts {
  const observations: Observation[] = [];
  const renounced = basics.owner !== null && basics.owner.toLowerCase() === ZERO_ADDRESS;
  const owner = basics.owner === null || renounced ? null : lowerAddress(basics.owner);

  if (!basics.isContract) {
    observations.push({ code: 'not_a_contract', text: 'There is no contract code at this address.' });
  }
  if (owner !== null) {
    observations.push({ code: 'owner_set', text: `The contract names an owner: ${owner}.` });
  }
  if (renounced) {
    observations.push({ code: 'owner_renounced', text: 'The contract reports the zero address as its owner.' });
  }
  if (basics.proxyImplementation !== null) {
    observations.push({
      code: 'upgradeable_proxy',
      text: `The contract is a proxy whose implementation is ${basics.proxyImplementation}.`,
    });
  }
  if (basics.hasMintSelector) {
    observations.push({ code: 'mint_selector_present', text: 'The bytecode contains a mint function selector.' });
  }
  if (basics.hasPauseSelector) {
    observations.push({ code: 'pause_selector_present', text: 'The bytecode contains a pause function selector.' });
  }

  let deployerHoldingBps: number | null = null;
  if (launch !== null && basics.holderBalance !== null && basics.totalSupply !== null) {
    try {
      const supply = BigInt(basics.totalSupply);
      if (supply > 0n) deployerHoldingBps = Number((BigInt(basics.holderBalance) * 10_000n) / supply);
    } catch {
      deployerHoldingBps = null;
    }
  }
  if (deployerHoldingBps !== null && deployerHoldingBps > 1000) {
    observations.push({
      code: 'deployer_holds_over_10_percent',
      text: `The address that launched this token holds ${(deployerHoldingBps / 100).toFixed(2)} percent of its supply.`,
    });
  }
  observations.push(
    launch !== null
      ? {
          code: 'launched_on_pons',
          text: `A Pons factory emitted a launch of this token in block ${launch.blockNumber}.`,
        }
      : {
          code: 'not_found_on_pons',
          text: 'No launch of this token was found in the Pons factories that were scanned.',
        },
  );
  if (
    basics.isContract &&
    (basics.name === null || basics.symbol === null || basics.decimals === null || basics.totalSupply === null)
  ) {
    observations.push({
      code: 'fields_unreadable',
      text: 'One or more of name, symbol, decimals and total supply could not be read from the contract.',
    });
  }

  return {
    address,
    chainId: 4663,
    method: TRUST_METHODS.token,
    blindSpots: [...TRUST_BLIND_SPOTS.token],
    readAtBlock: basics.readAtBlock,
    isContract: basics.isContract,
    codeSizeBytes: basics.codeSizeBytes,
    name: basics.name,
    symbol: basics.symbol,
    decimals: basics.decimals,
    totalSupply: basics.totalSupply,
    owner,
    proxyImplementation: basics.proxyImplementation,
    hasMintSelector: basics.hasMintSelector,
    hasPauseSelector: basics.hasPauseSelector,
    ponsLaunch: launch,
    deployerHoldingBps,
    observations,
  };
}

export function createTrustHandlers(deps: DataDeps): Pick<DataHandlers, 'developer' | 'token' | 'wallet'> {
  const { chain, store, records } = deps;

  const developer = async (input: { address: string }): Promise<DeveloperLookup> => {
    const address = lowerAddress(input.address);
    const scan = await chain.readLaunchesByDeployer(address, DEVELOPER_LAUNCHES_MAX);
    const launches = scan.launches.slice(0, DEVELOPER_LAUNCHES_MAX);
    const observations: Observation[] = [];
    if (scan.total === 0) {
      observations.push({
        code: 'no_launches_found',
        text: 'No launch by this address was found in the Pons factories that were scanned.',
      });
    }
    if (scan.total > launches.length) {
      observations.push({
        code: 'launches_truncated',
        text: `${scan.total} launches were found; the newest ${launches.length} are listed.`,
      });
    }
    return {
      address,
      method: TRUST_METHODS.developer,
      blindSpots: [...TRUST_BLIND_SPOTS.developer],
      factoriesScanned: PONS_FACTORIES.map((factory) => factory.address),
      scannedFromBlock: scan.scannedFromBlock,
      scannedToBlock: scan.scannedToBlock,
      launchCount: scan.total,
      launches,
      observations,
    };
  };

  const token = async (input: { address: string }): Promise<TokenFacts> => {
    const address = lowerAddress(input.address);
    // The deployer is known only from the launch, so the launch is read first.
    const launch = await chain.readLaunchOfToken(address);
    const basics = await chain.readTokenBasics(address, launch === null ? null : launch.deployer);
    return describeToken(basics, launch, address);
  };

  const wallet = async (input: { address: string }): Promise<WalletRecord> => {
    const address = lowerAddress(input.address);
    const observations: Observation[] = [];
    const agents: WalletAgentRecord[] = [];
    const agent = await store.getAgentByOwner(address);
    const season = agent === null || agent.hidden ? null : await currentSeason(store, deps.now().toISOString());
    if (agent !== null && !agent.hidden && season !== null) {
      const [standing, portfolio, listings] = await Promise.all([
        store.getStanding(agent.id, season.id),
        store.getPortfolio(agent.id, season.id),
        records.listingsOf(address),
      ]);
      if (standing !== null && portfolio !== null) {
        agents.push({
          agentId: agent.id,
          name: agent.name,
          division: agent.division,
          season,
          rank: standing.rank,
          stats: portfolio.stats,
          lastStatus: standing.lastStatus,
          listing: listings.find((entry) => entry.agentId === agent.id) ?? null,
        });
      }
    }
    if (agents.length === 0) {
      observations.push({ code: 'no_agent_found', text: 'This wallet owns no public agent in the league.' });
    }
    return {
      address,
      method: TRUST_METHODS.wallet,
      blindSpots: [...TRUST_BLIND_SPOTS.wallet],
      agents,
      observations,
    };
  };

  return {
    developer: developer as DataHandlers['developer'],
    token: token as DataHandlers['token'],
    wallet: wallet as DataHandlers['wallet'],
  };
}
