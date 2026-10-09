import type { ClaimSignatureVerifier } from '@prix/contracts';
import { readWithAgreement } from '@prix/market/agreement';
import {
  BaseError,
  createPublicClient,
  encodeFunctionData,
  HttpRequestError,
  hashMessage,
  http,
  recoverMessageAddress,
  TimeoutError,
} from 'viem';

const ERC6492_MAGIC = '6492649264926492649264926492649264926492649264926492649264926492';
const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

/**
 * True when a failed request is worth asking the next endpoint about (docs/CONTRACTS.md section 20):
 * a transport failure, a timeout, HTTP 408, 429 or a 5xx. A JSON-RPC refusal or a revert is an
 * answer, the same everywhere, and ends the check.
 */
export function claimReadMovesOn(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk((e) => {
      if (e instanceof TimeoutError) return true;
      if (!(e instanceof HttpRequestError)) return false;
      const status = e.status;
      return status === undefined || status === 408 || status === 429 || status >= 500;
    }) !== null
  );
}

/**
 * The claim signature check. ECDSA recovery first, as sign-in does. Only when it does not match, and
 * only with `contractWallets` on, the chain is asked: `eth_getCode` of the wallet, then one direct
 * ERC-1271 `isValidSignature` call to it, nothing executed in front of it.
 * With contract wallets off no network call is ever made. Never throws and never logs.
 *
 * `rpcUrls` are the endpoints of every chain read, in their order (`rpcEndpoints` of packages/market).
 * They are asked under the two-endpoint rule (`readWithAgreement`, D-110 finding 4): an endpoint that
 * fails in transport hands the check to the next; the keyed RPC_URL or the official endpoint is
 * believed alone; a third-party fallback that says "valid" is believed only when the next endpoint
 * on another host says the same. Anything else is a refusal.
 */
export function createClaimVerifier(options: {
  contractWallets: boolean;
  rpcUrls: readonly string[];
  /** For tests; the Worker's own fetch otherwise. */
  fetch?: typeof fetch;
}): ClaimSignatureVerifier {
  const clients = new Map<string, ReturnType<typeof createPublicClient>>();
  const clientOf = (url: string) => {
    let client = clients.get(url);
    if (client === undefined) {
      client = createPublicClient({
        transport: http(url, {
          timeout: 5_000,
          retryCount: 0,
          ...(options.fetch ? { fetchFn: options.fetch } : {}),
        }),
      });
      clients.set(url, client);
    }
    return client;
  };

  return {
    async verify({ wallet, message, signature }) {
      if (!/^0x[0-9a-fA-F]+$/.test(signature)) return null;
      try {
        const recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
        if (recovered.toLowerCase() === wallet.toLowerCase()) return 'eoa';
      } catch {
        // Not an ECDSA signature: a contract wallet may still accept it, if they are switched on.
      }
      if (!options.contractWallets) return null;
      // ERC-6492 wrappers carry a factory call that would run before the check: refused outright.
      if (signature.toLowerCase().endsWith(ERC6492_MAGIC)) return null;
      if (options.rpcUrls.length === 0) return null;
      const data = encodeFunctionData({
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [hashMessage(message), signature as `0x${string}`],
      });
      const address = wallet as `0x${string}`;
      try {
        const agreed = await readWithAgreement(
          options.rpcUrls,
          async (url) => {
            const client = clientOf(url);
            const code = await client.getCode({ address });
            if (code === undefined || code === '0x') return false;
            const result = await client.call({ to: address, data });
            return result.data?.toLowerCase().startsWith(ERC1271_MAGIC) === true;
          },
          {
            movesOn: claimReadMovesOn,
            agree: (a, b) => a === b,
            // A refusal grants nothing and needs no second opinion.
            needsConfirmation: (valid) => valid,
          },
        );
        return agreed.ok && agreed.value ? 'contract' : null;
      } catch {
        return null;
      }
    },
  };
}
