type TopbarProps = {
  onOpenMenu: () => void;
  onToggleTheme: () => void;
  siteLabel: string;
};

export default function Topbar({ onOpenMenu, onToggleTheme, siteLabel }: TopbarProps) {
  return (
    <header className="topbar">
      <button className="menu-toggle" aria-label="Open menu" onClick={onOpenMenu}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
      </button>
      <div className="topbar__title">
        <span className="title-desktop">{siteLabel}</span>
        <span className="title-mobile">{siteLabel}</span>
      </div>
      <span className="spacer" />
      <button className="theme-toggle" aria-label="Toggle theme" onClick={onToggleTheme}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.2 6.2-1.4-1.4M7.2 7.2 5.8 5.8m12.4 0-1.4 1.4M7.2 16.8l-1.4 1.4" />
          <circle cx="12" cy="12" r="4" />
        </svg>
      </button>
    </header>
  );
}
