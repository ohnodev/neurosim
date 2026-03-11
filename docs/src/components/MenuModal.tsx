import { useEffect } from "react";
import type { NavLink } from "../types/docs";

type MenuModalProps = {
  isOpen: boolean;
  activeSection: string;
  navSubLinks: NavLink[];
  onClose: () => void;
};

export default function MenuModal({ isOpen, activeSection, navSubLinks, onClose }: MenuModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  return (
    <>
      <div className={`menu-overlay ${isOpen ? "open" : ""}`} onClick={onClose} />
      <aside className={`menu-modal ${isOpen ? "open" : ""}`}>
        <div className="menu-header">
          <div className="menu-brand">
            <img src="/neurosim-logo-v2.svg" alt="NeuroSim" />
            NeuroSim Docs
          </div>
          <button className="menu-close" aria-label="Close menu" onClick={onClose}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M5 5l10 10M15 5 5 15" />
            </svg>
          </button>
        </div>
        <div className="menu-content">
          <div className="menu-label">Navigate</div>
          <a className="menu-link active" href="/">
            Documentation
          </a>
          <a className="menu-link" href="https://neurosim.fun" target="_blank" rel="noopener noreferrer">
            neurosim.fun
          </a>
          <a className="menu-link" href="https://world.neurosim.fun" target="_blank" rel="noopener noreferrer">
            Enter World
          </a>
          <a className="menu-link" href="https://theinnermostloop.substack.com/p/the-first-multi-behavior-brain-upload" target="_blank" rel="noopener noreferrer">
            Lore · Brain Upload Article
          </a>

          <div className="menu-label">On This Page</div>
          {navSubLinks.map((item) => (
            <a key={item.id} className={`menu-sub-link ${activeSection === item.id ? "active" : ""}`} href={`#${item.id}`}>
              {item.label}
            </a>
          ))}

          <div className="menu-footer">
            <a href="https://t.me/neurosimportal" target="_blank" rel="noopener noreferrer" aria-label="Telegram">
              <img src="/icons/telegram-logo.svg" alt="Telegram" />
            </a>
            <a href="https://x.com/neurosim" target="_blank" rel="noopener noreferrer" aria-label="X">
              <img src="/icons/x-logo.svg" alt="X" />
            </a>
          </div>
        </div>
      </aside>
    </>
  );
}
