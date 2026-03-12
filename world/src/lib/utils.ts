/**
 * Shared utility functions for the world app.
 */

export function getHungerColor(hunger: number): string {
  if (hunger > 50) return '#5a5';
  if (hunger > 20) return '#ca0';
  return '#c44';
}

export function getHealthColor(health: number): string {
  if (health > 50) return '#48a';
  if (health > 20) return '#c95';
  return '#c44';
}

/** Bigint-safe ETH formatter to avoid precision loss. */
export function formatEth(wei: bigint, decimals = 6): string {
  const ONE = 10n ** 18n;
  const whole = wei / ONE;
  const frac = wei % ONE;
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals);
  return `${whole}.${fracStr}`;
}

export function safeAmountWei(val: string | undefined): bigint {
  if (val == null || val === '') return 0n;
  try {
    const n = BigInt(val);
    return n >= 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

export function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
