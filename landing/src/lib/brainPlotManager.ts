/**
 * External plot manager for the landing brain 3D plot.
 * Owns all Plotly calls; preserves scene camera after restyle (fixes mobile reset).
 * responsive: false + debounced resize to avoid viewport-driven relayout on mobile.
 */
import Plotly from 'plotly.js-dist-min';
import { getSceneCamera } from '../../../shared/lib/plotlySceneCamera';
import {
  computeColor,
  computeHoverText,
  BRAIN_PLOT_COLORSCALE,
} from '../../../shared/lib/brainPlotColors';
import { isTouchDevice } from '../../../shared/lib/isTouchDevice';

export type GetActivity = () => Record<string, number>;

const RESIZE_DEBOUNCE_MS = 400;

export function createBrainPlotManager(getActivity: GetActivity) {
  let el: HTMLDivElement | null = null;
  let ids: string[] = [];
  let sides: string[] = [];
  let plotReady = false;
  let interacting = false;
  let pendingRestyle = false;
  let resizeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const touchOpts: AddEventListenerOptions = { passive: true };

  function doRestyle(restoreCamera = true): void {
    if (!el || !plotReady || ids.length === 0) return;
    const gd = el;
    const savedCamera = restoreCamera ? getSceneCamera(gd) : null;
    const activity = getActivity();
    const color = ids.map((id, i) => computeColor(activity, id, sides[i] ?? ''));
    const text = ids.map((id, i) => computeHoverText(id, sides[i] ?? '', activity));
    Plotly.restyle(gd, { 'marker.color': [color], text: [text] }, [0]);
    if (savedCamera) {
      Plotly.relayout(gd, { 'scene.camera': savedCamera } as Record<string, unknown>);
    }
  }

  function onDown(): void {
    interacting = true;
  }

  function onUp(): void {
    interacting = false;
    if (pendingRestyle && !isTouchDevice()) {
      pendingRestyle = false;
      setTimeout(() => doRestyle(false), 0);
    } else if (pendingRestyle) {
      pendingRestyle = false;
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
    doRestyle(false);
  }

  function mount(
    container: HTMLDivElement,
    neuronIds: string[],
    sideLabels: string[],
    xs: number[],
    ys: number[],
    zs: number[],
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

    const activity = getActivity();
    const color = ids.map((id, i) => computeColor(activity, id, sides[i] ?? ''));
    const text = ids.map((id, i) => computeHoverText(id, sides[i] ?? '', activity));

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
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#aaa', size: 10 },
      showlegend: false,
      uirevision: 'brain-plot',
      scene: {
        xaxis: { visible: false, range: [-1.2, 1.2] },
        yaxis: { visible: false, range: [-1.2, 1.2] },
        zaxis: { visible: false, range: [-1.2, 1.2] },
        bgcolor: 'rgba(0,0,0,0)',
        camera: { eye: { x: 0.2, y: -0.2, z: 0.5 } },
        aspectmode: 'cube',
        dragmode: 'orbit',
      },
    };

    function onResize(): void {
      if (resizeTimeoutId != null) clearTimeout(resizeTimeoutId);
      resizeTimeoutId = setTimeout(() => {
        resizeTimeoutId = null;
        if (el && plotReady && !interacting && Plotly.Plots) {
          Plotly.Plots.resize(el);
        }
      }, RESIZE_DEBOUNCE_MS);
    }

    container.addEventListener('mousedown', onDown);
    container.addEventListener('touchstart', onDown, touchOpts);
    container.addEventListener('touchcancel', onUp, touchOpts);
    container.addEventListener('dblclick', onDblClick, { capture: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp, touchOpts);
    window.addEventListener('blur', onUp);

    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    const plotPromise = Plotly.newPlot(container, traces, layout, {
      responsive: false,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      staticPlot: false,
    } as Record<string, unknown>);
    plotPromise.then(() => {
      if (el && Plotly.Plots) {
        plotReady = true;
        Plotly.Plots.resize(el);
      }
    }).catch((err) => {
      if (import.meta.env?.DEV) {
        console.error('[brainPlotManager] Plotly.newPlot failed:', err);
      }
    });
  }

  function destroy(): void {
    if (!el) return;
    if (resizeTimeoutId != null) {
      clearTimeout(resizeTimeoutId);
      resizeTimeoutId = null;
    }
    if (resizeObserver && el) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    el.removeEventListener('mousedown', onDown);
    el.removeEventListener('touchstart', onDown, touchOpts);
    el.removeEventListener('touchcancel', onUp, touchOpts);
    el.removeEventListener('dblclick', onDblClick, { capture: true });
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchend', onUp, touchOpts);
    window.removeEventListener('blur', onUp);
    Plotly.purge(el);
    el = null;
    ids = [];
    sides = [];
    plotReady = false;
    interacting = false;
    pendingRestyle = false;
  }

  return { mount, update, destroy };
}
