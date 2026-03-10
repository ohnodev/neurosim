import { useRef, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { WorldSource } from '../../../api/src/world';
import { subscribeSim, sendStart, sendStop, getConnectionState } from '../lib/simWsClient';
import { BrainOverlay, type NeuronWithPosition } from './BrainOverlay';

interface FlyState {
  x: number;
  y: number;
  z: number;
  heading: number;
  t: number;
  hunger: number;
  flyTimeLeft?: number;  // 0-1, flight energy
  restTimeLeft?: number; // seconds resting
}

function getHungerColor(hunger: number): string {
  if (hunger > 50) return '#5a5';
  if (hunger > 20) return '#ca0';
  return '#c44';
}

const API_BASE =
  (import.meta.env.VITE_API_URL as string)?.trim() || 'http://localhost:3001';

function FlyMesh({ state }: { state: FlyState }) {
  const mesh = useRef<THREE.Mesh>(null);
  const lerp = useRef(state);

  useEffect(() => {
    if (!mesh.current) return;
    lerp.current = { ...state };
  }, [state]);

  const x = state.x ?? 0, y = state.y ?? 0, z = state.z ?? 0, h = state.heading ?? 0;
  return (
    <group position={[x, z, y]} rotation={[0, h, 0]}>
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
            <sphereGeometry args={[0.8, 24, 24]} />
            <meshStandardMaterial
              color={s.type === 'food' ? '#e8a838' : '#88ccff'}
              emissive={s.type === 'food' ? '#553300' : '#4488ff'}
              emissiveIntensity={s.type === 'light' ? 0.6 : 0.2}
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
  const [flyState, setFlyState] = useState<FlyState>({ x: 0, y: 0, z: 0.35, heading: 0, t: 0, hunger: 100 });
  const [sources, setSources] = useState<WorldSource[]>([]);
  const [neuronIds, setNeuronIds] = useState<string[]>([]);
  const [neuronLabels, setNeuronLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [neuronsWithPositions, setNeuronsWithPositions] = useState<NeuronWithPosition[]>([]);

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
        const list = d.neurons as { root_id: string; role?: string; side?: string; cell_type?: string; x?: number; y?: number; z?: number }[];
        setNeuronIds(list.map((n) => n.root_id));
        setNeuronsWithPositions(list.map((n) => ({ root_id: n.root_id, side: n.side, x: n.x, y: n.y, z: n.z })));
        const labels: Record<string, string> = {};
        for (const n of list) {
          const full = [n.cell_type, n.role].filter(Boolean).join(' ') || n.root_id;
          labels[n.root_id] = full; // keep full label; UI uses overflow: ellipsis if needed
        }
        setNeuronLabels(labels);
      })
      .catch((err) => {
        console.error('[FlyViewer] /api/neurons:', err);
        setError('Failed to load neurons');
      });
  }, []);

  useEffect(() => {
    const unsub = subscribeSim((event) => {
      if ('_event' in event) {
        if (event._event === 'open') {
          setConnected(true);
          setError(null);
        } else if (event._event === 'closed') {
          setConnected(false);
        } else if (event._event === 'error') {
          setError(event.error);
        }
        return;
      }
      const data = event as { fly?: FlyState; activity?: Record<string, number>; simRunning?: boolean; error?: string };
      if (data.simRunning !== undefined) setSimRunning(data.simRunning);
      if (data.error) setError(data.error);
      else {
        if (data.fly) setFlyState(data.fly);
        if (data.activity) {
          setActivity(data.activity);
          setActiveCount(Object.keys(data.activity).length);
        } else {
          setActivity({});
        }
      }
    });
    return unsub;
  }, []);

  const toggleSim = () => {
    if (getConnectionState() !== 'open') return;
    if (simRunning) sendStop();
    else sendStart();
  };

  const topActivity = Object.entries(activity)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  const flyMode = flyState.z > 1.1 ? 'flying' : flyState.z < 0.6 ? 'resting' : 'idle';

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Canvas layer - must stay behind UI */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, isolation: 'isolate' }}>
        <Canvas camera={{ position: [8, 6, 8], fov: 50 }}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
          <OrbitControls />
          <FlyMesh state={flyState} />
          <WorldSources sources={sources} />
          <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[50, 50, 32, 32]} />
            <meshStandardMaterial color="#2d5a27" roughness={0.9} metalness={0.05} />
          </mesh>
        </Canvas>
      </div>
      {/* UI layer - always on top, always visible */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 2147483647, pointerEvents: 'none' }}>
        {error && (
          <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#f88', padding: '8px 16px', borderRadius: 8, pointerEvents: 'auto' }}>
            {error}
          </div>
        )}
        <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', pointerEvents: 'auto' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={toggleSim} disabled={!connected} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: connected ? (simRunning ? '#c44' : '#2a5') : '#555', color: '#fff', cursor: connected ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
              {simRunning ? 'Stop' : 'Start'}
            </button>
            <span style={{ background: connected ? '#0a0' : '#555', color: '#fff', padding: '4px 12px', borderRadius: 8 }}>
              {connected ? 'Connected' : 'Connecting...'}
            </span>
            {activeCount > 0 && <span style={{ color: '#aaa', fontSize: 12 }}>Active: {activeCount}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ width: 120, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ fontSize: 10, color: '#888', padding: '2px 6px' }}>Hunger</div>
              <div style={{ height: 8, background: '#333', borderRadius: 2, margin: '0 4px 4px', overflow: 'hidden' }}>
                <div style={{ width: `${flyState.hunger ?? 100}%`, height: '100%', background: getHungerColor(flyState.hunger ?? 100), transition: 'width 0.2s' }} />
              </div>
            </div>
            <div style={{ width: 120, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ fontSize: 10, color: '#888', padding: '2px 6px' }}>
                {flyState.restTimeLeft != null && flyState.restTimeLeft > 0 ? 'Rest' : 'Fatigue'}
              </div>
              <div style={{ height: 8, background: '#333', borderRadius: 2, margin: '0 4px 4px', overflow: 'hidden' }}>
                {flyState.restTimeLeft != null && flyState.restTimeLeft > 0 ? (
                  <div style={{ width: `${Math.max(0, 100 - (flyState.restTimeLeft / 4) * 100)}%`, height: '100%', background: '#6a6', transition: 'width 0.2s' }} />
                ) : (
                  <div style={{ width: `${((flyState.flyTimeLeft ?? 1) * 100).toFixed(0)}%`, height: '100%', background: '#48a', transition: 'width 0.2s' }} />
                )}
              </div>
            </div>
          </div>
        </div>
        <BrainOverlay neurons={neuronsWithPositions} activity={activity} visible={connected} />
        <div style={{ position: 'absolute', bottom: 12, left: 12, maxWidth: 420, minWidth: 340, maxHeight: '40vh', overflow: 'auto', background: 'rgba(0,0,0,0.85)', color: '#ccc', fontSize: 11, padding: 10, borderRadius: 8, fontFamily: 'monospace', pointerEvents: 'auto' }}>
          <div style={{ color: '#888', marginBottom: 6 }}>Status</div>
          <div style={{ marginBottom: 4 }}>pos ({(flyState.x ?? 0).toFixed(1)}, {(flyState.y ?? 0).toFixed(1)}, {(flyState.z ?? 0).toFixed(1)})</div>
          <div style={{ marginBottom: 4 }}>heading {((flyState.heading ?? 0) * 180 / Math.PI).toFixed(0)}° | {flyMode}</div>
          <div style={{ marginBottom: 8 }}>t {(flyState.t ?? 0).toFixed(1)}s | hunger {Math.round(flyState.hunger ?? 0)}</div>
          <div style={{ color: '#888', marginBottom: 4 }}>Firing neurons ({activeCount})</div>
          <div style={{ maxHeight: 120, overflow: 'auto' }}>
            {topActivity.length === 0 && <span style={{ color: '#666' }}>—</span>}
            {topActivity.map(([id, v]) => (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, minWidth: 0 }} title={`${neuronLabels[id] || id}\n${id}`}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{neuronLabels[id] || shortId(id)}</span>
                <span style={{ color: '#8cf', flexShrink: 0 }}>{(Math.min(v ?? 0, 1)).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
