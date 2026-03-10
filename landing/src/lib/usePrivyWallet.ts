import type { Address } from 'viem';
import { usePrivyWalletContext } from './privyWalletContext';

export function usePrivyWallet() {
  return usePrivyWalletContext();
}

export function useActiveAddress(): Address | undefined {
  return usePrivyWalletContext().address;
}

export function useWalletClient() {
  return usePrivyWalletContext().walletClient;
}

