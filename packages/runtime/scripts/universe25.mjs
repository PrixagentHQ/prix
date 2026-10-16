// Shared by the stage 2 check scripts (docs/CONTRACTS.md section 23). Local only, never deployed.
//
// Until packages/market lists SOL, BNB and HYPE, a script that needs the 25-symbol universe adds
// them to the in-memory UNIVERSE array of this process, before packages/runtime is loaded, so the
// runtime sees the universe the contract names. Nothing is written to any file. Once the market's
// own list has them, nothing is added and the scripts run on the real list.

import { ARBITRUM_CHAIN_ID } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';

/** The three Arbitrum feeds of section 23, in the universe order the contract names: BNB, HYPE, SOL. */
const ARBITRUM_ENTRIES = [
  { symbol: 'BNB', name: 'BNB', feedAddress: '0x6970460aabf80c5be983c6b74e5d06dedca95d4a' },
  { symbol: 'HYPE', name: 'Hyperliquid', feedAddress: '0xf9ce4fe2f0ece0362cb416844ae179a49591d567' },
  { symbol: 'SOL', name: 'Solana', feedAddress: '0x24cea4b8ce57cda5058b924b9b9987992450590c' },
];

/** The symbols of the universe as packages/market lists it, before anything is added. */
export const MARKET_SYMBOLS = UNIVERSE.map((token) => token.symbol);

/** The universe as packages/market lists it today, without anything added. */
export function marketUniverse() {
  return UNIVERSE.filter((token) => MARKET_SYMBOLS.includes(token.symbol));
}

/** Adds the Arbitrum entries the market does not list yet. Returns the symbols it added. */
export function ensureUniverse25() {
  const added = [];
  for (const entry of ARBITRUM_ENTRIES) {
    if (UNIVERSE.some((token) => token.symbol === entry.symbol)) continue;
    UNIVERSE.push({
      kind: 'crypto',
      chainId: ARBITRUM_CHAIN_ID,
      ...entry,
      feedDecimals: 8,
      sourceUrl: 'https://docs.chain.link/data-feeds/price-feeds/addresses?network=arbitrum',
      readOn: '2026-10-09',
    });
    added.push(entry.symbol);
  }
  return added;
}

export { UNIVERSE };
