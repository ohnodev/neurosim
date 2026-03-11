/**
 * Flushes pending rewards as $NEURO token transfers (ERC20) on Base.
 * Sends one transfer per recipient from the neurosim wallet.
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
import { takeBatchForFlush, confirmDistributed, rollbackBatch } from './rewardStore.js';

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

let flushing = false;

/**
 * Flush pending rewards to recipients via ERC20 transfer.
 * Waits for on-chain confirmation before marking distributed.
 * Serialized: only one flush runs at a time. One tx per recipient.
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

      const confirmed: string[] = [];
      const confirmedAmounts: bigint[] = [];
      let failed = false;

      for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        const amount = amounts[i];
        if (amount === undefined) continue;

        try {
          const to = getAddress(recipient) as `0x${string}`;
          const { txHash } = await executeContractTx({
            wallet: wallet as WalletLike,
            publicClient: publicClient as PublicClientLike,
            chain: base,
            to: NEURO_TOKEN_ADDRESS,
            data: encodeFunctionData({
              abi: ERC20_TRANSFER_ABI,
              functionName: 'transfer',
              args: [to, amount],
            }),
            value: 0n,
            timeoutMs: 60_000,
            label: 'rewardDistributor',
          });

          confirmed.push(recipient);
          confirmedAmounts.push(amount);
          confirmDistributed([recipient], [amount], txHash);
          console.log('[rewardDistributor] transferred to', recipient, 'tx', txHash);
        } catch (err) {
          console.error('[rewardDistributor] transfer failed for', recipient, err);
          failed = true;
          break;
        }
      }

      if (failed && confirmed.length === 0) {
        rollbackBatch(recipients, amounts);
        return;
      }
      if (failed && confirmed.length > 0) {
        const remainderR = recipients.slice(confirmed.length);
        const remainderA = amounts.slice(confirmed.length);
        rollbackBatch(remainderR, remainderA);
        return;
      }
    }
  } finally {
    flushing = false;
  }
}
