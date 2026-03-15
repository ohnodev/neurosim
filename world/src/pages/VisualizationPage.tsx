import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import PlaybackControls from '../components/PlaybackControls';

type RingReplayNeuron = {
  rootId: string;
  ringIndex: number;
  angleDeg: number;
  side: string;
  hemibrainType: string;
};

type RingReplayTick = {
  tick: number;
  timeSec: number;
  spikes: string[];
};

type RingReplayData = {
  neurons: RingReplayNeuron[];
  ticks: RingReplayTick[];
};

type SceneState = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  points: THREE.Points;
  colorAttr: THREE.BufferAttribute;
  idToIndex: Map<string, number>;
};

const INACTIVE_COLOR = new THREE.Color(0x1a2035);
const ACTIVE_COLOR = new THREE.Color(0x7cff90);
const PLAYBACK_BASE_MS = 80;
const RING_RADIUS = 0.88;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseRingReplayCsv(input: string): RingReplayData {
  const lines = input.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error('CSV is empty');
  const neuronMap = new Map<string, RingReplayNeuron>();
  const ticksMap = new Map<number, { timeSec: number; spikes: Array<{ rootId: string; spikeOrder: number }> }>();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i] ?? '');
    if (cols.length < 9) continue;
    const tick = Number(cols[0]);
    const timeSec = Number(cols[1]);
    const spikeOrder = Number(cols[2]);
    const isActive = cols[3] === '1';
    const rootId = cols[4] ?? '';
    const ringIndex = Number(cols[5]);
    const angleDeg = Number(cols[6]);
    const hemibrainType = cols[7] ?? '';
    const side = cols[8] ?? '';
    if (!rootId || !Number.isFinite(ringIndex) || !Number.isFinite(angleDeg)) continue;
    if (!neuronMap.has(rootId)) {
      neuronMap.set(rootId, {
        rootId,
        ringIndex,
        angleDeg,
        side,
        hemibrainType,
      });
    }
    if (!Number.isFinite(tick) || tick <= 0 || !isActive) continue;
    const bucket = ticksMap.get(tick) ?? { timeSec: Number.isFinite(timeSec) ? timeSec : 0, spikes: [] };
    bucket.spikes.push({ rootId, spikeOrder: Number.isFinite(spikeOrder) ? spikeOrder : 0 });
    ticksMap.set(tick, bucket);
  }
  const neurons = [...neuronMap.values()].sort((a, b) => a.ringIndex - b.ringIndex);
  const maxTick = Math.max(1, ...ticksMap.keys());
  const ticks: RingReplayTick[] = [];
  for (let tick = 1; tick <= maxTick; tick += 1) {
    const bucket = ticksMap.get(tick);
    if (!bucket) {
      ticks.push({ tick, timeSec: tick * 0.0001, spikes: [] });
      continue;
    }
    bucket.spikes.sort((a, b) => a.spikeOrder - b.spikeOrder);
    ticks.push({
      tick,
      timeSec: bucket.timeSec,
      spikes: bucket.spikes.map((s) => s.rootId),
    });
  }
  return { neurons, ticks };
}

function buildScene(container: HTMLDivElement, neurons: RingReplayNeuron[]): SceneState {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090d1a);
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 50);
  camera.position.set(0, 0, 2.6);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const n = Math.max(1, neurons.length);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < neurons.length; i += 1) {
    const neuron = neurons[i]!;
    const id = neuron.rootId;
    idToIndex.set(id, i);
    const angleRad = (neuron.angleDeg * Math.PI) / 180;
    positions[i * 3] = Math.cos(angleRad) * RING_RADIUS;
    positions[i * 3 + 1] = Math.sin(angleRad) * RING_RADIUS;
    positions[i * 3 + 2] = 0;
    colors[i * 3] = INACTIVE_COLOR.r;
    colors[i * 3 + 1] = INACTIVE_COLOR.g;
    colors[i * 3 + 2] = INACTIVE_COLOR.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geometry.setAttribute('color', colorAttr);
  const material = new THREE.PointsMaterial({
    size: 0.012,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);

  const light = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(light);

  const render = () => renderer.render(scene, camera);
  render();

  const resizeObserver = new ResizeObserver(() => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    render();
  });
  resizeObserver.observe(container);
  (renderer as unknown as { __dispose?: () => void }).__dispose = () => {
    resizeObserver.disconnect();
    scene.remove(points);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };

  return { scene, camera, renderer, points, colorAttr, idToIndex };
}

function applyTickSpikes(sceneState: SceneState, spikes: string[]): void {
  const { colorAttr, idToIndex, renderer, scene, camera } = sceneState;
  const count = colorAttr.count;
  for (let i = 0; i < count; i += 1) {
    colorAttr.setXYZ(i, INACTIVE_COLOR.r, INACTIVE_COLOR.g, INACTIVE_COLOR.b);
  }
  for (const id of spikes) {
    const idx = idToIndex.get(id);
    if (idx == null) continue;
    colorAttr.setXYZ(idx, ACTIVE_COLOR.r, ACTIVE_COLOR.g, ACTIVE_COLOR.b);
  }
  colorAttr.needsUpdate = true;
  renderer.render(scene, camera);
}

export default function VisualizationPage() {
  const [replay, setReplay] = useState<RingReplayData | null>(null);
  const [currentTick, setCurrentTick] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);

  const neurons = useMemo(() => {
    if (!replay) return [];
    return replay.neurons;
  }, [replay]);

  useEffect(() => {
    const container = sceneContainerRef.current;
    if (!container || neurons.length === 0) return;
    if (sceneRef.current) {
      (sceneRef.current.renderer as unknown as { __dispose?: () => void }).__dispose?.();
      sceneRef.current = null;
    }
    sceneRef.current = buildScene(container, neurons);
    return () => {
      if (sceneRef.current) {
        (sceneRef.current.renderer as unknown as { __dispose?: () => void }).__dispose?.();
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
      setCurrentTick((prev) => {
        if (prev >= replay.ticks.length) return replay.ticks.length;
        return prev + 1;
      });
    }, delay);
    return () => window.clearInterval(timer);
  }, [playing, replay, speed]);

  useEffect(() => {
    if (!replay) return;
    if (currentTick >= replay.ticks.length) {
      setPlaying(false);
    }
  }, [currentTick, replay]);

  const handleReplayText = (text: string) => {
    try {
      const parsed = parseRingReplayCsv(text);
      setReplay(parsed);
      setCurrentTick(1);
      setPlaying(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const loadDefaultReplay = async () => {
    try {
      setError(null);
      const res = await fetch('/eonsystems_ring_neurons_spikes_per_tick.csv');
      if (!res.ok) throw new Error(`Default replay not found (${res.status})`);
      handleReplayText(await res.text());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#060a14' }}>
      <div style={{ padding: 12, display: 'grid', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={loadDefaultReplay}>Load ring replay (CSV)</button>
          <label style={{ fontSize: 13 }}>
            Load local CSV:
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                handleReplayText(await file.text());
              }}
              style={{ marginLeft: 8 }}
            />
          </label>
        </div>
        {replay ? (
          <PlaybackControls
            playing={playing}
            tick={currentTick}
            totalTicks={replay.ticks.length}
            speed={speed}
            onPlayPause={() => setPlaying((p) => !p)}
            onPrevTick={() => setCurrentTick((t) => Math.max(1, t - 1))}
            onNextTick={() => setCurrentTick((t) => Math.min(replay.ticks.length, t + 1))}
            onSeekTick={(tick) => setCurrentTick(Math.max(1, Math.min(replay.ticks.length, tick)))}
            onSpeedChange={setSpeed}
          />
        ) : null}
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          {replay
            ? `ring neurons=${replay.neurons.length}, ticks=${replay.ticks.length}`
            : 'Load logs/eonsystems_ring_neurons_spikes_per_tick.csv to start playback.'}
        </div>
        {error ? <div style={{ color: '#f99', fontSize: 12 }}>{error}</div> : null}
      </div>
      <div ref={sceneContainerRef} style={{ minHeight: 0 }} />
    </div>
  );
}
