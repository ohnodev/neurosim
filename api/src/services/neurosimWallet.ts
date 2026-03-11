/**
 * Wallet client for sending transactions (e.g. reward distributions).
 * Uses NEUROSIM_PRIVATE_KEY and BASE_RPC_URL from env.
 */
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const RPC_URL = process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.NEUROSIM_PRIVATE_KEY?.trim();
const isTest = process.env.VITEST === 'true';

let _walletClient: WalletClient | null = null;
let _publicClient: PublicClient | null = null;

function getPublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: base,
      transport: http(RPC_URL),
    });
  }
  return _publicClient;
}

/**
 * Returns a wallet client for sending transactions. Null if key missing or in tests.
 */
export function getNeurosimWallet(): WalletClient | null {
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
export function getNeurosimPublicClient(): PublicClient {
  return getPublicClient();
}
