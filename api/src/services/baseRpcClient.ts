import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

export const baseRpcClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});
