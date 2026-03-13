/**
 * Shared brain plot manager. Uses Plotly.react for updates (camera preservation).
 * plotly-cabal (patched Plotly.js) sets window.Plotly in browser.
 * Consumer must import 'plotly-cabal' before using.
 * Used by landing BrainPlot and world BrainOverlay.
 */

interface PlotlyTrace {
  type?: string;
  x?: number[];
  y?: number[];
  z?: number[];
  mode?: string;
  marker?: Record<string, unknown>;
  text?: string[];
  hoverinfo?: string;
}

interface PlotlyLayoutScene {
  xaxis?: Record<string, unknown>;
  yaxis?: Record<string, unknown>;
  zaxis?: Record<string, unknown>;
  bgcolor?: string;
  camera?: unknown;
  uirevision?: string;
  aspectmode?: string;
  dragmode?: string;
}

declare global {
  interface Window {
    Plotly?: {
      newPlot: (el: HTMLElement, data: PlotlyTrace[], layout: unknown, opts?: unknown) => Promise<void>;
      react: (el: HTMLElement, data: unknown[], layout: unknown, opts?: unknown) => void;
      Plots?: { resize: (el: HTMLElement) => void };
      purge: (el: HTMLElement) => void;
    };
  }
}

function getPlotly() {
  const P = typeof window !== 'undefined' ? window.Plotly : undefined;
  if (!P) throw new Error('plotly-cabal: window.Plotly not set');
  return P;
}

import {
  getSceneCamera,
  getDefaultCamera,
  cameraFromRelayout,
  type SceneCamera,
  UIREVISION,
} from './plotlySceneCamera';
import {
  computeColor,
  computeHoverText,
  BRAIN_PLOT_COLORSCALE,
} from './brainPlotColors';

export type GetActivity = () => Record<string, number>;

export interface BrainPlotManagerOptions {
  paperBgColor?: string;
  plotBgColor?: string;
  sceneBgColor?: string;
}

const RESIZE_DEBOUNCE_MS = 400;

export function createBrainPlotManager(
  getActivity: GetActivity,
  options?: BrainPlotManagerOptions
) {
  const paperBg = options?.paperBgColor ?? 'rgba(0,0,0,0)';
  const plotBg = options?.plotBgColor ?? 'rgba(0,0,0,0)';
  const sceneBg = options?.sceneBgColor ?? 'rgba(0,0,0,0)';

  let el: HTMLDivElement | null = null;
  let ids: string[] = [];
  let sides: string[] = [];
  let plotReady = false;
  let interacting = false;
  let pendingRestyle = false;
  let cameraRef: SceneCamera = getDefaultCamera();
  let dataRevision = 0;
  let xs: number[] = [];
  let ys: number[] = [];
  let zs: number[] = [];
  const config = {
    responsive: false,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    staticPlot: false,
  } as Record<string, unknown>;
  let resizeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let onRelayoutRef: ((ev: Record<string, unknown>) => void) | null = null;

  function doUpdate(): void {
    if (!el || !plotReady || ids.length === 0) return;
    const gd = el;
    const live = getSceneCamera(gd);
    if (live) cameraRef = live;
    const activity = getActivity();
    const color = ids.map((id, i) => computeColor(activity, id, sides[i] ?? ''));
    const text = ids.map((id, i) => computeHoverText(id, sides[i] ?? '', activity));
    const data: PlotlyTrace[] = [
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
      } as PlotlyTrace,
    ];
    dataRevision += 1;
    const scene: Partial<PlotlyLayoutScene> = {
      xaxis: { visible: false, range: [-1.2, 1.2] },
      yaxis: { visible: false, range: [-1.2, 1.2] },
      zaxis: { visible: false, range: [-1.2, 1.2] },
      bgcolor: sceneBg,
      uirevision: UIREVISION,
      aspectmode: 'cube',
      dragmode: 'orbit',
    };
    scene.camera = cameraRef;
    const layout: Record<string, unknown> = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: '#aaa', size: 10 },
      showlegend: false,
      ...({ datarevision: dataRevision } as Record<string, unknown>),
      uirevision: UIREVISION,
      scene,
    };
    getPlotly().react(gd, data, layout, config);
  }

  function onDown(): void {
    interacting = true;
  }

  function onUp(): void {
    interacting = false;
    if (pendingRestyle) {
      pendingRestyle = false;
      setTimeout(() => doUpdate(), 0);
    }
  }

  function onDblClick(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function update(): void {
    if (!el || !plotReady || ids.length === 0) return;
    if (interacting) {
      pendingRestyle = true;
      return;
    }
    doUpdate();
  }

  function mount(
    container: HTMLDivElement,
    neuronIds: string[],
    sideLabels: string[],
    xsIn: number[],
    ysIn: number[],
    zsIn: number[],
    onReady?: () => void,
  ): void {
    if (el !== null) {
      if (import.meta.env?.DEV) {
        console.warn('[brainPlotManager] mount called but already mounted; call destroy() first.');
      }
      return;
    }
    el = container;
    ids = neuronIds;
    sides = sideLabels;
    xs = xsIn;
    ys = ysIn;
    zs = zsIn;

    const activity = getActivity();
    const color = ids.map((id, i) => computeColor(activity, id, sides[i] ?? ''));
    const text = ids.map((id, i) => computeHoverText(id, sides[i] ?? '', activity));

    const traces: PlotlyTrace[] = [
      {
        type: 'scatter3d',
        x: xsIn,
        y: ysIn,
        z: zsIn,
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
      } as PlotlyTrace,
    ];

    const layout: Record<string, unknown> = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: '#aaa', size: 10 },
      showlegend: false,
      uirevision: UIREVISION,
      scene: {
        xaxis: { visible: false, range: [-1.2, 1.2] },
        yaxis: { visible: false, range: [-1.2, 1.2] },
        zaxis: { visible: false, range: [-1.2, 1.2] },
        bgcolor: sceneBg,
        camera: cameraRef,
        uirevision: UIREVISION,
        aspectmode: 'cube',
        dragmode: 'orbit',
      },
    };

    function onResize(): void {
      if (resizeTimeoutId != null) clearTimeout(resizeTimeoutId);
      resizeTimeoutId = setTimeout(() => {
        resizeTimeoutId = null;
        const P = getPlotly();
        if (el && plotReady && !interacting && P.Plots) {
          P.Plots.resize(el);
        }
      }, RESIZE_DEBOUNCE_MS);
    }

    container.addEventListener('mousedown', onDown);
    container.addEventListener('touchstart', onDown);
    container.addEventListener('touchcancel', onUp);
    container.addEventListener('dblclick', onDblClick, { capture: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('blur', onUp);

    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    const onRelayout = (ev: Record<string, unknown>) => {
      const next = cameraFromRelayout(ev, cameraRef);
      if (next) cameraRef = next;
    };
    onRelayoutRef = onRelayout;

    const Plotly = getPlotly();
    const plotPromise = Plotly.newPlot(container, traces, layout, config);
    plotPromise.then(() => {
      if (el && Plotly.Plots) {
        plotReady = true;
        (el as unknown as { on?: (e: string, fn: (ev: Record<string, unknown>) => void) => void }).on?.('plotly_relayout', onRelayout);
        Plotly.Plots.resize(el);
        onReady?.();
      }
    }).catch((err: unknown) => {
      if (import.meta.env?.DEV) {
        console.error('[brainPlotManager] Plotly.newPlot failed:', err);
      }
    });
  }

  function destroy(): void {
    if (!el) return;
    if (onRelayoutRef) {
      (el as unknown as { off?: (e: string, fn: (ev: Record<string, unknown>) => void) => void }).off?.('plotly_relayout', onRelayoutRef);
      onRelayoutRef = null;
    }
    if (resizeTimeoutId != null) {
      clearTimeout(resizeTimeoutId);
      resizeTimeoutId = null;
    }
    if (resizeObserver && el) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    el.removeEventListener('mousedown', onDown);
    el.removeEventListener('touchstart', onDown);
    el.removeEventListener('touchcancel', onUp);
    el.removeEventListener('dblclick', onDblClick, { capture: true });
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchend', onUp);
    window.removeEventListener('blur', onUp);
    getPlotly().purge(el);
    el = null;
    ids = [];
    sides = [];
    xs = [];
    ys = [];
    zs = [];
    plotReady = false;
    interacting = false;
    pendingRestyle = false;
    cameraRef = getDefaultCamera();
  }

  return { mount, update, destroy };
}
