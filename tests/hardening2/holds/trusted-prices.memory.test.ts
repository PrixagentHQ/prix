import { describe } from 'vitest';
import { createMemoryStore } from '../../support/memory-store.ts';
import { trustedPricesContract } from './trusted-prices-contract.ts';

describe('MemoryStore.getLastTrustedPrices', () => {
  trustedPricesContract(async () => createMemoryStore());
});
