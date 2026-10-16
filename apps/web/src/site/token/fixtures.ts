// Sample answers of GET /api/token, for fixture builds only (PRIX_FIXTURES=1). Three states:
// not launched, launched with the flag off, launched with the flag on. A fixture build picks one
// with ?state=notLaunched|flagOff|flagOn on the page address. Sample data, never shown in production.
import { type TokenInfoResponse, tierTable } from '@prix/contracts';

const SAMPLE_ADDRESS = '0x1111111111111111111111111111111111111111';
const tiers = tierTable([10, 100, 1000]);

export type TokenFixtureState = 'notLaunched' | 'flagOff' | 'flagOn';

export const tokenFixtures: Record<TokenFixtureState, TokenInfoResponse> = {
  notLaunched: {
    gatingOn: false,
    tokenAddress: null,
    explorerUrl: null,
    buyUrl: null,
    tiers,
    feedDelaySeconds: 86_400,
  },
  flagOff: {
    gatingOn: false,
    tokenAddress: SAMPLE_ADDRESS,
    explorerUrl: `https://robinhoodchain.blockscout.com/token/${SAMPLE_ADDRESS}`,
    buyUrl: null,
    tiers,
    feedDelaySeconds: 86_400,
  },
  flagOn: {
    gatingOn: true,
    tokenAddress: SAMPLE_ADDRESS,
    explorerUrl: `https://robinhoodchain.blockscout.com/token/${SAMPLE_ADDRESS}`,
    buyUrl: 'https://ponsfamily.com/sample',
    tiers,
    feedDelaySeconds: 86_400,
  },
};

export function tokenFixtureFor(url: URL): TokenInfoResponse {
  const wanted = url.searchParams.get('state');
  return wanted && Object.hasOwn(tokenFixtures, wanted)
    ? tokenFixtures[wanted as TokenFixtureState]
    : tokenFixtures.notLaunched;
}
