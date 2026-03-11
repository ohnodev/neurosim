import { useRef, useState, useEffect, useMemo, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { WorldSource } from '../../../api/src/world';
import { subscribeSim, type FlyState } from '../lib/simWsClient';
import { getApiBase } from '../lib/constants';
import { BrainOverlay, type NeuronWithPosition } from './BrainOverlay';
import { ConnectButton } from './ConnectButton';
import { BuyFlyModal } from './BuyFlyModal';
import { usePrivyWallet } from '../lib/usePrivyWallet';
import './FlyViewer.css';

function getHungerColor(hunger: number): string {
  if (hunger > 50) return '#5a5';
  if (hunger > 20) return '#ca0';
  return '#c44';
}

function getHealthColor(health: number): string {
  if (health > 50) return '#48a';
  if (health > 20) return '#c95';
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

interface ClaimedFly {
  id: string;
  method: string;
  claimedAt: string;
}

async function fetchMyFlies(address: string) {
  const r = await fetch(`${getApiBase()}/api/claim/my-flies?address=${address.toLowerCase()}`);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.flies ?? []) as ClaimedFly[];
}

async function fetchMyDeployed(address: string): Promise<Record<number, number>> {
  const r = await fetch(`${getApiBase()}/api/deploy/my-deployed?address=${address.toLowerCase()}`);
  if (!r.ok) return {};
  const data = await r.json();
  return data.deployed ?? {};
}

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
        background: selected ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
        borderRadius: 6,
        padding: 8,
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
              <div style={{ width: `${health}%`, height: '100%', background: getHealthColor(health), transition: 'width 0.2s' }} />
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
  const { address } = usePrivyWallet();
  const queryClient = useQueryClient();
  const [flies, setFlies] = useState<FlyState[]>([]);
  const [selectedFlyIndex, setSelectedFlyIndex] = useState(0);
  const [sources, setSources] = useState<WorldSource[]>([]);
  const [neuronLabels, setNeuronLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [activities, setActivities] = useState<(Record<string, number> | undefined)[]>([]);
  const [neuronsWithPositions, setNeuronsWithPositions] = useState<NeuronWithPosition[]>([]);
  const [fliesPanelOpen, setFliesPanelOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? false : true
  );
  const [buyFlySlot, setBuyFlySlot] = useState<number | null>(null);
  const isMobileDefault = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  const [statusPanelOpen, setStatusPanelOpen] = useState(() => !isMobileDefault());
  const [brainPanelOpen, setBrainPanelOpen] = useState(() => !isMobileDefault());

  const { data: myFlies = [] } = useQuery({
    queryKey: ['my-flies', address ?? ''],
    queryFn: () => fetchMyFlies(address!),
    enabled: !!address,
  });

  const { data: deployed = {}, refetch: refetchDeployed } = useQuery({
    queryKey: ['my-deployed', address ?? ''],
    queryFn: () => fetchMyDeployed(address!),
    enabled: !!address,
  });

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
        } else if (event._event === 'error') {
          setError(event.error);
        }
        return;
      }
      const data = event as { flies?: FlyState[]; fly?: FlyState; activity?: Record<string, number>; activities?: (Record<string, number> | undefined)[]; error?: string; sources?: WorldSource[] };
      if (data.error) setError(data.error);
      if (data.sources && Array.isArray(data.sources)) setSources(data.sources);
      if (!data.error) {
        if (Array.isArray(data.flies)) setFlies(data.flies);
        else if (data.fly) setFlies([data.fly]);
        if (Array.isArray(data.activities)) setActivities(data.activities);
        if (data.activity) setActivity(data.activity);
        else if (data.activity !== undefined) setActivity({});
      }
    });
    return unsub;
  }, []);

  const deployedSlotKeys = useMemo(
    () => Object.keys(deployed)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n) && deployed[n] != null)
      .sort((a, b) => a - b),
    [deployed]
  );

  const simIndexForSelected = deployed[selectedFlyIndex];
  const firstValidSlot = deployedSlotKeys.find(
    (slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null
  );
  const effectiveSimIndex =
    simIndexForSelected != null && flies[simIndexForSelected] != null
      ? simIndexForSelected
      : firstValidSlot != null
        ? deployed[firstValidSlot]!
        : undefined;
  const focusedFly =
    effectiveSimIndex != null && flies[effectiveSimIndex]
      ? flies[effectiveSimIndex]!
      : DEFAULT_FLY;
  const activityForSelected =
    effectiveSimIndex != null && Array.isArray(activities)
      ? (activities[effectiveSimIndex] ?? {})
      : activity;
  const activeCount = Object.keys(activityForSelected).length;
  const topActivity = Object.entries(activityForSelected)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  useEffect(() => {
    if (deployedSlotKeys.length === 0) return;
    const valid =
      simIndexForSelected != null && flies[simIndexForSelected] != null;
    if (!valid) {
      const firstValid = deployedSlotKeys.find(
        (slotIdx) => deployed[slotIdx] != null && flies[deployed[slotIdx]!] != null
      );
      setSelectedFlyIndex(firstValid ?? deployedSlotKeys[0]!);
    }
  }, [deployedSlotKeys, simIndexForSelected, flies, deployed]);

  const flyMode = getFlyMode(focusedFly);

  const deployFly = async (slotIndex: number) => {
    if (!address) return;
    const r = await fetch(`${getApiBase()}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address.toLowerCase(), slotIndex }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error ?? 'Deploy failed');
    }
    queryClient.invalidateQueries({ queryKey: ['my-deployed', address] });
    refetchDeployed();
  };

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
        <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'auto' }}>
          <ConnectButton />
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
                <div style={{ width: `${focusedFly.health ?? 100}%`, height: '100%', background: getHealthColor(focusedFly.health ?? 100), transition: 'width 0.2s' }} />
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: connected ? '#4ade80' : '#888' }}>
            {connected ? 'Sim running' : 'Connecting…'}
            {activeCount > 0 && <span style={{ color: 'rgba(255,255,255,0.6)' }}>Neurons: {activeCount}</span>}
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
          inert={!fliesPanelOpen ? true : undefined}
          aria-hidden={!fliesPanelOpen}
        >
          <div className="fly-viewer__flies-panel">
            <div style={{ color: '#888', marginBottom: 8, fontSize: 10 }}>Your Flies — click to view</div>
            {[0, 1, 2].map((i) => {
              const hasFly = myFlies[i] != null;
              const simIdx = deployed[i];
              const isDeployed = simIdx != null;
              const simFly = isDeployed ? (flies[simIdx] ?? DEFAULT_FLY) : DEFAULT_FLY;
              return (
                <div key={i} className="fly-viewer__fly-slot">
                  {!hasFly ? (
                    <button
                      type="button"
                      className="fly-viewer__fly-slot-empty"
                      onClick={() => setBuyFlySlot(i)}
                    >
                      <span className="fly-viewer__fly-slot-label">Fly {i + 1}</span>
                      <span className="fly-viewer__fly-slot-buy">Buy Fly</span>
                    </button>
                  ) : !isDeployed ? (
                    <button
                      type="button"
                      className="fly-viewer__fly-slot-empty"
                      onClick={async () => {
                        try {
                          await deployFly(i);
                        } catch (e) {
                          setError(e instanceof Error ? `Deploy failed: ${e.message}` : 'Deploy failed');
                        }
                      }}
                    >
                      <span className="fly-viewer__fly-slot-label">Fly {i + 1}</span>
                      <span className="fly-viewer__fly-slot-buy">Deploy</span>
                    </button>
                  ) : (
                    <FlyStatusCard
                      index={i}
                      fly={simFly}
                      selected={i === selectedFlyIndex}
                      onSelect={() => setSelectedFlyIndex(i)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {buyFlySlot != null && (
          <BuyFlyModal
            isOpen={true}
            onClose={() => setBuyFlySlot(null)}
            slotIndex={buyFlySlot}
            onSuccess={() => {
              if (address) queryClient.invalidateQueries({ queryKey: ['my-flies', address] });
            }}
          />
        )}
        {/* Brain activity panel - collapsible, minimized on mobile by default */}
        <div className={`fly-viewer__side-panel fly-viewer__brain-panel ${brainPanelOpen ? 'fly-viewer__side-panel--open' : 'fly-viewer__side-panel--minimized'}`}>
          {brainPanelOpen ? (
            <>
              <button
                type="button"
                className="fly-viewer__panel-minimize"
                onClick={() => setBrainPanelOpen(false)}
                aria-label="Minimize brain activity"
                title="Minimize"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                <span>Minimize</span>
              </button>
              <div style={{ color: '#888', marginBottom: 6 }}>Brain activity — Fly {selectedFlyIndex + 1} (viewing)</div>
              <div style={{ width: 320, height: 240, position: 'relative' }}>
                <BrainOverlay neurons={neuronsWithPositions} activity={activityForSelected} visible={connected} embedded />
              </div>
            </>
          ) : (
            <button
              type="button"
              className="fly-viewer__panel-expand"
              onClick={() => setBrainPanelOpen(true)}
              aria-label="Show brain activity"
              title="Brain activity"
            >
              <span className="fly-viewer__panel-expand-label">Brain</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            </button>
          )}
        </div>
        {/* Status panel - collapsible, minimized on mobile by default */}
        <div className={`fly-viewer__side-panel fly-viewer__status-panel ${statusPanelOpen ? 'fly-viewer__side-panel--open' : 'fly-viewer__side-panel--minimized'}`}>
          {statusPanelOpen ? (
            <div className="fly-viewer__status-content">
              <button
                type="button"
                className="fly-viewer__panel-minimize"
                onClick={() => setStatusPanelOpen(false)}
                aria-label="Minimize status"
                title="Minimize"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                <span>Minimize</span>
              </button>
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
          ) : (
            <button
              type="button"
              className="fly-viewer__panel-expand"
              onClick={() => setStatusPanelOpen(true)}
              aria-label="Show status"
              title="Status"
            >
              <span className="fly-viewer__panel-expand-label">Status</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
