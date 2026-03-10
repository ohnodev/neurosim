// Obelisk NFT on Base mainnet - holders get 1 free fly claim
export const OBELISK_NFT_ADDRESS =
  (process.env.OBELISK_NFT_ADDRESS as `0x${string}`) ||
  ('0x5e2C23B61e9Da60512DAb98AA8f3e31950297e99' as `0x${string}`);

// $NEURO token - 1M tokens required for paid claim
export const NEURO_TOKEN_ADDRESS =
  (process.env.NEURO_TOKEN_ADDRESS as `0x${string}`) ||
  ('0x0000000000000000000000000000000000000000' as `0x${string}`);

// Receiver address for token payment (deploy later)
export const CLAIM_RECEIVER_ADDRESS =
  (process.env.CLAIM_RECEIVER_ADDRESS as `0x${string}`) ||
  ('0x0000000000000000000000000000000000000000' as `0x${string}`);
