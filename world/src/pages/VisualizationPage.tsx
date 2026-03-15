import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import PlaybackControls from '../components/PlaybackControls';

type ReplayTick = {
  tick: number;
  time_sec: number;
  spikes: string[];
};

type ReplayData = {
  meta: {
    ticks: number;
    dt_sec: number;
    baseline_rate_hz: number;
    generated_at: string;
  };
  ticks: ReplayTick[];
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

function parseReplayJson(input: string): ReplayData {
  const parsed = JSON.parse(input) as ReplayData;
  if (!parsed || !Array.isArray(parsed.ticks) || !parsed.meta) {
    throw new Error('Invalid replay JSON');
  }
  return parsed;
}

function buildScene(container: HTMLDivElement, neuronIds: string[]): SceneState {
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

  const n = Math.max(1, neuronIds.length);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < neuronIds.length; i += 1) {
    const id = neuronIds[i]!;
    idToIndex.set(id, i);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = (col / Math.max(1, cols - 1)) * 2 - 1;
    const y = (row / Math.max(1, rows - 1)) * 2 - 1;
    positions[i * 3] = x * 0.9;
    positions[i * 3 + 1] = -y * 0.9;
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
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [currentTick, setCurrentTick] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);

  const neuronIds = useMemo(() => {
    if (!replay) return [];
    const ids = new Set<string>();
    for (const tick of replay.ticks) {
      for (const id of tick.spikes) ids.add(id);
    }
    return [...ids].sort();
  }, [replay]);

  useEffect(() => {
    const container = sceneContainerRef.current;
    if (!container || neuronIds.length === 0) return;
    if (sceneRef.current) {
      (sceneRef.current.renderer as unknown as { __dispose?: () => void }).__dispose?.();
      sceneRef.current = null;
    }
    sceneRef.current = buildScene(container, neuronIds);
    return () => {
      if (sceneRef.current) {
        (sceneRef.current.renderer as unknown as { __dispose?: () => void }).__dispose?.();
        sceneRef.current = null;
      }
    };
  }, [neuronIds]);

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
      const parsed = parseReplayJson(text);
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
      const res = await fetch('/eonsystems_baseline_spikes_per_tick.json');
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
          <button type="button" onClick={loadDefaultReplay}>Load default replay</button>
          <label style={{ fontSize: 13 }}>
            Load local JSON:
            <input
              type="file"
              accept=".json,application/json"
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
            ? `meta: ticks=${replay.meta.ticks}, dt=${replay.meta.dt_sec}, baseline_hz=${replay.meta.baseline_rate_hz}`
            : 'Load logs/eonsystems_baseline_spikes_per_tick.json to start playback.'}
        </div>
        {error ? <div style={{ color: '#f99', fontSize: 12 }}>{error}</div> : null}
      </div>
      <div ref={sceneContainerRef} style={{ minHeight: 0 }} />
    </div>
  );
}
