// Patch canvas getContext so Plotly uses willReadFrequently (silences Canvas2D warning)
const orig = HTMLCanvasElement.prototype.getContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(HTMLCanvasElement.prototype as any).getContext = function (contextId: string, options?: object) {
  if (contextId === '2d' && options && typeof options === 'object') {
    (options as Record<string, unknown>).willReadFrequently = true;
  } else if (contextId === '2d') {
    options = { willReadFrequently: true };
  }
  // @ts-expect-error - getContext overloads vary by contextId
  return orig.call(this, contextId, options);
};

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
