import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLogout, usePrivy } from '@privy-io/react-auth';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import './CompactMenu.css';

const GITHUB_URL = 'https://github.com/ohnodev/neurosim';
const RESEARCH_URL = 'https://research.neurosim.fun';

const SOCIAL_LINKS = [
  { name: 'X', href: 'https://x.com/i/communities/2031850986466078872' },
  { name: 'Telegram', href: 'https://t.me/neurosimportal' },
  { name: 'YouTube', href: 'https://www.youtube.com/watch?v=tV874dr02yQ' },
];

type CompactMenuProps = {
  className?: string;
};

export default function CompactMenu({ className = '' }: CompactMenuProps) {
  const location = useLocation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [socialsOpen, setSocialsOpen] = useState(false);
  const { ready, authenticated, login, connectWallet } = usePrivy();
  const { isConnected, address } = usePrivyWallet();
  const { logout } = useLogout();

  const walletLabel = isConnected && address
    ? `Disconnect (${address.slice(0, 6)}…${address.slice(-4)})`
    : 'Connect Wallet';

  const onWalletClick = () => {
    if (!ready) return;
    if (isConnected && authenticated) {
      void logout();
      setOpen(false);
      return;
    }
    if (authenticated) {
      connectWallet();
    } else {
      login();
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setSocialsOpen(false);
  }, [location.pathname]);

  return (
    <div ref={rootRef} className={`compact-menu ${className}`.trim()}>
      <button
        type="button"
        className="compact-menu__trigger"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="compact-menu__logo" aria-hidden="true" />
      </button>

      {open ? (
        <div className="compact-menu__panel" role="menu" aria-label="Navigation menu">
          <div className="compact-menu__section-label">Navigation</div>
          <Link to="/" className="compact-menu__item" role="menuitem">
            World
          </Link>
          <Link to="/visualization" className="compact-menu__item" role="menuitem">
            Visualization
          </Link>
          <button
            type="button"
            className="compact-menu__item"
            onClick={onWalletClick}
            disabled={!ready}
            role="menuitem"
          >
            {walletLabel}
          </button>
          <a
            href={RESEARCH_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="compact-menu__item"
            role="menuitem"
          >
            Research
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="compact-menu__item"
            role="menuitem"
          >
            GitHub
          </a>
          <button
            type="button"
            className="compact-menu__item compact-menu__item--toggle"
            onClick={() => setSocialsOpen((v) => !v)}
            aria-expanded={socialsOpen}
            role="menuitem"
          >
            <span>Socials</span>
            <span className={`compact-menu__arrow ${socialsOpen ? 'open' : ''}`}>▼</span>
          </button>
          {socialsOpen ? (
            <div className="compact-menu__sub">
              {SOCIAL_LINKS.map((link) => (
                <a
                  key={link.name}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="compact-menu__item compact-menu__item--sub"
                  role="menuitem"
                >
                  {link.name}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
