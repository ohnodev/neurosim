/**
 * Plugin-style camera: fly view (follow current fly) vs god view (orbit).
 * Consume via useFlyCamera() and render <FlyCameraController /> inside Canvas.
 */
import { createContext, useContext, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
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

const FOLLOW_DIST = 2.5;
const FOLLOW_HEIGHT = 1.2;
const SMOOTH = 0.12;

export function FlyCameraController({ enabled = true }: { enabled?: boolean }) {
  const { camera } = useThree();
  const ctx = useContext(FlyCameraContext);
  const posRef = useRef(new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z));
  const lookRef = useRef(new THREE.Vector3(0, 0, 0));

  useFrame(() => {
    if (!enabled || !ctx || ctx.mode !== 'fly' || !ctx.target) return;
    const t = ctx.target;
    // Game coords: x,y horizontal, z up. Three: position [x, z, y].
    const tx = t.x, ty = t.z, tz = t.y;
    const h = t.heading;
    const back = FOLLOW_DIST;
    const ex = tx - Math.sin(h) * back;
    const ey = ty + FOLLOW_HEIGHT;
    const ez = tz - Math.cos(h) * back;
    lookRef.current.set(tx, ty, tz);
    posRef.current.x += (ex - posRef.current.x) * SMOOTH;
    posRef.current.y += (ey - posRef.current.y) * SMOOTH;
    posRef.current.z += (ez - posRef.current.z) * SMOOTH;
    camera.position.copy(posRef.current);
    camera.lookAt(lookRef.current);
    camera.updateProjectionMatrix();
  });

  return null;
}

export { FlyCameraContext };
