import { useRef, useState, useEffect, useMemo, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import { FlyCameraContext, FlyCameraController, type CameraMode } from './FlyCameraController';
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

/** Bigint-safe ETH formatter to avoid precision loss. */
function formatEth(wei: bigint, decimals = 6): string {
  const ONE = 10n ** 18n;
  const whole = wei / ONE;
  const frac = wei % ONE;
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals);
  return `${whole}.${fracStr}`;
}

function safeAmountWei(val: string | undefined): bigint {
  if (val == null || val === "") return 0n;
  try {
    const n = BigInt(val);
    return n >= 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function RewardsTable({
  history,
  formatEth,
}: {
  history: { address: string; amountWei: string; timestamp: string; txHash?: string }[];
  formatEth: (wei: bigint) => string;
}) {
  const [copiedTx, setCopiedTx] = useState<string | null>(null);
  const copyTx = async (txHash: string) => {
    try {
      await navigator.clipboard.writeText(txHash);
      setCopiedTx(txHash);
      setTimeout(() => setCopiedTx(null), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="fly-viewer__rewards-table-wrap">
      <div className="fly-viewer__rewards-table">
        {history.length === 0 && <div style={{ color: '#666', padding: 8 }}>No rewards sent yet</div>}
        {history.slice().reverse().map((entry, i) => (
          <div key={`${entry.address}-${entry.timestamp}-${i}`} className="fly-viewer__rewards-row">
            <span className="fly-viewer__rewards-addr" title={entry.address}>{shortAddr(entry.address)}</span>
            <span className="fly-viewer__rewards-amount">{formatEth(safeAmountWei(entry.amountWei))}</span>
            <span className="fly-viewer__rewards-time" title={entry.timestamp}>
              {new Date(entry.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            {entry.txHash ? (
              <span className="fly-viewer__rewards-actions">
                <button
                  type="button"
                  className="fly-viewer__rewards-action"
                  onClick={() => copyTx(entry.txHash!)}
                  aria-label="Copy tx"
                  title="Copy tx hash"
                >
                  {copiedTx === entry.txHash ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  )}
                </button>
                <a
                  href={`https://basescan.org/tx/${entry.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="fly-viewer__rewards-action"
                  aria-label="View on BaseScan"
                  title="View on BaseScan"
                >
                  <img src="/basescan-logo.svg" alt="" width={12} height={12} />
                </a>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const FLY_THRESHOLD = 1.1; // z above this = flying (HUD mode)
const REST_DURATION_FALLBACK = 4;
const BUFFER_SIM_SEC = 2;
const MIN_FRAMES_TO_START = 30; // ~900ms at 30fps

const WING_ANIM_NAMES = ['wing-leftAction', 'wing-rightAction'];

interface Snapshot {
  t: number;
  flies: FlyState[];
  activities?: (Record<string, number> | undefined)[];
  activity?: Record<string, number>;
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function lerpAngle(a: number, b: number, alpha: number): number {
  let d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * alpha;
}

function lerpFlyState(a: FlyState, b: FlyState, alpha: number): FlyState {
  return {
    x: lerp(a.x ?? 0, b.x ?? 0, alpha),
    y: lerp(a.y ?? 0, b.y ?? 0, alpha),
    z: lerp(a.z ?? 0, b.z ?? 0, alpha),
    heading: lerpAngle(a.heading ?? 0, b.heading ?? 0, alpha),
    t: lerp(a.t ?? 0, b.t ?? 0, alpha),
    hunger: lerp(a.hunger ?? 100, b.hunger ?? 100, alpha),
    health: lerp(a.health ?? 100, b.health ?? 100, alpha),
    dead: b.dead,
    feeding: b.feeding,
    flyTimeLeft: lerp(a.flyTimeLeft ?? 1, b.flyTimeLeft ?? 1, alpha),
    restTimeLeft: lerp(a.restTimeLeft ?? 0, b.restTimeLeft ?? 0, alpha),
    restDuration: lerp(a.restDuration ?? REST_DURATION_FALLBACK, b.restDuration ?? REST_DURATION_FALLBACK, alpha),
  };
}

function extrapolateFlyState(prev: FlyState, last: FlyState, dt: number): FlyState {
  const dtSeg = Math.max(1e-6, (last.t ?? 0) - (prev.t ?? 0));
  const vx = ((last.x ?? 0) - (prev.x ?? 0)) / dtSeg;
  const vy = ((last.y ?? 0) - (prev.y ?? 0)) / dtSeg;
  const vz = ((last.z ?? 0) - (prev.z ?? 0)) / dtSeg;
  const vh = (() => {
    let d = (last.heading ?? 0) - (prev.heading ?? 0);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d / dtSeg;
  })();
  const lx = last.x ?? 0, ly = last.y ?? 0, lz = last.z ?? 0, lh = last.heading ?? 0;
  return {
    ...last,
    x: lx + vx * dt,
    y: ly + vy * dt,
    z: lz + vz * dt,
    heading: lh + vh * dt,
    t: (last.t ?? 0) + dt,
  };
}

const MIN_MOVEMENT_SQ = 0.02; // only update heading on meaningful movement
const HEADING_LERP = 0.38; // slower = smoother, less jitter
const HEADING_DEAD_ZONE = 0.15; // radians; ignore tiny heading corrections

function FlyModel({ state }: { state: FlyState }) {
  const group = useRef<THREE.Group>(null);
  const sceneRef = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF('/models/fly-animated/fly2-animation.glb');
  const { actions } = useAnimations(animations, sceneRef);
  const x = state.x ?? 0, y = state.y ?? 0, z = state.z ?? 0;
  const isFlying = z > FLY_THRESHOLD;
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const prevRef = useRef({ x, y });
  const headingRef = useRef(state.heading ?? 0);
  const targetHeadingRef = useRef(state.heading ?? 0);

  useEffect(() => {
    for (const name of WING_ANIM_NAMES) {
      const action = actions[name];
      if (!action) continue;
      if (isFlying) {
        action.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveTimeScale(2).play();
      } else {
        action.stop();
      }
    }
  }, [actions, isFlying]);

  useFrame(() => {
    const dx = x - prevRef.current.x;
    const dy = y - prevRef.current.y;
    prevRef.current = { x, y };
    const moveSq = dx * dx + dy * dy;
    if (moveSq > MIN_MOVEMENT_SQ) {
      const newTarget = Math.atan2(dx, dy) + Math.PI;
      let diff = newTarget - targetHeadingRef.current;
      if (diff > Math.PI) diff -= 2 * Math.PI;
      if (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) > HEADING_DEAD_ZONE) {
        targetHeadingRef.current = newTarget;
      }
    }
    if (group.current) {
      group.current.position.set(x, z, y);
      let d = targetHeadingRef.current - headingRef.current;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      headingRef.current += d * HEADING_LERP;
      group.current.rotation.y = headingRef.current;
    }
  });

  return (
    <group ref={group}>
      <primitive ref={sceneRef} object={cloned} scale={0.08} rotation={[0, 0, 0]} />
    </group>
  );
}

function InterpolatedFlies({
  bufferRef,
  latestFlies,
}: {
  bufferRef: React.MutableRefObject<Snapshot[]>;
  latestFlies: FlyState[];
}) {
  const [displayFlies, setDisplayFlies] = useState<FlyState[]>([]);
  const tDisplayRef = useRef<number | null>(null);

  useFrame((_, delta) => {
    const buf = bufferRef.current;
    if (buf.length === 0) {
      setDisplayFlies(latestFlies.filter((f) => !f.dead));
      return;
    }
    const last = buf[buf.length - 1]!;
    if (buf.length < MIN_FRAMES_TO_START) {
      setDisplayFlies(last.flies.filter((f) => !f.dead));
      return;
    }
    if (tDisplayRef.current === null) {
      tDisplayRef.current = buf[0]!.t;
    }
    tDisplayRef.current += delta;
    if (tDisplayRef.current > last.t) tDisplayRef.current = last.t;

    while (buf.length > 2 && tDisplayRef.current >= buf[1]!.t) {
      buf.shift();
    }
    const prev = buf[0]!;
    const next = buf[1];
    const tDisplay = tDisplayRef.current;

    const lerped: FlyState[] = [];
    if (next && prev.t < next.t) {
      const alpha = Math.max(0, Math.min(1, (tDisplay - prev.t) / (next.t - prev.t)));
      const n = Math.min(prev.flies.length, next.flies.length);
      for (let i = 0; i < n; i++) {
        lerped.push(lerpFlyState(prev.flies[i]!, next.flies[i]!, alpha));
      }
      for (let i = n; i < next.flies.length; i++) {
        lerped.push(next.flies[i]!);
      }
    } else {
      for (let i = 0; i < prev.flies.length; i++) {
        lerped.push(prev.flies[i]!);
      }
    }

    setDisplayFlies(lerped.filter((f) => !f.dead));
  });

  return (
    <>
      {displayFlies.map((fly, i) => (
        <FlyModel key={i} state={fly} />
      ))}
    </>
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

async function fetchFlyStats(address: string): Promise<{ stats: { slotIndex: number; feedCount: number }[]; rewardPerPointWei: string }> {
  const r = await fetch(`${getApiBase()}/api/rewards/stats?address=${address.toLowerCase()}`);
  if (!r.ok) return { stats: [], rewardPerPointWei: (1000n * 10n ** 18n).toString() };
  const data = await r.json();
  const fallbackWei = (1000n * 10n ** 18n).toString(); // 1000 $NEURO per point
  return { stats: data.stats ?? [], rewardPerPointWei: data.rewardPerPointWei ?? fallbackWei };
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
  points = 0,
}: {
  index: number;
  fly: FlyState;
  selected: boolean;
  onSelect: () => void;
  points?: number;
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
      className="fly-viewer__status-card"
      onClick={onSelect}
      style={{
        width: '100%',
        textAlign: 'left',
        border: '1px solid rgba(255,255,255,0.08)',
        background: selected ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
        borderRadius: 6,
        padding: 8,
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: selected ? '#aaf' : '#aaa', marginBottom: 6, fontWeight: 600 }}>
        <span>Fly {index + 1}{selected ? ' (viewing)' : ''}</span>
        <span style={{ fontSize: 9, color: '#8a8', fontFamily: 'monospace' }}>{points} pts</span>
      </div>
      {fly.dead ? (
        <div style={{ fontSize: 10, color: '#f88' }}>dead</div>
      ) : (
        <>
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Hunger</div>
            <div style={{ position: 'relative', height: 8, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${hunger}%`, height: '100%', background: getHungerColor(hunger), transition: 'width 0.2s' }} />
              <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontFamily: 'monospace', color: '#fff', textShadow: '0 0 2px #000, 0 1px 1px #000', pointerEvents: 'none' }}>{Math.round(hunger)}/100</span>
            </div>
          </div>
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Health</div>
            <div style={{ position: 'relative', height: 8, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${health}%`, height: '100%', background: getHealthColor(health), transition: 'width 0.2s' }} />
              <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontFamily: 'monospace', color: '#fff', textShadow: '0 0 2px #000, 0 1px 1px #000', pointerEvents: 'none' }}>{Math.round(health)}/100</span>
            </div>
          </div>
          <div style={{ marginBottom: 0 }}>
            <div style={{ fontSize: 9, color: '#888', marginBottom: 2 }}>Fatigue</div>
            <div style={{ position: 'relative', height: 8, background: '#222', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${fatiguePct}%`, height: '100%', background: '#48a', transition: 'width 0.2s' }} />
              <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontFamily: 'monospace', color: '#fff', textShadow: '0 0 2px #000, 0 1px 1px #000', pointerEvents: 'none' }}>{Math.round(fatiguePct)}/100</span>
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
  const [cameraMode, setCameraMode] = useState<CameraMode>('god');
  const [fliesPanelOpen, setFliesPanelOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? false : true
  );
  const [buyFlySlot, setBuyFlySlot] = useState<number | null>(null);
  const [fliesTab, setFliesTab] = useState<'current' | 'graveyard'>('current');
  const [graveyardByWallet, setGraveyardByWallet] = useState<Record<string, Set<number>>>(() => ({}));
  const graveyardSlots = useMemo(
    () => graveyardByWallet[address ?? ''] ?? new Set(),
    [graveyardByWallet, address]
  );
  const isMobileDefault = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  const [statusPanelOpen, setStatusPanelOpen] = useState(() => !isMobileDefault());
  const [statusTab, setStatusTab] = useState<'status' | 'rewards'>('status');
  const [brainPanelOpen, setBrainPanelOpen] = useState(() => !isMobileDefault());

  const snapshotBufferRef = useRef<Snapshot[]>([]);

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

  const { data: rewardsHistory } = useQuery({
    queryKey: ['rewards-history'],
    queryFn: async () => {
      const r = await fetch(getApiBase() + '/api/rewards/history?limit=50');
      if (!r.ok) throw new Error('Failed to fetch');
      const j = await r.json();
      return (j.history ?? []) as { address: string; amountWei: string; timestamp: string; txHash?: string }[];
    },
    refetchInterval: connected ? 15_000 : false,
  });

  const { data: flyStatsData } = useQuery({
    queryKey: ['fly-stats', address ?? ''],
    queryFn: () => fetchFlyStats(address!),
    enabled: !!address,
    refetchInterval: connected ? 5000 : false,
  });
  const statsBySlot = useMemo(() => {
    const m: Record<number, number> = {};
    for (const s of flyStatsData?.stats ?? []) m[s.slotIndex] = s.feedCount;
    return m;
  }, [flyStatsData?.stats]);

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
      const data = event as {
        t?: number;
        flies?: FlyState[];
        fly?: FlyState;
        frames?: Snapshot[];
        activity?: Record<string, number>;
        activities?: (Record<string, number> | undefined)[];
        error?: string;
        sources?: WorldSource[];
      };
      if (data.error) setError(data.error);
      if (data.sources && Array.isArray(data.sources)) setSources(data.sources);
      if (!data.error) {
        const buf = snapshotBufferRef.current;
        if (Array.isArray(data.frames) && data.frames.length > 0) {
          for (const f of data.frames) {
            buf.push({
              t: f.t,
              flies: f.flies,
              activities: f.activities ?? [],
              activity: f.activity ?? f.activities?.[0],
            });
          }
          while (buf.length > 1 && buf[buf.length - 1]!.t - buf[0]!.t > BUFFER_SIM_SEC) {
            buf.shift();
          }
        } else {
          const fliesArr = Array.isArray(data.flies) ? data.flies : data.fly ? [data.fly] : null;
          if (fliesArr) {
            buf.push({
              t: data.t ?? 0,
              flies: fliesArr,
              activities: Array.isArray(data.activities) ? data.activities : [],
              activity: data.activity ?? data.activities?.[0],
            });
          }
        }
        const last = buf[buf.length - 1];
        if (last) {
          setFlies(last.flies);
          setActivities(last.activities ?? []);
          setActivity(last.activity ?? last.activities?.[0] ?? {});
        } else if (Array.isArray(data.flies)) setFlies(data.flies);
        else if (data.fly) setFlies([data.fly]);
        if (data.activity != null) setActivity(data.activity);
        else if (Array.isArray(data.activities) && data.activities[0] != null) setActivity(data.activities[0] ?? {});
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

  useEffect(() => {
    if (effectiveSimIndex == null && cameraMode === 'fly') setCameraMode('god');
  }, [effectiveSimIndex, cameraMode]);

  const flyMode = getFlyMode(focusedFly);

  const flyCameraContextValue = useMemo(
    () => ({
      mode: cameraMode,
      setMode: setCameraMode,
      target:
        effectiveSimIndex != null
          ? {
              x: focusedFly.x ?? 0,
              y: focusedFly.y ?? 0,
              z: focusedFly.z ?? 0,
              heading: focusedFly.heading ?? 0,
            }
          : null,
    }),
    [cameraMode, effectiveSimIndex, focusedFly.x, focusedFly.y, focusedFly.z, focusedFly.heading]
  );

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
    queryClient.invalidateQueries({ queryKey: ['fly-stats', address] });
    refetchDeployed();
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Canvas layer - must stay behind UI */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, isolation: 'isolate' }}>
        <FlyCameraContext.Provider value={flyCameraContextValue}>
          <Canvas camera={{ position: [8, 6, 8], fov: 50 }} gl={{ outputColorSpace: THREE.SRGBColorSpace }}>
            <ambientLight intensity={0.8} />
            <directionalLight position={[10, 10, 5]} intensity={1.2} castShadow />
            <FlyCameraController />
            <Suspense fallback={null}>
              <InterpolatedFlies bufferRef={snapshotBufferRef} latestFlies={flies} />
            </Suspense>
          <WorldSources sources={sources} />
          <GroundPlane />
        </Canvas>
        </FlyCameraContext.Provider>
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
          {effectiveSimIndex != null && (
            <button
              type="button"
              className="fly-viewer__camera-toggle"
              onClick={() => setCameraMode((m) => (m === 'god' ? 'fly' : 'god'))}
              title={cameraMode === 'god' ? 'Follow current fly' : 'Orbit view'}
              style={{
                padding: '6px 10px',
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                background: cameraMode === 'fly' ? 'rgba(35, 70, 138, 0.6)' : 'rgba(0,0,0,0.85)',
                color: '#aaf',
                border: '1px solid rgba(100,100,140,0.3)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {cameraMode === 'god' ? 'Fly view' : 'God view'}
            </button>
          )}
          {focusedFly.dead && (
            <div style={{ width: 120, padding: '6px 8px', background: '#422', color: '#f88', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
              Fly died
            </div>
          )}
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
            <div className="fly-viewer__flies-tabs">
              <button
                type="button"
                className={`fly-viewer__flies-tab ${fliesTab === 'current' ? 'fly-viewer__flies-tab--active' : ''}`}
                onClick={() => setFliesTab('current')}
              >
                <img src="/fly.svg" alt="" width={14} height={14} className="fly-viewer__tab-icon" aria-hidden />
                Current
              </button>
              <button
                type="button"
                className={`fly-viewer__flies-tab ${fliesTab === 'graveyard' ? 'fly-viewer__flies-tab--active' : ''}`}
                onClick={() => setFliesTab('graveyard')}
              >
                <img src="/tombstone.svg" alt="" width={14} height={14} className="fly-viewer__tab-icon fly-viewer__tab-icon--tombstone" aria-hidden />
                Graveyard
              </button>
            </div>
            {fliesTab === 'current' ? (
              <>
                <div className="fly-viewer__current-title">Current Flies</div>
                {[0, 1, 2].map((i) => {
                      const inGraveyard = graveyardSlots.has(i);
                      const hasFly = myFlies[i] != null;
                      const simIdx = deployed[i];
                      const isDeployed = simIdx != null;
                      const hasSimFly = isDeployed && flies[simIdx] != null;
                      const simFly = hasSimFly ? flies[simIdx]! : DEFAULT_FLY;
                      const isDead = hasSimFly && simFly.dead;
                      const isEmpty = myFlies.length === 0 && i === 0;
                      return (
                        <div key={i} className="fly-viewer__fly-slot">
                          {inGraveyard ? (
                            <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--in-graveyard">
                              <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
                              <span className="fly-viewer__fly-slot-label">Fly {i + 1}</span>
                              <span style={{ fontSize: 9, color: '#666' }}>In graveyard</span>
                            </div>
                          ) : !hasFly ? (
                            <button
                              type="button"
                              className={`fly-viewer__fly-slot-empty ${isEmpty ? 'fly-viewer__fly-slot-empty--first' : ''}`}
                              onClick={() => setBuyFlySlot(i)}
                            >
                              <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
                              <span className="fly-viewer__fly-slot-label">
                                Fly {i + 1}
                              </span>
                              <span className="fly-viewer__fly-slot-buy">Buy NeuroFly</span>
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
                              <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
                              <span className="fly-viewer__fly-slot-label">Fly {i + 1}</span>
                              <span className="fly-viewer__fly-slot-buy">Deploy</span>
                            </button>
                          ) : isDeployed && !hasSimFly ? (
                            <div className="fly-viewer__fly-slot-empty fly-viewer__fly-slot--connecting">
                              <img src="/fly.svg" alt="" width={28} height={28} className="fly-viewer__fly-slot-icon" aria-hidden />
                              <span className="fly-viewer__fly-slot-label">Fly {i + 1}</span>
                              <span style={{ fontSize: 9, color: '#888' }}>Connecting…</span>
                            </div>
                          ) : isDead ? (
                            <div className="fly-viewer__fly-slot-dead">
                              <span className="fly-viewer__fly-slot-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                Fly {i + 1} (dead)
                                <span style={{ fontSize: 9, color: '#8a8', fontFamily: 'monospace' }}>{statsBySlot[i] ?? 0} pts</span>
                              </span>
                              <button
                                type="button"
                                className="fly-viewer__fly-slot-graveyard"
                                onClick={() => {
                                  setGraveyardByWallet((prev) => {
                                    const addr = address ?? '';
                                    const set = new Set(prev[addr] ?? []);
                                    set.add(i);
                                    return { ...prev, [addr]: set };
                                  });
                                  const next = [0, 1, 2].find(
                                    (j) =>
                                      j !== i &&
                                      !graveyardSlots.has(j) &&
                                      deployed[j] != null &&
                                      flies[deployed[j]!] != null
                                  );
                                  if (next != null && selectedFlyIndex === i) setSelectedFlyIndex(next);
                                }}
                              >
                                Send to NeuroFly Graveyard
                              </button>
                            </div>
                          ) : (
                            <FlyStatusCard
                              index={i}
                              fly={simFly}
                              selected={i === selectedFlyIndex}
                              onSelect={() => setSelectedFlyIndex(i)}
                              points={statsBySlot[i] ?? 0}
                            />
                          )}
                        </div>
                      );
                    })}
              </>
            ) : (
              <>
                <div className="fly-viewer__graveyard-title">NeuroFly Graveyard</div>
                {[0, 1, 2].map((i) => {
                  const inGraveyard = graveyardSlots.has(i);
                  const pts = statsBySlot[i] ?? 0;
                  const wei = flyStatsData?.rewardPerPointWei ? BigInt(flyStatsData.rewardPerPointWei) * BigInt(pts) : 0n;
                  const ethStr = pts > 0 ? formatEth(wei) : '0';
                  return (
                    <div key={i} className={`fly-viewer__fly-slot fly-viewer__fly-slot--graveyard ${!inGraveyard ? 'fly-viewer__fly-slot--graveyard-empty' : ''}`}>
                      {inGraveyard ? (
                        <>
                          <img src="/fly.svg" alt="" width={20} height={20} className="fly-viewer__fly-slot-icon" aria-hidden />
                          <img src="/tombstone.svg" alt="" width={18} height={18} className="fly-viewer__graveyard-icon" aria-hidden />
                          <div className="fly-viewer__graveyard-fly-info">
                            <span className="fly-viewer__fly-slot-label">Fly {i + 1}</span>
                            <span className="fly-viewer__graveyard-stats">{pts} pts · {ethStr} $NEURO</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <img src="/tombstone.svg" alt="" width={18} height={18} className="fly-viewer__graveyard-icon" aria-hidden />
                          <span className="fly-viewer__fly-slot-label" style={{ color: '#555' }}>—</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </>
            )}
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
        {/* Left: Status panel + toggle (toggle moves with panel edge, same as Brain on right) */}
        <div className="fly-viewer__side-strip fly-viewer__side-strip--left">
          <div className={`fly-viewer__status-panel ${statusPanelOpen ? 'fly-viewer__status-panel--open' : ''}`}>
            <div className="fly-viewer__status-content">
              <div className="fly-viewer__status-tabs">
                <button
                  type="button"
                  className={`fly-viewer__status-tab ${statusTab === 'status' ? 'fly-viewer__status-tab--active' : ''}`}
                  onClick={() => setStatusTab('status')}
                >
                  Status
                </button>
                <button
                  type="button"
                  className={`fly-viewer__status-tab ${statusTab === 'rewards' ? 'fly-viewer__status-tab--active' : ''}`}
                  onClick={() => setStatusTab('rewards')}
                >
                  Rewards
                </button>
              </div>
              {statusTab === 'status' ? (
                <div className="fly-viewer__status-tab-body">
                  <div style={{ color: '#888', marginBottom: 6 }}>Fly {selectedFlyIndex + 1} (viewing)</div>
                  <div style={{ marginBottom: 4 }}>pos ({(focusedFly.x ?? 0).toFixed(1)}, {(focusedFly.y ?? 0).toFixed(1)}, {(focusedFly.z ?? 0).toFixed(1)})</div>
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
                <RewardsTable history={rewardsHistory ?? []} formatEth={formatEth} />
              )}
            </div>
          </div>
          <button
            type="button"
            className={`fly-viewer__side-toggle fly-viewer__side-toggle--status ${statusPanelOpen ? 'fly-viewer__side-toggle--active' : ''}`}
            onClick={() => setStatusPanelOpen((o) => !o)}
            aria-label={statusPanelOpen ? 'Hide status' : 'Show status'}
            aria-expanded={statusPanelOpen}
            title={statusPanelOpen ? 'Hide status' : 'Show status'}
          >
            <span className="fly-viewer__side-toggle-label">Status</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={statusPanelOpen ? 'M19 12H5M12 19l-7-7 7-7' : 'M5 12h14M12 5l7 7-7 7'} /></svg>
          </button>
        </div>
        {/* Right: Brain vertical toggle + panel */}
        <div className="fly-viewer__side-strip fly-viewer__side-strip--right">
          <div className={`fly-viewer__brain-panel ${brainPanelOpen ? 'fly-viewer__brain-panel--open' : ''}`}>
            <div className="fly-viewer__brain-content">
              <div style={{ color: '#888', marginBottom: 6 }}>Brain activity — Fly {selectedFlyIndex + 1} (viewing)</div>
              <div className="fly-viewer__brain-plot">
                <BrainOverlay neurons={neuronsWithPositions} activity={activityForSelected} visible={connected} embedded containerVisible={brainPanelOpen} />
              </div>
            </div>
          </div>
          <button
            type="button"
            className={`fly-viewer__side-toggle fly-viewer__side-toggle--brain ${brainPanelOpen ? 'fly-viewer__side-toggle--active' : ''}`}
            onClick={() => setBrainPanelOpen((o) => !o)}
            aria-label={brainPanelOpen ? 'Hide brain activity' : 'Show brain activity'}
            aria-expanded={brainPanelOpen}
            title={brainPanelOpen ? 'Hide brain activity' : 'Show brain activity'}
          >
            <span className="fly-viewer__side-toggle-label">Brain</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={brainPanelOpen ? 'M5 12h14M12 5l7 7-7 7' : 'M19 12H5M12 19l-7-7 7-7'} /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
