import { usePrivy } from '@privy-io/react-auth';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useLogout } from '@privy-io/react-auth';

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

  const displayAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';

  if (!ready) {
    return (
      <button className="connect-btn" disabled>
        Loading...
      </button>
    );
  }

  if (!isConnected) {
    return (
      <button className="connect-btn" onClick={handleConnect}>
        Connect Wallet
      </button>
    );
  }

  return (
    <div className="connect-wallet-connected">
      <span className="connect-address">{displayAddress}</span>
      <button className="connect-btn connect-btn-outline" onClick={() => logout()}>
        Disconnect
      </button>
    </div>
  );
}
