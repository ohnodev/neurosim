import { useCallback, useEffect, useRef, useMemo } from 'react';
import Plotly from 'plotly.js-dist-min';
import {
  getSceneCamera,
  getDefaultCamera,
  cameraFromRelayout,
  type SceneCamera,
  UIREVISION,
} from '../../../shared/lib/plotlySceneCamera';
import {
  computeMarkerColors,
  computeHoverTexts,
  BRAIN_PLOT_COLORSCALE,
} from '../../../shared/lib/brainPlotColors';
export interface NeuronWithPosition {
  root_id: string;
  side?: string;
  x?: number;
  y?: number;
  z?: number;
}

interface BrainOverlayProps {
  neurons: NeuronWithPosition[];
  activity: Record<string, number>;
  visible?: boolean;
  /** When true, overlay fills its container (no absolute positioning). */
  embedded?: boolean;
  /** When true, container is visible (e.g. panel expanded). Triggers resize after expand. */
  containerVisible?: boolean;
}

function hasPosition(n: NeuronWithPosition): n is NeuronWithPosition & { x: number; y: number; z: number } {
  return (
    typeof n.x === 'number' && Number.isFinite(n.x) &&
    typeof n.y === 'number' && Number.isFinite(n.y) &&
    typeof n.z === 'number' && Number.isFinite(n.z)
  );
}

export function BrainOverlay({ neurons, activity, visible = true, embedded = false, containerVisible = true }: BrainOverlayProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const plotReady = useRef(false);
  const idsRef = useRef<string[]>([]);
  const sidesRef = useRef<string[]>([]);
  const interacting = useRef(false);
  const pendingResizeRef = useRef(false);
  const pendingRestyleRef = useRef(false);
  const plotKeyRef = useRef<string>('');
  const activityRef = useRef(activity);
  const cameraRef = useRef<SceneCamera>(getDefaultCamera());
  activityRef.current = activity;

  const withPos = neurons.filter(hasPosition);
  const n = withPos.length;
  const neuronIdsKey = useMemo(
    () =>
      neurons
        .filter(hasPosition)
        .map((p) => p.root_id)
        .sort()
        .join(','),
    [neurons]
  );

  // Fingerprint of root_id + positions and sides so plot recreates when identity or coordinates/sides change
  const positionsFingerprint = useMemo(() => {
    const list = neurons.filter(hasPosition);
    if (list.length === 0) return '';
    return list
      .map((p) => `${p.root_id},${p.x},${p.y},${p.z},${(p.side ?? '').toLowerCase()}`)
      .sort()
      .join('|');
  }, [neurons]);

  const plotCreationKey = n > 0 ? `${n}-${neuronIdsKey}-${positionsFingerprint}` : '';

  const preserveCameraRestyle = useCallback(
    (activityData: Record<string, number>) => {
      const el = plotRef.current;
      if (!el || !plotReady.current || idsRef.current.length === 0) return;
      const live = getSceneCamera(el);
      if (live) cameraRef.current = live;
      const ids = idsRef.current;
      const sides = sidesRef.current;
      const color = computeMarkerColors(ids, activityData, sides);
      const text = computeHoverTexts(ids, activityData, sides);
      Plotly.restyle(el, { 'marker.color': [color], text: [text] }, [0]);
      Plotly.relayout(el, {
        'scene.camera': cameraRef.current,
        'scene.uirevision': UIREVISION,
        uirevision: UIREVISION,
      } as Record<string, unknown>);
    },
    []
  );

  // Initial plot when neuron set (with positions) is available — do NOT depend on visible so we don't purge/recreate on connect toggle
  useEffect(() => {
    if (!plotRef.current || n === 0 || !plotCreationKey) return;

    plotKeyRef.current = plotCreationKey;
    const x = withPos.map((p) => p.x);
    const y = withPos.map((p) => p.y);
    const z = withPos.map((p) => p.z);
    const ids = withPos.map((p) => p.root_id);
    idsRef.current = ids;
    const sidesForRef = withPos.map((p) => (p.side ?? '').toLowerCase());
    sidesRef.current = sidesForRef;

    const minX = Math.min(...x);
    const maxX = Math.max(...x);
    const minY = Math.min(...y);
    const maxY = Math.max(...y);
    const minZ = Math.min(...z);
    const maxZ = Math.max(...z);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const xs = x.map((v) => (v - cx) / scale);
    const ys = y.map((v) => (v - cy) / scale);
    const zs = z.map((v) => (v - cz) / scale);

    const color = computeMarkerColors(ids, activity, sidesForRef);
    const text = computeHoverTexts(ids, activity, sidesForRef);

    const traces: Plotly.Data[] = [
      {
        type: 'scatter3d',
        x: xs,
        y: ys,
        z: zs,
        mode: 'markers',
        marker: {
          size: 3,
          color,
          colorscale: BRAIN_PLOT_COLORSCALE,
          cmin: 0,
          cmax: 1,
          showscale: false,
          line: { width: 0 },
        },
        hoverinfo: 'text',
        text,
      } as Plotly.Data,
    ];

    const layout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: 'rgba(10,10,18,0.85)',
      plot_bgcolor: 'rgba(10,10,18,0.9)',
      font: { color: '#aaa', size: 10 },
      showlegend: false,
      uirevision: UIREVISION,
      scene: {
        xaxis: { visible: false, range: [-1.2, 1.2] },
        yaxis: { visible: false, range: [-1.2, 1.2] },
        zaxis: { visible: false, range: [-1.2, 1.2] },
        bgcolor: 'rgba(10,10,18,0)',
        camera: cameraRef.current,
        uirevision: UIREVISION,
        aspectmode: 'cube',
        dragmode: 'orbit',
      },
    };

    const el = plotRef.current;
    const onDown = () => { interacting.current = true; };
    const onUp = () => {
      interacting.current = false;
      if (pendingResizeRef.current) pendingResizeRef.current = false;
      if (pendingRestyleRef.current) {
        pendingRestyleRef.current = false;
        setTimeout(() => preserveCameraRestyle(activityRef.current), 0);
      }
    };
    const onDblClick = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if ('stopImmediatePropagation' in e) e.stopImmediatePropagation();
    };
    const touchOpts = { passive: false } as AddEventListenerOptions;
    const keyForThisRun = plotCreationKey;
    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, touchOpts);
    el.addEventListener('touchcancel', onUp, touchOpts);
    el.addEventListener('dblclick', onDblClick, { capture: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp, touchOpts);
    window.addEventListener('blur', onUp);

    const onRelayout = (ev: Record<string, unknown>) => {
      const next = cameraFromRelayout(ev, cameraRef.current);
      if (next) cameraRef.current = next;
    };

    Plotly.newPlot(el, traces, layout, {
      responsive: false,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      staticPlot: false,
    } as Record<string, unknown>)
      .then(() => {
        if (plotKeyRef.current === keyForThisRun) {
          plotReady.current = true;
          (el as unknown as { on?: (e: string, fn: (ev: Record<string, unknown>) => void) => void }).on?.('plotly_relayout', onRelayout);
        }
      })
      .catch((err: unknown) => {
        if (import.meta.env?.DEV) {
          console.error('[BrainOverlay] Plotly.newPlot failed:', err);
        }
      });

    return () => {
      plotKeyRef.current = '';
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('touchstart', onDown, touchOpts);
      el.removeEventListener('touchcancel', onUp, touchOpts);
      el.removeEventListener('dblclick', onDblClick, { capture: true });
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp, touchOpts);
      window.removeEventListener('blur', onUp);
      Plotly.purge(el);
      plotReady.current = false;
    };
    /* activity and withPos intentionally omitted: plot recreation is driven by refs/fingerprint (plotCreationKey) */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, plotCreationKey]);

  // Resize Plotly when container changes — skip while interacting; set pending to replay on onUp
  useEffect(() => {
    if (!embedded || !visible) return;
    const el = plotRef.current;
    if (!el) return;
    const resize = () => {
      if (interacting.current) {
        pendingResizeRef.current = true;
        return;
      }
      if (plotReady.current && el) Plotly.Plots?.resize(el);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const t = setTimeout(resize, 300);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [embedded, visible]);

  // Force resize when panel becomes visible — skip while interacting; set pending to replay on onUp
  useEffect(() => {
    if (!embedded || !visible || !containerVisible) return;
    const el = plotRef.current;
    if (!el) return;
    const resize = () => {
      if (interacting.current) {
        pendingResizeRef.current = true;
        return;
      }
      if (plotReady.current && el) Plotly.Plots?.resize(el);
    };
    const t1 = setTimeout(resize, 50);
    const t2 = setTimeout(resize, 350);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [embedded, visible, containerVisible]);

  // Update colors and hover text when activity changes; restyle only, never relayout camera (avoids mobile snap-back)
  useEffect(() => {
    if (!plotRef.current || !plotReady.current || !visible || idsRef.current.length === 0) return;
    if (interacting.current) {
      pendingRestyleRef.current = true;
      return;
    }
    preserveCameraRestyle(activity);
  }, [activity, visible, preserveCameraRestyle]);

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
      {n === 0 ? (
        <div style={{ padding: 24, fontSize: 11, color: '#888', textAlign: 'center' }}>
          No neuron positions in connectome.
          <br />
          Run process-connectome with coordinates.csv.
        </div>
      ) : (
        <div
          ref={plotRef}
          style={{
            position: 'absolute',
            inset: 0,
            minWidth: 1,
            minHeight: 1,
            touchAction: 'none',
          }}
        />
      )}
    </div>
  );
}
