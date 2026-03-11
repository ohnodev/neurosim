/**
 * Plugin-style camera: fly view (follow fly + user rotates around it) vs god view (orbit).
 * In fly view the orbit target follows the fly smoothly; user can rotate the camera around the fly.
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
  target: FlyCameraTarget | null;
};

const FlyCameraContext = createContext<FlyCameraContextValue | null>(null);

export function useFlyCamera(): FlyCameraContextValue {
  const ctx = useContext(FlyCameraContext);
  if (!ctx) return { mode: 'god', setMode: () => {}, target: null };
  return ctx;
}

/** Smooth follow: orbit target tracks fly; camera moves by same delta to avoid jitter. */
const TARGET_SMOOTH = 0.08;

export function FlyCameraController() {
  const { camera } = useThree();
  const ctx = useContext(FlyCameraContext);
  const controlsRef = useRef<{ target: THREE.Vector3 } | null>(null);
  const smoothedTargetRef = useRef(new THREE.Vector3(0, 0, 0));
  const initialized = useRef(false);

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (ctx?.mode === 'fly' && ctx?.target) {
      const t = ctx.target;
      // Game coords: x,y horizontal, z up. Three: position [x, z, y].
      const tx = t.x, ty = t.z, tz = t.y;
      const want = new THREE.Vector3(tx, ty, tz);
      if (!initialized.current) {
        smoothedTargetRef.current.copy(want);
        initialized.current = true;
      }
      smoothedTargetRef.current.lerp(want, TARGET_SMOOTH);
      const newTarget = smoothedTargetRef.current;
      const delta = newTarget.clone().sub(controls.target);
      controls.target.copy(newTarget);
      camera.position.add(delta);
    } else {
      initialized.current = false;
    }
  }, -2);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <OrbitControls ref={controlsRef as any} />;
}

export { FlyCameraContext };
