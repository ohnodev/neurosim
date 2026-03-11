import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

/** Wing materials from glTF. Fallback object names if material names not set. */
const WING_MATERIAL_NAMES = ['fly-white', 'flywings-dark'];
const WING_OBJECT_NAMES_FALLBACK = ['Object_4', 'Object_5'];

function RotatingFly() {
  const group = useRef<THREE.Group>(null);
  const { scene } = useGLTF('/models/low_poly_fly/scene.gltf');
  const wingsRef = useRef<THREE.Mesh[]>([]);

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    wingsRef.current = [];
    c.traverse((obj) => {
      if (obj.isMesh) {
        const mesh = obj as THREE.Mesh;
        const mat = mesh.material;
        const matName = (Array.isArray(mat) ? mat[0]?.name : mat?.name) ?? '';
        const byMat = WING_MATERIAL_NAMES.includes(matName);
        const byObj = obj.name && WING_OBJECT_NAMES_FALLBACK.includes(obj.name);
        if (byMat || byObj) wingsRef.current.push(mesh);
      }
    });
    return c;
  }, [scene]);

  useFrame((_, delta) => {
    if (group.current) {
      group.current.rotation.y += delta * 0.6;
    }
    const t = performance.now() * 0.012;
    const flapX = Math.sin(t) * 0.85;
    const flapZ = Math.sin(t) * 0.35;
    for (const wing of wingsRef.current) {
      wing.rotation.x = flapX;
      wing.rotation.z = flapZ;
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
