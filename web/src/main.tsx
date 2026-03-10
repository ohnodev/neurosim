// Patch canvas getContext so Plotly and other libs use willReadFrequently (silences Canvas2D warning)
const orig = HTMLCanvasElement.prototype.getContext;
// @ts-expect-error - monkey-patch; orig has overloads that make assignment strict
HTMLCanvasElement.prototype.getContext = function (contextId: string, options?: object) {
  if (contextId === '2d' && options && typeof options === 'object') {
    (options as Record<string, unknown>).willReadFrequently = true;
  } else if (contextId === '2d') {
    options = { willReadFrequently: true };
  }
  // @ts-expect-error - getContext overloads vary; 2d accepts options
  return orig.call(this, contextId, options);
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
