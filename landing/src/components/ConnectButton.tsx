import { usePrivy } from '@privy-io/react-auth';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useLogout } from '@privy-io/react-auth';

const WalletIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
    <path d="M17 14h.01" />
  </svg>
);

export function ConnectButton() {
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { isConnected, address } = usePrivyWallet();
  const { logout } = useLogout();

  const handleConnect = () => {
    if (authenticated) {
      connectWallet();
    } else {
      login();
    }
  };

  const displayAddress = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';

  if (!ready) {
    return (
      <button className="connect-btn connect-btn-icon" disabled aria-label="Loading">
        <span className="connect-btn-dot" />
      </button>
    );
  }

  if (!isConnected) {
    return (
      <button className="connect-btn connect-btn-icon" onClick={handleConnect} aria-label="Connect wallet">
        <WalletIcon />
      </button>
    );
  }

  return (
    <div className="connect-wallet-connected">
      <span className="connect-address">{displayAddress}</span>
      <button className="connect-btn connect-btn-icon" onClick={() => logout()} aria-label="Disconnect">
        <WalletIcon />
      </button>
    </div>
  );
}
