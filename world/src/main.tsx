// Patch canvas getContext so Plotly and other libs use willReadFrequently (see html.spec.whatwg.org - silences Canvas2D getImageData warning)
const orig = HTMLCanvasElement.prototype.getContext;
// @ts-expect-error - monkey-patch; orig has overloads that make assignment strict
HTMLCanvasElement.prototype.getContext = function (contextId: string, options?: object) {
  if (contextId !== '2d') {
    // @ts-expect-error - getContext overloads vary
    return orig.call(this, contextId, options);
  }
  const base = (options && typeof options === 'object') ? (options as Record<string, unknown>) : {};
  const opts = { ...base };
  if (!('willReadFrequently' in opts)) opts.willReadFrequently = true;
  return orig.call(this, contextId, opts);
};

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
