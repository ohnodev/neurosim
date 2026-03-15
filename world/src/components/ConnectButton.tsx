import React, { useState, useRef, useCallback } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { WalletMenuModal } from './WalletMenuModal';
/** NeuroSim logo – mask so fill inherits button color (hover/active) */
function WalletIcon() {
  return <span className="wallet-btn__svg" aria-hidden />;
}

function ConnectButtonInner({
  devMode,
  onToggleDevMode,
}: {
  devMode: boolean;
  onToggleDevMode: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { ready } = usePrivy();
  const { isConnected } = usePrivyWallet();
  const onClose = useCallback(() => setModalOpen(false), []);

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
        onClose={onClose}
        anchorRef={buttonRef}
        devMode={devMode}
        onToggleDevMode={onToggleDevMode}
      />
    </>
  );
}

export const ConnectButton = React.memo(ConnectButtonInner);
