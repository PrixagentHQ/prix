/**
 * viem's account helpers, for tests that need a real wallet that signs a real message.
 *
 * The tests package does not list viem as a dependency (qa does not change dependencies), but
 * the API package does and its copy is installed. The import goes through that copy until the
 * operator adds `viem` to tests/package.json (see the report); the file then becomes
 * `export { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'`.
 */
// @ts-expect-error: the file path import has no type declarations next to it; the shape is declared below
import * as accounts from '../../apps/api/node_modules/viem/_esm/accounts/index.js';

export interface TestAccount {
  address: `0x${string}`;
  signMessage(args: { message: string }): Promise<`0x${string}`>;
}

const api = accounts as unknown as {
  generatePrivateKey(): `0x${string}`;
  privateKeyToAccount(key: `0x${string}`): TestAccount;
};

/** A new wallet with a random key. Only the test ever sees the key. */
export function newWallet(): TestAccount {
  const account = api.privateKeyToAccount(api.generatePrivateKey());
  // The API takes lower-case addresses only.
  return { address: account.address.toLowerCase() as `0x${string}`, signMessage: (a) => account.signMessage(a) };
}
