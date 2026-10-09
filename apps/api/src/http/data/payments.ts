import type {
  Address,
  DataConfig,
  DataDeps,
  PaymentFacts,
  PaymentPublic,
  PaymentService,
  PaymentVerdict,
  SubmitPaymentResponse,
} from '@prix/contracts';
import { ChainUnavailableError, DataFailure, lowerAddress } from '@prix/contracts';

/** Parses a decimal string into a bigint, or null when it is not a plain non-negative integer. */
function toBig(value: string): bigint | null {
  return /^[0-9]{1,78}$/.test(value) ? BigInt(value) : null;
}

/**
 * The policy of docs/contracts/phase-5-data.md section 6 rule 11, pure. The amount comes only from
 * the transfer logs the chain reader returned (USDG contract only); nothing the client sent is used.
 */
export function evaluatePayment(facts: PaymentFacts, wallet: Address, config: DataConfig): PaymentVerdict {
  if (!facts.found || facts.blockNumber === null) {
    return {
      kind: 'pending',
      message: 'The chain does not know this transaction yet. Wait a minute and submit the hash again.',
    };
  }
  if (facts.success !== true) {
    return { kind: 'invalid', message: 'This transaction did not succeed on the chain, so nothing was credited.' };
  }
  if (!facts.decimalsOk) {
    return {
      kind: 'invalid',
      message: 'The payment token does not report the expected number of decimals, so payments cannot be credited now.',
    };
  }
  if (config.paymentAddress === null) {
    return { kind: 'invalid', message: 'Payments are not set up, so nothing was credited.' };
  }
  const to = lowerAddress(config.paymentAddress);
  const from = lowerAddress(wallet);
  let sum = 0n;
  for (const transfer of facts.transfers) {
    if (lowerAddress(transfer.to) !== to || lowerAddress(transfer.from) !== from) continue;
    const value = toBig(transfer.valueMicro);
    if (value !== null) sum += value;
  }
  if (sum === 0n) {
    return {
      kind: 'invalid',
      message:
        'This transaction holds no USDG transfer from your signed-in wallet to the Prix payment address. Send from your own wallet to the address shown, then submit the new hash.',
    };
  }
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { kind: 'invalid', message: 'The amount is too large to credit. Contact support with the hash.' };
  }
  const amountMicro = Number(sum);
  if (amountMicro < config.minPaymentMicro) {
    return {
      kind: 'invalid',
      message: `The transfer is below the smallest payment that is credited, ${config.minPaymentMicro} micro-USDG. Send a larger amount and submit the new hash.`,
    };
  }
  if (facts.headBlock - facts.blockNumber < config.confirmations) {
    return {
      kind: 'pending',
      message: 'The transaction is found but not final yet. Wait a few minutes and submit the hash again.',
    };
  }
  return { kind: 'ok', amountMicro, blockNumber: facts.blockNumber };
}

export function createPaymentService(deps: Pick<DataDeps, 'data' | 'chain' | 'config' | 'now'>): PaymentService {
  const { data, chain, config } = deps;
  return {
    async submit(owner: Address, txHash: string): Promise<SubmitPaymentResponse> {
      if (!config.paymentsEnabled || config.paymentAddress === null) {
        throw new DataFailure('unavailable', 'Credits are not on sale yet. Check the pricing page later.');
      }
      const hash = txHash.toLowerCase();
      const wallet = lowerAddress(owner);
      let facts: PaymentFacts;
      try {
        facts = await chain.readPaymentFacts(hash);
      } catch (error) {
        if (error instanceof ChainUnavailableError) {
          throw new DataFailure('chain_unavailable', 'The chain could not be read just now. Try again in a minute.');
        }
        throw error;
      }
      const verdict = evaluatePayment(facts, wallet, config);
      if (verdict.kind === 'pending') throw new DataFailure('payment_pending', verdict.message, 'txHash');
      if (verdict.kind === 'invalid') throw new DataFailure('payment_invalid', verdict.message, 'txHash');

      const creditedAt = deps.now().toISOString();
      const outcome = await data.creditPayment({
        txHash: hash,
        owner: wallet,
        amountMicro: verdict.amountMicro,
        blockNumber: verdict.blockNumber,
        creditedAt,
      });
      if (outcome === 'taken') {
        throw new DataFailure(
          'payment_already_credited',
          'This transaction was already credited to another wallet. Submit a transaction you sent from this wallet.',
          'txHash',
        );
      }
      const credits = await data.getCredits(wallet);
      let payment: PaymentPublic = {
        txHash: hash,
        amountMicro: verdict.amountMicro,
        blockNumber: verdict.blockNumber,
        creditedAt,
      };
      if (outcome === 'already_credited') {
        const stored = (await data.listPayments(wallet, 50)).find((entry) => entry.txHash === hash);
        if (stored !== undefined) {
          payment = {
            txHash: stored.txHash,
            amountMicro: stored.amountMicro,
            blockNumber: stored.blockNumber,
            creditedAt: stored.creditedAt,
          };
        }
      }
      return { payment, balanceMicro: credits.balanceMicro, alreadyCredited: outcome === 'already_credited' };
    },
  };
}
