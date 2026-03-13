import React from 'react';

function SidePanelToggleInner({
  open,
  onToggle,
  label,
  position,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  position: 'left' | 'right';
}) {
  const hideLabel = `Hide ${label.toLowerCase()}`;
  const showLabel = `Show ${label.toLowerCase()}`;
  const ariaLabel = open ? hideLabel : showLabel;
  const chevronPath =
    position === 'left'
      ? open ? 'M19 12H5M12 19l-7-7 7-7' : 'M5 12h14M12 5l7 7-7 7'
      : open ? 'M5 12h14M12 5l7 7-7 7' : 'M19 12H5M12 19l-7-7 7-7';
  return (
    <button
      type="button"
      className={`fly-viewer__side-toggle fly-viewer__side-toggle--${position} ${open ? 'fly-viewer__side-toggle--active' : ''}`}
      onClick={onToggle}
      aria-label={ariaLabel}
      aria-expanded={open}
      title={ariaLabel}
    >
      <span className="fly-viewer__side-toggle-label">{label}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d={chevronPath} />
      </svg>
    </button>
  );
}

export const SidePanelToggle = React.memo(SidePanelToggleInner);
