import { useEffect, useRef, useState } from 'react'
import './CompactMenu.css'

const GITHUB_URL = 'https://github.com/ohnodev/neurosim'

const SOCIAL_LINKS = [
  { name: 'X', href: 'https://x.com/i/communities/2031850986466078872' },
  { name: 'Telegram', href: 'https://t.me/neurosimportal' },
  { name: 'YouTube', href: 'https://www.youtube.com/watch?v=tV874dr02yQ' },
]

const MENU_LINKS = [
  { name: 'Home', href: 'https://neurosim.fun/' },
  { name: 'World', href: 'https://neurosim.fun/' },
  { name: 'Visualization', href: 'https://neurosim.fun/visualization' },
  { name: 'Research', href: 'https://research.neurosim.fun/' },
  { name: 'GitHub', href: GITHUB_URL, external: true },
]

type CompactMenuProps = {
  className?: string
}

export default function CompactMenu({ className = '' }: CompactMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [socialsOpen, setSocialsOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setSocialsOpen(false)
      }
    }
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setSocialsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`compact-menu ${className}`.trim()}>
      <button
        type="button"
        className="compact-menu__trigger"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false)
            setSocialsOpen(false)
            return
          }
          setOpen(true)
        }}
      >
        <span className="compact-menu__logo" aria-hidden="true" />
      </button>

      {open ? (
        <nav className="compact-menu__panel" aria-label="Navigation menu">
          <div className="compact-menu__section-label">Navigation</div>
          {MENU_LINKS.map((item) => (
            <a
              key={item.name}
              href={item.href}
              target={item.external ? '_blank' : undefined}
              rel={item.external ? 'noopener noreferrer' : undefined}
              className="compact-menu__item"
            >
              {item.name}
            </a>
          ))}
          <button
            type="button"
            className="compact-menu__item compact-menu__item--toggle"
            onClick={() => setSocialsOpen((v) => !v)}
            aria-expanded={socialsOpen}
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
                >
                  {link.name}
                </a>
              ))}
            </div>
          ) : null}
        </nav>
      ) : null}
    </div>
  )
}

