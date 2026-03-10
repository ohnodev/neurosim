import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePrivy } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useNotification } from '../contexts/NotificationContext';
import { getApiBase } from '../lib/constants';

const ETH_AMOUNT = 100000000000000n; // 0.0001 ETH
const SUPPORT_MESSAGE = 'Please contact support via our Telegram channel for help.';

interface ClaimConfig {
  neuroTokenAddress: `0x${string}`;
  claimReceiverAddress: `0x${string}`;
  flyEthReceiver: `0x${string}`;
}

async function fetchConfig(): Promise<ClaimConfig> {
  const r = await fetch(`${getApiBase()}/api/claim/config`);
  if (!r.ok) {
    throw new Error(`Claim config failed: ${r.status} ${r.statusText}`);
  }
  try {
    return (await r.json()) as ClaimConfig;
  } catch (e) {
    throw new Error('Failed to parse claim config');
  }
}

interface BuyFlyModalProps {
  isOpen: boolean;
  onClose: () => void;
  slotIndex: number;
  onSuccess: () => void;
}

export function BuyFlyModal({ isOpen, onClose, slotIndex, onSuccess }: BuyFlyModalProps) {
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { address, walletClient } = usePrivyWallet();
  const queryClient = useQueryClient();
  const notification = useNotification();
  const [busy, setBusy] = useState<'eth' | 'neuro' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const { data: config } = useQuery({
    queryKey: ['claim-config'],
    queryFn: fetchConfig,
    staleTime: 60_000,
    enabled: isOpen,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const handleBuyEth = async () => {
    if (!walletClient || !address || !config?.flyEthReceiver) return;
    setBusy('eth');
    setError(null);
    try {
      const hash = await walletClient.sendTransaction({
        account: address,
        to: config.flyEthReceiver,
        value: ETH_AMOUNT,
        chain: base,
      });
      notification.show('Transaction sent, pending...', 'info');
      const apiBase = getApiBase();
      const maxAttempts = 5;
      const baseDelay = 1000;
      const verify = async (attempt = 0): Promise<void> => {
        if (!mountedRef.current) return;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, Math.min(baseDelay, 8000)));
          if (!mountedRef.current) return;
        }
        notification.update('Verifying payment...', 'info');
        const res = await fetch(`${apiBase}/api/claim/verify-eth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: hash, userAddress: address.toLowerCase() }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          if (address) queryClient.invalidateQueries({ queryKey: ['my-flies', address] });
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
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const handleBuyNeuro = () => {
    notification.show('$NEURO payment coming soon. Use ETH for now.', 'info');
  };

  if (!isOpen) return null;

  const neuroDisabled = !config?.neuroTokenAddress || config.neuroTokenAddress === '0x0000000000000000000000000000000000000000';

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
          <h2 id="buy-fly-title" className="neurosim-claim__title">Buy Fly #{slotIndex + 1}</h2>
          <p className="neurosim-claim__subtitle">Choose payment method</p>
          {error && <div className="neuroflies__error">{error}</div>}
          <div className="neurosim-claim__actions">
            <button
              type="button"
              className="neurosim-claim__btn neurosim-claim__btn--primary"
              onClick={handleBuyEth}
              disabled={!!busy || !walletClient || !address || !config?.flyEthReceiver}
            >
              {busy === 'eth' ? 'Confirming...' : 'Pay with 0.0001 ETH'}
            </button>
            <button
              type="button"
              className="neurosim-claim__btn neurosim-claim__btn--secondary"
              onClick={handleBuyNeuro}
              disabled={!!busy || neuroDisabled}
            >
              {busy === 'neuro' ? 'Confirming...' : 'Pay with $NEURO (coming soon)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
