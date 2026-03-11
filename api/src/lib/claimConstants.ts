/** ERC20 transfer ABI - single source for API (matches shared/lib/claimConstants) */
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
