import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useRef,
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

  const chainChangedCleanupRef = useRef<(() => void) | null>(null);

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
          switchChain?: (id: number) => Promise<void>;
        };
        if (typeof wallet.getEthereumProvider !== 'function') {
          setWalletClient(undefined);
          setLiveChainId(undefined);
          return;
        }
        // Switch to Base before creating client so transactions target the correct chain
        if (typeof wallet.switchChain === 'function') {
          await wallet.switchChain(base.id);
        }
        const provider = await wallet.getEthereumProvider();
        if (cancelled || !provider) return;

        const p = provider as import('viem').EIP1193Provider & { on?: (event: string, handler: (hex: string) => void) => void; removeListener?: (event: string, handler: (hex: string) => void) => void };
        const hexChainId = await p.request({ method: 'eth_chainId' });
        const chainId = hexChainId ? parseInt(String(hexChainId), 16) : undefined;
        if (!cancelled) setLiveChainId(chainId);

        const onChainChanged = (hex: string) => {
          if (cancelled) return;
          const id = hex ? parseInt(String(hex), 16) : undefined;
          setLiveChainId(id);
        };
        if (typeof p.on === 'function') {
          p.on('chainChanged', onChainChanged);
          chainChangedCleanupRef.current = () => {
            if (typeof p.removeListener === 'function') {
              p.removeListener('chainChanged', onChainChanged);
            }
            chainChangedCleanupRef.current = null;
          };
        }

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
      chainChangedCleanupRef.current?.();
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
