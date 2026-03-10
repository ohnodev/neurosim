export const PRIVY_APP_ID = 'cmmkr8zge00b00eky502lv0kn';

export function getApiBase(): string {
  if (typeof window === 'undefined') return 'https://api.neurosim.fun';
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  return isLocal ? 'http://localhost:3001' : 'https://api.neurosim.fun';
}
