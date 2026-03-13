import type { FlyState } from './simWsClient';

export const FLY_THRESHOLD = 1.1;
export const DEFAULT_FLY: FlyState = { x: 0, y: 0, z: 0.35, heading: 0, t: 0, hunger: 100 };

export function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(-8);
}

export function resolveEffectiveSimIndex(
  flies: FlyState[],
  deployed: Record<number, number | null | undefined>,
  selectedFlyIndex: number,
  deployedSlotKeys?: number[]
): number | undefined {
  const simIndexForSelected = deployed[selectedFlyIndex];
  const keys =
    deployedSlotKeys ??
    Object.keys(deployed)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n) && deployed[n] != null)
      .sort((a, b) => a - b);
  const firstValidSlot = keys.find(
    (slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null
  );
  return simIndexForSelected != null && flies[simIndexForSelected] != null
    ? simIndexForSelected
    : firstValidSlot != null
      ? deployed[firstValidSlot]!
      : undefined;
}

export function getFlyMode(fly: FlyState): string {
  if (fly.dead) return 'dead';
  if (fly.feeding) return 'feeding';
  if ((fly.z ?? 0) > FLY_THRESHOLD) return 'flying';
  if ((fly.z ?? 0) < 0.6) return 'resting';
  return 'idle';
}
