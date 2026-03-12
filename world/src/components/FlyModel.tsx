import { useRef, useMemo } from 'react';
import { useGLTF, useAnimations } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { FlyState } from '../lib/simWsClient';

const FLY_THRESHOLD = 1.1;
const WING_ANIM_NAMES = ['wing-leftAction', 'wing-rightAction'];
const MIN_MOVEMENT_SQ = 0.001;
/** Frame-rate independent: alpha = 1-exp(-k*delta), k≈14.5 gives ~0.38 at 30fps */
const HEADING_LERP_RATE = 14.5;
const HEADING_DEAD_ZONE = 0.15;

export function FlyModel({
  statesRef,
  index,
}: {
  statesRef: React.MutableRefObject<FlyState[]>;
  index: number;
}) {
  const group = useRef<THREE.Group>(null);
  const sceneRef = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF('/models/fly-animated/fly2-animation.glb');
  const { actions } = useAnimations(animations, sceneRef);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const prevPosRef = useRef({ x: 0, y: 0 });
  const headingRef = useRef(0);
  const targetHeadingRef = useRef(0);
  const wasFlyingRef = useRef(false);
  const initializedRef = useRef(false);

  useFrame((_, delta) => {
    const state = statesRef.current[index];
    if (!state || !group.current) return;

    const x = state.x ?? 0;
    const y = state.y ?? 0;
    const z = state.z ?? 0;
    const isFlying = z > FLY_THRESHOLD;

    const dx = x - prevPosRef.current.x;
    const dy = y - prevPosRef.current.y;
    prevPosRef.current = { x, y };
    const moveSq = dx * dx + dy * dy;
    if (moveSq > MIN_MOVEMENT_SQ) {
      const newTarget = Math.atan2(dx, dy) + Math.PI;
      let diff = newTarget - targetHeadingRef.current;
      if (diff > Math.PI) diff -= 2 * Math.PI;
      if (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) > HEADING_DEAD_ZONE) targetHeadingRef.current = newTarget;
    }
    if (!initializedRef.current) {
      headingRef.current = targetHeadingRef.current;
      initializedRef.current = true;
    }

    group.current.position.set(x, z, y);

    const alpha = Math.min(1, 1 - Math.exp(-HEADING_LERP_RATE * delta));
    let d = targetHeadingRef.current - headingRef.current;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    headingRef.current += d * alpha;
    group.current.rotation.y = headingRef.current;

    if (isFlying !== wasFlyingRef.current) {
      wasFlyingRef.current = isFlying;
      for (const name of WING_ANIM_NAMES) {
        const action = actions[name];
        if (!action) continue;
        if (isFlying) {
          action.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveTimeScale(2).play();
        } else {
          action.stop();
        }
      }
    }
  });

  return (
    <group ref={group}>
      <primitive ref={sceneRef} object={cloned} scale={0.08} rotation={[0, 0, 0]} />
    </group>
  );
}
