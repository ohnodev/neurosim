/** Returns true on viewports ≤768px. Safe for SSR (returns false when window is undefined). */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 768px)').matches;
}
