import { getApiBase } from './constants';

export { formatNeuroAmount } from '../../../shared/lib/claimConstants';

export interface ClaimConfig {
  neuroTokenAddress: `0x${string}`;
  claimReceiverAddress: `0x${string}`;
  flyNeuroAmountWei?: string;
}


export async function fetchClaimConfig(): Promise<ClaimConfig | null> {
  const r = await fetch(`${getApiBase()}/api/claim/config`);
  if (!r.ok) return null;
  return r.json();
}

export interface BalanceCheck {
  ethBalanceWei: string;
  neuroBalanceWei: string;
  flyNeuroRequiredWei: string;
}

export async function fetchBalanceCheck(address: string): Promise<BalanceCheck | null> {
  const r = await fetch(`${getApiBase()}/api/claim/balance-check?address=${address.toLowerCase()}`);
  if (!r.ok) return null;
  return r.json();
}
