import type { Address } from 'viem';
import { usePrivyWalletContext, type PrivyWalletContextValue } from './privyWalletContext';

export function usePrivyWallet(): PrivyWalletContextValue {
  return usePrivyWalletContext();
}

export function useActiveAddress(): Address | undefined {
  return usePrivyWalletContext().address;
}

export function useWalletClient() {
  return usePrivyWalletContext().walletClient;
}

