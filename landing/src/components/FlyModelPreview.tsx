import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

const WING_NAMES = ['Object_4', 'Object_5', 'Object_6'];

function RotatingFly() {
  const group = useRef<THREE.Group>(null);
  const { scene } = useGLTF('/models/low_poly_fly/scene.gltf');
  const wingsRef = useRef<THREE.Object3D[]>([]);

  const cloned = useMemo(() => scene.clone(true), [scene]);

  useEffect(() => {
    wingsRef.current = [];
    cloned.traverse((obj) => {
      if (obj.name && WING_NAMES.includes(obj.name)) wingsRef.current.push(obj);
    });
  }, [cloned]);

  useFrame((_, delta) => {
    if (group.current) {
      group.current.rotation.y += delta * 0.6;
    }
    const flap = Math.sin(performance.now() * 0.015) * 0.35;
    for (const wing of wingsRef.current) {
      wing.rotation.x = flap;
    }
  });

  return (
    <group ref={group}>
      <primitive object={cloned} scale={0.1} />
    </group>
  );
}

export function FlyModelPreview() {
  return (
    <div style={{ width: '100%', height: '100%', background: 'rgba(0,0,0,0.3)' }}>
      <Canvas
        camera={{ position: [0, 0, 2.5], fov: 45 }}
        gl={{ antialias: true }}
        style={{ width: '100%', height: '100%' }}
      >
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 2, 2]} intensity={1.2} />
        <pointLight position={[-1, -1, 1]} intensity={0.5} />
        <RotatingFly />
      </Canvas>
    </div>
  );
}
