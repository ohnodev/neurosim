// Obelisk NFT on Base mainnet - holders get 1 free fly claim
export const OBELISK_NFT_ADDRESS =
  (process.env.OBELISK_NFT_ADDRESS as `0x${string}`) ||
  ('0x5e2C23B61e9Da60512DAb98AA8f3e31950297e99' as `0x${string}`);

// $NEURO token
export const NEURO_TOKEN_ADDRESS =
  (process.env.NEURO_TOKEN_ADDRESS as `0x${string}`) ||
  ('0x73e0591f7b75cc4D82B415d34Cd353683C896cbf' as `0x${string}`);

// Receiver for token payment - NEUROSIM wallet (receives fly payments + distributes rewards)
export const CLAIM_RECEIVER_ADDRESS =
  (process.env.CLAIM_RECEIVER_ADDRESS as `0x${string}`) ||
  ('0x4ca3bd0Db772A015FA7099f1b8490FcF0832c121' as `0x${string}`);

/** 10,000 $NEURO (18 decimals) to buy one fly */
export const FLY_NEURO_AMOUNT = 10_000n * 10n ** 18n;

