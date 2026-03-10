import { useRef, useState, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { WorldSource } from '../../../api/src/world';
import { subscribeSim, sendStart, sendStop, getConnectionState, type FlyState } from '../lib/simWsClient';
import { getApiBase } from '../lib/wsUrl';
import { BrainOverlay, type NeuronWithPosition } from './BrainOverlay';
import './FlyViewer.css';

function getHungerColor(hunger: number): string {
  if (hunger > 50) return '#5a5';
  if (hunger > 20) return '#ca0';
  return '#c44';
}

const FLY_THRESHOLD = 1.1; // z above this = flying (wings flap + HUD mode)
const REST_DURATION_FALLBACK = 4; // fallback when flyState.restDuration not in payload
const WING_NAMES = ['Object_4', 'Object_5', 'Object_6']; // fly-white, flywings-dark, glass (wing materials)

function FlyModel({ state }: { state: FlyState }) {
  const { scene } = useGLTF('/models/low_poly_fly/scene.gltf');
  const group = useRef<THREE.Group>(null);
  const wingsRef = useRef<THREE.Object3D[]>([]);

  const x = state.x ?? 0, y = state.y ?? 0, z = state.z ?? 0;
  const heading = state.heading ?? 0;
  const isFlying = z > FLY_THRESHOLD;

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    wingsRef.current = [];
    c.traverse((obj) => {
      if (obj.name && WING_NAMES.includes(obj.name)) wingsRef.current.push(obj);
    });
    return c;
  }, [scene]);

  useFrame(() => {
    if (isFlying) {
      const flap = Math.sin(performance.now() * 0.02) * 0.4;
      for (const wing of wingsRef.current) {
        wing.rotation.x = flap;
      }
    } else {
      for (const wing of wingsRef.current) {
        wing.rotation.x = 0;
      }
    }
  });

  return (
    <group ref={group} position={[x, z, y]} rotation={[0, heading, 0]}>
      <primitive object={cloned} scale={0.08} rotation={[0, 0, 0]} />
    </group>
  );
}

const ARENA_SIZE = 48; // matches brain-sim ARENA (24) * 2 for fly world bounds

function GroundPlane() {
  return (
    <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[ARENA_SIZE, ARENA_SIZE]} />
      <meshStandardMaterial color="#2d5a27" roughness={0.9} metalness={0.05} />
    </mesh>
  );
}

function FoodModel() {
  const { scene } = useGLTF('/models/low-poly_apple/scene.gltf');
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return (
    <primitive object={cloned} scale={1.2} rotation={[0, 0, 0]} />
  );
}

function WorldSources({ sources }: { sources: WorldSource[] }) {
  return (
    <>
      {sources.map((s) => (
        <group key={s.id} position={[s.x, s.z, s.y]}>
          {s.type === 'food' ? (
            <Suspense fallback={
              <mesh>
                <sphereGeometry args={[0.8, 24, 24]} />
                <meshStandardMaterial color="#e8a838" />
              </mesh>
            }>
              <FoodModel />
            </Suspense>
          ) : (
            <mesh>
              <sphereGeometry args={[0.8, 24, 24]} />
              <meshStandardMaterial
                color="#88ccff"
                emissive="#4488ff"
                emissiveIntensity={0.6}
              />
            </mesh>
          )}
        </group>
      ))}
    </>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(-8);
}

const DEFAULT_FLY: FlyState = { x: 0, y: 0, z: 0.35, heading: 0, t: 0, hunger: 100 };

function getFlyMode(fly: FlyState): string {
  if (fly.dead) return 'dead';
  if (fly.feeding) return 'feeding';
  if ((fly.z ?? 0) > FLY_THRESHOLD) return 'flying';
  if ((fly.z ?? 0) < 0.6) return 'resting';
  return 'idle';
}

function FlyStatusCard({
  index,
  fly,
  selected,
  onSelect,
}: {
  index: number;
  fly: FlyState;
  selected: boolean;
  onSelect: () => void;
}) {
  const hunger = fly.hunger ?? 100;
  const health = fly.health ?? 100;
  const fatiguePct =
    fly.restTimeLeft != null && fly.restTimeLeft > 0
      ? 100 - ((fly.restTimeLeft ?? 0) / (fly.restDuration ?? REST_DURATION_FALLBACK)) * 100
      : (fly.flyTimeLeft ?? 1) * 100;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: '100%',
        textAlign: 'left',
        border: selected ? '1px solid rgba(99,102,241,0.5)' : '1px solid transparent',
        outline: 'none',
        background: selected ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
        borderRadius: 6,
        padding: 8,
        marginBottom: 8,
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <div style={{ fontSize: 10, color: selected ? '#aaf' : '#aaa', marginBottom: 6, fontWeight: 600 }}>
        Fly {index + 1}{selected ? ' (viewing)' : ''}
      </div>
      {fly.dead ? (
        <div style={{ fontSize: 10, color: '#f88' }}>dead</div>
      ) : (
        <>
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Hunger</div>
            <div style={{ height: 6, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${hunger}%`, height: '100%', background: getHungerColor(hunger), transition: 'width 0.2s' }} />
            </div>
          </div>
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Health</div>
            <div style={{ height: 6, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${health}%`, height: '100%', background: health > 50 ? '#5a5' : health > 20 ? '#ca0' : '#c44', transition: 'width 0.2s' }} />
            </div>
          </div>
          <div style={{ marginBottom: 0 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Fatigue</div>
            <div style={{ height: 6, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${fatiguePct}%`, height: '100%', background: '#48a', transition: 'width 0.2s' }} />
            </div>
          </div>
        </>
      )}
    </button>
  );
}

export default function FlyViewer() {
  const [flies, setFlies] = useState<FlyState[]>([]);
  const [selectedFlyIndex, setSelectedFlyIndex] = useState(0);
  const [sources, setSources] = useState<WorldSource[]>([]);
  const [neuronLabels, setNeuronLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [neuronsWithPositions, setNeuronsWithPositions] = useState<NeuronWithPosition[]>([]);
  const [fliesPanelOpen, setFliesPanelOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? false : true
  );

  useEffect(() => {
    const apiBase = getApiBase();
    fetch(apiBase + '/api/world')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then((d) => {
        if (!Array.isArray(d.sources)) throw new Error('Invalid /api/world response');
        setSources(d.sources);
      })
      .catch((err) => {
        console.error('[FlyViewer] /api/world:', err);
        setError('Failed to load world');
      });
    fetch(apiBase + '/api/neurons')
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then((d) => {
        if (!Array.isArray(d.neurons)) throw new Error('Invalid /api/neurons response');
        const list = d.neurons as { root_id: string; role?: string; side?: string; cell_type?: string; x?: number; y?: number; z?: number }[];
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
          setSimRunning(false);
        } else if (event._event === 'error') {
          setError(event.error);
          setSimRunning(false);
        }
        return;
      }
      const data = event as { flies?: FlyState[]; fly?: FlyState; activity?: Record<string, number>; simRunning?: boolean; error?: string; sources?: WorldSource[] };
      if (data.simRunning !== undefined) setSimRunning(data.simRunning);
      if (data.error) setError(data.error);
      if (data.sources && Array.isArray(data.sources)) setSources(data.sources);
      if (!data.error) {
        if (data.flies && data.flies.length > 0) setFlies(data.flies);
        else if (data.fly) setFlies([data.fly]);
        if (data.activity) {
          setActivity(data.activity);
          setActiveCount(Object.keys(data.activity).length);
        } else if (data.activity !== undefined) {
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
  const focusedFly = flies[selectedFlyIndex] ?? flies[0] ?? DEFAULT_FLY;
  const flyMode = getFlyMode(focusedFly);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Canvas layer - must stay behind UI */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, isolation: 'isolate' }}>
        <Canvas camera={{ position: [8, 6, 8], fov: 50 }} gl={{ outputColorSpace: THREE.SRGBColorSpace }}>
          <ambientLight intensity={0.8} />
          <directionalLight position={[10, 10, 5]} intensity={1.2} castShadow />
          <OrbitControls />
          <Suspense fallback={null}>
            {flies.map((fly, i) => !fly.dead && <FlyModel key={i} state={fly} />)}
          </Suspense>
          <WorldSources sources={sources} />
          <GroundPlane />
        </Canvas>
      </div>
      {/* UI layer - always on top, always visible */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>
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
            {focusedFly.dead && (
              <div style={{ width: 120, padding: '6px 8px', background: '#422', color: '#f88', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                Fly died
              </div>
            )}
            <div style={{ width: 120, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ fontSize: 10, color: '#888', padding: '2px 6px' }}>Hunger</div>
              <div style={{ height: 8, background: '#333', borderRadius: 2, margin: '0 4px 4px', overflow: 'hidden' }}>
                <div style={{ width: `${focusedFly.hunger ?? 100}%`, height: '100%', background: getHungerColor(focusedFly.hunger ?? 100), transition: 'width 0.2s' }} />
              </div>
            </div>
            <div style={{ width: 120, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ fontSize: 10, color: '#888', padding: '2px 6px' }}>Health</div>
              <div style={{ height: 8, background: '#333', borderRadius: 2, margin: '0 4px 4px', overflow: 'hidden' }}>
                <div style={{ width: `${focusedFly.health ?? 100}%`, height: '100%', background: (focusedFly.health ?? 100) > 50 ? '#5a5' : (focusedFly.health ?? 100) > 20 ? '#ca0' : '#c44', transition: 'width 0.2s' }} />
              </div>
            </div>
            <div style={{ width: 120, background: '#222', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ fontSize: 10, color: '#888', padding: '2px 6px' }}>
                {focusedFly.restTimeLeft != null && focusedFly.restTimeLeft > 0 ? 'Rest' : 'Fatigue'}
              </div>
              <div style={{ height: 8, background: '#333', borderRadius: 2, margin: '0 4px 4px', overflow: 'hidden' }}>
                {focusedFly.restTimeLeft != null && focusedFly.restTimeLeft > 0 ? (
                  <div style={{ width: `${Math.max(0, 100 - ((focusedFly.restTimeLeft ?? 0) / (focusedFly.restDuration ?? REST_DURATION_FALLBACK)) * 100)}%`, height: '100%', background: '#6a6', transition: 'width 0.2s' }} />
                ) : (
                  <div style={{ width: `${((focusedFly.flyTimeLeft ?? 1) * 100).toFixed(0)}%`, height: '100%', background: '#48a', transition: 'width 0.2s' }} />
                )}
              </div>
            </div>
          </div>
        </div>
        <button
          type="button"
          className={`fly-viewer__flies-toggle ${fliesPanelOpen ? 'fly-viewer__flies-toggle--active' : ''}`}
          onClick={() => setFliesPanelOpen((o) => !o)}
          aria-label={fliesPanelOpen ? 'Hide flies panel' : 'Show flies panel'}
          aria-expanded={fliesPanelOpen}
          title={fliesPanelOpen ? 'Hide flies panel' : 'Show flies panel'}
        >
          <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
            <path d="M4 18V8h2v10H4zm6 0V4h2v14h-2zm6 0v-6h2v6h-2z" />
          </svg>
        </button>
        <div
          className={`fly-viewer__flies-overlay ${fliesPanelOpen ? 'fly-viewer__flies-overlay--open' : ''}`}
          id="flies-panel-overlay"
        >
          <div className="fly-viewer__flies-panel">
            <div style={{ color: '#888', marginBottom: 8, fontSize: 10 }}>Your Flies — click to view</div>
            {flies.length === 0 && (
              <div style={{ color: '#666', fontSize: 10 }}>—</div>
            )}
            {flies.map((fly, i) => (
              <FlyStatusCard
                key={i}
                index={i}
                fly={fly}
                selected={i === selectedFlyIndex}
                onSelect={() => setSelectedFlyIndex(i)}
              />
            ))}
          </div>
        </div>
        <BrainOverlay neurons={neuronsWithPositions} activity={activity} visible={connected} />
        <div style={{ position: 'absolute', bottom: 12, left: 12, maxWidth: 420, minWidth: 340, maxHeight: '40vh', overflow: 'auto', background: 'rgba(0,0,0,0.85)', color: '#ccc', fontSize: 11, padding: 10, borderRadius: 8, fontFamily: 'monospace', pointerEvents: 'auto' }}>
          <div style={{ color: '#888', marginBottom: 6 }}>Status</div>
          <div style={{ marginBottom: 4 }}>Fly {selectedFlyIndex + 1} (viewing) | pos ({(focusedFly.x ?? 0).toFixed(1)}, {(focusedFly.y ?? 0).toFixed(1)}, {(focusedFly.z ?? 0).toFixed(1)})</div>
          <div style={{ marginBottom: 4 }}>heading {((focusedFly.heading ?? 0) * 180 / Math.PI).toFixed(0)}° | {flyMode}</div>
          <div style={{ marginBottom: 8 }}>t {(focusedFly.t ?? 0).toFixed(1)}s | hunger {Math.round(focusedFly.hunger ?? 0)} | health {Math.round(focusedFly.health ?? 100)}</div>
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
