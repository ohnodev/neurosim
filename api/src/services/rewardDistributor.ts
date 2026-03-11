/**
 * Flushes pending rewards to CabalTokenDistributor on Base.
 */
import { encodeFunctionData, getAddress } from 'viem';
import { base } from 'viem/chains';
import { CABAL_TOKEN_DISTRIBUTOR } from '../lib/addresses.js';
import { getNeurosimWallet } from './neurosimWallet.js';
import { getNeurosimPublicClient } from './neurosimWallet.js';
import { executeContractTx, type PublicClientLike, type WalletLike } from './transactionFacilitator.js';
import { takeBatchForFlush, confirmDistributed, rollbackBatch } from './rewardStore.js';

const CABAL_ABI = [
  {
    inputs: [
      { name: 'recipients', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    name: 'distributeETH',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

/** CabalTokenDistributor has MAX_BATCH_SIZE = 200; use a safe chunk size. */
const MAX_RECIPIENTS_PER_BATCH = 100;

let flushing = false;

/**
 * Flush pending rewards to recipients via CabalTokenDistributor.
 * Waits for on-chain confirmation before marking distributed.
 * Serialized: only one flush runs at a time. Batches are chunked to stay under contract limit.
 */
export async function flushRewards(): Promise<void> {
  if (flushing) return;
  const wallet = getNeurosimWallet();
  if (!wallet?.account) return;

  flushing = true;
  try {
    const publicClient = getNeurosimPublicClient();
    while (true) {
      const { recipients, amounts } = takeBatchForFlush(MAX_RECIPIENTS_PER_BATCH);
      if (recipients.length === 0) break;

      try {
        const recipientAddresses = recipients.map((r) => getAddress(r)) as `0x${string}`[];
        const totalWei = amounts.reduce((a, b) => a + b, 0n);

        const { txHash } = await executeContractTx({
          wallet: wallet as WalletLike,
          publicClient: publicClient as PublicClientLike,
          chain: base,
          to: CABAL_TOKEN_DISTRIBUTOR,
          data: encodeFunctionData({
            abi: CABAL_ABI,
            functionName: 'distributeETH',
            args: [recipientAddresses, amounts],
          }),
          value: totalWei,
          timeoutMs: 60_000,
          label: 'rewardDistributor',
        });

        confirmDistributed(recipients, amounts, txHash);
        console.log('[rewardDistributor] flushed', recipients.length, 'recipients, tx', txHash);
      } catch (err) {
        console.error('[rewardDistributor] flush failed:', err);
        rollbackBatch(recipients, amounts);
        return;
      }
    }
  } finally {
    flushing = false;
  }
}
