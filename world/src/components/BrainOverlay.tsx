/**
 * Thin container for the brain plot. All data/updates handled by brainPlotScene (outside React).
 * Mounts/disposes Plotly when visible toggles — frees memory when hidden (mobile optimization).
 */
import React, { useEffect, useRef, useState } from 'react';
import { initBrainPlot, type BrainPlotSceneRefs } from '../lib/brainPlotScene';

interface BrainOverlayProps {
  visible?: boolean;
  embedded?: boolean;
  followSimIndexRef: BrainPlotSceneRefs['followSimIndexRef'];
}

function BrainOverlayInner({ visible = true, embedded = false, followSimIndexRef }: BrainOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible) return;
    const container = containerRef.current;
    if (!container) return;
    setLoading(true);
    return initBrainPlot(container, { followSimIndexRef }, () => setLoading(false));
  }, [visible, followSimIndexRef]);

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

  if (!visible) {
    return (
      <div
        className="brain-overlay"
        style={{
          ...containerStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 11, color: '#666' }}>Brain activity</span>
      </div>
    );
  }

  return (
    <div className="brain-overlay" style={containerStyle}>
      <div style={{ position: 'absolute', top: 4, left: 8, fontSize: 10, color: '#888', zIndex: 1 }}>
        Brain activity
      </div>
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(10,10,18,0.9)',
            zIndex: 2,
          }}
        >
          <span style={{ fontSize: 11, color: '#888' }}>Loading…</span>
        </div>
      )}
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
