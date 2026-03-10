import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
} from 'react';
import { useWallets, usePrivy } from '@privy-io/react-auth';
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  type WalletClient,
  type PublicClient,
  type Address,
} from 'viem';
import { base } from 'viem/chains';
import { BASE_RPC } from './constants';

interface PrivyWalletContextValue {
  address: Address | undefined;
  chainId: number;
  isConnected: boolean;
  walletClient: WalletClient | undefined;
  publicClient: PublicClient;
}

const PrivyWalletContext = createContext<PrivyWalletContextValue | null>(null);

export function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const [walletClient, setWalletClient] = useState<WalletClient | undefined>(
    undefined,
  );

  const activeWallet =
    ready && authenticated && wallets.length > 0 ? wallets[0] : null;
  const address = activeWallet?.address
    ? (activeWallet.address as Address)
    : undefined;
  const isConnected = !!address && authenticated;

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: base,
        transport: http(BASE_RPC),
      }),
    [],
  );

  useEffect(() => {
    if (!activeWallet || !ready) {
      setWalletClient(undefined);
      return;
    }

    let cancelled = false;

    async function initWalletClient() {
      try {
        const wallet = activeWallet as {
          getEthereumProvider?: () => Promise<unknown>;
          switchChain?: (id: number) => Promise<void>;
        };
        if (typeof wallet.getEthereumProvider !== 'function') {
          setWalletClient(undefined);
          return;
        }
        if (typeof wallet.switchChain === 'function') {
          await wallet.switchChain(base.id);
        }
        const provider = await wallet.getEthereumProvider();
        if (cancelled || !provider) return;

        const client = createWalletClient({
          account: address as Address,
          chain: base,
          transport: custom(provider as import('viem').EIP1193Provider),
        });
        if (!cancelled) setWalletClient(client);
      } catch (err) {
        console.error('Failed to create wallet client:', err);
        if (!cancelled) setWalletClient(undefined);
      }
    }

    initWalletClient();
    return () => {
      cancelled = true;
    };
  }, [activeWallet, address, ready]);

  const value: PrivyWalletContextValue = useMemo(
    () => ({
      address,
      chainId: base.id,
      isConnected,
      walletClient,
      publicClient: publicClient as PublicClient,
    }),
    [address, isConnected, walletClient, publicClient],
  );

  return (
    <PrivyWalletContext.Provider value={value}>
      {children}
    </PrivyWalletContext.Provider>
  );
}

export function usePrivyWalletContext() {
  const ctx = useContext(PrivyWalletContext);
  if (!ctx) {
    throw new Error(
      'usePrivyWalletContext must be used within PrivyWalletProvider',
    );
  }
  return ctx;
}
