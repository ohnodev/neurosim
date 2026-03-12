import { type ReactNode } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { base } from 'viem/chains';
import { PRIVY_APP_ID } from '../lib/constants';
import { PrivyWalletProvider } from '../lib/privyWalletContext';
import { NotificationProvider } from '../contexts/NotificationContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const privyConfig = {
  loginMethods: ['wallet'] as ('wallet')[],
  embeddedWallets: {
    ethereum: { createOnLogin: 'off' as const },
  },
  appearance: {
    theme: 'dark' as const,
    accentColor: '#6366f1' as `#${string}`,
    showWalletLoginFirst: true,
    landingHeader: 'Connect to NeuroSim',
    loginMessage: 'Connect a wallet to claim your fly',
  },
  defaultChain: base,
  supportedChains: [base],
};

export function OnchainProviders({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <QueryClientProvider client={queryClient}>
        <NotificationProvider>
          <PrivyWalletProvider>{children}</PrivyWalletProvider>
        </NotificationProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
