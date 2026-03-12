/**
 * Thin container for the brain plot. All data/updates handled by brainPlotScene (outside React).
 */
import React, { useEffect, useRef } from 'react';
import { initBrainPlot, type BrainPlotSceneRefs } from '../lib/brainPlotScene';

interface BrainOverlayProps {
  visible?: boolean;
  embedded?: boolean;
  followSimIndexRef: BrainPlotSceneRefs['followSimIndexRef'];
}

function BrainOverlayInner({ visible = true, embedded = false, followSimIndexRef }: BrainOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return initBrainPlot(container, { followSimIndexRef });
  }, [followSimIndexRef]);

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
    <div
      className="brain-overlay"
      style={{
        ...containerStyle,
        ...(!visible ? { visibility: 'hidden' as const, pointerEvents: 'none' as const } : {}),
      }}
    >
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
          touchAction: 'none',
        }}
      />
    </div>
  );
}

export const BrainOverlay = React.memo(BrainOverlayInner);
