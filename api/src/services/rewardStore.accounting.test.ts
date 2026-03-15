import { describe, it, expect, beforeEach } from 'vitest';
import { addFly } from './flyStore.js';
import {
  clearForTesting,
  REWARD_PER_FOOD,
  recordFeedingPoints,
  flushAccruedPointsToPending,
  takeBatchForFlush,
  rollbackBatch,
} from './rewardStore.js';

function randomAddress(): string {
  const suffix = Math.floor(Math.random() * 0xfffffffffff)
    .toString(16)
    .padStart(12, '0');
  return `0x0000000000000000000000000000${suffix}`;
}

describe('rewardStore feeding accounting', () => {
  beforeEach(() => {
    clearForTesting();
  });

  it('flushes only earned-minus-flushed delta and prevents double distribution', () => {
    const testAddr = randomAddress();
    const fly = addFly(testAddr, {
      method: 'pay',
      claimedAt: new Date().toISOString(),
      seed: 7,
    });
    expect(fly).not.toBeNull();

    // 100 points corresponds to one full fruit value.
    recordFeedingPoints(testAddr, 0, 25);
    recordFeedingPoints(testAddr, 0, 75);

    const changed1 = flushAccruedPointsToPending();
    expect(changed1).toBe(1);

    const batch1 = takeBatchForFlush();
    expect(batch1.recipients).toEqual([testAddr.toLowerCase()]);
    expect(batch1.amounts).toEqual([REWARD_PER_FOOD]);

    // Simulate temporary send failure and return to pending.
    rollbackBatch(batch1.recipients, batch1.amounts);

    // Re-flush without new points must not create additional pending.
    const changed2 = flushAccruedPointsToPending();
    expect(changed2).toBe(0);

    const batch2 = takeBatchForFlush();
    expect(batch2.recipients).toEqual([testAddr.toLowerCase()]);
    expect(batch2.amounts).toEqual([REWARD_PER_FOOD]);
  });
});
