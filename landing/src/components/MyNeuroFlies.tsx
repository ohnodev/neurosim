import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base } from 'viem/chains';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import { useNotification } from '../contexts/NotificationContext';
import { getApiBase } from '../lib/constants';

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

interface ClaimConfig {
  neuroTokenAddress: `0x${string}`;
  claimReceiverAddress: `0x${string}`;
  flyEthReceiver: `0x${string}`;
}

const SUPPORT_MESSAGE = 'Please contact support via our Telegram channel for help.';

async function fetchConfig(): Promise<ClaimConfig | null> {
  const r = await fetch(`${getApiBase()}/api/claim/config`);
  if (!r.ok) return null;
  return r.json();
}

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

export function MyNeuroFlies() {
  const { isConnected, address, walletClient } = usePrivyWallet();
  const queryClient = useQueryClient();
  const notification = useNotification();
  const [busy, setBusy] = useState<'obelisk' | 'neuro' | 'eth' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const { data: config } = useQuery({
    queryKey: ['claim-config'],
    queryFn: fetchConfig,
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
  const full = eligibility.method === 'full' || flies.length >= 3;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const invalidateMyFlies = () => {
    if (address) queryClient.invalidateQueries({ queryKey: ['my-flies', address] });
  };

  const handleClaimFree = async () => {
    if (!address) return;
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
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

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
        notification.update('Verifying payment...', 'info');
        const res = await fetch(`${apiBase}/api/claim/verify-eth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: hash, userAddress: address.toLowerCase() }),
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
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const handleBuyNeuro = async () => {
    if (!walletClient || !address || !config?.neuroTokenAddress || !config?.claimReceiverAddress) return;
    const zero = '0x0000000000000000000000000000000000000000';
    if (config.neuroTokenAddress === zero || config.claimReceiverAddress === zero) {
      setError('Claim not configured');
      return;
    }
    setBusy('neuro');
    setError(null);
    try {
      const hash = await walletClient.writeContract({
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
          body: JSON.stringify({ txHash: hash, userAddress: address.toLowerCase() }),
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
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const slots = [0, 1, 2];

  return (
    <div className="neuroflies">
      <h3 className="neuroflies__title">My NeuroFlies</h3>
      <div className="neuroflies__slots">
        {slots.map((i) => (
          <div
            key={i}
            className={`neuroflies__slot ${flies[i] ? 'neuroflies__slot--filled' : 'neuroflies__slot--empty'}`}
          >
            {flies[i] ? (
              <div className="neuroflies__fly">
                <div className="neuroflies__fly-icon" />
                <span className="neuroflies__fly-label">#{i + 1}</span>
              </div>
            ) : (
              <span className="neuroflies__slot-placeholder">—</span>
            )}
          </div>
        ))}
      </div>

      {error && <div className="neuroflies__error">{error}</div>}

      {!isConnected ? (
        <p className="neuroflies__hint">Connect wallet to claim or buy NeuroFlies.</p>
      ) : eligibility.loading ? (
        <p className="neuroflies__hint">Loading...</p>
      ) : full ? (
        <p className="neuroflies__hint">You have 3 NeuroFlies.</p>
      ) : (
        <div className="neuroflies__actions">
          {eligibility.method === 'obelisk' && (
            <button
              className="neuroflies__btn neuroflies__btn--primary"
              onClick={handleClaimFree}
              disabled={!!busy}
            >
              {busy === 'obelisk' ? 'Claiming...' : 'Claim free (Obelisk)'}
            </button>
          )}
          <button
            className="neuroflies__btn"
            onClick={handleBuyEth}
            disabled={!!busy || !config?.flyEthReceiver}
          >
            {busy === 'eth' ? 'Confirming...' : 'Buy with 0.0001 ETH'}
          </button>
          <button
            className="neuroflies__btn"
            onClick={handleBuyNeuro}
            disabled={
              !!busy ||
              !config?.neuroTokenAddress ||
              !config?.claimReceiverAddress ||
              config.neuroTokenAddress === '0x0000000000000000000000000000000000000000'
            }
          >
            {busy === 'neuro' ? 'Confirming...' : 'Buy with 1M $NEURO'}
          </button>
        </div>
      )}
    </div>
  );
}
