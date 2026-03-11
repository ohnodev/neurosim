import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { fetchClaimConfig } from '../lib/claimApi';
import { parseWalletError } from '../../../shared/lib/parseWalletError';

interface BuyFlyModalProps {
  isOpen: boolean;
  onClose: () => void;
  slotIndex: number;
  onSuccess: () => void;
  eligibility: { method: 'obelisk' | 'pay' | 'full'; loading: boolean };
  onClaimFree: () => Promise<void>;
  onBuyNeuro: () => Promise<void>;
  busy: 'obelisk' | 'neuro' | null;
}

export function BuyFlyModal({
  isOpen,
  onClose,
  slotIndex,
  onSuccess,
  eligibility,
  onClaimFree,
  onBuyNeuro,
  busy,
}: BuyFlyModalProps) {
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { wallets } = useWallets();
  const { address, walletClient, chainId } = usePrivyWallet();
  const mountedRef = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [txSentNonRetryable, setTxSentNonRetryable] = useState(false);
  const [submittedTxHash, setSubmittedTxHash] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ['claim-config'],
    queryFn: fetchClaimConfig,
    staleTime: 60_000,
    enabled: isOpen,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setTxSentNonRetryable(false);
      setSubmittedTxHash(null);
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const isOnBaseChain = chainId === base.id;

  const handleSwitchToBase = async () => {
    if (!ready || !wallets.length) return;
    const wallet = address
      ? wallets.find((w) => w.address?.toLowerCase() === address.toLowerCase()) ?? wallets[0]
      : wallets[0];
    const w = wallet as { switchChain?: (chainId: number) => Promise<void> };
    if (!wallet || typeof w.switchChain !== 'function') return;
    try {
      await w.switchChain(base.id);
    } catch {
      if (mountedRef.current) setError('Failed to switch to Base. Please try again.');
    }
  };

  const handleClaimFree = async () => {
    setError(null);
    try {
      await onClaimFree();
      onSuccess();
      onClose();
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Claim failed');
    }
  };

  const handleBuyNeuro = async () => {
    setError(null);
    setTxSentNonRetryable(false);
    setSubmittedTxHash(null);
    try {
      await onBuyNeuro();
      onSuccess();
      onClose();
    } catch (err) {
      const e = err as { txSentNonRetryable?: boolean; submittedTxHash?: string };
      if (e?.txSentNonRetryable && e?.submittedTxHash && mountedRef.current) {
        setTxSentNonRetryable(true);
        setSubmittedTxHash(e.submittedTxHash);
        setError(null);
      } else if (mountedRef.current) {
        setError(parseWalletError(err));
      }
    }
  };

  if (!isOpen) return null;

  const ZERO = '0x0000000000000000000000000000000000000000';
  const neuroDisabled =
    !config?.neuroTokenAddress ||
    config.neuroTokenAddress === ZERO ||
    !config?.claimReceiverAddress ||
    config.claimReceiverAddress === ZERO;

  const modalContent = !address ? (
    <div
      className="neurosim-claim-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-wallet-title"
    >
      <div className="neurosim-claim-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="neurosim-claim__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="neurosim-claim__card">
          <h2 id="connect-wallet-title" className="neurosim-claim__title">
            Connect Wallet
          </h2>
          <p className="neurosim-claim__subtitle">Connect your wallet to buy a NeuroFly.</p>
          <button
            type="button"
            className="neurosim-claim__btn neurosim-claim__btn--primary"
            onClick={() => {
              (authenticated ? connectWallet : login)();
              onClose();
            }}
            disabled={!ready}
          >
            Connect Wallet
          </button>
        </div>
      </div>
    </div>
  ) : (
    <div
      className="neurosim-claim-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="buy-fly-title"
    >
      <div className="neurosim-claim-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="neurosim-claim__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="neurosim-claim__card">
          <h2 id="buy-fly-title" className="neurosim-claim__title">
            Buy NeuroFly #{slotIndex + 1}
          </h2>
          <p className="neurosim-claim__subtitle">Pay with 10k $NEURO to buy a fly</p>
          {txSentNonRetryable && (
            <div className="neuroflies__error">
              Transaction sent. Do not retry. Please contact support via our Telegram channel for help.
              {submittedTxHash && (
                <span style={{ display: 'block', fontSize: 10, marginTop: 4, wordBreak: 'break-all' }}>
                  Tx: {submittedTxHash}
                </span>
              )}
            </div>
          )}
          {error && !txSentNonRetryable && <div className="neuroflies__error">{error}</div>}
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
              <>
                {eligibility.method === 'obelisk' && (
                  <button
                    type="button"
                    className="neurosim-claim__btn neurosim-claim__btn--primary"
                    onClick={handleClaimFree}
                    disabled={!!busy || !!txSentNonRetryable || eligibility.loading}
                  >
                    {busy === 'obelisk' ? 'Claiming...' : 'Claim free (Obelisk)'}
                  </button>
                )}
                <button
                  type="button"
                  className="neurosim-claim__btn neurosim-claim__btn--primary"
                  onClick={handleBuyNeuro}
                  disabled={!!busy || !!txSentNonRetryable || !walletClient || !address || neuroDisabled}
                >
                  {busy === 'neuro' ? 'Confirming...' : 'Pay with 10k $NEURO'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
