/**
 * ERC20 transfer ABI for API use. Duplicated from shared/lib/claimConstants so the API
 * remains deployable without depending on the frontend shared package.
 */
export const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { internalType: 'address' as const, name: 'to', type: 'address' as const },
      { internalType: 'uint256' as const, name: 'amount', type: 'uint256' as const },
    ],
    name: 'transfer',
    outputs: [{ internalType: 'bool' as const, name: '', type: 'bool' as const }],
    stateMutability: 'nonpayable' as const,
    type: 'function' as const,
  },
] as const;
