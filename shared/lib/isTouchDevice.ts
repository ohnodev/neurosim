/** Plotly restyle resets 3D camera on mobile; used to skip restyle on touch devices. */
export function isTouchDevice(): boolean {
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
}
