/**
 * Robust transaction sending with nonce handling, replacement (underpriced), and nonce recovery.
 * Port of basemarket's TransactionFacilitator logic for a single signer, using viem.
 */
import type { Hash } from 'viem';
import type { TransactionReceipt } from 'viem';

/** Minimal wallet: has account and sendTransaction. Accepts viem WalletClient. */
export type WalletLike = { account: { address: `0x${string}` } | null | undefined; sendTransaction: (args: unknown) => Promise<Hash> };

/** Minimal public client: getTransactionCount, estimateFeesPerGas, waitForTransactionReceipt. */
export type PublicClientLike = {
  getTransactionCount: (args: { address: `0x${string}`; blockTag?: 'pending' }) => Promise<number>;
  estimateFeesPerGas: () => Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }>;
  waitForTransactionReceipt: (args: { hash: Hash; timeout?: number }) => Promise<TransactionReceipt>;
};

type ChainLike = { id: number };

export type ExecuteParams = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gasLimit?: bigint;
  timeoutMs?: number;
};

export type ExecutionResult = {
  txHash: Hash;
  receipt: TransactionReceipt;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const FEE_MULTIPLIER_FIRST = 120n; // 120%
const FEE_MULTIPLIER_REPLACEMENT = 150n; // 150% for replacement
const FEE_BUMP_PERCENT = 112n; // 112% of original + 1 for replacement
const NONCE_RECOVERY_GAS_LIMIT = 21_000n;

function errorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error).toLowerCase();
  }
  const details = error as { code?: string; shortMessage?: string; message?: string };
  return `${details.code ?? ''} ${details.shortMessage ?? ''} ${details.message ?? ''}`.toLowerCase();
}

function multiplyFee(value: bigint, numerator: bigint, denominator = 100n): bigint {
  return (value * numerator) / denominator;
}

function maxDefinedFee(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

function isRecoverableSendError(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes('timeout') ||
    text.includes('replacement transaction underpriced') ||
    text.includes('nonce too low') ||
    text.includes('nonce too high') ||
    text.includes('nonce has already been used') ||
    text.includes('already known') ||
    text.includes('temporarily underpriced')
  );
}

/**
 * Send a single contract tx with robust nonce/fee handling.
 * Uses pending nonce, 120% fees; on receipt timeout sends replacement with bumped fees.
 * On recoverable send errors, runs nonce recovery (1 wei to self) and retries once.
 */
export async function executeContractTx(params: {
  wallet: WalletLike;
  publicClient: PublicClientLike;
  chain: ChainLike;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gasLimit?: bigint;
  timeoutMs?: number;
  label?: string;
}): Promise<ExecutionResult> {
  const label = params.label ?? 'tx';
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const account = params.wallet.account;
  if (!account) throw new Error(`[${label}] wallet has no account`);

  const attempt = async (): Promise<ExecutionResult> => {
    const nonce = await params.publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });

    const fees = await params.publicClient.estimateFeesPerGas();
    const baseFees =
      fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
        ? {
            maxFeePerGas: multiplyFee(fees.maxFeePerGas, FEE_MULTIPLIER_FIRST),
            maxPriorityFeePerGas: multiplyFee(fees.maxPriorityFeePerGas, FEE_MULTIPLIER_FIRST),
          }
        : 'gasPrice' in fees && fees.gasPrice != null
          ? { gasPrice: multiplyFee(fees.gasPrice, FEE_MULTIPLIER_FIRST) }
          : undefined;

    const firstHash = await params.wallet.sendTransaction({
      account,
      chain: params.chain,
      to: params.to,
      data: params.data,
      value: params.value,
      nonce,
      gas: params.gasLimit,
      ...baseFees,
    });

    const firstReceipt = await waitForReceipt(
      params.publicClient,
      firstHash,
      timeoutMs,
      label
    );
    if (firstReceipt) {
      assertSucceeded(firstReceipt, label);
      return { txHash: firstHash, receipt: firstReceipt };
    }

    // Timeout: send replacement with bumped fees
    const replacementFees =
      fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
        ? {
            maxFeePerGas: maxDefinedFee(
              multiplyFee(fees.maxFeePerGas, FEE_MULTIPLIER_REPLACEMENT),
              multiplyFee(fees.maxFeePerGas, FEE_BUMP_PERCENT) + 1n
            ),
            maxPriorityFeePerGas: maxDefinedFee(
              multiplyFee(fees.maxPriorityFeePerGas, FEE_MULTIPLIER_REPLACEMENT),
              multiplyFee(fees.maxPriorityFeePerGas, FEE_BUMP_PERCENT) + 1n
            ),
          }
        : 'gasPrice' in fees && fees.gasPrice != null
          ? { gasPrice: multiplyFee(fees.gasPrice, FEE_BUMP_PERCENT) + 1n }
          : undefined;

    const replacementHash = await params.wallet.sendTransaction({
      account,
      chain: params.chain,
      to: params.to,
      data: params.data,
      value: params.value,
      nonce,
      gas: params.gasLimit,
      ...replacementFees,
    });

    const replacementReceipt = await waitForReceipt(
      params.publicClient,
      replacementHash,
      timeoutMs,
      label
    );
    if (replacementReceipt) {
      assertSucceeded(replacementReceipt, label);
      return { txHash: replacementHash, receipt: replacementReceipt };
    }

    throw new Error(`[${label}] timed out waiting for receipt (first=${firstHash}, replacement=${replacementHash})`);
  };

  try {
    return await attempt();
  } catch (err) {
    if (isRecoverableSendError(err)) {
      console.warn(`[${label}] recoverable send error, running nonce recovery:`, errorText(err));
      await recoverNonce(params.wallet, params.publicClient, params.chain, account.address, label);
      return attempt();
    }
    throw err;
  }
}

async function waitForReceipt(
  publicClient: PublicClientLike,
  hash: Hash,
  _timeoutMs: number,
  _label: string
): Promise<TransactionReceipt | null> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: _timeoutMs,
    });
    return receipt;
  } catch {
    return null;
  }
}

function assertSucceeded(receipt: TransactionReceipt, label: string): void {
  if (receipt.status !== 'success') {
    throw new Error(`[${label}] transaction reverted: ${receipt.transactionHash}`);
  }
}

async function recoverNonce(
  wallet: WalletLike,
  publicClient: PublicClientLike,
  chain: ChainLike,
  address: `0x${string}`,
  label: string
): Promise<void> {
  const account = wallet.account;
  if (!account) return;
  try {
    const nonce = await publicClient.getTransactionCount({
      address,
      blockTag: 'pending',
    });
    const fees = await publicClient.estimateFeesPerGas();
    const feeOverrides =
      fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null
        ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
        : 'gasPrice' in fees && fees.gasPrice != null
          ? { gasPrice: fees.gasPrice }
          : {};
    const hash = await wallet.sendTransaction({
      account,
      chain,
      to: address,
      value: 1n,
      nonce,
      gas: NONCE_RECOVERY_GAS_LIMIT,
      ...feeOverrides,
    });
    await publicClient.waitForTransactionReceipt({ hash }).catch(() => undefined);
  } catch (recoveryError) {
    console.warn(`[${label}] nonce recovery failed for ${address}:`, recoveryError);
  }
}
