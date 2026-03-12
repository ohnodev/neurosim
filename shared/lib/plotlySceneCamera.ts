/**
 * Shared Plotly 3D scene camera read utility.
 * Used by landing (brainPlotManager) and world (BrainOverlay) to preserve
 * camera after restyle on mobile.
 */
export type SceneCamera = Record<string, { x: number; y: number; z: number }>;

/**
 * Copy current scene camera from Plotly internal layout (preserve after restyle on mobile).
 */
export function getSceneCamera(gd: HTMLDivElement): SceneCamera | null {
  const fullLayout = (gd as unknown as { _fullLayout?: { scene?: { camera?: Record<string, { x: number; y: number; z: number }> } } })._fullLayout;
  const cam = fullLayout?.scene?.camera;
  if (!cam?.eye || !cam?.center || !cam?.up) return null;
  return {
    eye: { x: cam.eye.x, y: cam.eye.y, z: cam.eye.z },
    center: { x: cam.center.x, y: cam.center.y, z: cam.center.z },
    up: { x: cam.up.x, y: cam.up.y, z: cam.up.z },
  };
}
