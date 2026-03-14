import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useNotification } from '../contexts/NotificationContext';
import { getApiBase } from '../lib/constants';
import { apiKeys, type ClaimedFly } from '../lib/api';
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

interface BalanceCheck {
  neuroBalanceWei?: string;
  flyNeuroRequiredWei?: string;
}

interface VerifyPaymentSuccess {
  success: boolean;
  fly?: ClaimedFly;
}

function parseNonNegativeWei(raw: string | undefined): bigint | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  try {
    const n = BigInt(s);
    return n >= 0n ? n : null;
  } catch {
    return null;
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
  const { wallets } = useWallets();
  const { address, walletClient, chainId } = usePrivyWallet();
  const queryClient = useQueryClient();
  const notification = useNotification();
  const [busy, setBusy] = useState<'neuro' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverRequiredAmountWei, setServerRequiredAmountWei] = useState<bigint | null>(null);
  const mountedRef = useRef(true);
  const isOpenRef = useRef(false);

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

  useEffect(() => {
    isOpenRef.current = isOpen;
    if (!isOpen) setServerRequiredAmountWei(null);
    return () => {
      isOpenRef.current = false;
    };
  }, [isOpen]);

  const isOnBaseChain = chainId === base.id;

  const transferAmountWei = serverRequiredAmountWei ?? FLY_NEURO_AMOUNT_FALLBACK;
  const formattedTransferAmount = formatNeuroAmount(transferAmountWei.toString());

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
    const canUpdateState = () => mountedRef.current && isOpenRef.current;
    setBusy('neuro');
    setError(null);
    try {
      const balanceRes = await fetch(`${getApiBase()}/api/claim/balance-check?address=${address.toLowerCase()}`);
      const balanceData: BalanceCheck = balanceRes.ok
        ? await balanceRes.json().catch(() => ({} as BalanceCheck))
        : {};
      const parsedRequiredAmount = parseNonNegativeWei(balanceData.flyNeuroRequiredWei);
      const serverRequiredAmount =
        parsedRequiredAmount != null && parsedRequiredAmount > 0n ? parsedRequiredAmount : null;
      if (canUpdateState()) setServerRequiredAmountWei(serverRequiredAmount);
      if (!canUpdateState()) return;
      const resolvedTransferAmount = serverRequiredAmount ?? FLY_NEURO_AMOUNT_FALLBACK;
      const balanceWei = parseNonNegativeWei(balanceData.neuroBalanceWei);
      if (balanceWei != null && balanceWei < resolvedTransferAmount) {
        if (canUpdateState()) {
          setError(`Insufficient $NEURO. You need ${formatNeuroAmount(resolvedTransferAmount.toString())} $NEURO to buy a fly.`);
        }
        return;
      }

      const hash = await walletClient.writeContract({
        account: address,
        address: NEURO_TOKEN_ADDRESS,
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [CLAIM_RECEIVER_ADDRESS, resolvedTransferAmount],
        chain: base,
      });
      notification.show('Transaction sent, pending...', 'info');
      const apiBase = getApiBase();
      const maxAttempts = 5;
      const baseDelay = 1000;
      const verify = async (attempt = 0): Promise<void> => {
        if (!canUpdateState()) return;
        notification.update('Verifying payment...', 'info');
        const res = await fetch(`${apiBase}/api/claim/verify-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: hash, userAddress: address.toLowerCase() }),
        });
        if (!canUpdateState()) return;
        const data = await res.json().catch(() => ({} as { success?: boolean; error?: string; fly?: unknown }));
        if (res.ok && data.success === true) {
          if (address) {
            queryClient.setQueryData(
              apiKeys.myFlies(address),
              (current: unknown): Array<ClaimedFly | null> => {
                const next = Array.isArray(current)
                  ? [...current]
                  : [null, null, null];
                while (next.length < 3) next.push(null);
                const isValidSlotIndex = Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < 3;
                const fly = (data as VerifyPaymentSuccess).fly;
                if (
                  isValidSlotIndex &&
                  fly &&
                  typeof fly.id === 'string' &&
                  typeof fly.method === 'string' &&
                  typeof fly.claimedAt === 'string'
                ) {
                  next[slotIndex] = fly;
                } else if (isValidSlotIndex && next[slotIndex] == null) {
                  next[slotIndex] = {
                    id: `pending-${Date.now()}`,
                    method: 'pay',
                    claimedAt: new Date().toISOString(),
                  };
                }
                return next.slice(0, 3);
              }
            );
            queryClient.setQueryData(
              apiKeys.myDeployed(address),
              (current: unknown) => {
                if (current && typeof current === 'object') {
                  const c = current as { deployed?: Record<number, number>; graveyardSlots?: number[] };
                  const isValidSlotIndex = Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < 3;
                  const nextDeployed = c.deployed && typeof c.deployed === 'object'
                    ? { ...c.deployed }
                    : {};
                  if (isValidSlotIndex) {
                    delete nextDeployed[slotIndex];
                  }
                  const nextGraveyard = Array.isArray(c.graveyardSlots)
                    ? c.graveyardSlots.filter((s) => s !== slotIndex)
                    : [];
                  return { ...c, deployed: nextDeployed, graveyardSlots: nextGraveyard };
                }
                return { deployed: {}, graveyardSlots: [] };
              }
            );
            queryClient.invalidateQueries({ queryKey: apiKeys.myFlies(address) });
            queryClient.invalidateQueries({ queryKey: apiKeys.myDeployed(address) });
            queryClient.invalidateQueries({ queryKey: apiKeys.flyStats(address) });
            queryClient.invalidateQueries({ queryKey: apiKeys.graveyard(address) });
          }
          onSuccess();
          if (!canUpdateState()) return;
          notification.update('NeuroFly added!', 'success');
          setTimeout(() => notification.hide(), 2000);
          onClose();
          return;
        }
        const errorMessage = typeof data.error === 'string'
          ? data.error
          : (res.ok && data.success !== true ? 'Verification failed' : undefined);
        const retryable = errorMessage === 'Transaction not found' || errorMessage === 'Verification failed';
        if (retryable && attempt < maxAttempts) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt), 8000);
          await new Promise((r) => setTimeout(r, delay));
          if (canUpdateState()) return verify(attempt + 1);
          return;
        }
        if (!canUpdateState()) return;
        notification.update(SUPPORT_MESSAGE, 'error');
        setTimeout(() => notification.hide(), 5000);
        throw new Error(errorMessage ?? 'Verification failed');
      };
      await verify();
    } catch (err) {
      if (canUpdateState()) setError(parseWalletError(err));
    } finally {
      if (canUpdateState()) setBusy(null);
    }
  }, [walletClient, address, isOnBaseChain, queryClient, notification, onSuccess, onClose, slotIndex]);

  if (!isOpen) return null;

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
            Pay with {formattedTransferAmount} $NEURO to buy a fly
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
                disabled={!!busy || !walletClient || !address}
              >
                {busy === 'neuro' ? 'Confirming...' : `Pay with ${formattedTransferAmount} $NEURO`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
