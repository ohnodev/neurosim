/** ERC20 transfer ABI for $NEURO payments */
export const ERC20_TRANSFER_ABI = [
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

/** Link to buy $NEURO on The Cabal (shared by landing and world). */
export const CABAL_BUY_NEURO_URL = 'https://thecabal.app/base/0x73e0591f7b75cc4d82b415d34cd353683c896cbf';

/** Fallback: 10,000 $NEURO (18 decimals) to buy one fly. Prefer API config when available. */
export const FLY_NEURO_AMOUNT_FALLBACK = 10_000n * 10n ** 18n;

export function formatNeuroAmount(wei: string): string {
  const n = BigInt(wei);
  const one = 10n ** 18n;
  const whole = Number(n / one);
  if (whole >= 1000) return `${(whole / 1000).toFixed(whole % 1000 === 0 ? 0 : 1)}k`;
  return String(whole);
}
