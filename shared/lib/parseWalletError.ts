/**
 * Parse wallet/transaction errors into user-friendly messages.
 * Handles user rejection (MetaMask "Reject"), insufficient balance, etc.
 */
export function parseWalletError(err: unknown): string {
  if (!err) return 'Transaction failed';
  const e = err as {
    code?: number;
    shortMessage?: string;
    message?: string;
    cause?: { code?: number; message?: string };
  };
  const msg = (e.shortMessage ?? e.message ?? e.cause?.message ?? '').toLowerCase();
  const code = e.code ?? e.cause?.code;

  // 4100: Unauthorized / wallet needs reauthorization
  if (code === 4100) {
    return 'Wallet not authorized. Please reconnect or reauthorize the dApp.';
  }
  // User rejected (MetaMask: 4001, WalletConnect may use 5000)
  if (code === 4001 || code === 5000) {
    return "Transaction rejected. Please try again when you're ready.";
  }
  if (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected') ||
    msg.includes('denied') ||
    msg.includes('action_rejected')
  ) {
    return "Transaction rejected. Please try again when you're ready.";
  }

  // Insufficient balance
  if (
    msg.includes('insufficient') ||
    msg.includes('exceeds balance') ||
    msg.includes('not enough') ||
    msg.includes('unable to cover')
  ) {
    if (msg.includes('eth') || msg.includes('native') || msg.includes('value')) {
      return 'Insufficient ETH. Add more ETH to your wallet to complete this purchase.';
    }
    if (msg.includes('token') || msg.includes('erc20') || msg.includes('neuro')) {
      return 'Insufficient $NEURO. You need 1M $NEURO to buy a fly.';
    }
    return 'Insufficient balance. Add more funds to your wallet.';
  }

  return e instanceof Error ? e.message : 'Transaction failed';
}
