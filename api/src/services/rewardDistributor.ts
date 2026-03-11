/**
 * Flushes pending rewards to CabalTokenDistributor on Base.
 */
import { encodeFunctionData, getAddress } from 'viem';
import { base } from 'viem/chains';
import { CABAL_TOKEN_DISTRIBUTOR } from '../lib/addresses.js';
import { getNeurosimWallet } from './neurosimWallet.js';
import { getNeurosimPublicClient } from './neurosimWallet.js';
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

let flushing = false;

/**
 * Flush pending rewards to recipients via CabalTokenDistributor.
 * Waits for on-chain confirmation before marking distributed.
 * Serialized: only one flush runs at a time.
 */
export async function flushRewards(): Promise<void> {
  if (flushing) return;
  const wallet = getNeurosimWallet();
  if (!wallet?.account) return;

  const { recipients, amounts } = takeBatchForFlush();
  if (recipients.length === 0) return;

  flushing = true;
  const totalWei = amounts.reduce((a, b) => a + b, 0n);
  const recipientAddresses = recipients.map((r) => getAddress(r)) as `0x${string}`[];

  try {
    const hash = await wallet.sendTransaction({
      account: wallet.account!,
      chain: base,
      to: CABAL_TOKEN_DISTRIBUTOR,
      data: encodeFunctionData({
        abi: CABAL_ABI,
        functionName: 'distributeETH',
        args: [recipientAddresses, amounts],
      }),
      value: totalWei,
    });

    const publicClient = getNeurosimPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== 'success') {
      console.error('[rewardDistributor] tx reverted, rolling back', hash);
      rollbackBatch(recipients, amounts);
      return;
    }

    confirmDistributed(recipients, amounts);
    console.log('[rewardDistributor] flushed', recipients.length, 'recipients, tx', hash);
  } catch (err) {
    console.error('[rewardDistributor] flush failed:', err);
    rollbackBatch(recipients, amounts);
  } finally {
    flushing = false;
  }
}
