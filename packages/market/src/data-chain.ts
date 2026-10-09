import type { DataChainPort } from '@prix/contracts';
import { readPaymentFacts } from './payment-facts.ts';
import { readLaunchesByDeployer, readLaunchOfToken } from './pons.ts';
import { createRpc } from './rpc.ts';
import { readTokenBasics } from './token-facts.ts';

/** Reads only: no key, no signing, no method that writes. */
export function createDataChain(config: { rpcUrls: readonly string[]; fetch?: typeof fetch }): DataChainPort {
  const rpc = createRpc(config.rpcUrls, config.fetch);
  return {
    readLaunchesByDeployer: (deployer, limit) => readLaunchesByDeployer(rpc, deployer, limit),
    readLaunchOfToken: (token) => readLaunchOfToken(rpc, token),
    readTokenBasics: (token, holder) => readTokenBasics(rpc, token, holder),
    // Endpoint by endpoint under the two-endpoint rule: a payment grants paid calls.
    readPaymentFacts: (txHash) => readPaymentFacts(config.rpcUrls, txHash, config.fetch),
  };
}
