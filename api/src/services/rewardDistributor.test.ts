/**
 * Integration test: sends 1 $NEURO to self via ERC20 transfer.
 * Skips if NEUROSIM_PRIVATE_KEY or BASE_RPC_URL are missing.
 * Costs a small amount of gas but validates token distribution works.
 */
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { createWalletClient, createPublicClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { NEURO_TOKEN_ADDRESS } from '../lib/addresses.js';
import { ERC20_TRANSFER_ABI } from '../lib/claimConstants.js';

const AMOUNT = 1n * 10n ** 18n; // 1 $NEURO

const pk = process.env.NEUROSIM_PRIVATE_KEY?.trim();
const rpc = process.env.BASE_RPC_URL?.trim();

describe('rewardDistributor integration', () => {
  it.skipIf(!pk || !rpc || NEURO_TOKEN_ADDRESS === '0x0000000000000000000000000000000000000000')(
    'sends 1 $NEURO to self via ERC20 transfer',
    { timeout: 15_000 },
    async () => {
      const account = privateKeyToAccount(pk! as `0x${string}`);
      const wallet = createWalletClient({
        account,
        chain: base,
        transport: http(rpc!),
      });

      const hash = await wallet.sendTransaction({
        to: NEURO_TOKEN_ADDRESS,
        data: encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [account.address, AMOUNT],
        }),
        value: 0n,
      });

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      const publicClient = createPublicClient({
        chain: base,
        transport: http(rpc),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
    }
  );
});
