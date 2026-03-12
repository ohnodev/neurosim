/** Side-effect module: sets window.Plotly. No exports. */
declare module 'plotly-cabal' {}

declare module 'plotly.js-dist-min' {
  interface PlotlyData {
    type?: string;
    x?: number[];
    y?: number[];
    z?: number[];
    mode?: string;
    marker?: Record<string, unknown>;
    text?: string[];
    hoverinfo?: string;
  }
  interface PlotlyLayout {
    autosize?: boolean;
    margin?: Record<string, number>;
    paper_bgcolor?: string;
    plot_bgcolor?: string;
    font?: Record<string, unknown>;
    scene?: Record<string, unknown>;
    showlegend?: boolean;
    uirevision?: string;
  }
  const Plotly: {
    newPlot: (
      el: HTMLElement,
      data: PlotlyData[],
      layout: Partial<PlotlyLayout>,
      opts?: Record<string, unknown>,
    ) => Promise<void>;
    relayout: (el: HTMLElement, update: Record<string, unknown>) => Promise<void>;
    restyle: (el: HTMLElement, update: Record<string, unknown>, indices?: number[]) => void;
    purge: (el: HTMLElement) => void;
  };
  namespace Plotly {
    type Data = PlotlyData;
    type Layout = PlotlyLayout;
  }
  export default Plotly;
}
