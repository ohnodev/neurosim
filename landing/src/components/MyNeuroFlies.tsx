import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base } from 'viem/chains';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useNotification } from '../contexts/NotificationContext';
import { getApiBase } from '../lib/constants';
import { fetchClaimConfig, fetchBalanceCheck } from '../lib/claimApi';
import { parseWalletError } from '../../../shared/lib/parseWalletError';
import { BuyFlyModal } from './BuyFlyModal';

const ERC20_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const NEURO_AMOUNT = 1_000_000n * 10n ** 18n;
const ETH_AMOUNT = 100000000000000n; // 0.0001 ETH

interface NeuroFly {
  id: string;
  method: 'obelisk' | 'pay';
  claimedAt: string;
}

const SUPPORT_MESSAGE = 'Please contact support via our Telegram channel for help.';

async function fetchMyFliesAndEligibility(address: string) {
  const apiBase = getApiBase();
  const addr = address.toLowerCase();
  const [fliesRes, eligRes] = await Promise.all([
    fetch(`${apiBase}/api/claim/my-flies?address=${addr}`).then((r) => r.json()),
    fetch(`${apiBase}/api/claim/eligibility/${addr}`).then((r) => r.json()),
  ]);
  const flies: NeuroFly[] = fliesRes.flies ?? [];
  const method = (eligRes.method as 'obelisk' | 'pay' | 'full') ?? 'pay';
  return { flies, method };
}

async function fetchFlyStats(address: string): Promise<{ stats: { slotIndex: number; feedCount: number }[] }> {
  const r = await fetch(`${getApiBase()}/api/rewards/stats?address=${address.toLowerCase()}`);
  if (!r.ok) return { stats: [] };
  const data = await r.json();
  return { stats: data.stats ?? [] };
}

export function MyNeuroFlies() {
  const { isConnected, address, walletClient } = usePrivyWallet();
  const queryClient = useQueryClient();
  const notification = useNotification();
  const [busy, setBusy] = useState<'obelisk' | 'neuro' | 'eth' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const { data: config } = useQuery({
    queryKey: ['claim-config'],
    queryFn: fetchClaimConfig,
    staleTime: 60_000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['my-flies', address ?? ''],
    queryFn: () => fetchMyFliesAndEligibility(address!),
    enabled: !!isConnected && !!address,
  });

  const flies = data?.flies ?? [];
  const eligibility = data
    ? { method: data.method, loading: false }
    : { method: 'pay' as const, loading: isLoading };
  const { data: flyStatsData } = useQuery({
    queryKey: ['fly-stats', address ?? ''],
    queryFn: () => fetchFlyStats(address!),
    enabled: !!address,
  });
  const statsBySlot = useMemo(() => {
    const m: Record<number, number> = {};
    for (const s of flyStatsData?.stats ?? []) m[s.slotIndex] = s.feedCount;
    return m;
  }, [flyStatsData?.stats]);

  // Slot user is buying for; API assigns next available slot (same as clicked empty slot)
  const [buyFlySlot, setBuyFlySlot] = useState<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const invalidateMyFlies = () => {
    if (address) {
      queryClient.invalidateQueries({ queryKey: ['my-flies', address] });
      queryClient.invalidateQueries({ queryKey: ['fly-stats', address] });
    }
  };

  const handleClaimFree = async () => {
    if (!address) {
      const msg = 'Address missing';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    setBusy('obelisk');
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/claim/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Claim failed');
      invalidateMyFlies();
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Claim failed');
      throw err;
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const handleBuyEth = async () => {
    if (!walletClient) {
      const msg = 'Wallet client missing';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    if (!address) {
      const msg = 'Address missing';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    if (!config?.flyEthReceiver) {
      const msg = 'Fly ETH receiver config missing';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    setBusy('eth');
    setError(null);
    let submittedHash: string | null = null;
    try {
      const bal = await fetchBalanceCheck(address);
      if (bal && BigInt(bal.ethBalanceWei) < BigInt(bal.flyEthRequiredWithGasWei)) {
        const msg = 'Insufficient ETH. Add more ETH to your wallet to complete this purchase.';
        if (mountedRef.current) setError(msg);
        throw new Error(msg);
      }
      submittedHash = await walletClient.sendTransaction({
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
        notification.update('Verifying payment...', 'info');
        const res = await fetch(`${apiBase}/api/claim/verify-eth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: submittedHash, userAddress: address.toLowerCase() }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          invalidateMyFlies();
          notification.update('NeuroFly added!', 'success');
          setTimeout(() => notification.hide(), 2000);
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
      if (submittedHash) {
        const e = new Error(SUPPORT_MESSAGE) as Error & { txSentNonRetryable?: boolean; submittedTxHash?: string };
        e.txSentNonRetryable = true;
        e.submittedTxHash = submittedHash;
        throw e;
      }
      if (mountedRef.current) setError(parseWalletError(err));
      throw err;
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const handleBuyNeuro = async () => {
    if (!walletClient) {
      const msg = 'Wallet client missing';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    if (!address) {
      const msg = 'Address missing';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    if (!config?.neuroTokenAddress || !config?.claimReceiverAddress) {
      const msg = 'Claim receiver config missing';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    const zero = '0x0000000000000000000000000000000000000000';
    if (config.neuroTokenAddress === zero || config.claimReceiverAddress === zero) {
      const msg = 'Claim not configured';
      if (mountedRef.current) setError(msg);
      throw new Error(msg);
    }
    setBusy('neuro');
    setError(null);
    let submittedHash: string | null = null;
    try {
      const bal = await fetchBalanceCheck(address);
      if (bal) {
        if (BigInt(bal.neuroBalanceWei) < BigInt(bal.flyNeuroRequiredWei)) {
          const msg = 'Insufficient $NEURO. You need 1M $NEURO to buy a fly.';
          if (mountedRef.current) setError(msg);
          throw new Error(msg);
        }
        const minGasWei = BigInt(bal.flyNeuroEthRequiredWithGasWei);
        if (minGasWei > 0n && BigInt(bal.ethBalanceWei) < minGasWei) {
          const msg = 'Insufficient ETH for gas. Add more ETH to your wallet to complete this purchase.';
          if (mountedRef.current) setError(msg);
          throw new Error(msg);
        }
      }
      submittedHash = await walletClient.writeContract({
        account: address,
        address: config.neuroTokenAddress,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [config.claimReceiverAddress, NEURO_AMOUNT],
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
          body: JSON.stringify({ txHash: submittedHash, userAddress: address.toLowerCase() }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          invalidateMyFlies();
          notification.update('NeuroFly added!', 'success');
          setTimeout(() => notification.hide(), 2000);
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
      if (submittedHash) {
        const e = new Error(SUPPORT_MESSAGE) as Error & { txSentNonRetryable?: boolean; submittedTxHash?: string };
        e.txSentNonRetryable = true;
        e.submittedTxHash = submittedHash;
        throw e;
      }
      if (mountedRef.current) setError(parseWalletError(err));
      throw err;
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const slots = [0, 1, 2];

  return (
    <div className="neuroflies">
      <h3 className="neuroflies__title">My NeuroFlies</h3>
      <div className="neuroflies__slots">
        {slots.map((i) => {
          const hasFly = !!flies[i];
          const isEmpty = flies.length === 0 && i === 0;
          return (
            <div key={i} className="neuroflies__slot">
              {hasFly ? (
                <div className="neuroflies__slot-filled">
                  <img src="/fly.svg" alt="" width={28} height={28} className="neuroflies__fly-icon-img" aria-hidden />
                  <span className="neuroflies__fly-slot-label" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                    Fly {i + 1}
                    <span className="neuroflies__fly-pts">{statsBySlot[i] ?? 0} pts</span>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className={`neuroflies__slot-empty ${isEmpty ? 'neuroflies__slot-empty--first' : ''}`}
                  onClick={() => {
                    if (!isConnected) {
                      notification.show('Connect your wallet first', 'info');
                      return;
                    }
                    setBuyFlySlot(i);
                  }}
                >
                  <img src="/fly.svg" alt="" width={28} height={28} className="neuroflies__fly-icon-img" aria-hidden />
                  <span className="neuroflies__fly-slot-label">
                    {isEmpty ? 'You have no flies' : `Fly ${i + 1}`}
                  </span>
                  <span className="neuroflies__fly-slot-buy">{isEmpty ? 'Buy your first fly' : 'Buy Fly'}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {error && <div className="neuroflies__error">{error}</div>}

      <BuyFlyModal
        isOpen={buyFlySlot !== null}
        onClose={() => setBuyFlySlot(null)}
        slotIndex={buyFlySlot ?? 0}
        onSuccess={invalidateMyFlies}
        eligibility={eligibility}
        onClaimFree={handleClaimFree}
        onBuyEth={handleBuyEth}
        onBuyNeuro={handleBuyNeuro}
        busy={busy}
      />
    </div>
  );
}
