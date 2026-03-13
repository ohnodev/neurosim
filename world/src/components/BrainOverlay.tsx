/**
 * Brain plot in an iframe. When the panel closes, the iframe is removed
 * and its JS context (Plotly, etc.) is destroyed and can be GC'd.
 * Main page never loads Plotly.
 */
import React, { useEffect, useRef } from 'react';
import { useSimRefs } from '../lib/simDisplayContext';

interface BrainOverlayProps {
  visible?: boolean;
  embedded?: boolean;
  followSimIndexRef: React.MutableRefObject<number | undefined>;
}

const ACTIVITY_POST_MS = 100;

function BrainOverlayInner({ embedded = false, followSimIndexRef }: BrainOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { activityRef, activitiesRef } = useSimRefs();

  useEffect(() => {
    const id = setInterval(() => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(
        {
          type: 'neurosim-activity',
          activity: activityRef.current ?? {},
          activities: activitiesRef.current ?? [],
          followSimIndex: followSimIndexRef.current,
        },
        '*'
      );
    }, ACTIVITY_POST_MS);
    return () => clearInterval(id);
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
      <iframe
        ref={iframeRef}
        src="/brain-plot.html"
        title="Brain activity plot"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 'none',
          minWidth: 1,
          minHeight: 1,
        }}
      />
    </div>
  );
}

export const BrainOverlay = React.memo(BrainOverlayInner);
