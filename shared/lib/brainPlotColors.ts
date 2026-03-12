/**
 * Brain plot neuron color and hover text.
 */
export const BRAIN_PLOT_COLORSCALE: [number, string][] = [
  [0, '#444'],
  [0.2, '#4a6'],
  [0.5, '#8c4'],
  [0.8, '#f84'],
  [1, '#f44'],
];

export function computeColor(
  activity: Record<string, number>,
  neuronId: string,
  _side: string
): number {
  const v = activity[neuronId];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

export function computeHoverText(
  neuronId: string,
  side: string,
  activity: Record<string, number>
): string {
  const v = activity[neuronId];
  const act = typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '0';
  const sideLabel = side ? ` (${side})` : '';
  return `${neuronId}${sideLabel}\nactivity: ${act}`;
}
