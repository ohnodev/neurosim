import { type ReactNode, createContext, useContext, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

export type NotificationType = 'info' | 'success' | 'error' | 'warning';

interface NotificationContextValue {
  show: (message: string, type?: NotificationType) => void;
  hide: () => void;
  update: (message: string, type?: NotificationType) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotification() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotification must be used within NotificationProvider');
  return ctx;
}

function NotificationToast({ message, type, visible, onClose }: { message: string; type: NotificationType; visible: boolean; onClose: () => void }) {
  if (!visible) return null;
  const content = (
    <div className={`notification-toast notification-toast--${type}`} role="status" aria-live="polite">
      <span className="notification-toast__message">{message}</span>
      <button type="button" className="notification-toast__close" onClick={onClose} aria-label="Dismiss">×</button>
    </div>
  );
  return createPortal(content, document.body);
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ message: '', type: 'info' as NotificationType, visible: false });
  const show = useCallback((message: string, type: NotificationType = 'info') => setState({ message, type, visible: true }), []);
  const hide = useCallback(() => setState((s) => ({ ...s, visible: false })), []);
  const update = useCallback((message: string, type: NotificationType = 'info') => setState((s) => ({ ...s, message, type })), []);
  return (
    <NotificationContext.Provider value={{ show, hide, update }}>
      {children}
      <NotificationToast message={state.message} type={state.type} visible={state.visible} onClose={hide} />
    </NotificationContext.Provider>
  );
}
