/**
 * Flushes pending rewards as $NEURO token transfers (ERC20) on Base.
 * Sends one transfer per recipient from the neurosim wallet.
 * Skips dead-letter recipients (permanent failures). Retries transient errors.
 */
import { encodeFunctionData, getAddress } from 'viem';
import { base } from 'viem/chains';
import { NEURO_TOKEN_ADDRESS } from '../lib/addresses.js';
import { getNeurosimWallet } from './neurosimWallet.js';
import { getNeurosimPublicClient } from './neurosimWallet.js';
import {
  executeContractTx,
  type PublicClientLike,
  type WalletLike,
} from './transactionFacilitator.js';
import { takeBatchForFlush, confirmDistributed, rollbackBatch, dropFromInFlight } from './rewardStore.js';

const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const MAX_TRANSIENT_RETRIES = 2;

/** In-memory set of recipients to skip (permanent failures). Cleared on restart. */
const deadLetter = new Set<string>();

function errorText(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err).toLowerCase();
  const e = err as { code?: string; shortMessage?: string; message?: string };
  return `${e.code ?? ''} ${e.shortMessage ?? ''} ${e.message ?? ''}`.toLowerCase();
}

function isPermanentError(err: unknown): boolean {
  const text = errorText(err);
  return (
    text.includes('invalid address') ||
    text.includes('invalid address or ENS name') ||
    text.includes('execution reverted') ||
    text.includes('insufficient') ||
    text.includes('transfer to the zero address') ||
    text.includes('ERC20: transfer to the zero address')
  );
}

let flushing = false;

/**
 * Flush pending rewards to recipients via ERC20 transfer.
 * Skips dead-letter recipients. Retries transient errors. Advances past failures so the queue is not blocked.
 */
export async function flushRewards(): Promise<void> {
  if (flushing) return;
  const wallet = getNeurosimWallet();
  if (!wallet?.account) return;

  flushing = true;
  try {
    const publicClient = getNeurosimPublicClient();
    while (true) {
      const { recipients, amounts } = takeBatchForFlush();
      if (recipients.length === 0) break;

      const toProcess: { r: string; a: bigint }[] = [];
      const toDrop: { r: string; a: bigint }[] = [];
      for (let i = 0; i < recipients.length; i++) {
        const r = recipients[i].toLowerCase();
        const a = amounts[i];
        if (a === undefined) continue;
        if (deadLetter.has(r)) {
          toDrop.push({ r: recipients[i], a });
        } else {
          toProcess.push({ r: recipients[i], a });
        }
      }
      if (toDrop.length > 0) {
        dropFromInFlight(toDrop.map((x) => x.r), toDrop.map((x) => x.a));
      }
      if (toProcess.length === 0) continue;

      const confirmed: string[] = [];
      const confirmedAmounts: bigint[] = [];
      const toRollback: string[] = [];
      const toRollbackAmounts: bigint[] = [];

      for (const { r, a } of toProcess) {
        let lastErr: unknown;
        let sent = false;
        for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
          try {
            const to = getAddress(r) as `0x${string}`;
            const { txHash } = await executeContractTx({
              wallet: wallet as WalletLike,
              publicClient: publicClient as PublicClientLike,
              chain: base,
              to: NEURO_TOKEN_ADDRESS,
              data: encodeFunctionData({
                abi: ERC20_TRANSFER_ABI,
                functionName: 'transfer',
                args: [to, a],
              }),
              value: 0n,
              timeoutMs: 60_000,
              label: 'rewardDistributor',
            });
            confirmed.push(r);
            confirmedAmounts.push(a);
            confirmDistributed([r], [a], txHash);
            console.log('[rewardDistributor] transferred to', r, 'tx', txHash);
            sent = true;
            break;
          } catch (err) {
            lastErr = err;
            if (isPermanentError(err)) {
              console.error('[rewardDistributor] permanent failure for', r, err);
              deadLetter.add(r.toLowerCase());
              dropFromInFlight([r], [a]);
              break;
            }
            if (retry < MAX_TRANSIENT_RETRIES) {
              console.warn('[rewardDistributor] transient failure for', r, 'retry', retry + 1, err);
            } else {
              console.error('[rewardDistributor] transient failure for', r, 'after retries', err);
              toRollback.push(r);
              toRollbackAmounts.push(a);
              break;
            }
          }
        }
        if (!sent && !toRollback.includes(r) && !deadLetter.has(r.toLowerCase())) {
          toRollback.push(r);
          toRollbackAmounts.push(a);
        }
      }

      if (toRollback.length > 0) {
        rollbackBatch(toRollback, toRollbackAmounts);
      }
    }
  } finally {
    flushing = false;
  }
}
