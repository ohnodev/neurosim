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
  is_epg: boolean;
  epg_tile_index_0_7?: number;
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
    epg_neuron_total?: number;
    epg_neuron_unique_fired?: number;
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
  glowPoints: THREE.Points;
  bumpArrow: THREE.ArrowHelper;
  colorAttr: THREE.BufferAttribute;
  glowColorAttr: THREE.BufferAttribute;
  idToIndex: Map<string, number>;
  isRingByIndex: boolean[];
  isEpgByIndex: boolean[];
  ringDirectionByIndex: Array<THREE.Vector2 | null>;
  epgDirectionByIndex: Array<THREE.Vector2 | null>;
  epgBinByIndex: Array<number | null>;
  epgBinPopulation: number[];
  epgHeatByIndex: number[];
  lastAppliedTick: number;
  decodeEmaAngleDeg: number | null;
  arrowState: {
    angleCurrentDeg: number;
    angleTargetDeg: number;
    strengthCurrent: number;
    strengthTarget: number;
    smoothingEnabled: boolean;
    smoothAlpha: number;
  };
  dispose: () => void;
};

type ViewMode = 'raw' | 'aligned' | 'compass';
type DatasetMode = 'baseline' | 'left_bias_odor' | 'joe_toggle_300' | 'visual_cue_stripe';
type FocusPopulation = 'all' | 'epg_only';
type DecodeMode = 'vector_norm' | 'sharpened_p2' | 'argmax_bin' | 'ema_vector';
type PlaybackSpeed = number | 'irl';

const INACTIVE_COLOR = new THREE.Color(0x2e3e5d);
const INACTIVE_RING_COLOR = new THREE.Color(0x6b58a9);
const INACTIVE_EPG_COLOR = new THREE.Color(0x4d6fb6);
const ACTIVE_COLOR = new THREE.Color(0x6eff9e);
const ACTIVE_RING_COLOR = new THREE.Color(0xff4fd8);
const ACTIVE_EPG_COLOR = new THREE.Color(0xfff07a);
const EPG_HEAT_ORANGE = new THREE.Color(0xff9f43);
const EPG_HEAT_RED = new THREE.Color(0xff3b30);
const NO_GLOW_COLOR = new THREE.Color(0x000000);
const PLAYBACK_BASE_MS = 80;
const EPG_COMPASS_BINS = 8;
const EPG_BUMP_WINDOW_TICKS = 5;
const EPG_HEAT_TAU_TICKS = 3;
const EPG_HEAT_ADD = 0.25;
const EPG_HEAT_MAX = 1.8;
const EPG_EMA_ALPHA = 0.2;
const EPG_GLOW_SIZE = 0.13;
const EPG_GLOW_OPACITY = 0.52;

function controlButtonStyle(active: boolean): Record<string, string | number> {
  return {
    color: '#eef4ff',
    background: active ? '#3a5787' : '#2a3e60',
    border: '1px solid #6f8fc0',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    opacity: active ? 1 : 0.78,
  };
}

type CompassStats = {
  epgActiveCount: number;
  epgLeftCount: number;
  epgRightCount: number;
  ringActiveCount: number;
  bumpAngleDeg: number | null;
  bumpStrength: number;
  epgBins: number[];
  epgWindowSpikes: number;
  epgWindowTicks: number;
  epgWindowMs: number;
  epgTopBinIndex: number;
  epgTopBinSpikes: number;
};

function normalizeAngleDeg(angleDeg: number): number {
  let a = angleDeg;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

function shortestAngleLerpDeg(fromDeg: number, toDeg: number, alpha: number): number {
  const delta = normalizeAngleDeg(toDeg - fromDeg);
  return normalizeAngleDeg(fromDeg + delta * alpha);
}

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
  // Prefer EPG population for compass alignment; fallback to ring neurons.
  const anchor = neurons.filter((n) => n.is_epg);
  const ring = anchor.length >= 3 ? anchor : neurons.filter((n) => n.is_ring);
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

function createGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    return texture;
  }
  const center = size / 2;
  const grad = ctx.createRadialGradient(center, center, 0, center, center, center);
  grad.addColorStop(0, 'rgba(255,255,255,1.0)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.2)');
  grad.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.Texture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function buildScene(container: HTMLDivElement, neurons: ReplayNeuron[], viewMode: ViewMode): SceneState {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2435);
  const mostlyEpg = neurons.filter((n) => n.is_epg).length >= Math.max(8, Math.floor(neurons.length * 0.7));

  const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 100);
  camera.position.set(0, 0, mostlyEpg ? 1.25 : 2.5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = mostlyEpg ? 0.1 : 0.3;
  controls.maxDistance = mostlyEpg ? 4 : 8;

  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  const aligned = computeAlignedPoints(neurons, viewMode !== 'raw');
  if (viewMode === 'compass') {
    const ringIndices: number[] = [];
    for (let i = 0; i < neurons.length; i += 1) {
      if (neurons[i]?.is_epg) ringIndices.push(i);
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

      // Prefer explicit EPG tile mapping (0..7) for true functional ring layout.
      const tileGroups = new Map<number, number[]>();
      for (const i of ringIndices) {
        const tile = neurons[i]?.epg_tile_index_0_7;
        if (tile == null || tile < 0 || tile > 7) continue;
        const group = tileGroups.get(tile) ?? [];
        group.push(i);
        tileGroups.set(tile, group);
      }

      if (tileGroups.size >= 4) {
        for (const [tile, indices] of tileGroups.entries()) {
          indices.sort((a, b) => (neurons[a]?.root_id ?? '').localeCompare(neurons[b]?.root_id ?? ''));
          const sector = (Math.PI * 2) / 8;
          const baseAngle = (tile / 8) * Math.PI * 2;
          const spread = sector * 0.35;
          for (let k = 0; k < indices.length; k += 1) {
            const idx = indices[k]!;
            const centered = indices.length > 1 ? (k / (indices.length - 1)) - 0.5 : 0;
            const a = baseAngle + centered * spread;
            const p = aligned[idx]!;
            p.x = cx + Math.cos(a) * targetRadius;
            p.y = cy + Math.sin(a) * targetRadius;
            p.z = cz;
          }
        }
      } else {
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
  const glowColors = new Float32Array(n * 3);
  const idToIndex = new Map<string, number>();
  const isRingByIndex: boolean[] = new Array(n).fill(false);
  const isEpgByIndex: boolean[] = new Array(n).fill(false);
  const ringDirectionByIndex: Array<THREE.Vector2 | null> = new Array(n).fill(null);
  const epgDirectionByIndex: Array<THREE.Vector2 | null> = new Array(n).fill(null);
  const epgBinByIndex: Array<number | null> = new Array(n).fill(null);
  const epgBinPopulation = new Array<number>(EPG_COMPASS_BINS).fill(0);
  const epgHeatByIndex = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const neuron = neurons[i]!;
    const p = aligned[i]!;
    idToIndex.set(neuron.root_id, i);
    isRingByIndex[i] = neuron.is_ring;
    isEpgByIndex[i] = neuron.is_epg;
    positions[i * 3] = (p.x - cx) / scale;
    positions[i * 3 + 1] = (p.y - cy) / scale;
    positions[i * 3 + 2] = (p.z - cz) / scale;
    if (neuron.is_ring) {
      const v = new THREE.Vector2(positions[i * 3], positions[i * 3 + 1]);
      if (v.lengthSq() > 1e-8) {
        ringDirectionByIndex[i] = v.normalize();
      }
    }
    if (neuron.is_epg) {
      if (neuron.epg_tile_index_0_7 != null) {
        const tile = Math.max(0, Math.min(EPG_COMPASS_BINS - 1, neuron.epg_tile_index_0_7));
        const a = (tile / EPG_COMPASS_BINS) * Math.PI * 2;
        epgDirectionByIndex[i] = new THREE.Vector2(Math.cos(a), Math.sin(a));
        epgBinByIndex[i] = tile;
        epgBinPopulation[tile] += 1;
      } else {
        const ev = new THREE.Vector2(positions[i * 3], positions[i * 3 + 1]);
        if (ev.lengthSq() > 1e-8) {
          epgDirectionByIndex[i] = ev.normalize();
          const angle = Math.atan2(ev.y, ev.x);
          const normalized = (angle + Math.PI) / (2 * Math.PI);
          const bin = Math.max(0, Math.min(EPG_COMPASS_BINS - 1, Math.floor(normalized * EPG_COMPASS_BINS)));
          epgBinByIndex[i] = bin;
          epgBinPopulation[bin] += 1;
        }
      }
    }
    const c = neuron.is_epg ? INACTIVE_EPG_COLOR : neuron.is_ring ? INACTIVE_RING_COLOR : INACTIVE_COLOR;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    glowColors[i * 3] = 0;
    glowColors[i * 3 + 1] = 0;
    glowColors[i * 3 + 2] = 0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geometry.setAttribute('color', colorAttr);
  const glowGeometry = new THREE.BufferGeometry();
  glowGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const glowColorAttr = new THREE.BufferAttribute(glowColors, 3);
  glowGeometry.setAttribute('color', glowColorAttr);
  const material = new THREE.PointsMaterial({
    size: mostlyEpg ? 0.028 : 0.012,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);
  const glowTexture = createGlowTexture();
  const glowMaterial = new THREE.PointsMaterial({
    size: mostlyEpg ? EPG_GLOW_SIZE : 0.05,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: EPG_GLOW_OPACITY,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    map: glowTexture,
    alphaTest: 0.01,
  });
  const glowPoints = new THREE.Points(glowGeometry, glowMaterial);
  scene.add(glowPoints);
  const bumpArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    0.0001,
    ACTIVE_RING_COLOR.getHex(),
    0.06,
    0.03,
  );
  bumpArrow.visible = true;
  scene.add(bumpArrow);

  const arrowState = {
    angleCurrentDeg: 0,
    angleTargetDeg: 0,
    strengthCurrent: 0.2,
    strengthTarget: 0.2,
    smoothingEnabled: true,
    smoothAlpha: 0.18,
  };

  scene.add(new THREE.AmbientLight(0xffffff, 0.95));

  let raf = 0;
  const animate = () => {
    const smoothAlpha = arrowState.smoothingEnabled ? arrowState.smoothAlpha : 1;
    arrowState.angleCurrentDeg = shortestAngleLerpDeg(arrowState.angleCurrentDeg, arrowState.angleTargetDeg, smoothAlpha);
    arrowState.strengthCurrent = arrowState.strengthCurrent + (arrowState.strengthTarget - arrowState.strengthCurrent) * smoothAlpha;
    const dir3 = new THREE.Vector3(
      Math.cos((arrowState.angleCurrentDeg * Math.PI) / 180),
      Math.sin((arrowState.angleCurrentDeg * Math.PI) / 180),
      0,
    ).normalize();
    bumpArrow.setDirection(dir3);
    bumpArrow.setLength(0.28 + 0.52 * Math.min(1, Math.max(0.08, arrowState.strengthCurrent)), 0.07, 0.035);
    bumpArrow.setColor(ACTIVE_RING_COLOR);
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
    scene.remove(glowPoints);
    scene.remove(points);
    glowGeometry.dispose();
    glowMaterial.dispose();
    glowTexture.dispose();
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
    glowPoints,
    bumpArrow,
    colorAttr,
    glowColorAttr,
    idToIndex,
    isRingByIndex,
    isEpgByIndex,
    ringDirectionByIndex,
    epgDirectionByIndex,
    epgBinByIndex,
    epgBinPopulation,
    epgHeatByIndex,
    lastAppliedTick: 0,
    decodeEmaAngleDeg: null,
    arrowState,
    dispose,
  };
}

function buildEpgWindowWeights(
  replay: ReplayData,
  currentTick: number,
  windowTicks: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const endIdx = Math.max(0, Math.min(replay.ticks.length - 1, currentTick - 1));
  const startIdx = Math.max(0, endIdx - windowTicks + 1);
  for (let i = startIdx; i <= endIdx; i += 1) {
    for (const id of replay.ticks[i]?.spikes ?? []) {
      out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

function epgHeatToColor(heat: number): THREE.Color {
  const t = Math.max(0, Math.min(1, heat / EPG_HEAT_MAX));
  if (t <= 0) return INACTIVE_EPG_COLOR.clone();
  if (t < 0.5) {
    return ACTIVE_EPG_COLOR.clone().lerp(EPG_HEAT_ORANGE, t / 0.5);
  }
  return EPG_HEAT_ORANGE.clone().lerp(EPG_HEAT_RED, (t - 0.5) / 0.5);
}

function epgHeatToGlowColor(heat: number): THREE.Color {
  const t = Math.max(0, Math.min(1, heat / EPG_HEAT_MAX));
  if (t <= 0) return NO_GLOW_COLOR;
  const base = ACTIVE_EPG_COLOR.clone().lerp(EPG_HEAT_RED, Math.pow(t, 0.8));
  return base.multiplyScalar(0.15 + 0.95 * t * t);
}

function applyTickSpikes(
  sceneState: SceneState,
  spikes: string[],
  epgWindowWeights?: Map<string, number>,
  epgWindowTicks = 1,
  dtSec = 0.0001,
  currentTick = 1,
  decodeMode: DecodeMode = 'vector_norm',
): CompassStats {
  const {
    colorAttr,
    glowColorAttr,
    idToIndex,
    isRingByIndex,
    isEpgByIndex,
    epgBinByIndex,
    epgBinPopulation,
    epgHeatByIndex,
  } = sceneState;
  const tickDelta = sceneState.lastAppliedTick > 0 ? Math.max(1, currentTick - sceneState.lastAppliedTick) : 1;
  if (currentTick < sceneState.lastAppliedTick) {
    epgHeatByIndex.fill(0);
  }
  const decayFactor = Math.exp(-(tickDelta / EPG_HEAT_TAU_TICKS));
  for (let i = 0; i < epgHeatByIndex.length; i += 1) {
    epgHeatByIndex[i] *= decayFactor;
    if (epgHeatByIndex[i] < 1e-4) epgHeatByIndex[i] = 0;
  }
  const count = colorAttr.count;
  for (let i = 0; i < count; i += 1) {
    const c = isEpgByIndex[i]
      ? epgHeatToColor(epgHeatByIndex[i] ?? 0)
      : isRingByIndex[i]
        ? INACTIVE_RING_COLOR
        : INACTIVE_COLOR;
    colorAttr.setXYZ(i, c.r, c.g, c.b);
    const g = isEpgByIndex[i] ? epgHeatToGlowColor(epgHeatByIndex[i] ?? 0) : NO_GLOW_COLOR;
    glowColorAttr.setXYZ(i, g.r, g.g, g.b);
  }
  let epgActiveCount = 0;
  let epgLeftCount = 0;
  let epgRightCount = 0;
  let ringActiveCount = 0;
  const epgBinsRaw = new Array<number>(EPG_COMPASS_BINS).fill(0);
  for (const id of spikes) {
    const idx = idToIndex.get(id);
    if (idx == null) continue;
    if (isEpgByIndex[idx]) {
      epgHeatByIndex[idx] = Math.min(EPG_HEAT_MAX, (epgHeatByIndex[idx] ?? 0) + EPG_HEAT_ADD);
      const c = epgHeatToColor(epgHeatByIndex[idx]);
      colorAttr.setXYZ(idx, c.r, c.g, c.b);
      const g = epgHeatToGlowColor(epgHeatByIndex[idx]);
      glowColorAttr.setXYZ(idx, g.r, g.g, g.b);
    } else {
      const c = isRingByIndex[idx] ? ACTIVE_RING_COLOR : ACTIVE_COLOR;
      colorAttr.setXYZ(idx, c.r, c.g, c.b);
      if (isRingByIndex[idx]) ringActiveCount += 1;
    }
    if (isEpgByIndex[idx]) {
      epgActiveCount += 1;
      const bin = epgBinByIndex[idx];
      if (bin != null) epgBinsRaw[bin] += 1;
    }
  }
  let windowSpikeTotal = epgActiveCount;
  if (epgWindowWeights && epgWindowWeights.size > 0) {
    epgBinsRaw.fill(0);
    windowSpikeTotal = 0;
    for (const [id, weight] of epgWindowWeights.entries()) {
      if (weight <= 0) continue;
      const idx = idToIndex.get(id);
      if (idx == null || !isEpgByIndex[idx]) continue;
      const bin = epgBinByIndex[idx];
      if (bin == null) continue;
      epgBinsRaw[bin] += weight;
      windowSpikeTotal += weight;
    }
  }
  const epgBins = epgBinsRaw.map((v, i) => {
    const pop = epgBinPopulation[i] ?? 0;
    return pop > 0 ? v / pop : 0;
  });
  let epgTopBinIndex = 0;
  let epgTopBinSpikes = 0;
  for (let i = 0; i < epgBins.length; i += 1) {
    const v = epgBins[i] ?? 0;
    if (v > epgTopBinSpikes) {
      epgTopBinSpikes = v;
      epgTopBinIndex = i;
    }
  }
  const bump = new THREE.Vector2(0, 0);
  let bumpWeightTotal = 0;
  epgLeftCount = 0;
  epgRightCount = 0;
  for (let i = 0; i < EPG_COMPASS_BINS; i += 1) {
    const w = epgBins[i];
    if (w <= 0) continue;
    const a = (i / EPG_COMPASS_BINS) * Math.PI * 2;
    const dx = Math.cos(a);
    bump.x += w * dx;
    bump.y += w * Math.sin(a);
    if (dx < 0) epgLeftCount += w;
    else if (dx > 0) epgRightCount += w;
    bumpWeightTotal += w;
  }
  const vectorBumpStrength = bumpWeightTotal > 0 ? bump.length() / bumpWeightTotal : 0;
  const vectorBumpAngleDeg = bump.lengthSq() > 1e-8 ? (Math.atan2(bump.y, bump.x) * 180) / Math.PI : null;
  const bumpSharp = new THREE.Vector2(0, 0);
  let sharpWeightTotal = 0;
  for (let i = 0; i < EPG_COMPASS_BINS; i += 1) {
    const w = epgBins[i] * epgBins[i];
    if (w <= 0) continue;
    const a = (i / EPG_COMPASS_BINS) * Math.PI * 2;
    bumpSharp.x += w * Math.cos(a);
    bumpSharp.y += w * Math.sin(a);
    sharpWeightTotal += w;
  }
  const sharpAngleDeg = bumpSharp.lengthSq() > 1e-8 ? (Math.atan2(bumpSharp.y, bumpSharp.x) * 180) / Math.PI : null;
  const sharpStrength = sharpWeightTotal > 0 ? bumpSharp.length() / sharpWeightTotal : 0;

  const argmaxAngleDeg = epgTopBinSpikes > 0 ? ((epgTopBinIndex / EPG_COMPASS_BINS) * 360) : null;
  const argmaxStrength = epgTopBinSpikes;

  let bumpAngleDeg: number | null = vectorBumpAngleDeg;
  let bumpStrength = vectorBumpStrength;
  if (decodeMode === 'sharpened_p2') {
    bumpAngleDeg = sharpAngleDeg;
    bumpStrength = sharpStrength;
  } else if (decodeMode === 'argmax_bin') {
    bumpAngleDeg = argmaxAngleDeg;
    bumpStrength = argmaxStrength;
  } else if (decodeMode === 'ema_vector') {
    if (vectorBumpAngleDeg != null) {
      if (sceneState.decodeEmaAngleDeg == null) sceneState.decodeEmaAngleDeg = vectorBumpAngleDeg;
      else sceneState.decodeEmaAngleDeg = shortestAngleLerpDeg(sceneState.decodeEmaAngleDeg, vectorBumpAngleDeg, EPG_EMA_ALPHA);
    }
    bumpAngleDeg = sceneState.decodeEmaAngleDeg;
    bumpStrength = vectorBumpStrength;
  } else {
    sceneState.decodeEmaAngleDeg = null;
  }
  if (bumpAngleDeg != null) {
    sceneState.arrowState.angleTargetDeg = normalizeAngleDeg(bumpAngleDeg);
    sceneState.arrowState.strengthTarget = Math.max(0.08, bumpStrength);
  }
  colorAttr.needsUpdate = true;
  glowColorAttr.needsUpdate = true;
  const epgBinMax = epgBins.reduce((m, v) => Math.max(m, v), 0);
  const epgBinNorm = epgBinMax > 0 ? epgBins.map((v) => v / epgBinMax) : epgBins;
  sceneState.lastAppliedTick = currentTick;
  return {
    epgActiveCount,
    epgLeftCount,
    epgRightCount,
    ringActiveCount,
    bumpAngleDeg,
    bumpStrength,
    epgBins: epgBinNorm,
    epgWindowSpikes: windowSpikeTotal,
    epgWindowTicks,
    epgWindowMs: epgWindowTicks * dtSec * 1000,
    epgTopBinIndex,
    epgTopBinSpikes,
  };
}

export default function VisualizationPage() {
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [currentTick, setCurrentTick] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [viewMode, setViewMode] = useState<ViewMode>('compass');
  const [datasetMode, setDatasetMode] = useState<DatasetMode>('visual_cue_stripe');
  const [focusPopulation, setFocusPopulation] = useState<FocusPopulation>('epg_only');
  const [decodeMode, setDecodeMode] = useState<DecodeMode>('vector_norm');
  const [arrowSmoothing, setArrowSmoothing] = useState(true);
  const [compassStats, setCompassStats] = useState<CompassStats>({
    epgActiveCount: 0,
    epgLeftCount: 0,
    epgRightCount: 0,
    ringActiveCount: 0,
    bumpAngleDeg: null,
    bumpStrength: 0,
    epgBins: new Array<number>(EPG_COMPASS_BINS).fill(0),
    epgWindowSpikes: 0,
    epgWindowTicks: 1,
    epgWindowMs: 0,
    epgTopBinIndex: 0,
    epgTopBinSpikes: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);

  const neurons = useMemo(() => replay?.neurons ?? [], [replay]);
  const ringIdSet = useMemo(() => new Set(neurons.filter((n) => n.is_ring).map((n) => n.root_id)), [neurons]);
  const displayNeurons = useMemo(
    () => (focusPopulation === 'epg_only' ? neurons.filter((n) => n.is_epg) : neurons),
    [neurons, focusPopulation],
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setError(null);
        const datasetUrl = datasetMode === 'baseline'
          ? '/eonsystems_brain_subset_baseline_replay.json'
          : datasetMode === 'left_bias_odor'
            ? '/eonsystems_brain_subset_left_bias_replay.json'
            : datasetMode === 'joe_toggle_300'
              ? '/eonsystems_brain_subset_phased_left_bias_replay.json'
              : '/eonsystems_brain_subset_visual_cue_replay.json';
        const res = await fetch(`${datasetUrl}?v=${Date.now()}`, { cache: 'no-store' });
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
    if (!container || displayNeurons.length === 0) return;
    if (sceneRef.current) {
      sceneRef.current.dispose();
      sceneRef.current = null;
    }
    sceneRef.current = buildScene(container, displayNeurons, viewMode);
    return () => {
      if (sceneRef.current) {
        sceneRef.current.dispose();
        sceneRef.current = null;
      }
    };
  }, [displayNeurons, viewMode]);

  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.arrowState.smoothingEnabled = arrowSmoothing;
  }, [arrowSmoothing]);

  useEffect(() => {
    if (!replay || !sceneRef.current) return;
    const idx = Math.max(0, Math.min(replay.ticks.length - 1, currentTick - 1));
    const spikes = replay.ticks[idx]?.spikes ?? [];
    const dtSec = replay.ticks.length > 1
      ? Math.max(1e-6, replay.ticks[1].time_sec - replay.ticks[0].time_sec)
      : 0.0001;
    const epgWindowTicks = EPG_BUMP_WINDOW_TICKS;
    const epgWindowWeights = buildEpgWindowWeights(replay, currentTick, epgWindowTicks);
    const stats = applyTickSpikes(sceneRef.current, spikes, epgWindowWeights, epgWindowTicks, dtSec, currentTick, decodeMode);
    let ringInputActive = 0;
    for (const id of spikes) {
      if (ringIdSet.has(id)) ringInputActive += 1;
    }
    setCompassStats({ ...stats, ringActiveCount: ringInputActive });
  }, [replay, currentTick, ringIdSet, decodeMode]);

  useEffect(() => {
    if (!playing || !replay) return undefined;
    if (speed === 'irl') {
      const dtSec = replay.ticks.length > 1
        ? Math.max(1e-6, replay.ticks[1].time_sec - replay.ticks[0].time_sec)
        : 0.0001;
      const ticksPerSecond = Math.max(1, Math.round(1 / dtSec));
      const intervalMs = 50;
      const ticksPerStep = Math.max(1, Math.round((ticksPerSecond * intervalMs) / 1000));
      const timer = window.setInterval(() => {
        setCurrentTick((prev) => Math.min(replay.ticks.length, prev + ticksPerStep));
      }, intervalMs);
      return () => window.clearInterval(timer);
    }
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
  const epgCount = replay?.neurons.filter((n) => n.is_epg).length ?? 0;
  const bumpTheta = compassStats.bumpAngleDeg != null ? ((compassStats.bumpAngleDeg + 360) % 360) : null;

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#060a14' }}>
      <div style={{ padding: 12, display: 'grid', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setDatasetMode('visual_cue_stripe')} style={controlButtonStyle(datasetMode === 'visual_cue_stripe')}>
            Visual cue stripe
          </button>
          <button type="button" onClick={() => setDatasetMode('baseline')} style={controlButtonStyle(datasetMode === 'baseline')}>
            Baseline
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setViewMode('raw')} style={controlButtonStyle(viewMode === 'raw')}>Raw</button>
          <button type="button" onClick={() => setViewMode('aligned')} style={controlButtonStyle(viewMode === 'aligned')}>Aligned</button>
          <button type="button" onClick={() => setViewMode('compass')} style={controlButtonStyle(viewMode === 'compass')}>Compass loop</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setFocusPopulation('epg_only')} style={controlButtonStyle(focusPopulation === 'epg_only')}>
            EPG only
          </button>
          <button type="button" onClick={() => setFocusPopulation('all')} style={controlButtonStyle(focusPopulation === 'all')}>
            All neurons
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setDecodeMode('vector_norm')} style={controlButtonStyle(decodeMode === 'vector_norm')}>
            Decode: Vector
          </button>
          <button type="button" onClick={() => setDecodeMode('sharpened_p2')} style={controlButtonStyle(decodeMode === 'sharpened_p2')}>
            Decode: Sharp p2
          </button>
          <button type="button" onClick={() => setDecodeMode('argmax_bin')} style={controlButtonStyle(decodeMode === 'argmax_bin')}>
            Decode: Argmax
          </button>
          <button type="button" onClick={() => setDecodeMode('ema_vector')} style={controlButtonStyle(decodeMode === 'ema_vector')}>
            Decode: EMA
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setArrowSmoothing((v) => !v)} style={controlButtonStyle(arrowSmoothing)}>
            Arrow smoothing: {arrowSmoothing ? 'ON' : 'OFF'}
          </button>
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
        <div
          style={{
            fontSize: 12,
            opacity: 0.92,
            minHeight: 18,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          }}
          title={replay ? `scenario=${replay.meta.scenario ?? 'n/a'} | decode=${decodeMode} | neurons=${replay.neurons.length} | rendered=${displayNeurons.length} | ticks=${replay.ticks.length} | epg fired=${replay.meta.epg_neuron_unique_fired ?? 'n/a'} | bump angle=${compassStats.bumpAngleDeg == null ? 'n/a' : `${compassStats.bumpAngleDeg.toFixed(1)}deg`} | bump strength=${compassStats.bumpStrength.toFixed(3)} | top bin=${compassStats.epgTopBinIndex}` : undefined}
        >
          {replay
            ? `scenario=${replay.meta.scenario ?? 'n/a'} | decode=${decodeMode} | ticks=${replay.ticks.length} | epg fired=${replay.meta.epg_neuron_unique_fired ?? 'n/a'} | bump=${compassStats.bumpAngleDeg == null ? 'n/a' : `${compassStats.bumpAngleDeg.toFixed(1)}deg`} (${compassStats.bumpStrength.toFixed(2)}) | top bin=${compassStats.epgTopBinIndex}`
            : 'Loading replay...'}
        </div>
        {replay ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <svg width="120" height="120" viewBox="-60 -60 120 120" style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
              <circle cx="0" cy="0" r="42" fill="none" stroke="rgba(140,120,255,0.35)" strokeWidth="2" />
              {compassStats.epgBins.map((v, i) => {
                const a0 = (i / compassStats.epgBins.length) * Math.PI * 2 - Math.PI / 2;
                const a1 = ((i + 1) / compassStats.epgBins.length) * Math.PI * 2 - Math.PI / 2;
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
              EPG compass readout: sector intensity and arrow are decoded from a sliding EPG spike window for stability.
              Ring neurons remain useful as sensory-input drive, but heading is decoded from EPG space.
            </div>
          </div>
        ) : null}
        {error ? <div style={{ color: '#f99', fontSize: 12 }}>{error}</div> : null}
      </div>
      <div ref={sceneContainerRef} style={{ minHeight: 0 }} />
    </div>
  );
}
