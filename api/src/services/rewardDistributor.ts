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

  flushing = true;
  const { recipients, amounts } = takeBatchForFlush();
  if (recipients.length === 0) {
    flushing = false;
    return;
  }

  let txHash: `0x${string}` | undefined;
  try {
    const recipientAddresses = recipients.map((r) => getAddress(r)) as `0x${string}`[];
    const totalWei = amounts.reduce((a, b) => a + b, 0n);

    txHash = await wallet.sendTransaction({
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
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      console.error('[rewardDistributor] tx reverted, rolling back', txHash);
      rollbackBatch(recipients, amounts);
      return;
    }

    confirmDistributed(recipients, amounts);
    console.log('[rewardDistributor] flushed', recipients.length, 'recipients, tx', txHash);
  } catch (err) {
    console.error('[rewardDistributor] flush failed:', err);
    if (txHash === undefined) {
      rollbackBatch(recipients, amounts);
    } else {
      console.error('[rewardDistributor] tx was broadcast; batch left in-flight for reconciliation', txHash);
    }
  } finally {
    flushing = false;
  }
}
