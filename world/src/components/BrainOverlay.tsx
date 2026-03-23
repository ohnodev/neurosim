/**
 * Lightweight Three.js 3D scatter for brain activity. No Plotly.
 * Only mounted when panel is open; unmounts fully when closed.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSimRefs } from '../lib/simDisplayContext';
import { initBrainPoints } from '../lib/brainPointsScene';
import type { NeuronWithPosition } from '../../../shared/lib/brainTypes';

interface BrainOverlayProps {
  visible?: boolean;
  embedded?: boolean;
  followSimIndexRef: React.MutableRefObject<number | undefined>;
  neurons?: NeuronWithPosition[];
  title?: string;
}

function BrainOverlayInner({ visible = true, embedded = false, followSimIndexRef, neurons, title = 'Brain activity' }: BrainOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activityRef, activitiesRef } = useSimRefs();
  const normalizedNeurons = useMemo(() => neurons ?? [], [neurons]);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    const container = containerRef.current;
    if (!container) return;
    setRenderError(null);
    try {
      return initBrainPoints(container, { activityRef, activitiesRef, followSimIndexRef }, normalizedNeurons);
    } catch (err) {
      console.error('[BrainOverlay] init failed', err);
      setRenderError('3D unavailable');
      return;
    }
  }, [visible, activityRef, activitiesRef, followSimIndexRef, normalizedNeurons]);

  if (!visible) return null;

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
        {title}
      </div>
      {renderError ? (
        <div style={{ position: 'absolute', top: 24, left: 8, right: 8, fontSize: 10, color: '#c88', zIndex: 1 }}>
          {renderError}
        </div>
      ) : null}
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
