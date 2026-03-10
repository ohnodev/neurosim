import { useState, useEffect } from 'react';
import { base } from 'viem/chains';
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

const CLAIM_AMOUNT = 1_000_000n * 10n ** 18n;

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

  useEffect(() => {
    fetch(`${getApiBase()}/api/claim/config`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: ClaimConfig | null) => d && setConfig(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isConnected || !address) {
      setEligibility({ method: null, loading: false });
      return;
    }
    setEligibility((e) => ({ ...e, loading: true }));
    fetch(`${getApiBase()}/api/claim/eligibility/${address.toLowerCase()}`)
      .then((r) => r.json())
      .then((d: { method?: EligibilityMethod }) => {
        setEligibility({ method: d.method ?? 'pay', loading: false });
      })
      .catch(() => {
        setEligibility({ method: 'pay', loading: false });
      });
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
    if (!config?.neuroTokenAddress || !config?.claimReceiverAddress ||
        config.neuroTokenAddress === '0x0000000000000000000000000000000000000000') {
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
        const res = await fetch(`${apiBase}/api/claim/verify-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash: hash,
            userAddress: address.toLowerCase(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return;
        if (data.error === 'Transaction not found' && attempt < 12) {
          await new Promise((r) => setTimeout(r, 3000));
          return verifyWithRetry(attempt + 1);
        }
        throw new Error(data.error ?? 'Verification failed');
      };
      await verifyWithRetry();
      setTxState('done');
      setClaimStatus('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
      setTxState('idle');
    }
  };

  return (
    <section className="claim-section">
      <h1 className="claim-title">NeuroSim</h1>
      <p className="claim-tagline">Claim your digital fly. One brain, infinite simulations.</p>

      {!isConnected ? (
        <p className="claim-hint">Connect your wallet to claim your fly.</p>
      ) : eligibility.loading ? (
        <p className="claim-hint">Checking eligibility...</p>
      ) : claimStatus === 'success' ? (
        <div className="claim-success">You claimed your fly. Welcome.</div>
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
                config.neuroTokenAddress === '0x0000000000000000000000000000000000000000'
              }
            >
              {txState === 'awaiting' && 'Confirm in wallet...'}
              {txState === 'confirming' && 'Confirming...'}
              {txState === 'done' && 'Claimed!'}
              {txState === 'idle' && 'Pay 1M $NEURO to Claim'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
