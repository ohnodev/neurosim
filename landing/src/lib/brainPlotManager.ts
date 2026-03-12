/**
 * External plot manager for the landing brain 3D plot.
 * Owns all Plotly calls; preserves scene camera after restyle (fixes mobile reset).
 * responsive: false + debounced resize to avoid viewport-driven relayout on mobile.
 */
import Plotly from 'plotly.js-dist-min';

function computeColor(activity: Record<string, number>, id: string, side: string): number {
  const a = activity[id] ?? 0;
  if (a <= 0) return 0;
  const s = side.toLowerCase();
  if (s === 'left') return 0.3 + a * 0.4;
  if (s === 'right') return 0.7 + a * 0.3;
  return 0.5 + a * 0.2;
}

function computeHoverText(id: string, side: string, activity: Record<string, number>): string {
  const a = activity[id] ?? 0;
  const sideLabel = side || 'center';
  return `ID: ${id.slice(-8)}\n${sideLabel} | ${(a * 100).toFixed(0)}%`;
}

/** Copy current scene camera from Plotly internal layout (preserve after restyle on mobile). */
function getSceneCamera(gd: HTMLDivElement): Record<string, { x: number; y: number; z: number }> | null {
  const fullLayout = (gd as unknown as { _fullLayout?: { scene?: { camera?: Record<string, { x: number; y: number; z: number }> } } })._fullLayout;
  const cam = fullLayout?.scene?.camera;
  if (!cam?.eye || !cam?.center || !cam?.up) return null;
  return {
    eye: { x: cam.eye.x, y: cam.eye.y, z: cam.eye.z },
    center: { x: cam.center.x, y: cam.center.y, z: cam.center.z },
    up: { x: cam.up.x, y: cam.up.y, z: cam.up.z },
  };
}

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
  const touchOpts: AddEventListenerOptions = { passive: false };

  function doRestyle(): void {
    if (!el || !plotReady || ids.length === 0) return;
    const gd = el;
    const savedCamera = getSceneCamera(gd);
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
    if (pendingRestyle) {
      pendingRestyle = false;
      doRestyle();
    }
  }

  function onDblClick(e: Event): void {
    e.preventDefault();
  }

  function update(): void {
    if (!el || !plotReady || ids.length === 0) return;
    if (interacting) {
      pendingRestyle = true;
      return;
    }
    doRestyle();
  }

  function mount(
    container: HTMLDivElement,
    neuronIds: string[],
    sideLabels: string[],
    xs: number[],
    ys: number[],
    zs: number[],
  ): void {
    if (el !== null) return;
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
          colorscale: [
            [0, '#888888'],
            [0.3, '#4a7de8'],
            [0.5, '#e8b84a'],
            [0.7, '#e85a4a'],
            [1, '#ff8c7a'],
          ],
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

    Plotly.newPlot(container, traces, layout, {
      responsive: false,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      staticPlot: false,
    } as Record<string, unknown>).then(() => {
      plotReady = true;
      if (el && Plotly.Plots) Plotly.Plots.resize(el);
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
