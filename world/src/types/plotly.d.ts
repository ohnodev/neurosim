/**
 * Module declaration for plotly.js-dist-min (no upstream types).
 * Minimal typing for 3D scatter and overlay usage.
 */
declare module 'plotly.js-dist-min' {
  interface PlotlyData {
    type?: string;
    x?: unknown;
    y?: unknown;
    z?: unknown;
    mode?: string;
    marker?: Record<string, unknown>;
    hoverinfo?: string;
    text?: string[] | string;
    [key: string]: unknown;
  }

  interface PlotlyLayout {
    scene?: Record<string, unknown>;
    [key: string]: unknown;
  }

  const Plotly: {
    Plots?: { resize: (el: HTMLElement) => void };
    newPlot: (
      el: HTMLElement,
      data: PlotlyData[],
      layout: Partial<PlotlyLayout>,
      options?: Record<string, unknown>,
    ) => Promise<void>;
    restyle: (
      el: HTMLElement,
      update: Record<string, unknown>,
      indices?: number[],
    ) => void;
    purge: (el: HTMLElement) => void;
  };

  namespace Plotly {
    type Data = PlotlyData;
    type Layout = PlotlyLayout;
  }

  export default Plotly;
}
