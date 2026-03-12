/**
 * Shared brain plot color and hover text helpers.
 * Used by landing (brainPlotManager) and world (BrainOverlay).
 */

export const BRAIN_PLOT_COLORSCALE: [number, string][] = [
  [0, '#888888'],
  [0.3, '#4a7de8'],
  [0.5, '#e8b84a'],
  [0.7, '#e85a4a'],
  [1, '#ff8c7a'],
];

export function computeColor(activity: Record<string, number>, id: string, side: string): number {
  const a = activity[id] ?? 0;
  if (a <= 0) return 0;
  const s = side.toLowerCase();
  if (s === 'left') return 0.3 + a * 0.4;
  if (s === 'right') return 0.7 + a * 0.3;
  return 0.5 + a * 0.2;
}

export function computeHoverText(id: string, side: string, activity: Record<string, number>): string {
  const a = activity[id] ?? 0;
  const sideLabel = side || 'center';
  return `ID: ${id.slice(-8)}\n${sideLabel} | ${(a * 100).toFixed(0)}%`;
}

export function computeMarkerColors(
  ids: string[],
  activity: Record<string, number>,
  sides: string[]
): number[] {
  return ids.map((id, i) => computeColor(activity, id, sides[i] ?? ''));
}

export function computeHoverTexts(
  ids: string[],
  activity: Record<string, number>,
  sides: string[]
): string[] {
  return ids.map((id, i) => computeHoverText(id, sides[i] ?? '', activity));
}
