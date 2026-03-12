/**
 * Plotly 3D scene camera helpers. Extracts camera from plotly layout / relayout events.
 */
export interface SceneCamera {
  eye: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
}

export const UIREVISION = 'brain-plot-v1';

const DEFAULT_CAMERA: SceneCamera = {
  eye: { x: 1.5, y: 1.5, z: 1.2 },
  center: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 0, z: 1 },
};

export function getDefaultCamera(): SceneCamera {
  return {
    eye: { ...DEFAULT_CAMERA.eye },
    center: { ...DEFAULT_CAMERA.center },
    up: { ...DEFAULT_CAMERA.up },
  };
}

function getLayout(gd: HTMLElement): { scene?: { camera?: SceneCamera } } | undefined {
  if (typeof window === 'undefined') return undefined;
  const gdAny = gd as unknown as { _fullLayout?: { scene?: { camera?: SceneCamera } } };
  return gdAny._fullLayout;
}

export function getSceneCamera(gd: HTMLElement): SceneCamera | undefined {
  const layout = getLayout(gd);
  const cam = layout?.scene?.camera;
  if (!cam || typeof cam.eye !== 'object' || typeof cam.center !== 'object' || typeof cam.up !== 'object') {
    return undefined;
  }
  return {
    eye: { x: cam.eye.x ?? 1.5, y: cam.eye.y ?? 1.5, z: cam.eye.z ?? 1.2 },
    center: { x: cam.center.x ?? 0, y: cam.center.y ?? 0, z: cam.center.z ?? 0 },
    up: { x: cam.up.x ?? 0, y: cam.up.y ?? 0, z: cam.up.z ?? 1 },
  };
}

export function cameraFromRelayout(
  ev: Record<string, unknown>,
  fallback: SceneCamera
): SceneCamera | undefined {
  const eye = ev['scene.camera.eye'] as { x?: number; y?: number; z?: number } | undefined;
  const center = ev['scene.camera.center'] as { x?: number; y?: number; z?: number } | undefined;
  const up = ev['scene.camera.up'] as { x?: number; y?: number; z?: number } | undefined;
  if (!eye && !center && !up) return undefined;
  return {
    eye: {
      x: typeof eye?.x === 'number' ? eye.x : fallback.eye.x,
      y: typeof eye?.y === 'number' ? eye.y : fallback.eye.y,
      z: typeof eye?.z === 'number' ? eye.z : fallback.eye.z,
    },
    center: {
      x: typeof center?.x === 'number' ? center.x : fallback.center.x,
      y: typeof center?.y === 'number' ? center.y : fallback.center.y,
      z: typeof center?.z === 'number' ? center.z : fallback.center.z,
    },
    up: {
      x: typeof up?.x === 'number' ? up.x : fallback.up.x,
      y: typeof up?.y === 'number' ? up.y : fallback.up.y,
      z: typeof up?.z === 'number' ? up.z : fallback.up.z,
    },
  };
}
