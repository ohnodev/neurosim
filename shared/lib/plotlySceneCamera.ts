/**
 * Shared Plotly 3D scene camera utilities.
 * Camera lives in layout.scene.camera; use plotly_relayout to capture user changes.
 */
export interface SceneCamera {
  eye: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
}

export const UIREVISION = 'brain-plot-v1';

const DEFAULT_CAMERA: SceneCamera = {
  eye: { x: 0.2, y: -0.2, z: 0.5 },
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

export function getSceneCamera(gd: HTMLDivElement): SceneCamera | null {
  const fullLayout = (gd as unknown as { _fullLayout?: { scene?: { camera?: SceneCamera } } })._fullLayout;
  const cam = fullLayout?.scene?.camera;
  if (!cam?.eye || !cam?.center || !cam?.up) return null;
  return {
    eye: { x: cam.eye.x, y: cam.eye.y, z: cam.eye.z },
    center: { x: cam.center.x, y: cam.center.y, z: cam.center.z },
    up: { x: cam.up.x, y: cam.up.y, z: cam.up.z },
  };
}

export function cameraFromRelayout(ev: Record<string, unknown>, current: SceneCamera): SceneCamera | null {
  const full = ev['scene.camera'] as SceneCamera | undefined;
  if (full?.eye && full?.center && full?.up) {
    return full;
  }
  const hasPartial =
    ev['scene.camera.eye.x'] !== undefined || ev['scene.camera.eye.y'] !== undefined ||
    ev['scene.camera.eye.z'] !== undefined || ev['scene.camera.up.x'] !== undefined ||
    ev['scene.camera.up.y'] !== undefined || ev['scene.camera.up.z'] !== undefined ||
    ev['scene.camera.center.x'] !== undefined || ev['scene.camera.center.y'] !== undefined ||
    ev['scene.camera.center.z'] !== undefined;
  if (!hasPartial) return null;
  return {
    eye: {
      x: (ev['scene.camera.eye.x'] as number) ?? current.eye.x,
      y: (ev['scene.camera.eye.y'] as number) ?? current.eye.y,
      z: (ev['scene.camera.eye.z'] as number) ?? current.eye.z,
    },
    up: {
      x: (ev['scene.camera.up.x'] as number) ?? current.up.x,
      y: (ev['scene.camera.up.y'] as number) ?? current.up.y,
      z: (ev['scene.camera.up.z'] as number) ?? current.up.z,
    },
    center: {
      x: (ev['scene.camera.center.x'] as number) ?? current.center.x,
      y: (ev['scene.camera.center.y'] as number) ?? current.center.y,
      z: (ev['scene.camera.center.z'] as number) ?? current.center.z,
    },
  };
}
