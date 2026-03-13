import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const RPC_URL = process.env.BASE_RPC_URL?.trim() || '';
if (!RPC_URL && process.env.NODE_ENV === 'production') {
  throw new Error('BASE_RPC_URL is required for claim verification in production. Set it in your environment.');
}
const rpcUrl = RPC_URL || 'https://mainnet.base.org';

export const baseRpcClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl, {
    timeout: 30_000,
    retryCount: 5,
    retryDelay: 500,
  }),
});
