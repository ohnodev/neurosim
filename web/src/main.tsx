// Patch canvas getContext so Plotly and other libs use willReadFrequently (silences Canvas2D warning)
const orig = HTMLCanvasElement.prototype.getContext;
function isPlotlyCanvas(el: HTMLCanvasElement): boolean {
  return !!(el.closest?.('.js-plotly-plot') ?? el.hasAttribute?.('data-plotly') ?? el.classList?.contains?.('js-plotly-plot'));
}
// @ts-expect-error - monkey-patch; orig has overloads that make assignment strict
HTMLCanvasElement.prototype.getContext = function (contextId: string, options?: object) {
  if (contextId !== '2d' || !isPlotlyCanvas(this)) {
    // @ts-expect-error - getContext overloads vary
    return orig.call(this, contextId, options);
  }
  const baseOptions = (options && typeof options === 'object') ? options as Record<string, unknown> : {};
  const newOptions = { ...baseOptions, willReadFrequently: true };
  // @ts-expect-error - 2d accepts options
  return orig.call(this, contextId, newOptions);
};

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
