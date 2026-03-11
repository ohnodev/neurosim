import { useState, useEffect, useRef } from 'react';
import { base } from 'viem/chains';
import { ClaimFlyModal } from './ClaimFlyModal';
import { usePrivyWallet } from '../lib/usePrivyWallet';
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

const CLAIM_AMOUNT = 10_000n * 10n ** 18n;

type EligibilityMethod = 'obelisk' | 'pay' | 'already_claimed' | null;

interface ClaimConfig {
  neuroTokenAddress: `0x${string}`;
  claimReceiverAddress: `0x${string}`;
}

export function ClaimFlySection() {
  const { isConnected, address, walletClient } = usePrivyWallet();
  const [config, setConfig] = useState<ClaimConfig | null>(null);
  const [eligibility, setEligibility] = useState<{
    method: EligibilityMethod;
    loading: boolean;
  }>({ method: null, loading: false });
  const [claimStatus, setClaimStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [txState, setTxState] = useState<'idle' | 'awaiting' | 'confirming' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSeed, setModalSeed] = useState(() => Date.now());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    fetch(`${getApiBase()}/api/claim/config`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: ClaimConfig | null) => d && setConfig(d))
      .catch((err) => {
        console.error('Failed to fetch claim config:', err);
      });
  }, []);

  useEffect(() => {
    if (!isConnected || !address) {
      setEligibility({ method: null, loading: false });
      return;
    }
    const ctrl = new AbortController();
    const reqAddr = address.toLowerCase();
    setEligibility((e) => ({ ...e, loading: true }));
    fetch(`${getApiBase()}/api/claim/eligibility/${reqAddr}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: { method?: EligibilityMethod }) => {
        if (address?.toLowerCase() !== reqAddr) return;
        setEligibility({ method: d.method ?? 'pay', loading: false });
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        if (address?.toLowerCase() !== reqAddr) return;
        setEligibility({ method: 'pay', loading: false });
      });
    return () => ctrl.abort();
  }, [isConnected, address]);

  const handleClaimFree = async () => {
    if (!address) return;
    setClaimStatus('pending');
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/claim/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Claim failed');
      setClaimStatus('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claim failed');
      setClaimStatus('error');
    }
  };

  const handlePayAndClaim = async () => {
    if (!walletClient || !address) {
      setError('Wallet not ready');
      return;
    }
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    if (!config?.neuroTokenAddress || !config?.claimReceiverAddress ||
        config.neuroTokenAddress === zeroAddr || config.claimReceiverAddress === zeroAddr) {
      setError('Claim not configured');
      return;
    }
    setTxState('awaiting');
    setError(null);
    try {
      const hash = await walletClient.writeContract({
        account: address,
        address: config.neuroTokenAddress,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [config.claimReceiverAddress, CLAIM_AMOUNT],
        chain: base,
      });
      setTxState('confirming');
      const apiBase = getApiBase();
      const verifyWithRetry = async (attempt = 0): Promise<void> => {
        if (!mountedRef.current) return;
        const res = await fetch(`${apiBase}/api/claim/verify-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash: hash,
            userAddress: address.toLowerCase(),
          }),
        });
        if (!mountedRef.current) return;
        const data = await res.json().catch(() => ({}));
        if (res.ok) return;
        if (data.error === 'Transaction not found' && attempt < 12) {
          await new Promise((r) => setTimeout(r, 3000));
          if (mountedRef.current) return verifyWithRetry(attempt + 1);
          return;
        }
        throw new Error(data.error ?? 'Verification failed');
      };
      await verifyWithRetry();
      if (!mountedRef.current) return;
      setTxState('done');
      setClaimStatus('success');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Transaction failed');
      setTxState('idle');
      setClaimStatus('error');
    }
  };

  return (
    <div className="claim-section">
      <h2 className="section__title">Claim your fly</h2>
      <ClaimFlyModal open={modalOpen} onClose={() => setModalOpen(false)} seed={modalSeed} />
      {!isConnected ? (
        <>
          <p className="claim-hint">Connect your wallet to claim your fly.</p>
          <button className="claim-btn claim-btn-primary" onClick={() => { setModalSeed(Date.now()); setModalOpen(true); }}>
            Claim your fly
          </button>
        </>
      ) : eligibility.loading ? (
        <p className="claim-hint">Checking eligibility...</p>
      ) : claimStatus === 'success' ? (
        <>
          <div className="claim-success">You claimed your fly. Welcome.</div>
          <button className="claim-btn" onClick={() => { setModalSeed(Date.now()); setModalOpen(true); }}>
            View your fly
          </button>
        </>
      ) : (
        <>
          {error && <div className="claim-error">{error}</div>}
          {eligibility.method === 'already_claimed' && (
            <p className="claim-hint">You have already claimed your fly.</p>
          )}
          {eligibility.method === 'obelisk' && (
            <button
              className="claim-btn claim-btn-primary"
              onClick={handleClaimFree}
              disabled={claimStatus === 'pending'}
            >
              {claimStatus === 'pending' ? 'Claiming...' : 'Claim Free (Obelisk Holder)'}
            </button>
          )}
          {eligibility.method === 'pay' && (
            <button
              className="claim-btn claim-btn-primary"
              onClick={handlePayAndClaim}
              disabled={
                txState !== 'idle' ||
                !config?.neuroTokenAddress ||
                !config?.claimReceiverAddress ||
                config.neuroTokenAddress === '0x0000000000000000000000000000000000000000' ||
                config.claimReceiverAddress === '0x0000000000000000000000000000000000000000'
              }
            >
              {txState === 'awaiting' && 'Confirm in wallet...'}
              {txState === 'confirming' && 'Confirming...'}
              {txState === 'done' && 'Claimed!'}
              {txState === 'idle' && 'Pay 10k $NEURO to Claim'}
            </button>
          )}
          <button className="claim-btn" onClick={() => { setModalSeed(Date.now()); setModalOpen(true); }} style={{ marginTop: 8 }}>
            Preview claim
          </button>
        </>
      )}
    </div>
  );
}
