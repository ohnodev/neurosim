const DEV_MODE_KEY = 'neurosim.devMode';

export function getInitialDevMode(): boolean {
  if (typeof window === 'undefined') return false;
  const saved = window.localStorage.getItem(DEV_MODE_KEY);
  if (saved === '1') return true;
  if (saved === '0') return false;
  return !!import.meta.env.DEV;
}

export function persistDevMode(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEV_MODE_KEY, enabled ? '1' : '0');
}

