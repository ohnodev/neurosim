import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useNotification } from '../contexts/NotificationContext';
import { getApiBase } from '../lib/constants';
import { apiKeys } from '../lib/api';
import { parseWalletError } from '../../../shared/lib/parseWalletError';
import {
  CABAL_BUY_NEURO_URL,
  CLAIM_RECEIVER_ADDRESS,
  ERC20_TRANSFER_ABI,
  FLY_NEURO_AMOUNT_FALLBACK,
  formatNeuroAmount,
  NEURO_TOKEN_ADDRESS,
} from '../../../shared/lib/claimConstants';

const SUPPORT_MESSAGE = 'Please contact support via our Telegram channel for help.';

interface BuyFlyModalProps {
  isOpen: boolean;
  onClose: () => void;
  slotIndex: number;
  onSuccess: () => void;
}

export function BuyFlyModal({ isOpen, onClose, slotIndex, onSuccess }: BuyFlyModalProps) {
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { wallets } = useWallets();
  const { address, walletClient, chainId } = usePrivyWallet();
  const queryClient = useQueryClient();
  const notification = useNotification();
  const [busy, setBusy] = useState<'neuro' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen, onClose]);

  const isOnBaseChain = chainId === base.id;

  const transferAmount = FLY_NEURO_AMOUNT_FALLBACK;
  const displayAmountLabel = formatNeuroAmount(transferAmount.toString());

  const handleSwitchToBase = useCallback(async () => {
    if (!ready || !wallets.length) return;
    const wallet = address
      ? wallets.find((w) => w.address?.toLowerCase() === address.toLowerCase()) ?? wallets[0]
      : wallets[0];
    const w = wallet as { switchChain?: (chainId: number) => Promise<void> };
    if (!wallet || typeof w.switchChain !== 'function') return;
    try {
      await w.switchChain(base.id);
    } catch {
      setError('Failed to switch to Base. Please try again.');
    }
  }, [ready, wallets, address]);

  const handleBuyNeuro = useCallback(async () => {
    if (!walletClient || !address || !isOnBaseChain) return;
    setBusy('neuro');
    setError(null);
    try {
      const hash = await walletClient.writeContract({
        account: address,
        address: NEURO_TOKEN_ADDRESS,
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [CLAIM_RECEIVER_ADDRESS, transferAmount],
        chain: base,
      });
      notification.show('Transaction sent, pending...', 'info');
      const apiBase = getApiBase();
      const maxAttempts = 5;
      const baseDelay = 1000;
      const verify = async (attempt = 0): Promise<void> => {
        if (!mountedRef.current) return;
        notification.update('Verifying payment...', 'info');
        const res = await fetch(`${apiBase}/api/claim/verify-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: hash, userAddress: address.toLowerCase() }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          if (address) queryClient.invalidateQueries({ queryKey: apiKeys.myFlies(address) });
          onSuccess();
          notification.update('NeuroFly added!', 'success');
          setTimeout(() => notification.hide(), 2000);
          onClose();
          return;
        }
        const retryable = data.error === 'Transaction not found' || data.error === 'Verification failed';
        if (retryable && attempt < maxAttempts) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt), 8000);
          await new Promise((r) => setTimeout(r, delay));
          if (mountedRef.current) return verify(attempt + 1);
        }
        notification.update(SUPPORT_MESSAGE, 'error');
        setTimeout(() => notification.hide(), 5000);
        throw new Error(data.error ?? 'Verification failed');
      };
      await verify();
    } catch (err) {
      if (mountedRef.current) setError(parseWalletError(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [walletClient, address, isOnBaseChain, queryClient, notification, onSuccess, onClose, transferAmount]);

  if (!isOpen) return null;

  const neuroDisabled = false;

  const modalContent = !address ? (
    <div className="neurosim-claim-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="connect-wallet-title">
      <div className="neurosim-claim-modal" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="neurosim-claim__close" onClick={onClose} aria-label="Close">×</button>
          <div className="neurosim-claim__card">
            <h2 id="connect-wallet-title" className="neurosim-claim__title">Connect Wallet</h2>
            <p className="neurosim-claim__subtitle">Connect your wallet to buy a NeuroFly.</p>
            <button
              type="button"
              className="neurosim-claim__btn neurosim-claim__btn--primary"
              onClick={() => { (authenticated ? connectWallet : login)(); onClose(); }}
              disabled={!ready}
            >
              Connect Wallet
            </button>
          </div>
        </div>
      </div>
  ) : (
    <div className="neurosim-claim-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="buy-fly-title">
      <div className="neurosim-claim-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="neurosim-claim__close" onClick={onClose} aria-label="Close">×</button>
        <div className="neurosim-claim__card">
          <h2 id="buy-fly-title" className="neurosim-claim__title">Buy NeuroFly #{slotIndex + 1}</h2>
          <p className="neurosim-claim__subtitle">
            Pay with {displayAmountLabel} $NEURO to buy a fly
          </p>
          {error && (
            <div className="neuroflies__error">
              {error}
              {error.includes('Insufficient') && (
                <div style={{ marginTop: 8 }}>
                  <a href={CABAL_BUY_NEURO_URL} target="_blank" rel="noopener noreferrer" className="neurosim-claim__cabal-link">
                    Buy $NEURO on The Cabal
                  </a>
                </div>
              )}
            </div>
          )}
          {!isOnBaseChain && (
            <div className="neuroflies__error" style={{ marginBottom: 12 }}>
              Wrong network. Switch to Base to pay.
            </div>
          )}
          <div className="neurosim-claim__actions">
            {!isOnBaseChain ? (
              <button
                type="button"
                className="neurosim-claim__btn neurosim-claim__btn--primary"
                onClick={handleSwitchToBase}
              >
                Switch to Base
              </button>
            ) : (
              <button
                type="button"
                className="neurosim-claim__btn neurosim-claim__btn--primary"
                onClick={handleBuyNeuro}
                disabled={!!busy || !walletClient || !address || neuroDisabled}
              >
                {busy === 'neuro' ? 'Confirming...' : `Pay with ${displayAmountLabel} $NEURO`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
