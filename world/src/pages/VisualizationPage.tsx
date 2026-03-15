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
  colorAttr: THREE.BufferAttribute;
  idToIndex: Map<string, number>;
  isRingByIndex: boolean[];
  dispose: () => void;
};

const INACTIVE_COLOR = new THREE.Color(0x16203a);
const INACTIVE_RING_COLOR = new THREE.Color(0x3e2c78);
const ACTIVE_COLOR = new THREE.Color(0x6eff9e);
const ACTIVE_RING_COLOR = new THREE.Color(0xff4fd8);
const PLAYBACK_BASE_MS = 80;

function buildScene(container: HTMLDivElement, neurons: ReplayNeuron[]): SceneState {
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
  for (const n of neurons) {
    if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z;
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

  for (let i = 0; i < n; i += 1) {
    const neuron = neurons[i]!;
    idToIndex.set(neuron.root_id, i);
    isRingByIndex[i] = neuron.is_ring;
    positions[i * 3] = (neuron.x - cx) / scale;
    positions[i * 3 + 1] = (neuron.y - cy) / scale;
    positions[i * 3 + 2] = (neuron.z - cz) / scale;
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
    scene.remove(points);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };

  return { scene, camera, renderer, controls, points, colorAttr, idToIndex, isRingByIndex, dispose };
}

function applyTickSpikes(sceneState: SceneState, spikes: string[]): void {
  const { colorAttr, idToIndex, isRingByIndex } = sceneState;
  const count = colorAttr.count;
  for (let i = 0; i < count; i += 1) {
    const c = isRingByIndex[i] ? INACTIVE_RING_COLOR : INACTIVE_COLOR;
    colorAttr.setXYZ(i, c.r, c.g, c.b);
  }
  for (const id of spikes) {
    const idx = idToIndex.get(id);
    if (idx == null) continue;
    const c = isRingByIndex[idx] ? ACTIVE_RING_COLOR : ACTIVE_COLOR;
    colorAttr.setXYZ(idx, c.r, c.g, c.b);
  }
  colorAttr.needsUpdate = true;
}

export default function VisualizationPage() {
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [currentTick, setCurrentTick] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);

  const neurons = useMemo(() => replay?.neurons ?? [], [replay]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setError(null);
        const res = await fetch('/eonsystems_brain_subset_replay.json');
        if (!res.ok) throw new Error(`Replay not found (${res.status})`);
        const parsed = await res.json() as ReplayData;
        if (!active) return;
        setReplay(parsed);
        setCurrentTick(1);
      } catch (err) {
        if (!active) return;
        setError((err as Error).message);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const container = sceneContainerRef.current;
    if (!container || neurons.length === 0) return;
    if (sceneRef.current) {
      sceneRef.current.dispose();
      sceneRef.current = null;
    }
    sceneRef.current = buildScene(container, neurons);
    return () => {
      if (sceneRef.current) {
        sceneRef.current.dispose();
        sceneRef.current = null;
      }
    };
  }, [neurons]);

  useEffect(() => {
    if (!replay || !sceneRef.current) return;
    const idx = Math.max(0, Math.min(replay.ticks.length - 1, currentTick - 1));
    const spikes = replay.ticks[idx]?.spikes ?? [];
    applyTickSpikes(sceneRef.current, spikes);
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

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#060a14' }}>
      <div style={{ padding: 12, display: 'grid', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
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
            ? `neurons=${replay.neurons.length} (ring=${ringCount}) | ticks=${replay.ticks.length} | ring fired=${replay.meta.ring_neuron_unique_fired}`
            : 'Loading preprocessed brain subset replay...'}
        </div>
        {error ? <div style={{ color: '#f99', fontSize: 12 }}>{error}</div> : null}
      </div>
      <div ref={sceneContainerRef} style={{ minHeight: 0 }} />
    </div>
  );
}
