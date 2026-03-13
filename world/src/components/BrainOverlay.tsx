/**
 * Lightweight Three.js 3D scatter for brain activity. No Plotly.
 * Only mounted when panel is open; unmounts fully when closed.
 */
import React, { useEffect, useRef } from 'react';
import { useSimRefs } from '../lib/simDisplayContext';
import { initBrainPoints } from '../lib/brainPointsScene';

interface BrainOverlayProps {
  visible?: boolean;
  embedded?: boolean;
  followSimIndexRef: React.MutableRefObject<number | undefined>;
}

function BrainOverlayInner({ embedded = false, followSimIndexRef }: BrainOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activityRef, activitiesRef } = useSimRefs();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return initBrainPoints(container, { activityRef, activitiesRef, followSimIndexRef });
  }, [activityRef, activitiesRef, followSimIndexRef]);

  const containerStyle = embedded
    ? {
        position: 'relative' as const,
        width: '100%',
        height: '100%',
        borderRadius: 8,
        overflow: 'hidden' as const,
        border: '1px solid rgba(100,100,140,0.3)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        background: 'rgba(10,10,18,0.9)',
        pointerEvents: 'auto' as const,
      }
    : {
        position: 'absolute' as const,
        bottom: 12,
        right: 12,
        width: 320,
        height: 240,
        borderRadius: 8,
        overflow: 'hidden' as const,
        border: '1px solid rgba(100,100,140,0.3)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        background: 'rgba(10,10,18,0.9)',
        zIndex: 100,
        pointerEvents: 'auto' as const,
      };

  return (
    <div className="brain-overlay" style={containerStyle}>
      <div style={{ position: 'absolute', top: 4, left: 8, fontSize: 10, color: '#888', zIndex: 1 }}>
        Brain activity
      </div>
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          inset: 0,
          minWidth: 1,
          minHeight: 1,
        }}
      />
    </div>
  );
}

export const BrainOverlay = React.memo(BrainOverlayInner);
