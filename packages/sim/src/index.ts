import type { SimEngine } from '@prix/contracts';
import { newPortfolio, valuePortfolio } from './portfolio.ts';
import { rebalance } from './rebalance.ts';

/**
 * The paper portfolio engine. docs/CONTRACTS.md section 7 specifies every function.
 *
 * It is a simulation: nothing here holds funds, places an order or talks to a wallet.
 * Every function is pure: no clock, no randomness and no I/O. Prices and decisions come in
 * as arguments, so replaying stored decisions at stored prices gives the stored record again.
 */
export const sim: SimEngine = {
  newPortfolio,
  valuePortfolio,
  rebalance,
};
