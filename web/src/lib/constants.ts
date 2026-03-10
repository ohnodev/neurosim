export const PRIVY_APP_ID =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_PRIVY_APP_ID?: string } }).env?.VITE_PRIVY_APP_ID) ||
  'cmmkr8zge00b00eky502lv0kn';

export const LANDING_URL = 'https://neurosim.fun';

export function getApiBase(): string {
  const envBase =
    typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE?.trim();
  if (envBase) return envBase.replace(/\/$/, '');
  if (typeof window === 'undefined') return 'http://localhost:3001';
  const isLocal =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  return isLocal ? 'http://localhost:3001' : 'https://api.neurosim.fun';
}
