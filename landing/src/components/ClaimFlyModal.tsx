import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';

const WORLD_URL = 'https://world.neurosim.fun';
const DOCS_URL = 'https://docs.neurosim.fun';

/** Seeded random: returns 0–1 based on seed */
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/** Generate fly stats from seed */
function getFlyStats(seed: number) {
  const r = (i: number) => seededRandom(seed + i * 0.1);
  return {
    strength: Math.round(30 + r(1) * 70),
    resilience: Math.round(25 + r(2) * 70),
    speed: Math.round(35 + r(3) * 60),
  };
}

interface ClaimFlyModalProps {
  open: boolean;
  onClose: () => void;
  seed?: number;
}

export function ClaimFlyModal({ open, onClose, seed = Date.now() }: ClaimFlyModalProps) {
  const stats = useMemo(() => getFlyStats(seed), [seed]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const modalEl = document.querySelector('.claim-modal');
    const closeBtn = modalEl?.querySelector<HTMLElement>('.claim-modal__close');
    if (closeBtn) closeBtn.focus();

    const focusables = 'a, button, input, [tabindex]:not([tabindex="-1"])';

    function getFocusables(container: Element): HTMLElement[] {
      return Array.from(container.querySelectorAll<HTMLElement>(focusables));
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !modalEl) return;
      const els = getFocusables(modalEl);
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const modalContent = (
    <div className="claim-modal-overlay" onClick={onClose}>
      <div
        className="claim-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="claim-modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="claim-modal__brain">
          <div className="claim-modal__brain-placeholder">
            <div className="claim-modal__pulse" />
            <span>Your fly</span>
          </div>
        </div>
        <div className="claim-modal__card">
          <div className="claim-modal__card-glow" />
          <h2 id="claim-modal-title" className="claim-modal__title">Congratulations on your fly!</h2>
          <p className="claim-modal__subtitle">Your digital fly has been minted.</p>
          <div className="claim-modal__stats">
            <div className="claim-modal__stat">
              <span className="claim-modal__stat-label">Strength</span>
              <div className="claim-modal__stat-bar">
                <div className="claim-modal__stat-fill" style={{ width: `${stats.strength}%` }} />
              </div>
              <span className="claim-modal__stat-value">{stats.strength}</span>
            </div>
            <div className="claim-modal__stat">
              <span className="claim-modal__stat-label">Resilience</span>
              <div className="claim-modal__stat-bar">
                <div className="claim-modal__stat-fill" style={{ width: `${stats.resilience}%` }} />
              </div>
              <span className="claim-modal__stat-value">{stats.resilience}</span>
            </div>
            <div className="claim-modal__stat">
              <span className="claim-modal__stat-label">Speed</span>
              <div className="claim-modal__stat-bar">
                <div className="claim-modal__stat-fill" style={{ width: `${stats.speed}%` }} />
              </div>
              <span className="claim-modal__stat-value">{stats.speed}</span>
            </div>
          </div>
          <div className="claim-modal__actions">
            <a
              href={WORLD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="claim-modal__btn claim-modal__btn--primary"
            >
              Enter World · Run in simulation
            </a>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="claim-modal__btn claim-modal__btn--secondary"
            >
              Read docs
            </a>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
