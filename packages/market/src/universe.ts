import type { UniverseToken } from '@prix/contracts';

/**
 * The symbols the league trades: 20 Stock Tokens, then two crypto assets (docs/CONTRACTS.md section 21,
 * documented at CRYPTO_READ_ON below). The Stock Tokens were GENERATED from primary sources on 2026-10-06; RESEARCH.md has the
 * method, the raw chain reads and the ranking. Do not edit an address by hand: re-run the research.
 *
 * Where each address was read:
 * - `tokenAddress`: Robinhood's Token Contracts page, TOKEN_SOURCE_URL. Its table is generated live from
 *   TOKEN_SOURCE_DATA_URL, Robinhood's own asset registry API, which is what was read.
 * - `feedAddress`: Chainlink's feed list for Robinhood Chain, FEED_SOURCE_URL, which Robinhood's oracle page
 *   names as the source of truth. The page renders FEED_SOURCE_DATA_URL, which is what was read. The address is
 *   the Standard Proxy of the "Robinhood <SYMBOL> / USD" feed, not the SVR proxy.
 *
 * The contract's `sourceUrl` holds one URL per token, so it carries the Robinhood page; the feed source is
 * the same for every entry and is exported below.
 *
 * Every address was then called on chain 2026-10-06 at block 81375149: the token's `symbol()` equals the
 * symbol here, the feed's `description()` names the same ticker, and `decimals()` matches on both.
 *
 * Selection: no free, verifiable measure of the tokens' trading liquidity exists (RESEARCH.md, section 6).
 * The stated fallback is on-chain value outstanding, `totalSupply()` times the feed price, at that block:
 * the 20 largest among Stock Tokens with a live Chainlink feed. Order here is by symbol.
 *
 * `name` is the token's own `name()` without its constant ending " • Robinhood Token". A price here is the
 * price of one token, which is the share price times the token's dividend and split multiplier, not the
 * share price itself.
 */
export const TOKEN_SOURCE_URL = 'https://docs.robinhood.com/chain/contracts';
export const TOKEN_SOURCE_DATA_URL = 'https://api.robinhood.com/rhj/assets';
export const FEED_SOURCE_URL = 'https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood';
export const FEED_SOURCE_DATA_URL = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';
/** The UTC day every Stock Token address was read and checked on chain. */
export const READ_ON = '2026-10-06';

/**
 * The day the two crypto feeds were read (docs/CONTRACTS.md section 21). Their `sourceUrl` is
 * FEED_SOURCE_URL, since a crypto entry has no Robinhood token: the "BTC / USD" and "ETH / USD" rows of
 * FEED_SOURCE_DATA_URL, field `proxyAddress` (the Standard Proxy; the SVR proxy is
 * `secondaryProxyAddress`), 8 decimals, heartbeat 86,400 s, deviation 0.5%. Both were then called on
 * chain at block 83603110 on two endpoints, publicnode and dRPC, with identical answers: `description()`
 * "BTC / USD" and "ETH / USD", `decimals()` 8, and a current `latestRoundData()`. RESEARCH.md, section 11.
 */
export const CRYPTO_READ_ON = '2026-10-09';

export const UNIVERSE: readonly UniverseToken[] = [
  {
    kind: 'stock',
    symbol: 'AAPL',
    name: 'Apple',
    tokenAddress: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
    tokenDecimals: 18,
    feedAddress: '0x6b22a786baa607d76728168703a39ea9c99f2cd0',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'AMD',
    name: 'AMD',
    tokenAddress: '0x86923f96303d656e4aa86d9d42d1e57ad2023fdc',
    tokenDecimals: 18,
    feedAddress: '0x943a29e7ae51a4798823ca9eed2ed533b2a22c72',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'AMZN',
    name: 'Amazon',
    tokenAddress: '0x12f190a9f9d7d37a250758b26824b97ce941bf54',
    tokenDecimals: 18,
    feedAddress: '0xd5a1508ced74c084ebf3cbe853e2c968fb2a651c',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'COIN',
    name: 'Coinbase',
    tokenAddress: '0x6330d8c3178a418788df01a47479c0ce7ccf450b',
    tokenDecimals: 18,
    feedAddress: '0xa3a468a452940b7d6b69991207b508c609a98ef2',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'CRCL',
    name: 'Circle Internet Group',
    tokenAddress: '0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5',
    tokenDecimals: 18,
    feedAddress: '0x6652edf64ba3731c4f2d3ce821a0fb1f1f6b482a',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'GME',
    name: 'GameStop',
    tokenAddress: '0x1b0e319c6a659f002271b69db8a7df2f911c153e',
    tokenDecimals: 18,
    feedAddress: '0x27c71df6a64fb476468edf256cf72c038bab5b67',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'GOOGL',
    name: 'Alphabet Class A',
    tokenAddress: '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
    tokenDecimals: 18,
    feedAddress: '0xf6f373a037c30f0e5010d854385ca89185ae638b',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'INTC',
    name: 'Intel',
    tokenAddress: '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681',
    tokenDecimals: 18,
    feedAddress: '0x3f390c5c24628ac7c489515402235fead71d1913',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'META',
    name: 'Meta Platforms',
    tokenAddress: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35',
    tokenDecimals: 18,
    feedAddress: '0x7c38c00c30bee9378381e7b6135d7283356d71b1',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'MSFT',
    name: 'Microsoft',
    tokenAddress: '0xe93237c50d904957cf27e7b1133b510c669c2e74',
    tokenDecimals: 18,
    feedAddress: '0x45c3c877c15e6ba2ebb19ea114ea508d14c1af2e',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'MSTR',
    name: 'Strategy Inc.',
    tokenAddress: '0xec262a75e413fafd0df80480274532c79d42da09',
    tokenDecimals: 18,
    feedAddress: '0x396118bdfb181e6240e74d243f266b061c0edc3d',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'MU',
    name: 'Micron Technology',
    tokenAddress: '0xff080c8ce2e5feadaca0da81314ae59d232d4afd',
    tokenDecimals: 18,
    feedAddress: '0x425eefdcf05ed6526c3ce61af99429a228a6d596',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'NVDA',
    name: 'NVIDIA',
    tokenAddress: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
    tokenDecimals: 18,
    feedAddress: '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'PLTR',
    name: 'Palantir Technologies',
    tokenAddress: '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a',
    tokenDecimals: 18,
    feedAddress: '0x820abedff239034956b7a9d2f0a331f9f075eb4c',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'QQQ',
    name: 'Invesco QQQ',
    tokenAddress: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
    tokenDecimals: 18,
    feedAddress: '0x80901d846d5d7b030f26b480776ee3b29374c2ae',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'SGOV',
    name: 'iShares 0-3 Month Treasury Bond',
    tokenAddress: '0x92fd66527192e3e61d4ddd13322aa222de86f9b5',
    tokenDecimals: 18,
    feedAddress: '0xa0df4ee0fff975306345875e3548fcc519577a11',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'SPCX',
    name: 'Space Exploration Technologies Corp. Class A Common Stock',
    tokenAddress: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
    tokenDecimals: 18,
    feedAddress: '0xb265810950ba6c5c0ff821c9963014a56fd8bffb',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    tokenAddress: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
    tokenDecimals: 18,
    feedAddress: '0x319724394d3a0e3669269846abe664cd621f9f6a',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'TSLA',
    name: 'Tesla',
    tokenAddress: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
    tokenDecimals: 18,
    feedAddress: '0x4a1166a659a55625345e9515b32adecea5547c38',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  {
    kind: 'stock',
    symbol: 'USO',
    name: 'United States Oil Fund',
    tokenAddress: '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344',
    tokenDecimals: 18,
    feedAddress: '0x75a9c76ef439e2c7c2e5a34ab105ecfe3766431c',
    feedDecimals: 8,
    sourceUrl: TOKEN_SOURCE_URL,
    readOn: READ_ON,
  },
  // The crypto assets of docs/CONTRACTS.md section 21, after the Stock Tokens, in symbol order.
  {
    kind: 'crypto',
    symbol: 'BTC',
    name: 'Bitcoin',
    feedAddress: '0xa2c5184bf03d373dc9de4876eb4bce595b460251',
    feedDecimals: 8,
    sourceUrl: FEED_SOURCE_URL,
    readOn: CRYPTO_READ_ON,
  },
  {
    kind: 'crypto',
    symbol: 'ETH',
    name: 'Ethereum',
    feedAddress: '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9',
    feedDecimals: 8,
    sourceUrl: FEED_SOURCE_URL,
    readOn: CRYPTO_READ_ON,
  },
];
