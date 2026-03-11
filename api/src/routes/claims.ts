import { Router, type Request, type Response } from 'express';
import { decodeEventLog } from 'viem';
import { baseRpcClient } from '../services/baseRpcClient.js';
import { tryClaim } from '../services/claimStore.js';
import { getFlies, addFly, canClaimObelisk } from '../services/flyStore.js';
import {
  OBELISK_NFT_ADDRESS,
  NEURO_TOKEN_ADDRESS,
  CLAIM_RECEIVER_ADDRESS,
  FLY_NEURO_AMOUNT,
} from '../lib/addresses.js';

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const router = Router();

const ERC721_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const TRANSFER_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
] as const;

/** 10,000 $NEURO required to buy one fly */
const REQUIRED_AMOUNT = 10_000n * 10n ** 18n;

function parseAndValidateAddress(raw: unknown): `0x${string}` {
  const s = (typeof raw === 'string' ? raw : '')?.trim().toLowerCase();
  if (!s || !/^0x[a-f0-9]{40}$/.test(s)) {
    throw new Error('Invalid address');
  }
  return s as `0x${string}`;
}

router.get('/balance-check', async (req: Request, res: Response) => {
  try {
    let addr: `0x${string}`;
    try {
      addr = parseAndValidateAddress(req.query.address);
    } catch {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    const [ethBalance, neuroBalance] = await Promise.all([
      baseRpcClient.getBalance({ address: addr }),
      NEURO_TOKEN_ADDRESS.toLowerCase() !== zeroAddr
        ? baseRpcClient.readContract({
            address: NEURO_TOKEN_ADDRESS,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [addr],
          })
        : 0n,
    ]);
    res.json({
      ethBalanceWei: ethBalance.toString(),
      neuroBalanceWei: neuroBalance.toString(),
      flyNeuroRequiredWei: FLY_NEURO_AMOUNT.toString(),
    });
  } catch (err) {
    console.error('[claims] balance-check error:', err);
    res.status(500).json({ error: 'Failed to check balance' });
  }
});

router.get('/config', (_req: Request, res: Response) => {
  res.json({
    neuroTokenAddress: NEURO_TOKEN_ADDRESS,
    claimReceiverAddress: CLAIM_RECEIVER_ADDRESS,
    flyNeuroAmountWei: FLY_NEURO_AMOUNT.toString(),
  });
});

router.get('/my-flies', (req: Request, res: Response) => {
  try {
    let address: `0x${string}`;
    try {
      address = parseAndValidateAddress(req.query.address);
    } catch {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }
    const flies = getFlies(address);
    res.json({ flies });
  } catch (err) {
    console.error('[claims] my-flies error:', err);
    res.status(500).json({ error: 'Failed to load flies' });
  }
});

router.get('/eligibility/:address', async (req: Request, res: Response) => {
  try {
    let address: `0x${string}`;
    try {
      address = parseAndValidateAddress(req.params.address);
    } catch {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }

    const flies = getFlies(address);
    if (flies.length >= 3) {
      res.json({ method: 'full' as const, eligible: false, flyCount: 3 });
      return;
    }

    const balance = await baseRpcClient.readContract({
      address: OBELISK_NFT_ADDRESS,
      abi: ERC721_ABI,
      functionName: 'balanceOf',
      args: [address],
    });

    const hasObelisk = balance >= 1n;
    const canFree = hasObelisk && canClaimObelisk(address);

    if (canFree) {
      res.json({ method: 'obelisk' as const, eligible: true, flyCount: flies.length });
      return;
    }

    res.json({ method: 'pay' as const, eligible: true, flyCount: flies.length });
  } catch (err) {
    console.error('[claims] eligibility error:', err);
    res.status(500).json({ error: 'Failed to check eligibility' });
  }
});

router.post('/free', async (req: Request, res: Response) => {
  try {
    let address: `0x${string}`;
    try {
      address = parseAndValidateAddress(req.body?.address);
    } catch {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }

    if (!canClaimObelisk(address)) {
      res.status(400).json({ error: 'Already claimed free Obelisk fly or at max' });
      return;
    }

    const balance = await baseRpcClient.readContract({
      address: OBELISK_NFT_ADDRESS,
      abi: ERC721_ABI,
      functionName: 'balanceOf',
      args: [address],
    });

    if (balance < 1n) {
      res.status(403).json({ error: 'Obelisk NFT balance required' });
      return;
    }

    const fly = addFly(address, {
      method: 'obelisk',
      claimedAt: new Date().toISOString(),
      seed: Date.now(),
    });
    if (!fly) {
      res.status(400).json({ error: 'Already at max flies' });
      return;
    }
    await tryClaim(address, { method: 'obelisk', claimedAt: fly.claimedAt });
    res.json({ success: true, fly });
  } catch (err) {
    console.error('[claims] free claim error:', err);
    res.status(500).json({ error: 'Claim failed' });
  }
});

router.post('/verify-payment', async (req: Request, res: Response) => {
  try {
    const { txHash, userAddress } = req.body as {
      txHash?: string;
      userAddress?: string;
    };
    const userLower = (userAddress as string)?.toLowerCase();
    if (!txHash || !userLower || !/^0x[a-fA-F0-9]{64}$/.test(txHash) || !/^0x[a-fA-F0-9]{40}$/.test(userLower)) {
      res.status(400).json({ error: 'Invalid txHash or userAddress' });
      return;
    }

    if (NEURO_TOKEN_ADDRESS === '0x0000000000000000000000000000000000000000' as `0x${string}` ||
        CLAIM_RECEIVER_ADDRESS === '0x0000000000000000000000000000000000000000' as `0x${string}`) {
      res.status(503).json({ error: 'Claim payment not configured' });
      return;
    }

    const receipt = await baseRpcClient.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    if (!receipt) {
      res.status(400).json({ error: 'Transaction not found' });
      return;
    }

    if (receipt.status !== 'success') {
      res.status(400).json({ error: 'Transaction failed or reverted' });
      return;
    }

    const transferEvent = receipt.logs
      .map((log) => {
        try {
          if (log.address.toLowerCase() !== NEURO_TOKEN_ADDRESS.toLowerCase()) return null;
          const decoded = decodeEventLog({
            abi: TRANSFER_EVENT_ABI,
            data: log.data,
            topics: log.topics,
          });
          return decoded;
        } catch {
          return null;
        }
      })
      .find((d) => {
        if (!d || d.eventName !== 'Transfer') return false;
        const args = d.args as { from: string; to: string; value: bigint };
        return (
          args.from.toLowerCase() === userLower &&
          args.to.toLowerCase() === CLAIM_RECEIVER_ADDRESS.toLowerCase() &&
          args.value >= REQUIRED_AMOUNT
        );
      });

    if (!transferEvent || !transferEvent.args) {
      res.status(400).json({ error: 'Valid Transfer event not found' });
      return;
    }

    const fly = addFly(userLower, {
      method: 'pay',
      txHash,
      claimedAt: new Date().toISOString(),
      seed: Date.now(),
    });
    if (!fly) {
      res.json({ success: true, message: 'At max flies' });
      return;
    }
    await tryClaim(userLower, { method: 'pay', txHash, claimedAt: fly.claimedAt });
    res.json({ success: true, fly });
  } catch (err) {
    console.error('[claims] verify-payment error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

export default router;
