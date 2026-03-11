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

// Receiver for ETH payment (0.0001 ETH) - NEUROSIM wallet (receives fly payments + distributes rewards)
export const FLY_ETH_RECEIVER = '0x4ca3bd0Db772A015FA7099f1b8490FcF0832c121' as `0x${string}`;

export const FLY_ETH_AMOUNT = 100000000000000n; // 0.0001 ETH in wei

// CabalTokenDistributor on Base mainnet - batch ETH distribution
export const CABAL_TOKEN_DISTRIBUTOR =
  '0x96E4Db2C7978e7104460F062dcDb66cA00ebCcD0' as `0x${string}`;
