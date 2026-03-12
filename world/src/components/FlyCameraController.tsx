/**
 * Plugin-style camera: fly view (follow fly + user rotates around it) vs god view (orbit).
 * In fly view the orbit target follows the interpolated fly position for smooth tracking.
 */
import { createContext, useContext, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

export type CameraMode = 'god' | 'fly';

export type FlyCameraTarget = {
  x: number;
  y: number;
  z: number;
  heading: number;
};

type FlyCameraContextValue = {
  mode: CameraMode;
  setMode: (m: CameraMode) => void;
  /** Fallback target ref (updated by parent, no re-renders) */
  targetRef: React.MutableRefObject<FlyCameraTarget | null>;
  /** Interpolated fly states by sim index; camera follows this for smooth tracking */
  interpolatedBySimRef: React.MutableRefObject<unknown[]> | null;
  /** Sim index of the fly to follow */
  followSimIndex: number | undefined;
};

const FlyCameraContext = createContext<FlyCameraContextValue | null>(null);

export function useFlyCamera(): FlyCameraContextValue {
  const ctx = useContext(FlyCameraContext);
  if (!ctx) return { mode: 'god', setMode: () => {}, targetRef: { current: null }, interpolatedBySimRef: null, followSimIndex: undefined };
  return ctx;
}

/** Lerp follow; target is interpolated so no jumps - higher value = snappier follow */
const TARGET_SMOOTH = 0.12;
/** Default distance from fly in fly view (a bit closer). */
const FLY_VIEW_DISTANCE = 3;

export function FlyCameraController() {
  const { camera } = useThree();
  const ctx = useContext(FlyCameraContext);
  const controlsRef = useRef<{ target: THREE.Vector3 } | null>(null);
  const smoothedTargetRef = useRef(new THREE.Vector3(0, 0, 0));
  const initialized = useRef(false);

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (ctx?.mode === 'fly') {
      // Prefer interpolated position (smooth) over raw target (jumps on WS updates)
      let want: THREE.Vector3;
      const fly = ctx.interpolatedBySimRef?.current?.[ctx.followSimIndex ?? -1] as { x?: number; y?: number; z?: number } | undefined;
      if (fly && typeof fly.x === 'number' && typeof fly.y === 'number' && typeof fly.z === 'number') {
        // Game coords: x,y horizontal, z up. Three: position [x, z, y].
        want = new THREE.Vector3(fly.x, fly.z, fly.y);
      } else {
        const t = ctx.targetRef?.current;
        if (!t) return;
        want = new THREE.Vector3(t.x, t.z, t.y);
      }
      if (!initialized.current) {
        smoothedTargetRef.current.copy(want);
        initialized.current = true;
      }
      smoothedTargetRef.current.lerp(want, TARGET_SMOOTH);
      const newTarget = smoothedTargetRef.current;
      const delta = newTarget.clone().sub(controls.target);
      controls.target.copy(newTarget);
      camera.position.add(delta);

      // Gently pull closer when far (fly view default)
      const dist = camera.position.distanceTo(controls.target);
      if (dist > FLY_VIEW_DISTANCE) {
        const dir = camera.position.clone().sub(controls.target).normalize();
        const desired = controls.target.clone().add(dir.multiplyScalar(FLY_VIEW_DISTANCE));
        camera.position.lerp(desired, 0.035);
      }
    } else {
      initialized.current = false;
    }
  }, -2);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (
    <OrbitControls
      ref={controlsRef as any}
      maxDistance={1000}
    />
  );
}

export { FlyCameraContext };
