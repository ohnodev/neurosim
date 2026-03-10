import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useLogout } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { WORLD_URL } from '../lib/constants';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function DisconnectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

interface WalletMenuModalProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

export function WalletMenuModal({ isOpen, onClose, anchorRef }: WalletMenuModalProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isConnected, address, chainId } = usePrivyWallet();
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { logout } = useLogout({ onSuccess: onClose });
  const { wallets } = useWallets();

  const isOnBaseChain = chainId === base.id;
  const displayAddress = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const handleCopy = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      setCopied(true);
      copyTimeoutRef.current = setTimeout(() => {
        copyTimeoutRef.current = null;
        setCopied(false);
        onClose();
      }, 1800);
    } catch {
      /* ignore */
    }
  }, [address, onClose]);

  const handleLogout = useCallback(() => {
    if (!ready || !authenticated) {
      onClose();
      return;
    }
    void logout();
  }, [logout, onClose, ready, authenticated]);

  const handleConnect = useCallback(() => {
    if (authenticated) connectWallet();
    else login();
    onClose();
  }, [authenticated, login, connectWallet, onClose]);

  const handleSwitchChain = useCallback(async () => {
    if (!ready || !wallets.length) return;
    const wallet = address
      ? wallets.find((w) => w.address?.toLowerCase() === address.toLowerCase()) ?? wallets[0]
      : wallets[0];
    const w = wallet as { switchChain?: (chainId: number) => Promise<void> };
    if (!wallet || typeof w.switchChain !== 'function') return;
    try {
      await w.switchChain(base.id);
      onClose();
    } catch {
      /* user declined */
    }
  }, [ready, wallets, address, onClose]);

  if (!isOpen) return null;

  const rect = anchorRef.current?.getBoundingClientRect();
  const top = rect ? rect.bottom + 8 : 56;
  const right = rect ? window.innerWidth - rect.right : 24;

  const modalContent = (
    <>
      <div
        className="wallet-modal-backdrop"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="wallet-modal"
        role="menu"
        aria-label="Wallet menu"
        style={{ top, right }}
      >
        {!isConnected ? (
          <button type="button" className="wallet-modal-item wallet-modal-connect" onClick={handleConnect}>
            Connect Wallet
          </button>
        ) : (
          <>
            <div className="wallet-modal-address-row">
              <span className="wallet-modal-address">{displayAddress}</span>
              <span className={`wallet-modal-chain ${isOnBaseChain ? 'ok' : 'wrong'}`}>
                {isOnBaseChain ? 'Base' : 'Wrong Chain'}
              </span>
            </div>
            <button type="button" className="wallet-modal-item" onClick={handleCopy}>
              <CopyIcon />
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
            {!isOnBaseChain && (
              <button type="button" className="wallet-modal-item wallet-modal-switch" onClick={handleSwitchChain}>
                Switch to Base
              </button>
            )}
            <button
              type="button"
              className="wallet-modal-item"
              onClick={handleLogout}
              disabled={!ready || !authenticated}
            >
              <DisconnectIcon />
              <span>Disconnect</span>
            </button>
          </>
        )}
        <a
          href={WORLD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="wallet-modal-item wallet-modal-link"
          onClick={onClose}
        >
          Enter World
        </a>
      </div>
    </>
  );

  return createPortal(modalContent, document.body);
}
