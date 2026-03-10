import { useState, useRef } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { WalletMenuModal } from './WalletMenuModal';

/** Abstract Neuro-themed SVG: neural nodes / interconnected mesh */
function NeuroIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="6" r="2" />
      <circle cx="8" cy="14" r="1.5" />
      <circle cx="16" cy="14" r="1.5" />
      <circle cx="6" cy="10" r="1" />
      <circle cx="18" cy="10" r="1" />
      <path d="M12 8v4M10 12l-2 2M14 12l2 2M10 10l-2-2M14 10l2-2M8 14l-2 4M16 14l2 4" />
    </svg>
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

  if (!ready) {
    return (
      <button className="wallet-btn wallet-btn--loading" disabled aria-label="Loading">
        <span className="wallet-btn__dot" />
      </button>
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`wallet-btn ${modalOpen ? 'wallet-btn--active' : ''}`}
        onClick={handleClick}
        aria-label={isConnected ? 'Open wallet menu' : 'Connect wallet'}
        aria-expanded={modalOpen}
        aria-haspopup="menu"
      >
        <span className="wallet-btn__icon">
          <NeuroIcon />
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
