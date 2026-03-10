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
  custom,
  type WalletClient,
  type Address,
} from 'viem';
import { base } from 'viem/chains';

export interface PrivyWalletContextValue {
  address: Address | undefined;
  chainId: number | undefined;
  isConnected: boolean;
  walletClient: WalletClient | undefined;
}

const PrivyWalletContext = createContext<PrivyWalletContextValue | null>(null);

export function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const [walletClient, setWalletClient] = useState<WalletClient | undefined>(
    undefined,
  );
  const [liveChainId, setLiveChainId] = useState<number | undefined>(undefined);

  const activeWallet =
    ready && authenticated && wallets.length > 0 ? wallets[0] : null;
  const address = activeWallet?.address
    ? (activeWallet.address as Address)
    : undefined;
  const isConnected = !!address && authenticated;

  useEffect(() => {
    if (!activeWallet || !ready) {
      setWalletClient(undefined);
      setLiveChainId(undefined);
      return;
    }

    setWalletClient(undefined);
    let cancelled = false;

    async function initWalletClient() {
      if (!address) {
        setWalletClient(undefined);
        setLiveChainId(undefined);
        return;
      }
      try {
        const wallet = activeWallet as {
          getEthereumProvider?: () => Promise<unknown>;
        };
        if (typeof wallet.getEthereumProvider !== 'function') {
          setWalletClient(undefined);
          setLiveChainId(undefined);
          return;
        }
        const provider = await wallet.getEthereumProvider();
        if (cancelled || !provider) return;

        const p = provider as import('viem').EIP1193Provider;
        const hexChainId = await p.request({ method: 'eth_chainId' });
        const chainId = hexChainId ? parseInt(String(hexChainId), 16) : undefined;
        if (!cancelled) setLiveChainId(chainId);

        const client = createWalletClient({
          account: address as Address,
          chain: base,
          transport: custom(p),
        });
        if (!cancelled) setWalletClient(client);
      } catch (err) {
        console.error('Failed to create wallet client:', err);
        if (!cancelled) {
          setWalletClient(undefined);
          setLiveChainId(undefined);
        }
      }
    }

    initWalletClient();
    return () => {
      cancelled = true;
    };
  }, [activeWallet, address, ready]);

  const chainId = liveChainId;

  const value: PrivyWalletContextValue = useMemo(
    () => ({
      address,
      chainId,
      isConnected,
      walletClient,
    }),
    [address, chainId, isConnected, walletClient],
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
