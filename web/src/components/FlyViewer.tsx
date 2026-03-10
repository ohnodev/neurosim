import { useRef, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

interface FlyState {
  x: number;
  y: number;
  z: number;
  heading: number;
  t: number;
  hunger?: number;
}

interface WorldSource {
  id: string;
  type: 'food' | 'light';
  x: number;
  y: number;
  z: number;
  radius: number;
}

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const API_WS = import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws';

function FlyMesh({ state }: { state: FlyState }) {
  const mesh = useRef<THREE.Mesh>(null);
  const lerp = useRef(state);

  useEffect(() => {
    if (!mesh.current) return;
    lerp.current = { ...state };
  }, [state]);

  return (
    <group position={[state.x, state.z, state.y]} rotation={[0, state.heading, 0]}>
      <mesh ref={mesh}>
        <capsuleGeometry args={[0.15, 0.4, 4, 8]} />
        <meshStandardMaterial color="#333" metalness={0.3} roughness={0.7} />
      </mesh>
      <mesh position={[0.2, 0.15, 0]} rotation={[0, 0, Math.PI / 2]}>
        <planeGeometry args={[0.4, 0.08]} />
        <meshStandardMaterial color="#666" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-0.2, 0.15, 0]} rotation={[0, 0, Math.PI / 2]}>
        <planeGeometry args={[0.4, 0.08]} />
        <meshStandardMaterial color="#666" side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function WorldSources({ sources }: { sources: WorldSource[] }) {
  return (
    <>
      {sources.map((s) => (
        <group key={s.id} position={[s.x, s.z, s.y]}>
          <mesh>
            <sphereGeometry args={[0.4, 16, 16]} />
            <meshStandardMaterial
              color={s.type === 'food' ? '#e8a838' : '#88ccff'}
              emissive={s.type === 'light' ? '#4488ff' : '#332200'}
              emissiveIntensity={s.type === 'light' ? 0.6 : 0.1}
            />
          </mesh>
        </group>
      ))}
    </>
  );
}

export default function FlyViewer() {
  const [flyState, setFlyState] = useState<FlyState>({ x: 0, y: 0, z: 2, heading: 0, t: 0, hunger: 100 });
  const [sources, setSources] = useState<WorldSource[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch(API_BASE + '/api/world')
      .then((r) => r.json())
      .then((d) => setSources(d.sources || []))
      .catch(() => setSources([]));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(API_WS);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
    };
    ws.onerror = () => setError('WebSocket error');
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.error) setError(data.error);
        else {
          if (data.fly) setFlyState(data.fly);
          if (data.activity) setActiveCount(Object.keys(data.activity).length);
        }
      } catch {}
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const stimulate = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stimulate', strength: 0.9 }));
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {error && (
        <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#f88', padding: '8px 16px', borderRadius: 8 }}>
          {error}
        </div>
      )}
      {connected && (
        <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={stimulate} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#333', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
              Stimulate
            </button>
            <span style={{ background: '#0a0', color: '#fff', padding: '4px 12px', borderRadius: 8 }}>Connected</span>
            {activeCount > 0 && <span style={{ color: '#aaa', fontSize: 12 }}>Active: {activeCount}</span>}
          </div>
          <div style={{ width: 120, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ fontSize: 10, color: '#888', padding: '2px 6px' }}>Hunger</div>
            <div style={{ height: 8, background: '#333', borderRadius: 2, margin: '0 4px 4px', overflow: 'hidden' }}>
              <div style={{ width: `${flyState.hunger ?? 100}%`, height: '100%', background: (flyState.hunger ?? 100) > 50 ? '#5a5' : (flyState.hunger ?? 0) > 20 ? '#ca0' : '#c44', transition: 'width 0.2s' }} />
            </div>
          </div>
        </div>
      )}
      <Canvas camera={{ position: [8, 6, 8], fov: 50 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
        <OrbitControls />
        <FlyMesh state={flyState} />
        <WorldSources sources={sources} />
        <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[50, 50]} />
          <meshStandardMaterial color="#1a1a2e" />
        </mesh>
      </Canvas>
    </div>
  );
}
