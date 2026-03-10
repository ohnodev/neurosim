import { Router, type Request, type Response } from 'express';
import { decodeEventLog } from 'viem';
import { baseRpcClient } from '../services/baseRpcClient.js';
import { getClaim, setClaim } from '../services/claimStore.js';
import {
  OBELISK_NFT_ADDRESS,
  NEURO_TOKEN_ADDRESS,
  CLAIM_RECEIVER_ADDRESS,
} from '../lib/addresses.js';

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

const REQUIRED_AMOUNT = 1_000_000n * 10n ** 18n;

router.get('/config', (_req: Request, res: Response) => {
  res.json({
    neuroTokenAddress: NEURO_TOKEN_ADDRESS,
    claimReceiverAddress: CLAIM_RECEIVER_ADDRESS,
  });
});

router.get('/eligibility/:address', async (req: Request, res: Response) => {
  try {
    const address = (req.params.address as string)?.toLowerCase();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }

    const existing = getClaim(address);
    if (existing) {
      res.json({ method: 'already_claimed' as const, eligible: false });
      return;
    }

    const balance = await baseRpcClient.readContract({
      address: OBELISK_NFT_ADDRESS,
      abi: ERC721_ABI,
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    });

    if (balance >= 1n) {
      res.json({ method: 'obelisk' as const, eligible: true });
      return;
    }

    res.json({ method: 'pay' as const, eligible: true });
  } catch (err) {
    console.error('[claims] eligibility error:', err);
    res.status(500).json({ error: 'Failed to check eligibility' });
  }
});

router.post('/free', async (req: Request, res: Response) => {
  try {
    const address = (req.body?.address as string)?.toLowerCase();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      res.status(400).json({ error: 'Invalid address' });
      return;
    }

    const existing = getClaim(address);
    if (existing) {
      res.status(400).json({ error: 'Already claimed' });
      return;
    }

    const balance = await baseRpcClient.readContract({
      address: OBELISK_NFT_ADDRESS,
      abi: ERC721_ABI,
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    });

    if (balance < 1n) {
      res.status(403).json({ error: 'Obelisk NFT balance required' });
      return;
    }

    setClaim(address, {
      method: 'obelisk',
      claimedAt: new Date().toISOString(),
    });
    res.json({ success: true });
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

    const existing = getClaim(userLower);
    if (existing) {
      res.json({ success: true, message: 'Already claimed' });
      return;
    }

    let receipt = await baseRpcClient.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });
    for (let i = 0; !receipt && i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      receipt = await baseRpcClient.getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
    }
    if (!receipt) {
      res.status(400).json({ error: 'Transaction not found' });
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

    setClaim(userLower, {
      method: 'pay',
      txHash,
      claimedAt: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[claims] verify-payment error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

export default router;
