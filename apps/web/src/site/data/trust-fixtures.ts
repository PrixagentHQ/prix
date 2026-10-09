import type { TrustKind } from './trust-client.ts';

/**
 * Sample answers of GET /api/data/trust/:kind/:address for a build with PRIX_FIXTURES=1. Every
 * address and name is made up. `?fixture=` on the page selects the state:
 *
 *   found (default)       a full answer for the kind
 *   empty                 nothing found for the address
 *   rate-limited, api-busy, chain-down, invalid-input   the matching error
 *   broken                an answer the page cannot read
 *
 * An unknown name makes every lookup fail, so a typing mistake is seen at once. This module imports
 * no zod and nothing from @prix/contracts.
 */

export interface FixtureAnswer {
  status: number;
  body: unknown;
}

const NOTICE =
  'Sample data. Prix data is a record of a paper-trading simulation and of public chain facts. It is not investment advice.';
const SAMPLE_ADDRESS = '0x00000000000000000000000000000000000000aa';
const SAMPLE_TOKEN = '0x00000000000000000000000000000000000000bb';
const BLIND = [
  'Sample text. These are facts read from the chain or from the league. They are not a score, a rating or a recommendation.',
  'Sample text. A lookup describes one address. It does not link addresses that belong to the same person.',
];

const error = (status: number, code: string): FixtureAnswer => ({
  status,
  body: { error: { code, message: 'Sample error.', field: null } },
});

function found(kind: TrustKind, address: string, empty: boolean): FixtureAnswer {
  if (kind === 'developers') {
    return {
      status: 200,
      body: {
        notice: NOTICE,
        data: {
          address,
          method: 'developer-v1',
          blindSpots: BLIND,
          factoriesScanned: [SAMPLE_ADDRESS, SAMPLE_TOKEN],
          scannedFromBlock: 8_991_118,
          scannedToBlock: 9_400_000,
          launchCount: empty ? 0 : 2,
          launches: empty
            ? []
            : [
                { factory: SAMPLE_ADDRESS, token: SAMPLE_TOKEN, deployer: address, blockNumber: 9_300_000 },
                { factory: SAMPLE_ADDRESS, token: SAMPLE_ADDRESS, deployer: address, blockNumber: 9_100_000 },
              ],
          observations: [
            empty
              ? {
                  code: 'no_launches_found',
                  text: 'No launch through the scanned factories was found for this address.',
                }
              : { code: 'launches_truncated', text: 'Sample statement: two launches were found.' },
          ],
        },
      },
    };
  }
  if (kind === 'tokens') {
    return {
      status: 200,
      body: {
        notice: NOTICE,
        data: {
          address,
          chainId: 4663,
          method: 'token-facts-v1',
          blindSpots: BLIND,
          readAtBlock: 9_400_001,
          isContract: !empty,
          codeSizeBytes: empty ? 0 : 4_200,
          name: empty ? null : 'Sample Token',
          symbol: empty ? null : 'SMPL',
          decimals: empty ? null : 18,
          totalSupply: empty ? null : '1000000000000000000000000',
          owner: null,
          proxyImplementation: null,
          hasMintSelector: false,
          hasPauseSelector: false,
          ponsLaunch: null,
          deployerHoldingBps: null,
          observations: [
            empty
              ? { code: 'not_a_contract', text: 'There is no contract code at this address.' }
              : { code: 'owner_renounced', text: 'Sample statement: the owner address is the zero address.' },
          ],
        },
      },
    };
  }
  return {
    status: 200,
    body: {
      notice: NOTICE,
      data: {
        address,
        method: 'wallet-record-v1',
        blindSpots: BLIND,
        agents: empty
          ? []
          : [
              {
                agentId: 'aaaaaaaaaaaa',
                name: 'Sample Agent',
                division: 'open',
                rank: 4,
                listing: { agentId: 'aaaaaaaaaaaa', listedAt: '2026-10-01T12:00:00Z', verifiedBadge: false },
              },
            ],
        observations: empty ? [{ code: 'no_agent_found', text: 'No agent of this wallet is in the league.' }] : [],
      },
    },
  };
}

export function answerFixture(kind: TrustKind, address: string, page: URL): FixtureAnswer {
  const name = page.searchParams.get('fixture') ?? 'found';
  if (name === 'found') return found(kind, address, false);
  if (name === 'empty') return found(kind, address, true);
  if (name === 'rate-limited') return error(429, 'rate_limited');
  if (name === 'api-busy') return error(503, 'api_busy');
  if (name === 'chain-down') return error(503, 'chain_unavailable');
  if (name === 'invalid-input') return error(400, 'invalid_input');
  if (name === 'broken') return { status: 200, body: { notice: NOTICE, data: { surprise: true } } };
  return error(500, 'internal');
}
