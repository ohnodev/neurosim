/**
 * Plotly with restyle override for mobile.
 * On touch devices, restyle is a no-op to avoid 3D camera reset (Plotly bug).
 */
import Plotly from 'plotly.js-dist-min';

function isTouchDevice(): boolean {
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
}

const originalRestyle = Plotly.restyle.bind(Plotly);

// Plotly typings declare restyle as void; it actually returns Promise
(Plotly as { restyle: typeof originalRestyle }).restyle = function patchedRestyle(
  gd: Parameters<typeof originalRestyle>[0],
  update: Parameters<typeof originalRestyle>[1],
  traceIndices?: Parameters<typeof originalRestyle>[2]
) {
  if (isTouchDevice()) return Promise.resolve(gd);
  return originalRestyle(gd, update, traceIndices);
};

export default Plotly;
