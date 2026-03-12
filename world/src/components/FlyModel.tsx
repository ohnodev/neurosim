import { useRef, useMemo } from 'react';
import { useGLTF, useAnimations } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { FlyState } from '../lib/simWsClient';

const FLY_THRESHOLD = 1.1;
const WING_ANIM_NAMES = ['wing-leftAction', 'wing-rightAction'];
const HEADING_LERP = 0.18;

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
  const headingRef = useRef(0);
  const wasFlyingRef = useRef(false);
  const initializedRef = useRef(false);

  useFrame(() => {
    const state = statesRef.current[index];
    if (!state || !group.current) return;

    const x = state.x ?? 0;
    const y = state.y ?? 0;
    const z = state.z ?? 0;
    const heading = state.heading ?? 0;
    const isFlying = z > FLY_THRESHOLD;

    if (!initializedRef.current) {
      headingRef.current = heading;
      initializedRef.current = true;
    }

    group.current.position.set(x, z, y);

    let d = heading - headingRef.current;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    headingRef.current += d * HEADING_LERP;
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
