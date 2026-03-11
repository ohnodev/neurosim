/**
 * Integration test: distributes ETH to self via CabalTokenDistributor.
 * Skips if NEUROSIM_PRIVATE_KEY or BASE_RPC_URL are missing.
 * Costs a small amount of gas but validates distributions work.
 */
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { createWalletClient, http, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { CABAL_TOKEN_DISTRIBUTOR, FLY_ETH_RECEIVER } from '../lib/addresses.js';

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

const AMOUNT = 10n ** 12n; // 0.000001 ETH

describe('rewardDistributor integration', () => {
  it('distributes ETH to self via CabalTokenDistributor', async () => {
    const pk = process.env.NEUROSIM_PRIVATE_KEY?.trim();
    const rpc = process.env.BASE_RPC_URL?.trim();
    if (!pk || !rpc) {
      console.log('[rewardDistributor] skipping: NEUROSIM_PRIVATE_KEY or BASE_RPC_URL not set');
      return;
    }

    const account = privateKeyToAccount(pk as `0x${string}`);
    const wallet = createWalletClient({
      account,
      chain: base,
      transport: http(rpc),
    });

    const recipients = [getAddress(FLY_ETH_RECEIVER)] as `0x${string}`[];
    const amounts = [AMOUNT];

    const hash = await wallet!.sendTransaction({
      to: CABAL_TOKEN_DISTRIBUTOR,
      data: encodeFunctionData({
        abi: CABAL_ABI,
        functionName: 'distributeETH',
        args: [recipients, amounts],
      }),
      value: AMOUNT,
    });

    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Wait for receipt
    const { createPublicClient } = await import('viem');
    const publicClient = createPublicClient({
      chain: base,
      transport: http(rpc),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
  });
});
