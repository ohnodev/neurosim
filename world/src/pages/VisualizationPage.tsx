import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import PlaybackControls from '../components/PlaybackControls';

type ReplayNeuron = {
  root_id: string;
  x: number;
  y: number;
  z: number;
  is_ring: boolean;
  side: string;
  hemibrain_type: string;
};

type ReplayTick = {
  tick: number;
  time_sec: number;
  spikes: string[];
};

type ReplayData = {
  meta: {
    generated_at: string;
    source_csv: string;
    ticks: number;
    unique_fired_neurons: number;
    ring_neuron_total: number;
    ring_neuron_unique_fired: number;
    scenario?: string;
  };
  neurons: ReplayNeuron[];
  ticks: ReplayTick[];
};

type SceneState = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  points: THREE.Points;
  bumpArrow: THREE.ArrowHelper;
  colorAttr: THREE.BufferAttribute;
  idToIndex: Map<string, number>;
  isRingByIndex: boolean[];
  ringDirectionByIndex: Array<THREE.Vector2 | null>;
  dispose: () => void;
};

type ViewMode = 'raw' | 'aligned' | 'compass';
type DatasetMode = 'baseline' | 'left_bias_odor';

const INACTIVE_COLOR = new THREE.Color(0x16203a);
const INACTIVE_RING_COLOR = new THREE.Color(0x3e2c78);
const ACTIVE_COLOR = new THREE.Color(0x6eff9e);
const ACTIVE_RING_COLOR = new THREE.Color(0xff4fd8);
const PLAYBACK_BASE_MS = 80;

type CompassStats = {
  ringActiveCount: number;
  ringLeftCount: number;
  ringRightCount: number;
  bumpAngleDeg: number | null;
  bumpStrength: number;
  ringBins: number[];
};

function powerIteration(
  m: number[][],
  iterations = 24,
  init?: THREE.Vector3,
): THREE.Vector3 {
  let v = (init?.clone() ?? new THREE.Vector3(1, 0, 0)).normalize();
  for (let i = 0; i < iterations; i += 1) {
    const next = new THREE.Vector3(
      m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
      m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
      m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
    );
    if (next.lengthSq() < 1e-12) break;
    v = next.normalize();
  }
  return v;
}

function computeAlignedPoints(neurons: ReplayNeuron[], alignToRing: boolean): THREE.Vector3[] {
  const points = neurons.map((n) => new THREE.Vector3(n.x, n.y, n.z));
  if (!alignToRing) return points;
  const ring = neurons.filter((n) => n.is_ring);
  if (ring.length < 3) return points;

  const center = new THREE.Vector3();
  for (const n of ring) center.add(new THREE.Vector3(n.x, n.y, n.z));
  center.multiplyScalar(1 / ring.length);

  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const n of ring) {
    const dx = n.x - center.x;
    const dy = n.y - center.y;
    const dz = n.z - center.z;
    cov[0][0] += dx * dx; cov[0][1] += dx * dy; cov[0][2] += dx * dz;
    cov[1][0] += dy * dx; cov[1][1] += dy * dy; cov[1][2] += dy * dz;
    cov[2][0] += dz * dx; cov[2][1] += dz * dy; cov[2][2] += dz * dz;
  }
  const inv = 1 / ring.length;
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) cov[r][c] *= inv;

  let u = powerIteration(cov, 28, new THREE.Vector3(1, 0.2, 0.1));
  const lambdaU =
    u.x * (cov[0][0] * u.x + cov[0][1] * u.y + cov[0][2] * u.z) +
    u.y * (cov[1][0] * u.x + cov[1][1] * u.y + cov[1][2] * u.z) +
    u.z * (cov[2][0] * u.x + cov[2][1] * u.y + cov[2][2] * u.z);
  const deflated = [
    [cov[0][0] - lambdaU * u.x * u.x, cov[0][1] - lambdaU * u.x * u.y, cov[0][2] - lambdaU * u.x * u.z],
    [cov[1][0] - lambdaU * u.y * u.x, cov[1][1] - lambdaU * u.y * u.y, cov[1][2] - lambdaU * u.y * u.z],
    [cov[2][0] - lambdaU * u.z * u.x, cov[2][1] - lambdaU * u.z * u.y, cov[2][2] - lambdaU * u.z * u.z],
  ];
  let v = powerIteration(deflated, 28, new THREE.Vector3(0.1, 1, 0.3));
  v.sub(u.clone().multiplyScalar(v.dot(u)));
  if (v.lengthSq() < 1e-10) v = new THREE.Vector3(0, 1, 0);
  v.normalize();
  let w = new THREE.Vector3().crossVectors(u, v);
  if (w.lengthSq() < 1e-10) w = new THREE.Vector3(0, 0, 1);
  w.normalize();
  v = new THREE.Vector3().crossVectors(w, u).normalize();

  // Stabilize left/right orientation so view stays consistent.
  let leftProj = 0;
  let rightProj = 0;
  let leftCount = 0;
  let rightCount = 0;
  for (const n of ring) {
    const d = new THREE.Vector3(n.x - center.x, n.y - center.y, n.z - center.z);
    const p = d.dot(u);
    if (n.side === 'left') { leftProj += p; leftCount += 1; }
    if (n.side === 'right') { rightProj += p; rightCount += 1; }
  }
  if (leftCount > 0 && rightCount > 0 && (rightProj / rightCount) < (leftProj / leftCount)) {
    u.multiplyScalar(-1);
    w.multiplyScalar(-1);
  }

  return points.map((p) => {
    const d = p.clone().sub(center);
    return new THREE.Vector3(d.dot(u), d.dot(v), d.dot(w));
  });
}

function buildScene(container: HTMLDivElement, neurons: ReplayNeuron[], viewMode: ViewMode): SceneState {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090d1a);

  const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 100);
  camera.position.set(0, 0, 2.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.3;
  controls.maxDistance = 8;

  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  const aligned = computeAlignedPoints(neurons, viewMode !== 'raw');
  if (viewMode === 'compass') {
    const ringIndices: number[] = [];
    for (let i = 0; i < neurons.length; i += 1) {
      if (neurons[i]?.is_ring) ringIndices.push(i);
    }
    if (ringIndices.length > 3) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const i of ringIndices) {
        cx += aligned[i]!.x;
        cy += aligned[i]!.y;
        cz += aligned[i]!.z;
      }
      cx /= ringIndices.length;
      cy /= ringIndices.length;
      cz /= ringIndices.length;
      let radiusSum = 0;
      let radiusCount = 0;
      for (const i of ringIndices) {
        const p = aligned[i]!;
        const dx = p.x - cx;
        const dy = p.y - cy;
        const r = Math.hypot(dx, dy);
        if (r > 1e-8) {
          radiusSum += r;
          radiusCount += 1;
        }
      }
      const targetRadius = radiusCount > 0 ? radiusSum / radiusCount : 1;
      for (const i of ringIndices) {
        const p = aligned[i]!;
        const dx = p.x - cx;
        const dy = p.y - cy;
        const r = Math.hypot(dx, dy);
        if (r > 1e-8) {
          p.x = cx + (dx / r) * targetRadius;
          p.y = cy + (dy / r) * targetRadius;
        }
        p.z = cz;
      }
    }
  }
  for (const p of aligned) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const scale = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);

  const n = neurons.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const idToIndex = new Map<string, number>();
  const isRingByIndex: boolean[] = new Array(n).fill(false);
  const ringDirectionByIndex: Array<THREE.Vector2 | null> = new Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    const neuron = neurons[i]!;
    const p = aligned[i]!;
    idToIndex.set(neuron.root_id, i);
    isRingByIndex[i] = neuron.is_ring;
    positions[i * 3] = (p.x - cx) / scale;
    positions[i * 3 + 1] = (p.y - cy) / scale;
    positions[i * 3 + 2] = (p.z - cz) / scale;
    if (neuron.is_ring) {
      const v = new THREE.Vector2(positions[i * 3], positions[i * 3 + 1]);
      if (v.lengthSq() > 1e-8) {
        ringDirectionByIndex[i] = v.normalize();
      }
    }
    const c = neuron.is_ring ? INACTIVE_RING_COLOR : INACTIVE_COLOR;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geometry.setAttribute('color', colorAttr);
  const material = new THREE.PointsMaterial({
    size: 0.01,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.96,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);
  const bumpArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    0.0001,
    ACTIVE_RING_COLOR.getHex(),
    0.06,
    0.03,
  );
  bumpArrow.visible = false;
  scene.add(bumpArrow);

  scene.add(new THREE.AmbientLight(0xffffff, 0.95));

  let raf = 0;
  const animate = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(animate);
  };
  animate();

  const resizeObserver = new ResizeObserver(() => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  const dispose = () => {
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    controls.dispose();
    scene.remove(bumpArrow);
    scene.remove(points);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };

  return {
    scene,
    camera,
    renderer,
    controls,
    points,
    bumpArrow,
    colorAttr,
    idToIndex,
    isRingByIndex,
    ringDirectionByIndex,
    dispose,
  };
}

function applyTickSpikes(sceneState: SceneState, spikes: string[]): CompassStats {
  const { colorAttr, idToIndex, isRingByIndex, ringDirectionByIndex, bumpArrow } = sceneState;
  const count = colorAttr.count;
  for (let i = 0; i < count; i += 1) {
    const c = isRingByIndex[i] ? INACTIVE_RING_COLOR : INACTIVE_COLOR;
    colorAttr.setXYZ(i, c.r, c.g, c.b);
  }
  let ringActiveCount = 0;
  let ringLeftCount = 0;
  let ringRightCount = 0;
  const bump = new THREE.Vector2(0, 0);
  const ringBins = new Array<number>(24).fill(0);
  for (const id of spikes) {
    const idx = idToIndex.get(id);
    if (idx == null) continue;
    const c = isRingByIndex[idx] ? ACTIVE_RING_COLOR : ACTIVE_COLOR;
    colorAttr.setXYZ(idx, c.r, c.g, c.b);
    if (isRingByIndex[idx]) {
      ringActiveCount += 1;
      const d = ringDirectionByIndex[idx];
      if (d) {
        bump.add(d);
        if (d.x < 0) ringLeftCount += 1;
        else if (d.x > 0) ringRightCount += 1;
        const angle = Math.atan2(d.y, d.x);
        const normalized = (angle + Math.PI) / (2 * Math.PI);
        const bin = Math.max(0, Math.min(ringBins.length - 1, Math.floor(normalized * ringBins.length)));
        ringBins[bin] += 1;
      }
    }
  }
  const bumpStrength = ringActiveCount > 0 ? bump.length() / ringActiveCount : 0;
  const bumpAngleDeg = bump.lengthSq() > 1e-8 ? (Math.atan2(bump.y, bump.x) * 180) / Math.PI : null;
  if (bumpAngleDeg == null) {
    bumpArrow.visible = false;
  } else {
    bumpArrow.visible = true;
    const dir3 = new THREE.Vector3(Math.cos((bumpAngleDeg * Math.PI) / 180), Math.sin((bumpAngleDeg * Math.PI) / 180), 0);
    bumpArrow.setDirection(dir3.normalize());
    bumpArrow.setLength(0.35 + 0.5 * Math.min(1, bumpStrength), 0.07, 0.035);
    bumpArrow.setColor(ACTIVE_RING_COLOR);
  }
  colorAttr.needsUpdate = true;
  const ringBinMax = ringBins.reduce((m, v) => Math.max(m, v), 0);
  const ringBinNorm = ringBinMax > 0 ? ringBins.map((v) => v / ringBinMax) : ringBins;
  return { ringActiveCount, ringLeftCount, ringRightCount, bumpAngleDeg, bumpStrength, ringBins: ringBinNorm };
}

export default function VisualizationPage() {
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [currentTick, setCurrentTick] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>('compass');
  const [datasetMode, setDatasetMode] = useState<DatasetMode>('baseline');
  const [compassStats, setCompassStats] = useState<CompassStats>({
    ringActiveCount: 0,
    ringLeftCount: 0,
    ringRightCount: 0,
    bumpAngleDeg: null,
    bumpStrength: 0,
    ringBins: new Array<number>(24).fill(0),
  });
  const [error, setError] = useState<string | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);

  const neurons = useMemo(() => replay?.neurons ?? [], [replay]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setError(null);
        const datasetUrl = datasetMode === 'baseline'
          ? '/eonsystems_brain_subset_baseline_replay.json'
          : '/eonsystems_brain_subset_left_bias_replay.json';
        const res = await fetch(datasetUrl);
        if (!res.ok) throw new Error(`Replay not found (${res.status})`);
        const parsed = await res.json() as ReplayData;
        if (!active) return;
        setReplay(parsed);
        setCurrentTick(1);
        setPlaying(false);
      } catch (err) {
        if (!active) return;
        setError((err as Error).message);
      }
    };
    void load();
    return () => { active = false; };
  }, [datasetMode]);

  useEffect(() => {
    const container = sceneContainerRef.current;
    if (!container || neurons.length === 0) return;
    if (sceneRef.current) {
      sceneRef.current.dispose();
      sceneRef.current = null;
    }
    sceneRef.current = buildScene(container, neurons, viewMode);
    return () => {
      if (sceneRef.current) {
        sceneRef.current.dispose();
        sceneRef.current = null;
      }
    };
  }, [neurons, viewMode]);

  useEffect(() => {
    if (!replay || !sceneRef.current) return;
    const idx = Math.max(0, Math.min(replay.ticks.length - 1, currentTick - 1));
    const spikes = replay.ticks[idx]?.spikes ?? [];
    const stats = applyTickSpikes(sceneRef.current, spikes);
    setCompassStats(stats);
  }, [replay, currentTick]);

  useEffect(() => {
    if (!playing || !replay) return undefined;
    const delay = Math.max(1, PLAYBACK_BASE_MS / Math.max(0.1, speed));
    const timer = window.setInterval(() => {
      setCurrentTick((prev) => (prev >= replay.ticks.length ? replay.ticks.length : prev + 1));
    }, delay);
    return () => window.clearInterval(timer);
  }, [playing, replay, speed]);

  useEffect(() => {
    if (!replay) return;
    if (currentTick >= replay.ticks.length) setPlaying(false);
  }, [currentTick, replay]);

  const totalTicks = replay?.ticks.length ?? 1;
  const ringCount = replay?.neurons.filter((n) => n.is_ring).length ?? 0;
  const bumpTheta = compassStats.bumpAngleDeg != null ? ((compassStats.bumpAngleDeg + 360) % 360) : null;

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#060a14' }}>
      <div style={{ padding: 12, display: 'grid', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setDatasetMode('baseline')} style={{ opacity: datasetMode === 'baseline' ? 1 : 0.65 }}>
            Baseline
          </button>
          <button type="button" onClick={() => setDatasetMode('left_bias_odor')} style={{ opacity: datasetMode === 'left_bias_odor' ? 1 : 0.65 }}>
            Left-bias odor
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setViewMode('raw')} style={{ opacity: viewMode === 'raw' ? 1 : 0.65 }}>Raw</button>
          <button type="button" onClick={() => setViewMode('aligned')} style={{ opacity: viewMode === 'aligned' ? 1 : 0.65 }}>Aligned</button>
          <button type="button" onClick={() => setViewMode('compass')} style={{ opacity: viewMode === 'compass' ? 1 : 0.65 }}>Compass loop</button>
        </div>
        {replay ? (
          <PlaybackControls
            playing={playing}
            tick={currentTick}
            totalTicks={totalTicks}
            speed={speed}
            onPlayPause={() => setPlaying((p) => !p)}
            onPrevTick={() => setCurrentTick((t) => Math.max(1, t - 1))}
            onNextTick={() => setCurrentTick((t) => Math.min(totalTicks, t + 1))}
            onSeekTick={(tick) => setCurrentTick(Math.max(1, Math.min(totalTicks, tick)))}
            onSpeedChange={setSpeed}
          />
        ) : null}
        <div style={{ fontSize: 12, opacity: 0.9 }}>
          {replay
            ? `dataset=${datasetMode} | neurons=${replay.neurons.length} (ring=${ringCount}) | ticks=${replay.ticks.length} | ring fired=${replay.meta.ring_neuron_unique_fired} | view=${viewMode}`
            : 'Loading preprocessed brain subset replay...'}
        </div>
        {replay ? (
          <div style={{ fontSize: 12, opacity: 0.95 }}>
            ring tick: active={compassStats.ringActiveCount} left={compassStats.ringLeftCount} right={compassStats.ringRightCount}
            {' '}| bump angle={compassStats.bumpAngleDeg == null ? 'n/a' : `${compassStats.bumpAngleDeg.toFixed(1)}deg`}
            {' '}| bump strength={compassStats.bumpStrength.toFixed(3)}
          </div>
        ) : null}
        {replay ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <svg width="120" height="120" viewBox="-60 -60 120 120" style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
              <circle cx="0" cy="0" r="42" fill="none" stroke="rgba(140,120,255,0.35)" strokeWidth="2" />
              {compassStats.ringBins.map((v, i) => {
                const a0 = (i / compassStats.ringBins.length) * Math.PI * 2 - Math.PI / 2;
                const a1 = ((i + 1) / compassStats.ringBins.length) * Math.PI * 2 - Math.PI / 2;
                const r0 = 30;
                const r1 = 30 + v * 14;
                const x0 = Math.cos(a0) * r0; const y0 = Math.sin(a0) * r0;
                const x1 = Math.cos(a1) * r0; const y1 = Math.sin(a1) * r0;
                const x2 = Math.cos(a1) * r1; const y2 = Math.sin(a1) * r1;
                const x3 = Math.cos(a0) * r1; const y3 = Math.sin(a0) * r1;
                const alpha = 0.2 + v * 0.8;
                return (
                  <path
                    key={`bin-${i}`}
                    d={`M ${x0} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`}
                    fill={`rgba(255,79,216,${alpha.toFixed(3)})`}
                    stroke="none"
                  />
                );
              })}
              {bumpTheta != null ? (
                <line
                  x1="0"
                  y1="0"
                  x2={(Math.cos((bumpTheta - 90) * Math.PI / 180) * 48).toFixed(3)}
                  y2={(Math.sin((bumpTheta - 90) * Math.PI / 180) * 48).toFixed(3)}
                  stroke="#ff4fd8"
                  strokeWidth="2.5"
                />
              ) : null}
            </svg>
            <div style={{ fontSize: 11, opacity: 0.85, maxWidth: 420 }}>
              Closed-loop compass readout: sector intensity shows ring activity distribution for this tick; arrow shows bump angle.
              In baseline you should see wandering/noisy sectors, while directional odor should bias occupancy and produce more coherent drift.
            </div>
          </div>
        ) : null}
        {error ? <div style={{ color: '#f99', fontSize: 12 }}>{error}</div> : null}
      </div>
      <div ref={sceneContainerRef} style={{ minHeight: 0 }} />
    </div>
  );
}
