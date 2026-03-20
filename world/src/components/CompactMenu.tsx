import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import './CompactMenu.css';

const GITHUB_URL = 'https://github.com/ohnodev/neurosim';

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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 7H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M4 12H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M4 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
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
          <Link to="/heading-calibration" className="compact-menu__item" role="menuitem">
            Settings
          </Link>
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
