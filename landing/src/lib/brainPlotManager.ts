/**
 * External plot manager for the landing brain 3D plot.
 * Owns all Plotly calls and only updates when not interacting, so React never triggers restyle during touch/drag.
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

export type GetActivity = () => Record<string, number>;

export function createBrainPlotManager(getActivity: GetActivity) {
  let el: HTMLDivElement | null = null;
  let ids: string[] = [];
  let sides: string[] = [];
  let plotReady = false;
  let interacting = false;
  let pendingRestyle = false;
  const touchOpts: AddEventListenerOptions = { passive: false };

  function doRestyle(): void {
    if (!el || !plotReady || ids.length === 0) return;
    const activity = getActivity();
    const color = ids.map((id, i) => computeColor(activity, id, sides[i] ?? ''));
    const text = ids.map((id, i) => computeHoverText(id, sides[i] ?? '', activity));
    Plotly.restyle(el, { 'marker.color': [color], text: [text] }, [0]);
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

    container.addEventListener('mousedown', onDown);
    container.addEventListener('touchstart', onDown, touchOpts);
    container.addEventListener('touchcancel', onUp, touchOpts);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp, touchOpts);
    window.addEventListener('blur', onUp);

    Plotly.newPlot(container, traces, layout, {
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      staticPlot: false,
    } as Record<string, unknown>).then(() => {
      plotReady = true;
    });
  }

  function destroy(): void {
    if (!el) return;
    el.removeEventListener('mousedown', onDown);
    el.removeEventListener('touchstart', onDown, touchOpts);
    el.removeEventListener('touchcancel', onUp, touchOpts);
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
