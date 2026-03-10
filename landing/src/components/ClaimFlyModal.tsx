import { Suspense, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { FlyModelPreview } from './FlyModelPreview';

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const modalContent = (
    <div className="claim-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Claim your fly">
      <div className="claim-modal" onClick={(e) => e.stopPropagation()}>
        <button className="claim-modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="claim-modal__brain">
          <Suspense
            fallback={
              <div className="claim-modal__brain-placeholder">
                <div className="claim-modal__pulse" />
                <span>Loading fly...</span>
              </div>
            }
          >
            <FlyModelPreview />
          </Suspense>
        </div>
        <div className="claim-modal__card">
          <div className="claim-modal__card-glow" />
          <h2 className="claim-modal__title">Congratulations on your fly!</h2>
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
