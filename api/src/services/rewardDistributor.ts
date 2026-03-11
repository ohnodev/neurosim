/**
 * Flushes pending rewards to CabalTokenDistributor on Base.
 */
import { encodeFunctionData, getAddress } from 'viem';
import { CABAL_TOKEN_DISTRIBUTOR } from '../lib/addresses.js';
import { getNeurosimWallet } from './neurosimWallet.js';
import { getPendingForFlush, markDistributed } from './rewardStore.js';

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

/**
 * Flush pending rewards to recipients via CabalTokenDistributor.
 * No-op if no wallet (tests) or no pending.
 */
export async function flushRewards(): Promise<void> {
  const wallet = getNeurosimWallet();
  if (!wallet?.account) return;

  const { recipients, amounts } = getPendingForFlush();
  if (recipients.length === 0) return;

  const totalWei = amounts.reduce((a, b) => a + b, 0n);
  const recipientAddresses = recipients.map((r) => getAddress(r)) as `0x${string}`[];

  try {
    const hash = await wallet.sendTransaction({
      to: CABAL_TOKEN_DISTRIBUTOR,
      data: encodeFunctionData({
        abi: CABAL_ABI,
        functionName: 'distributeETH',
        args: [recipientAddresses, amounts],
      }),
      value: totalWei,
    });
    console.log('[rewardDistributor] flushed', recipients.length, 'recipients, tx', hash);
    markDistributed(recipients, amounts);
  } catch (err) {
    console.error('[rewardDistributor] flush failed:', err);
  }
}
