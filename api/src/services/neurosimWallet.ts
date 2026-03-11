/**
 * Wallet client for sending transactions (e.g. reward distributions).
 * Uses NEUROSIM_PRIVATE_KEY and BASE_RPC_URL from env.
 */
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { baseRpcClient } from './baseRpcClient.js';

const RPC_URL = process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.NEUROSIM_PRIVATE_KEY?.trim();
const isTest = process.env.VITEST === 'true';

let _walletClient: ReturnType<typeof createWalletClient> | null = null;

/**
 * Returns a wallet client for sending transactions. Null if key missing or in tests.
 */
export function getNeurosimWallet(): ReturnType<typeof createWalletClient> | null {
  if (isTest || !PRIVATE_KEY) return null;
  if (_walletClient) return _walletClient;
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  _walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });
  return _walletClient;
}

/**
 * Public client for reading chain state (e.g. tx receipts).
 */
export function getNeurosimPublicClient() {
  return baseRpcClient;
}
