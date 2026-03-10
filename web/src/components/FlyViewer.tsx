import { useRef, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { WorldSource } from '../../../api/src/world';

interface FlyState {
  x: number;
  y: number;
  z: number;
  heading: number;
  t: number;
  hunger: number;
}

function getHungerColor(hunger: number): string {
  if (hunger > 50) return '#5a5';
  if (hunger > 20) return '#ca0';
  return '#c44';
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

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(-8);
}

export default function FlyViewer() {
  const [flyState, setFlyState] = useState<FlyState>({ x: 0, y: 0, z: 2, heading: 0, t: 0, hunger: 100 });
  const [sources, setSources] = useState<WorldSource[]>([]);
  const [neuronIds, setNeuronIds] = useState<string[]>([]);
  const [neuronLabels, setNeuronLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [lastStimulated, setLastStimulated] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch(API_BASE + '/api/world')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then((d) => {
        if (!Array.isArray(d.sources)) throw new Error('Invalid /api/world response');
        setSources(d.sources);
      })
      .catch((err) => {
        console.error('[FlyViewer] /api/world:', err);
        setError('Failed to load world');
      });
    fetch(API_BASE + '/api/neurons')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then((d) => {
        if (!Array.isArray(d.neurons)) throw new Error('Invalid /api/neurons response');
        const list = d.neurons as { root_id: string; role?: string; cell_type?: string }[];
        setNeuronIds(list.map((n) => n.root_id));
        const labels: Record<string, string> = {};
        for (const n of list) {
          const label = [n.cell_type, n.role].filter(Boolean).join(' ') || n.root_id;
          labels[n.root_id] = label.length > 14 ? label.slice(0, 12) + '…' : label;
        }
        setNeuronLabels(labels);
      })
      .catch((err) => {
        console.error('[FlyViewer] /api/neurons:', err);
        setError('Failed to load neurons');
      });
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
          if (data.activity) {
            setActivity(data.activity);
            setActiveCount(Object.keys(data.activity).length);
          } else setActivity({});
        }
      } catch {}
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const stimulate = () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    if (neuronIds.length === 0) return;
    const id = neuronIds[Math.floor(Math.random() * neuronIds.length)];
    setLastStimulated([id]);
    wsRef.current.send(JSON.stringify({ type: 'stimulate', neurons: [id], strength: 0.9 }));
  };

  const topActivity = Object.entries(activity)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  const flyMode = flyState.z > 2.5 ? 'flying' : flyState.z < 2.2 ? 'resting' : 'idle';

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
            <button onClick={stimulate} disabled={neuronIds.length === 0} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: neuronIds.length === 0 ? '#222' : '#333', color: '#fff', cursor: neuronIds.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              Stimulate
            </button>
            <span style={{ background: '#0a0', color: '#fff', padding: '4px 12px', borderRadius: 8 }}>Connected</span>
            {activeCount > 0 && <span style={{ color: '#aaa', fontSize: 12 }}>Active: {activeCount}</span>}
          </div>
          <div style={{ width: 120, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ fontSize: 10, color: '#888', padding: '2px 6px' }}>Hunger</div>
            <div style={{ height: 8, background: '#333', borderRadius: 2, margin: '0 4px 4px', overflow: 'hidden' }}>
              <div style={{ width: `${flyState.hunger}%`, height: '100%', background: getHungerColor(flyState.hunger), transition: 'width 0.2s' }} />
            </div>
          </div>
        </div>
      )}
      {connected && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, maxWidth: 320, maxHeight: '40vh', overflow: 'auto', background: 'rgba(0,0,0,0.75)', color: '#ccc', fontSize: 11, padding: 10, borderRadius: 8, fontFamily: 'monospace' }}>
          <div style={{ color: '#888', marginBottom: 6 }}>Status</div>
          <div style={{ marginBottom: 4 }}>pos ({flyState.x.toFixed(1)}, {flyState.y.toFixed(1)}, {flyState.z.toFixed(1)})</div>
          <div style={{ marginBottom: 4 }}>heading {(flyState.heading * 180 / Math.PI).toFixed(0)}° | {flyMode}</div>
          <div style={{ marginBottom: 8 }}>t {flyState.t.toFixed(1)}s | hunger {Math.round(flyState.hunger)}</div>
          <div style={{ color: '#888', marginBottom: 4 }}>Firing neurons ({activeCount})</div>
          <div style={{ maxHeight: 120, overflow: 'auto' }}>
            {topActivity.length === 0 && <span style={{ color: '#666' }}>—</span>}
            {topActivity.map(([id, v]) => (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }} title={id}>
                <span>{neuronLabels[id] || shortId(id)}</span>
                <span style={{ color: '#8cf' }}>{v.toFixed(2)}</span>
              </div>
            ))}
          </div>
          {lastStimulated.length > 0 && (
            <div style={{ marginTop: 8, color: '#c96' }}>Last stim: {lastStimulated.map((id) => neuronLabels[id] || shortId(id)).join(', ')}</div>
          )}
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
