import { useState, useRef } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { WalletMenuModal } from './WalletMenuModal';
/** NeuroSim logo icon for wallet button */
function WalletIcon() {
  return (
    <img
      src="/neurosim-logo-v1.svg"
      alt=""
      width={36}
      height={36}
      className="wallet-btn__svg"
      aria-hidden
    />
  );
}

export function ConnectButton() {
  const [modalOpen, setModalOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { ready } = usePrivy();
  const { isConnected } = usePrivyWallet();

  const handleClick = () => {
    if (!ready) return;
    setModalOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`wallet-btn ${!ready ? 'wallet-btn--loading' : ''} ${modalOpen ? 'wallet-btn--active' : ''}`}
        onClick={handleClick}
        disabled={!ready}
        aria-label={!ready ? 'Loading' : isConnected ? 'Open wallet menu' : 'Connect wallet'}
        aria-expanded={modalOpen}
        aria-haspopup="dialog"
      >
        <span className="wallet-btn__icon">
          <WalletIcon />
        </span>
      </button>
      <WalletMenuModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        anchorRef={buttonRef}
      />
    </>
  );
}
