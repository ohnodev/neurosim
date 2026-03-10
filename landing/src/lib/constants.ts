export const PRIVY_APP_ID =
  (import.meta.env.VITE_PRIVY_APP_ID as string) || 'cmmkr8zge00b00eky502lv0kn';

export const BASE_RPC =
  (import.meta.env.VITE_BASE_RPC_URL as string) || 'https://mainnet.base.org';

export const API_BASE =
  (import.meta.env.VITE_API_URL as string)?.trim() || 'http://localhost:3001';
