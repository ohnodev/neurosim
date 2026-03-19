import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import PlaybackControls from '../components/PlaybackControls';
import { useNotification } from '../contexts/NotificationContext';
import { getApiBase } from '../lib/constants';

type ReplayNeuron = {
  root_id: string;
  x: number;
  y: number;
  z: number;
  processed_label?: string;
  is_ring: boolean;
  is_epg: boolean;
  epg_tile_index_0_7?: number;
  is_epg_upstream?: boolean;
  is_epg_downstream?: boolean;
  is_delta7?: boolean;
  upstream_epg_bin_index_0_7?: number;
  downstream_epg_bin_index_0_7?: number;
  delta7_epg_bin_index_0_7?: number;
  side: string;
  hemibrain_type: string;
  flow?: string;
  super_class?: string;
  class?: string;
  sub_class?: string;
  cell_type?: string;
  hemilineage?: string;
  nerve?: string;
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
    dt_sec: number;
    epg_neuron_total?: number;
    epg_neuron_unique_fired?: number;
    delta7_inhibition_profile_by_offset?: number[];
    scenario?: string;
    note?: string;
  };
  neurons: ReplayNeuron[];
  ticks: ReplayTick[];
};

type ApiNeuron = {
  root_id: string;
  x?: number;
  y?: number;
  z?: number;
  role?: string;
  side?: string;
  cell_type?: string;
};

/** Per-tick duration in seconds. Prefer meta.dt_sec; else 1ms so 1000 ticks = 1s (replay tick time_sec is often wrong). */
function getReplayDtSec(replay: ReplayData | null): number {
  if (!replay?.ticks?.length) return 0.001;
  const fromMeta = replay.meta?.dt_sec;
  if (typeof fromMeta === 'number' && Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  return 0.001;
}

const HOVER_HIGHLIGHT_COLOR = new THREE.Color(0xffff88);
const HOVER_HIGHLIGHT_GLOW = new THREE.Color(0xffdd44);

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
  neuronIds: string[];
  hoveredNeuronId: { current: string | null };
  biologicalEpgPoints: THREE.Points | null;
  biologicalEpgIndices: number[];
  biologicalEpgColorAttr: THREE.BufferAttribute | null;
  isRingByIndex: boolean[];
  isEpgByIndex: boolean[];
  isUpstreamByIndex: boolean[];
  isDownstreamByIndex: boolean[];
  isDelta7ByIndex: boolean[];
  ringDirectionByIndex: Array<THREE.Vector2 | null>;
  epgDirectionByIndex: Array<THREE.Vector2 | null>;
  epgBinByIndex: Array<number | null>;
  upstreamBinByIndex: Array<number | null>;
  downstreamBinByIndex: Array<number | null>;
  delta7BinByIndex: Array<number | null>;
  epgBinPopulation: number[];
  upstreamBinPopulation: number[];
  downstreamBinPopulation: number[];
  delta7BinPopulation: number[];
  /** Replay + currentTick: updated by parent. Animation loop computes brightness purely from these. */
  replay: ReplayData | null;
  currentTick: number;
  brightnessByIndex: Float32Array;
  lastFrameTime: number;
  decodeEmaAngleDeg: number | null;
  arrowState: {
    angleCurrentDeg: number;
    angleTargetDeg: number;
    strengthCurrent: number;
    strengthTarget: number;
    smoothingEnabled: boolean;
    smoothAlpha: number;
  };
  tempC: THREE.Color;
  tempG: THREE.Color;
  tempEpgInactive: THREE.Color;
  tempEpgHot: THREE.Color;
  dispose: () => void;
};

type ViewMode = 'raw' | 'aligned' | 'compass';
type PlaybackSpeed = number | 'irl';
type ReplayDataset = { id: string; label: string; url: string };

const INACTIVE_COLOR = new THREE.Color(0x2e3e5d);
const INACTIVE_RING_COLOR = new THREE.Color(0x6b58a9);
const INACTIVE_EPG_COLOR = new THREE.Color(0x4d6fb6);
const INACTIVE_UPSTREAM_COLOR = new THREE.Color(0x2b4b68);
const INACTIVE_DOWNSTREAM_COLOR = new THREE.Color(0x5a3d2a);
const INACTIVE_DELTA7_COLOR = new THREE.Color(0x5e2b6d);
const ACTIVE_COLOR = new THREE.Color(0x6eff9e);
const ACTIVE_RING_COLOR = new THREE.Color(0xff4fd8);
const ACTIVE_UPSTREAM_COLOR = new THREE.Color(0x7ad7ff);
const ACTIVE_DOWNSTREAM_COLOR = new THREE.Color(0xffb57a);
const ACTIVE_DELTA7_COLOR = new THREE.Color(0xd08cff);
const EPG_HEAT_ORANGE = new THREE.Color(0xff9f43);
const EPG_HEAT_RED = new THREE.Color(0xff3b30);
const NO_GLOW_COLOR = new THREE.Color(0x000000);
const PLAYBACK_BASE_MS = 80;
/** EPG compass bins: 16 alternating L/R wedges in anatomical order from top clockwise. */
const EPG_COMPASS_BINS = 16;
const EPG_SLICE_ORDER_CLOCKWISE = [
  'L5', 'R4', 'L6', 'R3', 'L7', 'R2', 'L8', 'R1',
  'L1', 'R8', 'L2', 'R7', 'L3', 'R6', 'L4', 'R5',
];
const EPG_LABEL_TO_BIN = new Map(EPG_SLICE_ORDER_CLOCKWISE.map((label, i) => [label, i]));

/** Parse a two-column CSV line; supports quoted fields (RFC4180-style). processed_labels.csv must be root_id,label. */
function parseProcessedLabelsLine(line: string): [string, string] | null {
  const t = line.trim();
  if (!t) return null;
  const cols: string[] = [];
  let i = 0;
  while (i < t.length && cols.length < 2) {
    if (t[i] === '"') {
      i += 1;
      let field = '';
      while (i < t.length) {
        if (t[i] === '"') {
          i += 1;
          if (i < t.length && t[i] === '"') {
            field += '"';
            i += 1;
          } else break;
        } else {
          field += t[i];
          i += 1;
        }
      }
      cols.push(field);
      if (i < t.length && t[i] === ',') i += 1;
    } else {
      const comma = t.indexOf(',', i);
      const field = (comma >= 0 ? t.slice(i, comma) : t.slice(i)).trim();
      cols.push(field);
      i = comma >= 0 ? comma + 1 : t.length;
    }
  }
  if (cols.length >= 2) return [cols[0].trim(), cols[1].trim()];
  if (cols.length === 1) return [cols[0].trim(), ''];
  return null;
}
const EPG_SLICE_COLORS = [
  '#6b4cc4', '#8ea4e7', '#b4d7e7', '#7fd47f',
  '#d9f095', '#f1ef9a', '#f6df99', '#f6c79c',
  '#f2a39a', '#e18a7e', '#d978c5', '#bf5cb8',
  '#a95ac6', '#8e67d6', '#7a7bdd', '#6f5ccf',
];
/** Neuron stays lit for this many ticks after spike; brightness decays linearly to transparent. */
const SPIKE_DISPLAY_TICKS = 300;
/** Compass phase rotation. +90deg keeps bin-0 (L5) at the top in scene + SVG overlays. */
const COMPASS_ROTATION_RAD = Math.PI / 2;
/** Shorter window so arrow tracks current bump (was 12; with 1ms step, 5 ticks ≈ 5ms). */
const EPG_BUMP_WINDOW_TICKS = 5;
const EPG_GLOW_SIZE = 0.13;
const EPG_GLOW_OPACITY = 0.52;
const DELTA7_OPPOSITE_INHIBIT_WEIGHT = 0.55;
const EPG_INACTIVE_BIN_PENALTY = 0.35;
const SHOW_BIOLOGICAL_EPG_COPY = false;
/** If a bin has this fraction of its EPG population active (in window), we point the arrow at that bin center (clear bump signal). */
const EPG_DOMINANT_BIN_THRESHOLD = 0.8;
const PREFERRED_REPLAY_ID = 'neurosim_rust_pen_L100_R0_B0_100k_rec3p5x_replay';
const DEFAULT_REPLAY_DATASETS: ReplayDataset[] = [
  {
    id: 'neurosim_rust_pen_L100_R0_B0_100k_rec3p5x_replay',
    label: 'Baseline replay (PEN_a L100 R0, 100k, 3.5× EPG rec)',
    url: '/neurosim_rust_pen_L100_R0_B0_100k_rec3p5x_replay.json',
  },
  {
    id: 'neurosim_live',
    label: 'Live — tweak PEN_a L/R Hz (3.5× EPG rec, seed 17290319, record)',
    url: 'neurosim_live',
  },
];

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
  upstreamBins: number[];
  downstreamBins: number[];
  delta7Bins: number[];
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

function compassHeatFill(v: number, alpha = 0.95): string {
  const t = Math.max(0, Math.min(1, v));
  let r = 255;
  let g = 0;
  let b = 0;
  if (t < 0.5) {
    const u = t / 0.5;
    r = 255;
    g = Math.round(240 - (81 * u)); // yellow -> orange
    b = Math.round(122 - (79 * u));
  } else {
    const u = (t - 0.5) / 0.5;
    r = 255;
    g = Math.round(159 - (100 * u)); // orange -> red
    b = Math.round(67 - (19 * u));
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

const BIN_GAP_RAD = (Math.PI / 180) * 4;

function getWedgeParams(i: number, binCount: number): { wedge: number; a0: number; a1: number; midAngle: number } {
  const wedge = (Math.PI * 2) / binCount - BIN_GAP_RAD;
  const a0 = (i / binCount) * Math.PI * 2 - Math.PI / 2 + BIN_GAP_RAD / 2;
  const a1 = a0 + wedge;
  const midAngle = a0 + wedge / 2;
  return { wedge, a0, a1, midAngle };
}

/** 3D scene uses +Y up, so clockwise bin order requires a negative angular step. */
function sceneAngleForBin(bin: number, binCount: number): number {
  return COMPASS_ROTATION_RAD - (bin / binCount) * Math.PI * 2;
}

/** Convert a 2D scene-space angle back into clockwise bin index. */
function sceneAngleToBin(angleRad: number, binCount: number): number {
  let rel = COMPASS_ROTATION_RAD - angleRad;
  while (rel < 0) rel += Math.PI * 2;
  while (rel >= Math.PI * 2) rel -= Math.PI * 2;
  return Math.max(0, Math.min(binCount - 1, Math.floor((rel / (Math.PI * 2)) * binCount)));
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

function getEffectiveEpgLabel(
  neuron: ReplayNeuron,
  processedLabelMap: Map<string, string> | null,
): string | undefined {
  const fromMap = processedLabelMap?.get(neuron.root_id);
  if (fromMap && EPG_LABEL_TO_BIN.has(fromMap)) return fromMap;
  const side = (neuron.side ?? '').trim().toLowerCase();
  const tile = neuron.epg_tile_index_0_7;
  if ((side === 'left' || side === 'right') && typeof tile === 'number') {
    const label = `${side === 'left' ? 'L' : 'R'}${tile + 1}`;
    if (EPG_LABEL_TO_BIN.has(label)) return label;
  }
  const parsed = (neuron.processed_label ?? '').toUpperCase().replace(/[^LR0-9]/g, '');
  return EPG_LABEL_TO_BIN.has(parsed) ? parsed : undefined;
}

function getEffectiveEpgTile(
  neuron: ReplayNeuron,
  processedLabelMap: Map<string, string> | null,
): number | undefined {
  const label = getEffectiveEpgLabel(neuron, processedLabelMap);
  if (!label) return undefined;
  return EPG_LABEL_TO_BIN.get(label);
}

function isCompassEpgNeuron(neuron: ReplayNeuron): boolean {
  if (!neuron.is_epg) return false;
  // Exclude EPGt (L9/R9-like) from compass bins L1-R8.
  const hb = (neuron.hemibrain_type ?? '').trim().toUpperCase();
  return hb !== 'EPGT';
}

function buildScene(
  container: HTMLDivElement,
  neurons: ReplayNeuron[],
  viewMode: ViewMode,
  onHover?: (neuronId: string | null) => void,
  epgLabelMap?: Map<string, string> | null,
  replay?: ReplayData | null,
): SceneState {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2435);
  const mostlyEpg = neurons.filter((n) => isCompassEpgNeuron(n)).length >= Math.max(8, Math.floor(neurons.length * 0.7));

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
  let compassCenter: { x: number; y: number; z: number } | null = null;
  let compassBaseRadius: number | null = null;
  const aligned = computeAlignedPoints(neurons, viewMode !== 'raw');
  if (viewMode === 'compass') {
    const ringIndices: number[] = [];
    for (let i = 0; i < neurons.length; i += 1) {
      if (neurons[i] && isCompassEpgNeuron(neurons[i]!)) ringIndices.push(i);
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

      // Full circle: bins 0..(EPG_COMPASS_BINS-1) distributed evenly. No semicircle split (4 bins = DM1–DM4).
      const tileGroups = new Map<number, number[]>();
      for (const i of ringIndices) {
        const tile = getEffectiveEpgTile(neurons[i]!, epgLabelMap ?? null);
        if (tile == null || tile < 0 || tile >= EPG_COMPASS_BINS) continue;
        const group = tileGroups.get(tile) ?? [];
        group.push(i);
        tileGroups.set(tile, group);
      }
      if (tileGroups.size >= 2) {
        const sector = (Math.PI * 2) / EPG_COMPASS_BINS;
        const spread = sector * 0.35;
        for (const [tile, indices] of tileGroups.entries()) {
          indices.sort((a, b) => (neurons[a]?.root_id ?? '').localeCompare(neurons[b]?.root_id ?? ''));
          const baseAngle = sceneAngleForBin(tile, EPG_COMPASS_BINS);
          for (let k = 0; k < indices.length; k += 1) {
            const idx = indices[k]!;
            const centered = indices.length > 1 ? (k / (indices.length - 1)) - 0.5 : 0;
            const angle = baseAngle + centered * spread;
            const p = aligned[idx]!;
            p.x = cx + Math.cos(angle) * targetRadius;
            p.y = cy + Math.sin(angle) * targetRadius;
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
  if (viewMode === 'compass') {
    const epgIndices: number[] = [];
    for (let i = 0; i < neurons.length; i += 1) {
      if (neurons[i] && isCompassEpgNeuron(neurons[i]!)) epgIndices.push(i);
    }
    if (epgIndices.length > 3) {
      let cxCompass = 0;
      let cyCompass = 0;
      let czCompass = 0;
      for (const idx of epgIndices) {
        cxCompass += aligned[idx]!.x;
        cyCompass += aligned[idx]!.y;
        czCompass += aligned[idx]!.z;
      }
      cxCompass /= epgIndices.length;
      cyCompass /= epgIndices.length;
      czCompass /= epgIndices.length;
      let radiusSum = 0;
      for (const idx of epgIndices) {
        const p = aligned[idx]!;
        radiusSum += Math.hypot(p.x - cxCompass, p.y - cyCompass);
      }
      const baseRadius = Math.max(0.35, radiusSum / epgIndices.length);
      // Canonical compass layout: always place every EPG neuron on the ring.
      // This prevents any off-ring/floating point even if source coordinates or labels are partial.
      const tileGroups = new Map<number, number[]>();
      const unassigned: number[] = [];
      for (const idx of epgIndices) {
        const tile = getEffectiveEpgTile(neurons[idx]!, epgLabelMap ?? null);
        if (tile == null || tile < 0 || tile >= EPG_COMPASS_BINS) {
          unassigned.push(idx);
          continue;
        }
        const group = tileGroups.get(tile) ?? [];
        group.push(idx);
        tileGroups.set(tile, group);
      }
      if (tileGroups.size >= 2) {
        const sector = (Math.PI * 2) / EPG_COMPASS_BINS;
        const spread = sector * 0.35;
        for (const [tile, indices] of tileGroups.entries()) {
          indices.sort((a, b) => (neurons[a]?.root_id ?? '').localeCompare(neurons[b]?.root_id ?? ''));
          const angleCenter = sceneAngleForBin(tile, EPG_COMPASS_BINS);
          for (let k = 0; k < indices.length; k += 1) {
            const idx = indices[k]!;
            const centered = indices.length > 1 ? (k / (indices.length - 1)) - 0.5 : 0;
            const angle = angleCenter + centered * spread;
            aligned[idx]!.x = cxCompass + Math.cos(angle) * baseRadius;
            aligned[idx]!.y = cyCompass + Math.sin(angle) * baseRadius;
            aligned[idx]!.z = czCompass;
          }
        }
      }
      // Ensure every EPG is on the compass ring, even if processed label/tile is missing.
      for (let k = 0; k < unassigned.length; k += 1) {
        const idx = unassigned[k]!;
        const angle = sceneAngleForBin(k % EPG_COMPASS_BINS, EPG_COMPASS_BINS);
        aligned[idx]!.x = cxCompass + Math.cos(angle) * baseRadius;
        aligned[idx]!.y = cyCompass + Math.sin(angle) * baseRadius;
        aligned[idx]!.z = czCompass;
      }
      compassCenter = { x: cxCompass, y: cyCompass, z: czCompass };
      compassBaseRadius = baseRadius;
      const binAngleByBin = new Map<number, number>();
      const binWedgeSpanByBin = new Map<number, number>();
      const BIN_WEDGE = (Math.PI * 2) / EPG_COMPASS_BINS - (Math.PI / 180) * 2;
      for (let b = 0; b < EPG_COMPASS_BINS; b += 1) {
        let sumSin = 0; let sumCos = 0; let count = 0;
        let minA = Infinity; let maxA = -Infinity;
        for (const idx of epgIndices) {
          const tile = getEffectiveEpgTile(neurons[idx]!, epgLabelMap ?? null);
          if (tile != null && tile === b) {
            const px = aligned[idx]!.x - cxCompass;
            const py = aligned[idx]!.y - cyCompass;
            const a = Math.atan2(py, px);
            sumSin += Math.sin(a);
            sumCos += Math.cos(a);
            minA = Math.min(minA, a);
            maxA = Math.max(maxA, a);
            count += 1;
          }
        }
        binAngleByBin.set(
          b,
          count > 0 ? Math.atan2(sumSin / count, sumCos / count) : sceneAngleForBin(b, EPG_COMPASS_BINS),
        );
        binWedgeSpanByBin.set(b, count > 1 ? Math.max(0.05, maxA - minA) : BIN_WEDGE);
      }
      const upstreamCountByBin = new Array<number>(EPG_COMPASS_BINS).fill(0);
      const downstreamCountByBin = new Array<number>(EPG_COMPASS_BINS).fill(0);
      for (let i = 0; i < neurons.length; i += 1) {
        const n = neurons[i]!;
        if (n.is_epg) continue;
        const upBin = n.upstream_epg_bin_index_0_7;
        const downBin = n.downstream_epg_bin_index_0_7;
        if (upBin == null && downBin == null) continue;
        const bin = upBin ?? downBin ?? 0;
        const centerAngle = binAngleByBin.get(bin) ?? sceneAngleForBin(bin, EPG_COMPASS_BINS);
        const wedgeSpan = binWedgeSpanByBin.get(bin) ?? BIN_WEDGE;
        let radius: number;
        let k: number;
        if (upBin != null) {
          k = upstreamCountByBin[upBin]!;
          upstreamCountByBin[upBin] = k + 1;
          radius = baseRadius * 1.38;
        } else {
          k = downstreamCountByBin[downBin!]!;
          downstreamCountByBin[downBin!] = k + 1;
          radius = baseRadius * 0.62;
        }
        const nInBin = upBin != null ? upstreamCountByBin[upBin]! : downstreamCountByBin[downBin!]!;
        const angle = nInBin > 1
          ? centerAngle + (k - (nInBin - 1) / 2) * (wedgeSpan / (nInBin - 1))
          : centerAngle;
        aligned[i]!.x = cxCompass + Math.cos(angle) * radius;
        aligned[i]!.y = cyCompass + Math.sin(angle) * radius;
        aligned[i]!.z = czCompass + (upBin != null ? 0.02 : -0.02);
      }
    }
  }
  for (const p of aligned) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const cx = compassCenter != null ? compassCenter.x : (minX + maxX) / 2;
  const cy = compassCenter != null ? compassCenter.y : (minY + maxY) / 2;
  const cz = compassCenter != null ? compassCenter.z : (minZ + maxZ) / 2;
  const scale = compassBaseRadius != null
    ? Math.max(2 * compassBaseRadius * 1.5, 0.5)
    : Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);

  const n = neurons.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const glowColors = new Float32Array(n * 3);
  const idToIndex = new Map<string, number>();
  const isRingByIndex: boolean[] = new Array(n).fill(false);
  const isEpgByIndex: boolean[] = new Array(n).fill(false);
  const isUpstreamByIndex: boolean[] = new Array(n).fill(false);
  const isDownstreamByIndex: boolean[] = new Array(n).fill(false);
  const isDelta7ByIndex: boolean[] = new Array(n).fill(false);
  const ringDirectionByIndex: Array<THREE.Vector2 | null> = new Array(n).fill(null);
  const epgDirectionByIndex: Array<THREE.Vector2 | null> = new Array(n).fill(null);
  const epgBinByIndex: Array<number | null> = new Array(n).fill(null);
  const upstreamBinByIndex: Array<number | null> = new Array(n).fill(null);
  const downstreamBinByIndex: Array<number | null> = new Array(n).fill(null);
  const delta7BinByIndex: Array<number | null> = new Array(n).fill(null);
  const epgBinPopulation = new Array<number>(EPG_COMPASS_BINS).fill(0);
  const upstreamBinPopulation = new Array<number>(EPG_COMPASS_BINS).fill(0);
  const downstreamBinPopulation = new Array<number>(EPG_COMPASS_BINS).fill(0);
  const delta7BinPopulation = new Array<number>(EPG_COMPASS_BINS).fill(0);
  let lastFrameTime = performance.now() / 1000;

  for (let i = 0; i < n; i += 1) {
    const neuron = neurons[i]!;
    const p = aligned[i]!;
    idToIndex.set(neuron.root_id, i);
    isRingByIndex[i] = neuron.is_ring;
    isEpgByIndex[i] = isCompassEpgNeuron(neuron);
    isUpstreamByIndex[i] = Boolean(neuron.is_epg_upstream);
    isDownstreamByIndex[i] = Boolean(neuron.is_epg_downstream);
    isDelta7ByIndex[i] = Boolean(neuron.is_delta7);
    if (neuron.upstream_epg_bin_index_0_7 != null) {
      const value = neuron.upstream_epg_bin_index_0_7;
      const b = Math.max(0, Math.min(EPG_COMPASS_BINS - 1, Math.round((value / 7) * (EPG_COMPASS_BINS - 1))));
      upstreamBinByIndex[i] = b;
      upstreamBinPopulation[b] += 1;
    }
    if (neuron.downstream_epg_bin_index_0_7 != null) {
      const value = neuron.downstream_epg_bin_index_0_7;
      const b = Math.max(0, Math.min(EPG_COMPASS_BINS - 1, Math.round((value / 7) * (EPG_COMPASS_BINS - 1))));
      downstreamBinByIndex[i] = b;
      downstreamBinPopulation[b] += 1;
    }
    if (neuron.delta7_epg_bin_index_0_7 != null) {
      const value = neuron.delta7_epg_bin_index_0_7;
      const b = Math.max(0, Math.min(EPG_COMPASS_BINS - 1, Math.round((value / 7) * (EPG_COMPASS_BINS - 1))));
      delta7BinByIndex[i] = b;
      delta7BinPopulation[b] += 1;
    }
    positions[i * 3] = (p.x - cx) / scale;
    positions[i * 3 + 1] = (p.y - cy) / scale;
    positions[i * 3 + 2] = (p.z - cz) / scale;
    if (neuron.is_ring) {
      const v = new THREE.Vector2(positions[i * 3], positions[i * 3 + 1]);
      if (v.lengthSq() > 1e-8) {
        ringDirectionByIndex[i] = v.normalize();
      }
    }
    if (isCompassEpgNeuron(neuron)) {
      const tile = getEffectiveEpgTile(neuron, epgLabelMap ?? null);
      if (tile != null) {
        const t = Math.max(0, Math.min(EPG_COMPASS_BINS - 1, tile));
        const a = sceneAngleForBin(t, EPG_COMPASS_BINS);
        epgDirectionByIndex[i] = new THREE.Vector2(Math.cos(a), Math.sin(a));
        epgBinByIndex[i] = t;
        epgBinPopulation[t] += 1;
      } else {
        const ev = new THREE.Vector2(positions[i * 3], positions[i * 3 + 1]);
        if (ev.lengthSq() > 1e-8) {
          epgDirectionByIndex[i] = ev.normalize();
          const angle = Math.atan2(ev.y, ev.x);
          const bin = sceneAngleToBin(angle, EPG_COMPASS_BINS);
          epgBinByIndex[i] = bin;
          epgBinPopulation[bin] += 1;
        }
      }
    }
    const c = isCompassEpgNeuron(neuron)
      ? INACTIVE_EPG_COLOR.clone().multiplyScalar(0.42)
      : neuron.is_epg_upstream
        ? INACTIVE_UPSTREAM_COLOR
        : neuron.is_epg_downstream
          ? INACTIVE_DOWNSTREAM_COLOR
          : neuron.is_delta7
            ? INACTIVE_DELTA7_COLOR
          : neuron.is_ring
            ? INACTIVE_RING_COLOR
            : INACTIVE_COLOR;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    glowColors[i * 3] = 0;
    glowColors[i * 3 + 1] = 0;
    glowColors[i * 3 + 2] = 0;
  }

  // In compass view: add a second point cloud above the ring with EPG in their real biological (x,y,z) coordinates.
  let biologicalEpgPoints: THREE.Points | null = null;
  let biologicalEpgGeometry: THREE.BufferGeometry | null = null;
  let biologicalEpgMaterial: THREE.PointsMaterial | null = null;
  let biologicalEpgIndices: number[] = [];
  if (viewMode === 'compass' && SHOW_BIOLOGICAL_EPG_COPY) {
    const epgIndices = neurons.map((n, i) => (n.is_epg ? i : -1)).filter((i) => i >= 0);
    biologicalEpgIndices = epgIndices;
    if (epgIndices.length > 0) {
      let cxRaw = 0;
      let cyRaw = 0;
      let czRaw = 0;
      for (const i of epgIndices) {
        const n = neurons[i]!;
        cxRaw += n.x;
        cyRaw += n.y;
        czRaw += n.z;
      }
      cxRaw /= epgIndices.length;
      cyRaw /= epgIndices.length;
      czRaw /= epgIndices.length;
      let rawExtent = 0;
      for (const i of epgIndices) {
        const n = neurons[i]!;
        const dx = n.x - cxRaw;
        const dy = n.y - cyRaw;
        const dz = n.z - czRaw;
        rawExtent = Math.max(rawExtent, Math.hypot(dx, dy, dz));
      }
      const rawScale = Math.max(rawExtent, 1e-9);
      const bioPositions = new Float32Array(epgIndices.length * 3);
      const BIO_Z_OFFSET = 1.2; // above the compass (compass at z≈0 in normalized space)
      const BIO_SCALE = 0.5; // size of cloud relative to compass
      for (let k = 0; k < epgIndices.length; k += 1) {
        const n = neurons[epgIndices[k]!]!;
        bioPositions[k * 3] = ((n.x - cxRaw) / rawScale) * BIO_SCALE;
        bioPositions[k * 3 + 1] = ((n.y - cyRaw) / rawScale) * BIO_SCALE;
        bioPositions[k * 3 + 2] = ((n.z - czRaw) / rawScale) * BIO_SCALE + BIO_Z_OFFSET;
      }
      biologicalEpgGeometry = new THREE.BufferGeometry();
      biologicalEpgGeometry.setAttribute('position', new THREE.BufferAttribute(bioPositions, 3));
      const bioColor = new THREE.Color(0x88aacc);
      const bioColors = new Float32Array(epgIndices.length * 3);
      for (let k = 0; k < epgIndices.length; k += 1) {
        bioColors[k * 3] = bioColor.r;
        bioColors[k * 3 + 1] = bioColor.g;
        bioColors[k * 3 + 2] = bioColor.b;
      }
      biologicalEpgGeometry.setAttribute('color', new THREE.BufferAttribute(bioColors, 3));
      biologicalEpgMaterial = new THREE.PointsMaterial({
        size: 0.022,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: true,
        depthTest: true,
      });
      biologicalEpgPoints = new THREE.Points(biologicalEpgGeometry, biologicalEpgMaterial);
      scene.add(biologicalEpgPoints);
    }
  }
  const biologicalEpgColorAttr =
    biologicalEpgGeometry?.getAttribute('color') instanceof THREE.BufferAttribute
      ? (biologicalEpgGeometry.getAttribute('color') as THREE.BufferAttribute)
      : null;
  const hoveredNeuronId = { current: null as string | null };
  const neuronIds = neurons.map((n) => n.root_id);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geometry.setAttribute('color', colorAttr);
  const glowGeometry = new THREE.BufferGeometry();
  glowGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const glowColorAttr = new THREE.BufferAttribute(glowColors, 3);
  glowGeometry.setAttribute('color', glowColorAttr);
  const material = new THREE.PointsMaterial({
    size: mostlyEpg ? 0.032 : 0.02,
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

  let connectionLines: THREE.LineSegments | null = null;
  if (viewMode === 'compass') {
    /** For each upstream/downstream, draw to the EPG neuron in the same bin that is closest (radially aligned).
     * This keeps connections "right behind" the EPG neuron instead of crossing to the opposite side. */
    const epgIndicesByBin = new Map<number, number[]>();
    for (let i = 0; i < n; i += 1) {
      if (isEpgByIndex[i]) {
        const b = epgBinByIndex[i];
        if (b != null) {
          const list = epgIndicesByBin.get(b) ?? [];
          list.push(i);
          epgIndicesByBin.set(b, list);
        }
      }
    }
    const lineVertices: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const upBin = upstreamBinByIndex[i];
      const downBin = downstreamBinByIndex[i];
      const bin = upBin ?? downBin;
      if (bin == null) continue;
      const epgIndices = epgIndicesByBin.get(bin);
      if (!epgIndices?.length) continue;
      const px = positions[i * 3]!; const py = positions[i * 3 + 1]!; const pz = positions[i * 3 + 2]!;
      const uAngle = Math.atan2(py, px);
      let bestIdx = epgIndices[0]!;
      let bestDelta = Math.PI * 2;
      for (const j of epgIndices) {
        const ex = positions[j * 3]!; const ey = positions[j * 3 + 1]!;
        const eAngle = Math.atan2(ey, ex);
        let delta = Math.abs(eAngle - uAngle);
        if (delta > Math.PI) delta = Math.PI * 2 - delta;
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIdx = j;
        }
      }
      const ex = positions[bestIdx * 3]!; const ey = positions[bestIdx * 3 + 1]!; const ez = positions[bestIdx * 3 + 2]!;
      lineVertices.push(px, py, pz, ex, ey, ez);
    }
    if (lineVertices.length >= 6) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lineVertices, 3));
      connectionLines = new THREE.LineSegments(
        lineGeometry,
        new THREE.LineBasicMaterial({ color: 0x4466aa, transparent: true, opacity: 0.6, depthTest: true }),
      );
      scene.add(connectionLines);
    }
  }

  if (window.getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  const hoverTooltip = document.createElement('div');
  hoverTooltip.style.position = 'absolute';
  hoverTooltip.style.pointerEvents = 'none';
  hoverTooltip.style.display = 'none';
  hoverTooltip.style.whiteSpace = 'pre-wrap';
  hoverTooltip.style.maxWidth = '420px';
  hoverTooltip.style.padding = '6px 8px';
  hoverTooltip.style.borderRadius = '6px';
  hoverTooltip.style.background = 'rgba(5,10,20,0.92)';
  hoverTooltip.style.border = '1px solid rgba(130,170,255,0.45)';
  hoverTooltip.style.color = '#e8f1ff';
  hoverTooltip.style.fontSize = '11px';
  hoverTooltip.style.lineHeight = '1.25';
  hoverTooltip.style.zIndex = '4';
  container.appendChild(hoverTooltip);
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = mostlyEpg ? 0.04 : 0.028;
  const pointer = new THREE.Vector2(2, 2);
  const onPointerMove = (evt: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -(((evt.clientY - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(points, false);
    if (hits.length === 0 || hits[0]?.index == null) {
      hoveredNeuronId.current = null;
      onHover?.(null);
      hoverTooltip.style.display = 'none';
      return;
    }
    const hit = hits[0]!;
    const idx = hit.index as number;
    const neuron = neurons[idx];
    if (!neuron) {
      hoveredNeuronId.current = null;
      onHover?.(null);
      hoverTooltip.style.display = 'none';
      return;
    }
    hoveredNeuronId.current = neuron.root_id;
    onHover?.(neuron.root_id);
    const hemilineage = neuron.hemilineage ?? '';
    const flow = neuron.flow ?? '';
    const super_class = neuron.super_class ?? '';
    const neuronClass = neuron.class ?? '';
    const sub_class = neuron.sub_class ?? '';
    const cell_type = neuron.cell_type ?? '';
    const hemibrain_type = neuron.hemibrain_type ?? '';
    const side = neuron.side ?? '';
    const nerve = neuron.nerve ?? '';
    const lines: string[] = [neuron.root_id];
    if (neuron.is_epg) {
      // EPG: use classification (lineage e.g. DM2_CX_d1 drives 8 bins: 1–4 × d1–d2, left/right already correct)
      if (hemilineage) lines.push('hemilineage: ' + hemilineage);
      if (flow) lines.push('flow: ' + flow);
      if (super_class) lines.push('super_class: ' + super_class);
      if (neuronClass) lines.push('class: ' + neuronClass);
      if (sub_class) lines.push('sub_class: ' + sub_class);
      if (cell_type) lines.push('cell_type: ' + cell_type);
      if (hemibrain_type) lines.push('hemibrain_type: ' + hemibrain_type);
      if (side) lines.push('side: ' + side);
      if (nerve) lines.push('nerve: ' + nerve);
      const effLabel = getEffectiveEpgLabel(neuron, epgLabelMap ?? null);
      if (effLabel != null) lines.push('bin: ' + effLabel);
    } else {
      const clsParts: string[] = [];
      if (flow) clsParts.push('flow=' + flow);
      if (super_class) clsParts.push('super_class=' + super_class);
      if (neuronClass) clsParts.push('class=' + neuronClass);
      if (sub_class) clsParts.push('sub_class=' + sub_class);
      if (cell_type) clsParts.push('cell_type=' + cell_type);
      if (hemibrain_type) clsParts.push('hemibrain_type=' + hemibrain_type);
      if (hemilineage) clsParts.push('hemilineage=' + hemilineage);
      if (side) clsParts.push('side=' + side);
      if (nerve) clsParts.push('nerve=' + nerve);
      if (clsParts.length > 0) lines.push('classification: ' + clsParts.join(', '));
      if (lines.length === 1 && hemibrain_type) lines.push(hemibrain_type);
    }
    hoverTooltip.textContent = lines.join('\n');
    hoverTooltip.style.left = `${Math.max(6, evt.clientX - rect.left + 12)}px`;
    hoverTooltip.style.top = `${Math.max(6, evt.clientY - rect.top + 12)}px`;
    hoverTooltip.style.display = 'block';
  };
  const onPointerLeave = () => {
    hoveredNeuronId.current = null;
    onHover?.(null);
    hoverTooltip.style.display = 'none';
  };
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
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

  const state: SceneState = {
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
    neuronIds,
    hoveredNeuronId,
    biologicalEpgPoints: biologicalEpgPoints ?? null,
    biologicalEpgIndices,
    biologicalEpgColorAttr,
    isRingByIndex,
    isEpgByIndex,
    isUpstreamByIndex,
    isDownstreamByIndex,
    isDelta7ByIndex,
    ringDirectionByIndex,
    epgDirectionByIndex,
    epgBinByIndex,
    upstreamBinByIndex,
    downstreamBinByIndex,
    delta7BinByIndex,
    epgBinPopulation,
    upstreamBinPopulation,
    downstreamBinPopulation,
    delta7BinPopulation,
    replay: replay ?? null,
    currentTick: 1,
    brightnessByIndex: new Float32Array(colorAttr.count),
    lastFrameTime,
    decodeEmaAngleDeg: null,
    arrowState,
    tempC: new THREE.Color(),
    tempG: new THREE.Color(),
    tempEpgInactive: new THREE.Color(),
    tempEpgHot: new THREE.Color(),
    dispose: () => {},
  };

  let raf = 0;
  const animate = () => {
    const now = performance.now() / 1000;
    state.lastFrameTime = now;
    /** Compute brightness purely from replay + currentTick. No React state, no accumulation.
     * Neuron lit for SPIKE_DISPLAY_TICKS after spike; brightness = 1 - (ticks_ago / SPIKE_DISPLAY_TICKS). */
    const replay = state.replay;
    const currentTick = state.currentTick;
    if (state.brightnessByIndex.length !== colorAttr.count) {
      state.brightnessByIndex = new Float32Array(colorAttr.count);
    }
    const brightnessByIndex = state.brightnessByIndex;
    brightnessByIndex.fill(0);
    if (replay?.ticks?.length && currentTick >= 1) {
      const startTick = Math.max(1, currentTick - SPIKE_DISPLAY_TICKS);
      const spikeTickById = new Map<string, number>();
      for (let t = currentTick; t >= startTick && t >= 1; t -= 1) {
        for (const id of replay.ticks[t - 1]?.spikes ?? []) {
          if (!spikeTickById.has(id)) spikeTickById.set(id, t);
        }
      }
      for (const [id, spikeTick] of spikeTickById) {
        const idx = idToIndex.get(id);
        if (idx != null && idx < colorAttr.count) {
          const ticksAgo = currentTick - spikeTick;
          const b = Math.max(0, 1 - ticksAgo / SPIKE_DISPLAY_TICKS);
          if (b > (brightnessByIndex[idx] ?? 0)) brightnessByIndex[idx] = b;
        }
      }
    }
    const { tempC, tempG, tempEpgInactive, tempEpgHot } = state;
    for (let i = 0; i < colorAttr.count; i += 1) {
      const t = brightnessByIndex[i] ?? 0;
      if (isEpgByIndex[i]) {
        tempEpgInactive.copy(INACTIVE_EPG_COLOR).multiplyScalar(0.42);
        if (t <= 0) {
          tempC.copy(tempEpgInactive);
        } else {
          tempEpgHot.copy(tempEpgInactive).lerp(EPG_HEAT_ORANGE, 0.45).lerp(EPG_HEAT_RED, t);
          tempC.copy(tempEpgInactive).lerp(tempEpgHot, t);
        }
      } else if (isUpstreamByIndex[i]) {
        tempC.copy(INACTIVE_UPSTREAM_COLOR);
        if (t > 0) tempC.lerp(ACTIVE_UPSTREAM_COLOR, t);
      } else if (isDownstreamByIndex[i]) {
        tempC.copy(INACTIVE_DOWNSTREAM_COLOR);
        if (t > 0) tempC.lerp(ACTIVE_DOWNSTREAM_COLOR, t);
      } else if (isDelta7ByIndex[i]) {
        tempC.copy(INACTIVE_DELTA7_COLOR);
        if (t > 0) tempC.lerp(ACTIVE_DELTA7_COLOR, t);
      } else if (isRingByIndex[i]) {
        tempC.copy(INACTIVE_RING_COLOR);
        if (t > 0) tempC.lerp(ACTIVE_RING_COLOR, t);
      } else {
        tempC.copy(INACTIVE_COLOR);
        if (t > 0) tempC.lerp(ACTIVE_COLOR, t);
      }
      colorAttr.setXYZ(i, tempC.r, tempC.g, tempC.b);
      if (t <= 0 || !isEpgByIndex[i]) {
        tempG.copy(NO_GLOW_COLOR);
      } else {
        tempG.copy(INACTIVE_EPG_COLOR).lerp(EPG_HEAT_RED, t).multiplyScalar(0.22 + 1.1 * t * t);
      }
      glowColorAttr.setXYZ(i, tempG.r, tempG.g, tempG.b);
    }
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
    const hoveredId = hoveredNeuronId?.current ?? null;
    if (hoveredId != null) {
      const mainIdx = idToIndex.get(hoveredId);
      if (mainIdx != null && mainIdx < colorAttr.count) {
        colorAttr.setXYZ(mainIdx, HOVER_HIGHLIGHT_COLOR.r, HOVER_HIGHLIGHT_COLOR.g, HOVER_HIGHLIGHT_COLOR.b);
        glowColorAttr.setXYZ(mainIdx, HOVER_HIGHLIGHT_GLOW.r, HOVER_HIGHLIGHT_GLOW.g, HOVER_HIGHLIGHT_GLOW.b);
      }
    }
    if (biologicalEpgColorAttr && biologicalEpgIndices.length > 0) {
      const { tempC, tempEpgInactive, tempEpgHot } = state;
      for (let k = 0; k < biologicalEpgIndices.length; k += 1) {
        const mainIndex = biologicalEpgIndices[k];
        const id = neuronIds[mainIndex];
        if (id === hoveredId) {
          biologicalEpgColorAttr.setXYZ(k, HOVER_HIGHLIGHT_COLOR.r, HOVER_HIGHLIGHT_COLOR.g, HOVER_HIGHLIGHT_COLOR.b);
        } else {
          const t = brightnessByIndex[mainIndex] ?? 0;
          tempEpgInactive.copy(INACTIVE_EPG_COLOR).multiplyScalar(0.42);
          if (t <= 0) {
            biologicalEpgColorAttr.setXYZ(k, tempEpgInactive.r, tempEpgInactive.g, tempEpgInactive.b);
          } else {
            tempEpgHot.copy(tempEpgInactive).lerp(EPG_HEAT_ORANGE, 0.45).lerp(EPG_HEAT_RED, t);
            tempC.copy(tempEpgInactive).lerp(tempEpgHot, t);
            biologicalEpgColorAttr.setXYZ(k, tempC.r, tempC.g, tempC.b);
          }
        }
      }
      biologicalEpgColorAttr.needsUpdate = true;
    }
    colorAttr.needsUpdate = true;
    glowColorAttr.needsUpdate = true;
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
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    if (hoverTooltip.parentNode) {
      hoverTooltip.parentNode.removeChild(hoverTooltip);
    }
    if (biologicalEpgPoints != null) {
      scene.remove(biologicalEpgPoints);
      biologicalEpgGeometry?.dispose();
      biologicalEpgMaterial?.dispose();
    }
    if (connectionLines != null) {
      scene.remove(connectionLines);
      connectionLines.geometry.dispose();
      (connectionLines.material as THREE.Material).dispose();
    }
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
  state.dispose = dispose;
  return state;
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

function applyTickSpikes(
  sceneState: SceneState,
  replay: ReplayData,
  currentTick: number,
  epgWindowWeights?: Map<string, number>,
  epgWindowTicks = 1,
  dtSec = 0.001,
  delta7InhibitionProfileByOffset?: number[],
): CompassStats {
  const {
    idToIndex,
    isRingByIndex,
    isEpgByIndex,
    isUpstreamByIndex,
    isDownstreamByIndex,
    isDelta7ByIndex,
    epgBinByIndex,
    upstreamBinByIndex,
    downstreamBinByIndex,
    delta7BinByIndex,
    epgBinPopulation,
    upstreamBinPopulation,
    downstreamBinPopulation,
    delta7BinPopulation,
  } = sceneState;
  sceneState.replay = replay;
  sceneState.currentTick = currentTick;

  const spikes = replay.ticks[Math.max(0, currentTick - 1)]?.spikes ?? [];
  let epgActiveCount = 0;
  let epgLeftCount = 0;
  let epgRightCount = 0;
  let ringActiveCount = 0;
  const epgBinsRaw = new Array<number>(EPG_COMPASS_BINS).fill(0);
  const upstreamBinsRaw = new Array<number>(EPG_COMPASS_BINS).fill(0);
  const downstreamBinsRaw = new Array<number>(EPG_COMPASS_BINS).fill(0);
  const delta7BinsRaw = new Array<number>(EPG_COMPASS_BINS).fill(0);
  for (const id of spikes) {
    const idx = idToIndex.get(id);
    if (idx == null) continue;
    if (isRingByIndex[idx]) ringActiveCount += 1;
    if (isEpgByIndex[idx]) {
      epgActiveCount += 1;
      const bin = epgBinByIndex[idx];
      if (bin != null) epgBinsRaw[bin] += 1;
    }
    if (isUpstreamByIndex[idx]) {
      const bin = upstreamBinByIndex[idx];
      if (bin != null) upstreamBinsRaw[bin] += 1;
    }
    if (isDownstreamByIndex[idx]) {
      const bin = downstreamBinByIndex[idx];
      if (bin != null) downstreamBinsRaw[bin] += 1;
    }
    if (isDelta7ByIndex[idx]) {
      const bin = delta7BinByIndex[idx];
      if (bin != null) delta7BinsRaw[bin] += 1;
    }
  }
  let windowSpikeTotal = epgActiveCount;
  if (epgWindowWeights && epgWindowWeights.size > 0) {
    epgBinsRaw.fill(0);
    upstreamBinsRaw.fill(0);
    downstreamBinsRaw.fill(0);
    delta7BinsRaw.fill(0);
    windowSpikeTotal = 0;
    for (const [id, weight] of epgWindowWeights.entries()) {
      if (weight <= 0) continue;
      const idx = idToIndex.get(id);
      if (idx == null) continue;
      if (isEpgByIndex[idx]) {
        const bin = epgBinByIndex[idx];
        if (bin != null) {
          epgBinsRaw[bin] += weight;
          windowSpikeTotal += weight;
        }
      }
      if (isUpstreamByIndex[idx]) {
        const bin = upstreamBinByIndex[idx];
        if (bin != null) upstreamBinsRaw[bin] += weight;
      }
      if (isDownstreamByIndex[idx]) {
        const bin = downstreamBinByIndex[idx];
        if (bin != null) downstreamBinsRaw[bin] += weight;
      }
      if (isDelta7ByIndex[idx]) {
        const bin = delta7BinByIndex[idx];
        if (bin != null) delta7BinsRaw[bin] += weight;
      }
    }
  }
  const epgBinsCore = epgBinsRaw.map((v, i) => {
    const pop = epgBinPopulation[i] ?? 0;
    return pop > 0 ? v / pop : 0;
  });
  const upstreamBins = upstreamBinsRaw.map((v, i) => {
    const pop = upstreamBinPopulation[i] ?? 0;
    return pop > 0 ? v / pop : 0;
  });
  const downstreamBins = downstreamBinsRaw.map((v, i) => {
    const pop = downstreamBinPopulation[i] ?? 0;
    return pop > 0 ? v / pop : 0;
  });
  const delta7Bins = delta7BinsRaw.map((v, i) => {
    const pop = delta7BinPopulation[i] ?? 0;
    return pop > 0 ? v / pop : 0;
  });
  // Arrow and bump decode use EPG only (no upstream/downstream weight).
  const epgBins = epgBinsCore.map((v, i) => {
    const support = v;
    let inhib = 0;
    if (delta7InhibitionProfileByOffset && delta7InhibitionProfileByOffset.length === EPG_COMPASS_BINS) {
      for (let sourceBin = 0; sourceBin < EPG_COMPASS_BINS; sourceBin += 1) {
        const offset = (i - sourceBin + EPG_COMPASS_BINS) % EPG_COMPASS_BINS;
        inhib += (delta7Bins[sourceBin] ?? 0) * (delta7InhibitionProfileByOffset[offset] ?? 0);
      }
      inhib *= DELTA7_OPPOSITE_INHIBIT_WEIGHT;
    } else {
      const oppositeSourceBin = (i + (EPG_COMPASS_BINS / 2)) % EPG_COMPASS_BINS;
      inhib = (delta7Bins[oppositeSourceBin] ?? 0) * DELTA7_OPPOSITE_INHIBIT_WEIGHT;
    }
    return Math.max(0, support - inhib);
  });
  const epgBinMaxForDecode = epgBins.reduce((m, v) => Math.max(m, v), 0);
  const epgBinsForDecode = epgBinMaxForDecode > 0 ? epgBins.map((v) => v / epgBinMaxForDecode) : epgBins;
  const epgBinsSigned = epgBinsForDecode.map((v) => {
    const active = Math.max(0, Math.min(1, v));
    const inactive = 1 - active;
    return active - (inactive * EPG_INACTIVE_BIN_PENALTY);
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
    const w = epgBinsSigned[i] ?? 0;
    if (Math.abs(w) <= 1e-8) continue;
    const a = sceneAngleForBin(i, EPG_COMPASS_BINS);
    const dx = Math.cos(a);
    bump.x += w * dx;
    bump.y += w * Math.sin(a);
    if (dx < 0) epgLeftCount += Math.max(0, w);
    else if (dx > 0) epgRightCount += Math.max(0, w);
    bumpWeightTotal += Math.abs(w);
  }
  const vectorBumpStrength = bumpWeightTotal > 0 ? bump.length() / bumpWeightTotal : 0;
  const vectorBumpAngleDeg = bump.lengthSq() > 1e-8 ? (Math.atan2(bump.y, bump.x) * 180) / Math.PI : null;
  sceneState.decodeEmaAngleDeg = null;

  // If a bin has a clear majority of its EPG neurons active (e.g. 80%+), point the arrow there (clear bump signal).
  let bumpAngleDeg: number | null = vectorBumpAngleDeg;
  let bumpStrength = vectorBumpStrength;
  let dominantBin: number | null = null;
  for (let i = 0; i < EPG_COMPASS_BINS; i += 1) {
    if ((epgBinsCore[i] ?? 0) >= EPG_DOMINANT_BIN_THRESHOLD) {
      if (dominantBin == null || (epgBinsCore[i] ?? 0) > (epgBinsCore[dominantBin] ?? 0)) {
        dominantBin = i;
      }
    }
  }
  if (dominantBin != null) {
    bumpAngleDeg = (sceneAngleForBin(dominantBin, EPG_COMPASS_BINS) * 180) / Math.PI;
    bumpStrength = Math.max(bumpStrength, 0.85);
    epgTopBinIndex = dominantBin;
  }

  // Arrow direction and length use only EPG (+ Delta7 inhibition). Upstream/downstream are for display only.
  if (bumpAngleDeg != null) {
    sceneState.arrowState.angleTargetDeg = normalizeAngleDeg(bumpAngleDeg);
    sceneState.arrowState.strengthTarget = Math.max(0.08, bumpStrength);
  }
  // biologicalEpgColorAttr is driven by fluorescence in the animate loop (heatmap).
  // Hover highlight is also applied there. No uniform overwrite here.
  const epgBinMax = epgBins.reduce((m, v) => Math.max(m, v), 0);
  const epgBinNorm = epgBinMax > 0 ? epgBins.map((v) => v / epgBinMax) : epgBins;
  const upstreamMax = upstreamBins.reduce((m, v) => Math.max(m, v), 0);
  const upstreamNorm = upstreamMax > 0 ? upstreamBins.map((v) => v / upstreamMax) : upstreamBins;
  const downstreamMax = downstreamBins.reduce((m, v) => Math.max(m, v), 0);
  const downstreamNorm = downstreamMax > 0 ? downstreamBins.map((v) => v / downstreamMax) : downstreamBins;
  const delta7Max = delta7Bins.reduce((m, v) => Math.max(m, v), 0);
  const delta7Norm = delta7Max > 0 ? delta7Bins.map((v) => v / delta7Max) : delta7Bins;
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
    upstreamBins: upstreamNorm,
    downstreamBins: downstreamNorm,
    delta7Bins: delta7Norm,
  };
}

const NEUROSIM_LIVE_DT_SEC = 0.0001;
const NEUROSIM_LIVE_POLL_MS = 20;
const NEUROSIM_LIVE_MAX_TICKS_PER_POLL = 3000;
const NEUROSIM_LIVE_MAX_STORED_TICKS = 100_000;
const NEUROSIM_LIVE_MAX_BACKOFF_MS = 2000;

export default function VisualizationPage() {
  const [fetchedReplay, setFetchedReplay] = useState<ReplayData | null>(null);
  const [templateReplay, setTemplateReplay] = useState<ReplayData | null>(null);
  const [liveReplay, setLiveReplay] = useState<ReplayData | null>(null);
  const [liveTicks, setLiveTicks] = useState<ReplayTick[]>([]);
  const [recordedTicks, setRecordedTicks] = useState<ReplayTick[]>([]);
  const [liveReplaySource, setLiveReplaySource] = useState<'live' | 'recording'>('live');
  const liveReplayTickCountRef = useRef(0);
  const liveReplaySourceRef = useRef<'live' | 'recording'>('live');
  const liveReplayRef = useRef<ReplayData | null>(null);
  const liveEpgSeenRef = useRef<Set<string>>(new Set());
  const [liveEpgUniqueFired, setLiveEpgUniqueFired] = useState(0);
  const [recording, setRecording] = useState(false);
  const [liveSettings, setLiveSettings] = useState({ dtSec: NEUROSIM_LIVE_DT_SEC });
  /** Draft values; server uses last Apply (starts at 0 / 0). */
  const [penALeftHz, setPenALeftHz] = useState(0);
  const [penARightHz, setPenARightHz] = useState(0);
  const [appliedPenLeft, setAppliedPenLeft] = useState(0);
  const [appliedPenRight, setAppliedPenRight] = useState(0);
  const [applyBusy, setApplyBusy] = useState(false);
  const [liveAutoplay, setLiveAutoplay] = useState(true);
  const [latestLiveTickNumber, setLatestLiveTickNumber] = useState(0);
  const [penANeurons, setPenANeurons] = useState<{ left: Array<{ id: string; label: string }>; right: Array<{ id: string; label: string }> }>({ left: [], right: [] });
  const [penARatesById, setPenARatesById] = useState<Record<string, number>>({});
  const notification = useNotification();
  const liveAfterTickRef = useRef(0);
  const livePollFailRef = useRef(0);
  const recordingRef = useRef(false);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  const [currentTick, setCurrentTick] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [viewMode, setViewMode] = useState<ViewMode>('compass');
  const [replayDatasets] = useState<ReplayDataset[]>(DEFAULT_REPLAY_DATASETS);
  const [selectedReplayId, setSelectedReplayId] = useState<string>(
    DEFAULT_REPLAY_DATASETS.find((d) => d.id === PREFERRED_REPLAY_ID)?.id
      ?? DEFAULT_REPLAY_DATASETS[0]?.id
      ?? '',
  );
  const replay = useMemo(
    () => (selectedReplayId === 'neurosim_live' ? liveReplay : fetchedReplay),
    [selectedReplayId, liveReplay, fetchedReplay],
  );
  const [arrowSmoothing, setArrowSmoothing] = useState(true);
  const [epgLabelMap, setEpgLabelMap] = useState<Map<string, string> | null>(null);
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
    upstreamBins: new Array<number>(EPG_COMPASS_BINS).fill(0),
    downstreamBins: new Array<number>(EPG_COMPASS_BINS).fill(0),
    delta7Bins: new Array<number>(EPG_COMPASS_BINS).fill(0),
  });
  const [error, setError] = useState<string | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);

  const neurons = useMemo(() => {
    const base = replay?.neurons ?? [];
    const labelMap = epgLabelMap && epgLabelMap.size > 0 ? epgLabelMap : null;
    return base.map((n) => {
        const sideFromMap = labelMap?.get(n.root_id)?.startsWith('L') ? 'left' : labelMap?.get(n.root_id)?.startsWith('R') ? 'right' : undefined;
        const effLabel = getEffectiveEpgLabel(n, labelMap ?? null);
        const side = sideFromMap ?? (effLabel ? (effLabel.startsWith('L') ? 'left' : 'right') : n.side);
        return { ...n, side };
      });
  }, [replay?.neurons, epgLabelMap]);
  const ringIdSet = useMemo(() => new Set(neurons.filter((n) => n.is_ring).map((n) => n.root_id)), [neurons]);
  const epgUniqueFired = useMemo(() => {
    if (!replay) return null;
    if (selectedReplayId === 'neurosim_live') return liveEpgUniqueFired;
    let epgIds: Set<string>;
    if (epgLabelMap && epgLabelMap.size > 0) {
      epgIds = new Set(
        (replay.neurons ?? [])
          .filter((neuron) => epgLabelMap.has(neuron.root_id) && isCompassEpgNeuron(neuron))
          .map((neuron) => neuron.root_id),
      );
    } else {
      epgIds = new Set((replay.neurons ?? []).filter((neuron) => isCompassEpgNeuron(neuron)).map((neuron) => neuron.root_id));
    }
    if (epgIds.size === 0) return null;
    const fired = new Set<string>();
    for (const tick of replay.ticks) {
      for (const id of tick.spikes ?? []) {
        if (epgIds.has(id)) fired.add(id);
      }
    }
    return fired.size;
  }, [replay, epgLabelMap, selectedReplayId, liveEpgUniqueFired]);
  const displayNeurons = useMemo(() => {
    const seen = new Set<string>();
    return neurons.filter((neuron) => {
      if (seen.has(neuron.root_id)) return false;
      seen.add(neuron.root_id);
      return true;
    });
  }, [neurons]);
  const selectedReplay = useMemo(
    () => replayDatasets.find((d) => d.id === selectedReplayId) ?? replayDatasets[0],
    [replayDatasets, selectedReplayId],
  );

  useEffect(() => {
    let active = true;
    fetch('/processed_labels.csv?v=' + Date.now(), { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        if (!active || !text) return;
        const map = new Map<string, string>();
        const lines = text.split(/\r?\n/);
        for (let i = 1; i < lines.length; i += 1) {
          const parsed = parseProcessedLabelsLine(lines[i] ?? '');
          if (!parsed) continue;
          const [rid, labelRaw] = parsed;
          const label = labelRaw.toUpperCase();
          if (rid && EPG_LABEL_TO_BIN.has(label)) map.set(rid, label);
        }
        setEpgLabelMap(map);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setError(null);
        const datasetUrl = selectedReplay?.url;
        if (!datasetUrl) throw new Error('No replay dataset selected');
        const isNeuroSimLive = selectedReplay?.id === 'neurosim_live' || datasetUrl.startsWith('/api/neurosim-replay');
        if (isNeuroSimLive) {
          const apiRoot = getApiBase();
          const neuronRes = await fetch(`${apiRoot}/api/neurons?full=1&epgOnly=1`, { cache: 'no-store' });
          if (!neuronRes.ok) throw new Error(`Failed to load live neuron template (${neuronRes.status})`);
          const neuronPayload = (await neuronRes.json()) as { neurons?: ApiNeuron[] };
          const templateNeurons: ReplayNeuron[] = (neuronPayload.neurons ?? []).map((n) => ({
            root_id: n.root_id,
            x: typeof n.x === 'number' ? n.x : 0,
            y: typeof n.y === 'number' ? n.y : 0,
            z: typeof n.z === 'number' ? n.z : 0,
            processed_label: n.cell_type,
            is_ring: true,
            is_epg: true,
            side: n.side ?? 'unknown',
            hemibrain_type: n.cell_type ?? '',
            flow: n.role,
            cell_type: n.cell_type,
          }));
          if (!active) return;
          setTemplateReplay({
            meta: {
              generated_at: new Date().toISOString(),
              source_csv: 'api:/api/neurons?full=1&epgOnly=1',
              ticks: 0,
              unique_fired_neurons: 0,
              ring_neuron_total: 0,
              ring_neuron_unique_fired: 0,
              dt_sec: NEUROSIM_LIVE_DT_SEC,
              scenario: 'neurosim_live',
            },
            neurons: templateNeurons,
            ticks: [],
          });
          setFetchedReplay(null);
          liveReplayRef.current = null;
          setLiveReplay(null);
          setLiveTicks([]);
          setRecordedTicks([]);
          setLiveReplaySource('live');
          liveReplayTickCountRef.current = 0;
          liveReplaySourceRef.current = 'live';
          liveEpgSeenRef.current = new Set();
          setLiveEpgUniqueFired(0);
        } else {
          const res = await fetch(`${datasetUrl}?v=${Date.now()}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`Replay not found (${res.status})`);
          const parsed = await res.json() as ReplayData;
          if (!active) return;
          setFetchedReplay(parsed);
          setTemplateReplay(null);
          liveReplayRef.current = null;
          setLiveReplay(null);
        }
        setCurrentTick(1);
        setPlaying(false);
      } catch (err) {
        if (!active) return;
        setFetchedReplay(null);
        setTemplateReplay(null);
        liveReplayRef.current = null;
        setLiveReplay(null);
        setLiveTicks([]);
        setRecordedTicks([]);
        setLiveReplaySource('live');
        liveReplayTickCountRef.current = 0;
        liveReplaySourceRef.current = 'live';
        liveEpgSeenRef.current = new Set();
        setLiveEpgUniqueFired(0);
        liveAfterTickRef.current = 0;
        setCurrentTick(0);
        setPlaying(false);
        setError((err as Error).message);
      }
    };
    void load();
    return () => { active = false; };
  }, [selectedReplay]);

  useEffect(() => {
    if (selectedReplayId !== 'neurosim_live' || !templateReplay) {
      liveReplayTickCountRef.current = 0;
      liveReplaySourceRef.current = 'live';
      liveReplayRef.current = null;
      liveEpgSeenRef.current = new Set();
      setLiveEpgUniqueFired(0);
      setLiveReplay(null);
      return;
    }
    const ticks = liveReplaySource === 'recording' ? recordedTicks : liveTicks;
    const sourceChanged = liveReplaySourceRef.current !== liveReplaySource;
    const current = liveReplayRef.current;
    const replayMissing = current == null;
    const tickReset = ticks.length < liveReplayTickCountRef.current;
    const dtChanged = (current?.meta.dt_sec ?? liveSettings.dtSec) !== liveSettings.dtSec;
    const fullRebuild = replayMissing || sourceChanged || tickReset || dtChanged;
    const epgIds: Set<string> | null =
      epgLabelMap && epgLabelMap.size > 0
        ? new Set(epgLabelMap.keys())
        : templateReplay?.neurons
          ? new Set(templateReplay.neurons.filter((neuron) => neuron.is_epg === true).map((neuron) => neuron.root_id))
          : null;

    if (fullRebuild) {
      const seen = new Set<string>();
      if (epgIds && epgIds.size > 0) {
        for (const t of ticks) {
          for (const id of t.spikes ?? []) {
            if (epgIds.has(id)) seen.add(id);
          }
        }
      }
      liveEpgSeenRef.current = seen;
      setLiveEpgUniqueFired(seen.size);
      const next = {
        ...templateReplay,
        meta: {
          ...templateReplay.meta,
          dt_sec: liveSettings.dtSec,
          scenario: 'neurosim_live',
          ticks: ticks.length,
          epg_neuron_unique_fired: seen.size,
        },
        ticks: [...ticks],
      };
      liveReplayRef.current = next;
      setLiveReplay(next);
    } else if (ticks.length > liveReplayTickCountRef.current && current != null) {
      const appended = ticks.slice(liveReplayTickCountRef.current);
      if (epgIds && epgIds.size > 0) {
        for (const t of appended) {
          for (const id of t.spikes ?? []) {
            if (epgIds.has(id)) liveEpgSeenRef.current.add(id);
          }
        }
      }
      const seenCount = liveEpgSeenRef.current.size;
      setLiveEpgUniqueFired(seenCount);
      const next = {
        ...current,
        meta: {
          ...current.meta,
          dt_sec: liveSettings.dtSec,
          scenario: 'neurosim_live',
          ticks: ticks.length,
          epg_neuron_unique_fired: seenCount,
        },
        ticks: [...current.ticks, ...appended],
      };
      liveReplayRef.current = next;
      setLiveReplay(next);
    } else if (current != null && ticks !== current.ticks) {
      // Buffer replaced at cap (same length, new content) – sync replay so live view advances
      const seen = new Set<string>();
      if (epgIds && epgIds.size > 0) {
        for (const t of ticks) {
          for (const id of t.spikes ?? []) {
            if (epgIds.has(id)) seen.add(id);
          }
        }
      }
      liveEpgSeenRef.current = seen;
      setLiveEpgUniqueFired(seen.size);
      const next = {
        ...current,
        meta: {
          ...current.meta,
          dt_sec: liveSettings.dtSec,
          scenario: 'neurosim_live',
          ticks: ticks.length,
          epg_neuron_unique_fired: seen.size,
        },
        ticks: [...ticks],
      };
      liveReplayRef.current = next;
      setLiveReplay(next);
    } else if (current != null && current.meta.dt_sec !== liveSettings.dtSec) {
      const next = {
        ...current,
        meta: {
          ...current.meta,
          dt_sec: liveSettings.dtSec,
          scenario: 'neurosim_live',
        },
      };
      liveReplayRef.current = next;
      setLiveReplay(next);
    }

    liveReplayTickCountRef.current = ticks.length;
    liveReplaySourceRef.current = liveReplaySource;
  }, [selectedReplayId, templateReplay, liveReplaySource, liveTicks, recordedTicks, liveSettings.dtSec, epgLabelMap]);

  const isNeuroSimLive = selectedReplayId === 'neurosim_live';
  const apiBase = getApiBase();

  useEffect(() => {
    if (!isNeuroSimLive) return;
    let cancelled = false;
    fetch(`${apiBase}/api/neurosim-live/pen-a-neurons`)
      .then((r) => r.json())
      .then((data: { left?: Array<{ id: string; label: string }>; right?: Array<{ id: string; label: string }> }) => {
        if (!cancelled) setPenANeurons({ left: data.left ?? [], right: data.right ?? [] });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isNeuroSimLive, apiBase]);

  useEffect(() => {
    if (!isNeuroSimLive || !templateReplay) return;
    let cancelled = false;
    let timerId: number | null = null;
    const schedule = (fn: () => void, ms: number) => {
      if (timerId != null) clearTimeout(timerId);
      timerId = window.setTimeout(fn, ms);
    };
    const init = async () => {
      try {
        setError(null);
        const st = await fetch(`${apiBase}/api/neurosim-live/status`);
        if (!st.ok) throw new Error(`live status ${st.status}`);
        const j = (await st.json()) as {
          latestTick?: number;
          dtSec?: number;
          penALeftHz?: number;
          penARightHz?: number;
        };
        if (cancelled) return;
        const latest = Math.max(0, Math.floor(j.latestTick ?? 0));
        liveAfterTickRef.current = latest;
        setLatestLiveTickNumber(latest);
        setAppliedPenLeft(j.penALeftHz ?? 0);
        setAppliedPenRight(j.penARightHz ?? 0);
        setPenALeftHz(j.penALeftHz ?? 0);
        setPenARightHz(j.penARightHz ?? 0);
        if (typeof j.dtSec === 'number' && j.dtSec > 0) setLiveSettings({ dtSec: j.dtSec });
        setLiveTicks([]);
        setRecordedTicks([]);
        livePollFailRef.current = 0;
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    const poll = async () => {
      if (cancelled) return;
      try {
        const after = liveAfterTickRef.current;
        const res = await fetch(
          `${apiBase}/api/neurosim-live/ticks?after=${after}&max=${NEUROSIM_LIVE_MAX_TICKS_PER_POLL}`,
        );
        if (!res.ok) throw new Error(`live ticks ${res.status}`);
        const data = (await res.json()) as {
          ticks?: ReplayTick[];
          latestTick?: number;
          dtSec?: number;
        };
        if (cancelled) return;
        if (typeof data.dtSec === 'number' && data.dtSec > 0) {
          setLiveSettings({ dtSec: data.dtSec });
        }
        const batch = data.ticks ?? [];
        const latestFromServer = data.latestTick ?? 0;
        if (latestFromServer > 0) setLatestLiveTickNumber(latestFromServer);
        if (batch.length > 0) {
          const last = batch[batch.length - 1]!.tick;
          liveAfterTickRef.current = last;
          setLiveTicks((prev) => {
            const merged = [...prev, ...batch];
            return merged.length > NEUROSIM_LIVE_MAX_STORED_TICKS
              ? merged.slice(-NEUROSIM_LIVE_MAX_STORED_TICKS)
              : merged;
          });
          if (recordingRef.current) {
            setRecordedTicks((prev) => {
              const merged = [...prev, ...batch];
              return merged.length > NEUROSIM_LIVE_MAX_STORED_TICKS
                ? merged.slice(-NEUROSIM_LIVE_MAX_STORED_TICKS)
                : merged;
            });
          }
        }
        livePollFailRef.current = 0;
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          livePollFailRef.current += 1;
        }
      }
      if (!cancelled) {
        const backoff = Math.min(
          NEUROSIM_LIVE_POLL_MS * 2 ** livePollFailRef.current,
          NEUROSIM_LIVE_MAX_BACKOFF_MS,
        );
        schedule(() => void poll(), Math.max(NEUROSIM_LIVE_POLL_MS, backoff));
      }
    };
    const startPolling = async () => {
      await init();
      if (cancelled) return;
      schedule(() => void poll(), NEUROSIM_LIVE_POLL_MS);
    };
    void startPolling();
    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
  }, [isNeuroSimLive, templateReplay, apiBase]);

  useEffect(() => {
    if (!replay?.ticks.length || !isNeuroSimLive || liveReplaySource !== 'live' || !liveAutoplay) return;
    setCurrentTick(replay.ticks.length);
  }, [replay, replay?.ticks.length, isNeuroSimLive, liveReplaySource, liveAutoplay]);

  useEffect(() => {
    const container = sceneContainerRef.current;
    if (!container || displayNeurons.length === 0) return;
    if (sceneRef.current) {
      sceneRef.current.dispose();
      sceneRef.current = null;
    }
    sceneRef.current = buildScene(container, displayNeurons, viewMode, undefined, epgLabelMap, replay ?? null);
    return () => {
      if (sceneRef.current) {
        sceneRef.current.dispose();
        sceneRef.current = null;
      }
    };
  }, [displayNeurons, viewMode, epgLabelMap]);

  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.arrowState.smoothingEnabled = arrowSmoothing;
  }, [arrowSmoothing]);

  useEffect(() => {
    if (!replay || !sceneRef.current) return;
    sceneRef.current.replay = replay;
    sceneRef.current.currentTick = currentTick;
    const idx = Math.max(0, Math.min(replay.ticks.length - 1, currentTick - 1));
    const spikes = replay.ticks[idx]?.spikes ?? [];
    const dtSec = getReplayDtSec(replay);
    const epgWindowTicks = EPG_BUMP_WINDOW_TICKS;
    const epgWindowWeights = buildEpgWindowWeights(replay, currentTick, epgWindowTicks);
    const stats = applyTickSpikes(
      sceneRef.current,
      replay,
      currentTick,
      epgWindowWeights,
      epgWindowTicks,
      dtSec,
      replay.meta?.delta7_inhibition_profile_by_offset,
    );
    let ringInputActive = 0;
    for (const id of spikes) {
      if (ringIdSet.has(id)) ringInputActive += 1;
    }
    setCompassStats({ ...stats, ringActiveCount: ringInputActive });
  }, [replay, currentTick, ringIdSet]);

  useEffect(() => {
    if (!playing || !replay) return undefined;
    if (speed === 'irl') {
      const dtSec = getReplayDtSec(replay);
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

  const totalTicks =
    isNeuroSimLive && liveReplaySource === 'live' && latestLiveTickNumber > 0
      ? Math.max(latestLiveTickNumber, replay?.ticks.length ?? 0)
      : replay?.ticks.length ?? 1;
  const smoothedArrowAngleDeg = sceneRef.current?.arrowState?.angleCurrentDeg;
  const bumpTheta = Number.isFinite(smoothedArrowAngleDeg)
    ? (((smoothedArrowAngleDeg as number) + 360) % 360)
    : (compassStats.bumpAngleDeg != null ? ((compassStats.bumpAngleDeg + 360) % 360) : null);

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#060a14' }}>
      <div style={{ padding: 12, display: 'grid', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <details open style={{ minWidth: 420, color: '#d8e6ff' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              Replay files
            </summary>
            <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
              {replayDatasets.map((dataset) => (
                <button
                  key={dataset.id}
                  type="button"
                  onClick={() => setSelectedReplayId(dataset.id)}
                  style={{
                    ...controlButtonStyle(selectedReplayId === dataset.id),
                    display: 'block',
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  {dataset.label}
                </button>
              ))}
            </div>
          </details>
        </div>
        {isNeuroSimLive && templateReplay ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#9ec5ff', maxWidth: 420 }}>
              One continuous sim runs inside brain-service from startup (0 Hz until you apply). EPG spikes stream here; Apply updates PEN_a input on the fly.
            </span>
            <span style={{ fontSize: 11, color: '#7a9cc4' }}>
              Active input: L={appliedPenLeft} R={appliedPenRight} Hz
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              Left PEN_a
              <input
                type="range"
                min={0}
                max={200}
                value={Math.min(200, penALeftHz)}
                onChange={(e) => setPenALeftHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                style={{ width: 120 }}
              />
              <input
                type="number"
                min={0}
                max={500}
                value={penALeftHz}
                onChange={(e) => setPenALeftHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                style={{ width: 48, padding: '2px 4px', fontSize: 12 }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              Right PEN_a
              <input
                type="range"
                min={0}
                max={200}
                value={Math.min(200, penARightHz)}
                onChange={(e) => setPenARightHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                style={{ width: 120 }}
              />
              <input
                type="number"
                min={0}
                max={500}
                value={penARightHz}
                onChange={(e) => setPenARightHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                style={{ width: 48, padding: '2px 4px', fontSize: 12 }}
              />
            </label>
            <details open style={{ fontSize: 12, color: '#b8d4ff', marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Per-neuron PEN_a (Hz) — override global L/R</summary>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
                {penANeurons.left.length === 0 && penANeurons.right.length === 0 ? (
                  <span style={{ color: '#f0a050' }}>Loading PEN_a list…</span>
                ) : null}
                <div>
                  <div style={{ marginBottom: 4, fontWeight: 600 }}>Left (L1–L10)</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {penANeurons.left.map(({ id, label }) => (
                      <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ minWidth: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                          <span>{label}</span>
                          <span style={{ fontSize: 9, color: '#6a8aaa', fontWeight: 400 }}>{id}</span>
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={500}
                          placeholder={String(penALeftHz)}
                          value={penARatesById[id] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : Number(e.target.value);
                            setPenARatesById((prev) => {
                              const next = { ...prev };
                              if (v == null || !Number.isFinite(v)) delete next[id];
                              else next[id] = Math.max(0, Math.min(500, v));
                              return next;
                            });
                          }}
                          style={{ width: 44, padding: '2px 4px', fontSize: 11 }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ marginBottom: 4, fontWeight: 600 }}>Right (R1–R10)</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {penANeurons.right.map(({ id, label }) => (
                      <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ minWidth: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                          <span>{label}</span>
                          <span style={{ fontSize: 9, color: '#6a8aaa', fontWeight: 400 }}>{id}</span>
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={500}
                          placeholder={String(penARightHz)}
                          value={penARatesById[id] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : Number(e.target.value);
                            setPenARatesById((prev) => {
                              const next = { ...prev };
                              if (v == null || !Number.isFinite(v)) delete next[id];
                              else next[id] = Math.max(0, Math.min(500, v));
                              return next;
                            });
                          }}
                          style={{ width: 44, padding: '2px 4px', fontSize: 11 }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </details>
            <button
              type="button"
              onClick={async () => {
                setError(null);
                setApplyBusy(true);
                try {
                  const ratesById: Record<string, number> = {};
                  for (const { id } of penANeurons.left) {
                    const v = penARatesById[id];
                    ratesById[id] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : penALeftHz;
                  }
                  for (const { id } of penANeurons.right) {
                    const v = penARatesById[id];
                    ratesById[id] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : penARightHz;
                  }
                  const res = await fetch(`${apiBase}/api/neurosim-live/apply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      penALeftHz: penALeftHz,
                      penARightHz: penARightHz,
                      ratesById,
                    }),
                  });
                  const data = (await res.json().catch(() => ({}))) as { penALeftHz?: number; penARightHz?: number; error?: string };
                  if (!res.ok) throw new Error(data?.error ?? `apply failed: ${res.status}`);
                  const appliedL = data.penALeftHz ?? penALeftHz;
                  const appliedR = data.penARightHz ?? penARightHz;
                  setAppliedPenLeft(appliedL);
                  setAppliedPenRight(appliedR);
                  const overrides: string[] = [];
                  for (const { id, label } of penANeurons.left) {
                    const v = ratesById[id];
                    if (typeof v === 'number' && v !== appliedL) overrides.push(`${label}=${v}`);
                  }
                  for (const { id, label } of penANeurons.right) {
                    const v = ratesById[id];
                    if (typeof v === 'number' && v !== appliedR) overrides.push(`${label}=${v}`);
                  }
                  const msg =
                    overrides.length > 0
                      ? `PEN_a updated: ${overrides.join(', ')} Hz`
                      : `PEN_a applied: L=${appliedL} R=${appliedR} Hz`;
                  notification.show(msg, 'success');
                  setTimeout(() => notification.hide(), 2500);
                } catch (e) {
                  const msg = (e as Error).message;
                  setError(msg);
                  notification.show(msg, 'error');
                  setTimeout(() => notification.hide(), 4000);
                } finally {
                  setApplyBusy(false);
                }
              }}
              style={controlButtonStyle(false)}
              disabled={applyBusy}
            >
              Apply PEN_a Hz
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={liveAutoplay}
                onChange={(e) => setLiveAutoplay(e.target.checked)}
              />
              Autoplay live
            </label>
            <button
              type="button"
              onClick={() => setRecording((r) => !r)}
              style={controlButtonStyle(recording)}
            >
              Record {recording ? '(on)' : ''}
            </button>
            {recordedTicks.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => { setLiveReplaySource('recording'); setCurrentTick(1); setPlaying(false); }}
                  style={controlButtonStyle(liveReplaySource === 'recording')}
                >
                  Replay recording ({recordedTicks.length} ticks)
                </button>
                <button
                  type="button"
                  onClick={() => setLiveReplaySource('live')}
                  style={controlButtonStyle(liveReplaySource === 'live')}
                >
                  View live
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!templateReplay) return;
                    const payload: ReplayData = {
                      meta: {
                        ...templateReplay.meta,
                        generated_at: new Date().toISOString(),
                        source_csv: 'neurosim-live/recording',
                        ticks: recordedTicks.length,
                        scenario: 'neurosim_live_pen_a_recording',
                        dt_sec: liveSettings.dtSec,
                        note: `Continuous live sim; applied PEN_a last L=${appliedPenLeft} R=${appliedPenRight} Hz`,
                      },
                      neurons: templateReplay.neurons,
                      ticks: recordedTicks,
                    };
                    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `neurosim_live_pen_a_${Date.now()}.json`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                  style={controlButtonStyle(false)}
                >
                  Download JSON
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setViewMode('raw')} style={controlButtonStyle(viewMode === 'raw')}>Raw</button>
          <button type="button" onClick={() => setViewMode('aligned')} style={controlButtonStyle(viewMode === 'aligned')}>Aligned</button>
          <button type="button" onClick={() => setViewMode('compass')} style={controlButtonStyle(viewMode === 'compass')}>Compass loop</button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setArrowSmoothing((v) => !v)} style={controlButtonStyle(arrowSmoothing)}>
            Arrow smoothing: {arrowSmoothing ? 'ON' : 'OFF'}
          </button>
        </div>
        {replay ? (
          <PlaybackControls
            playing={playing}
            tick={
              isNeuroSimLive && liveReplaySource === 'live' && liveAutoplay && currentTick === replay.ticks.length && latestLiveTickNumber > 0
                ? latestLiveTickNumber
                : currentTick
            }
            totalTicks={totalTicks}
            speed={speed}
            onPlayPause={() => setPlaying((p) => !p)}
            onPrevTick={() => setCurrentTick((t) => Math.max(1, t - 1))}
            onNextTick={() => setCurrentTick((t) => Math.min(replay?.ticks.length ?? totalTicks, t + 1))}
            onSeekTick={(tick) => {
              const max = isNeuroSimLive && replay ? replay.ticks.length : totalTicks;
              setCurrentTick(Math.max(1, Math.min(max, tick)));
            }}
            onSpeedChange={setSpeed}
          />
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              flex: 1,
            }}
            title={replay ? `replay=${selectedReplay?.id ?? 'n/a'} | scenario=${replay.meta?.scenario ?? 'n/a'} | decode=vector | neurons=${Array.isArray(replay.neurons) ? replay.neurons.length : displayNeurons.length} | rendered=${displayNeurons.length} | ticks=${replay.ticks.length} | sim=${(replay.ticks.length * getReplayDtSec(replay)).toFixed(3)}s | dt=${(getReplayDtSec(replay) * 1000).toFixed(3)}ms | epg fired=${epgUniqueFired ?? 'n/a'} | bump angle=${compassStats.bumpAngleDeg == null ? 'n/a' : `${compassStats.bumpAngleDeg.toFixed(1)}deg`} | bump strength=${compassStats.bumpStrength.toFixed(3)} | top bin=${compassStats.epgTopBinIndex}` : undefined}
          >
            {replay
              ? `replay=${selectedReplay?.id ?? 'n/a'} | scenario=${replay.meta?.scenario ?? 'n/a'} | decode=vector | ticks=${replay.ticks.length} | sim=${(replay.ticks.length * getReplayDtSec(replay)).toFixed(3)}s | dt=${(getReplayDtSec(replay) * 1000).toFixed(3)}ms | epg fired=${epgUniqueFired ?? 'n/a'} | bump=${compassStats.bumpAngleDeg == null ? 'n/a' : `${compassStats.bumpAngleDeg.toFixed(1)}deg`} (${compassStats.bumpStrength.toFixed(2)}) | top bin=${compassStats.epgTopBinIndex}`
              : 'Loading replay...'}
          </div>
          {replay && compassStats.bumpStrength < 0.5 ? (
            <span
              style={{ fontSize: 11, color: 'rgba(120,200,255,0.9)', cursor: 'help', whiteSpace: 'nowrap' }}
              title="Weak bump? Try: (1) organic bump replay (ring drive), (2) run ≥1s, (3) full connectome, (4) match eonsystems scaling. See docs/BUMP_IMPROVEMENT_SUGGESTIONS.md"
            >
              Bump help
            </span>
          ) : null}
        </div>
        {replay ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <svg
              width="152"
              height="152"
              viewBox="-60 -60 120 120"
              style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8 }}
            >
              {/* Radial dividers: 16 bins, anatomical L/R ordering */}
              {Array.from({ length: EPG_COMPASS_BINS + 1 }, (_, i) => {
                const a = (i / EPG_COMPASS_BINS) * Math.PI * 2 - Math.PI / 2;
                return (
                  <line
                    key={`divider-${i}`}
                    x1="0" y1="0"
                    x2={(Math.cos(a) * 48).toFixed(3)}
                    y2={(Math.sin(a) * 48).toFixed(3)}
                    stroke="rgba(255,255,255,0.25)"
                    strokeWidth="0.8"
                  />
                );
              })}
              {Array.from({ length: EPG_COMPASS_BINS }, (_, i) => {
                const { a0, a1 } = getWedgeParams(i, EPG_COMPASS_BINS);
                const r0 = 23;
                const r1 = 30;
                const x0 = Math.cos(a0) * r0; const y0 = Math.sin(a0) * r0;
                const x1 = Math.cos(a1) * r0; const y1 = Math.sin(a1) * r0;
                const x2 = Math.cos(a1) * r1; const y2 = Math.sin(a1) * r1;
                const x3 = Math.cos(a0) * r1; const y3 = Math.sin(a0) * r1;
                return (
                  <path
                    key={`epg-slice-color-${i}`}
                    d={`M ${x0} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`}
                    fill={EPG_SLICE_COLORS[i % EPG_SLICE_COLORS.length]}
                    fillOpacity={0.45}
                    stroke="rgba(255,255,255,0.2)"
                    strokeWidth="0.4"
                  />
                );
              })}
              {Array.from({ length: EPG_COMPASS_BINS }, (_, i) => {
                const { midAngle } = getWedgeParams(i, EPG_COMPASS_BINS);
                const tr = 51;
                const tx = Math.cos(midAngle) * tr;
                const ty = Math.sin(midAngle) * tr;
                return (
                  <text
                    key={`epg-slice-label-${i}`}
                    x={tx.toFixed(3)}
                    y={ty.toFixed(3)}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="rgba(235,245,255,0.96)"
                    fontSize="4.2"
                    fontWeight="700"
                  >
                    {EPG_SLICE_ORDER_CLOCKWISE[i]}
                  </text>
                );
              })}
              <circle cx="0" cy="0" r="44" fill="none" stroke="rgba(120,200,255,0.32)" strokeWidth="1.2" />
              <circle cx="0" cy="0" r="36" fill="none" stroke="rgba(208,140,255,0.28)" strokeWidth="1.2" />
              <circle cx="0" cy="0" r="30" fill="none" stroke="rgba(255,79,216,0.35)" strokeWidth="1.4" />
              <circle cx="0" cy="0" r="18" fill="none" stroke="rgba(255,170,110,0.32)" strokeWidth="1.2" />
              {compassStats.upstreamBins.map((v, i) => {
                const { a0, a1 } = getWedgeParams(i, compassStats.upstreamBins.length);
                const r0 = 44;
                const r1 = 44 + v * 10;
                const x0 = Math.cos(a0) * r0; const y0 = Math.sin(a0) * r0;
                const x1 = Math.cos(a1) * r0; const y1 = Math.sin(a1) * r0;
                const x2 = Math.cos(a1) * r1; const y2 = Math.sin(a1) * r1;
                const x3 = Math.cos(a0) * r1; const y3 = Math.sin(a0) * r1;
                const alpha = 0.2 + v * 0.62;
                return (
                  <path
                    key={`up-bin-${i}`}
                    d={`M ${x0} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`}
                    fill={`rgba(120,200,255,${alpha.toFixed(3)})`}
                    stroke="none"
                  />
                );
              })}
              {compassStats.delta7Bins.map((v, i) => {
                const { a0, a1 } = getWedgeParams(i, compassStats.delta7Bins.length);
                const r0 = 36;
                const r1 = 36 + v * 7;
                const x0 = Math.cos(a0) * r0; const y0 = Math.sin(a0) * r0;
                const x1 = Math.cos(a1) * r0; const y1 = Math.sin(a1) * r0;
                const x2 = Math.cos(a1) * r1; const y2 = Math.sin(a1) * r1;
                const x3 = Math.cos(a0) * r1; const y3 = Math.sin(a0) * r1;
                const alpha = 0.18 + v * 0.58;
                return (
                  <path
                    key={`d7-bin-${i}`}
                    d={`M ${x0} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`}
                    fill={`rgba(208,140,255,${alpha.toFixed(3)})`}
                    stroke="none"
                  />
                );
              })}
              {compassStats.downstreamBins.map((v, i) => {
                const { a0, a1 } = getWedgeParams(i, compassStats.downstreamBins.length);
                const r0 = 18;
                const r1 = 18 + v * 8;
                const x0 = Math.cos(a0) * r0; const y0 = Math.sin(a0) * r0;
                const x1 = Math.cos(a1) * r0; const y1 = Math.sin(a1) * r0;
                const x2 = Math.cos(a1) * r1; const y2 = Math.sin(a1) * r1;
                const x3 = Math.cos(a0) * r1; const y3 = Math.sin(a0) * r1;
                const alpha = 0.2 + v * 0.62;
                return (
                  <path
                    key={`down-bin-${i}`}
                    d={`M ${x0} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`}
                    fill={`rgba(255,170,110,${alpha.toFixed(3)})`}
                    stroke="none"
                  />
                );
              })}
              {Array.from({ length: EPG_COMPASS_BINS }, (_, i) => {
                const { midAngle: a } = getWedgeParams(i, EPG_COMPASS_BINS);
                return (
                  <line
                    key={`link-up-base-${i}`}
                    x1={(Math.cos(a) * 44).toFixed(3)}
                    y1={(Math.sin(a) * 44).toFixed(3)}
                    x2={(Math.cos(a) * 30).toFixed(3)}
                    y2={(Math.sin(a) * 30).toFixed(3)}
                    stroke="rgba(120,200,255,0.35)"
                    strokeWidth="1.25"
                  />
                );
              })}
              {compassStats.upstreamBins.map((v, i) => {
                const { midAngle: a } = getWedgeParams(i, EPG_COMPASS_BINS);
                return (
                  <line
                    key={`link-up-${i}`}
                    x1={(Math.cos(a) * 44).toFixed(3)}
                    y1={(Math.sin(a) * 44).toFixed(3)}
                    x2={(Math.cos(a) * 30).toFixed(3)}
                    y2={(Math.sin(a) * 30).toFixed(3)}
                    stroke={`rgba(120,200,255,${(0.18 + v * 0.55).toFixed(3)})`}
                    strokeWidth="1.6"
                  />
                );
              })}
              {compassStats.delta7Bins.map((v, i) => {
                const { midAngle: a } = getWedgeParams(i, EPG_COMPASS_BINS);
                return (
                  <line
                    key={`link-d7-${i}`}
                    x1={(Math.cos(a) * 36).toFixed(3)}
                    y1={(Math.sin(a) * 36).toFixed(3)}
                    x2={(Math.cos(a) * 30).toFixed(3)}
                    y2={(Math.sin(a) * 30).toFixed(3)}
                    stroke={`rgba(208,140,255,${(0.16 + v * 0.52).toFixed(3)})`}
                    strokeWidth="1.4"
                  />
                );
              })}
              {compassStats.downstreamBins.map((v, i) => {
                const { midAngle: a } = getWedgeParams(i, EPG_COMPASS_BINS);
                return (
                  <line
                    key={`link-down-${i}`}
                    x1={(Math.cos(a) * 30).toFixed(3)}
                    y1={(Math.sin(a) * 30).toFixed(3)}
                    x2={(Math.cos(a) * 18).toFixed(3)}
                    y2={(Math.sin(a) * 18).toFixed(3)}
                    stroke={`rgba(255,170,110,${(0.18 + v * 0.55).toFixed(3)})`}
                    strokeWidth="1.6"
                  />
                );
              })}
              <circle cx="0" cy="0" r="42" fill="none" stroke="rgba(140,120,255,0.35)" strokeWidth="2" />
              {compassStats.epgBins.map((v, i) => {
                const { a0, a1 } = getWedgeParams(i, compassStats.epgBins.length);
                const r0 = 30;
                const r1 = 30 + v * 14;
                const x0 = Math.cos(a0) * r0; const y0 = Math.sin(a0) * r0;
                const x1 = Math.cos(a1) * r0; const y1 = Math.sin(a1) * r0;
                const x2 = Math.cos(a1) * r1; const y2 = Math.sin(a1) * r1;
                const x3 = Math.cos(a0) * r1; const y3 = Math.sin(a0) * r1;
                const alpha = 0.24 + v * 0.76;
                return (
                  <path
                    key={`bin-${i}`}
                    d={`M ${x0} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`}
                    fill={compassHeatFill(v, alpha)}
                    stroke="rgba(255,220,160,0.55)"
                    strokeWidth="1"
                  />
                );
              })}
              {bumpTheta != null ? (
                <line
                  x1="0"
                  y1="0"
                  x2={(Math.cos(bumpTheta * Math.PI / 180) * 48).toFixed(3)}
                  y2={(-Math.sin(bumpTheta * Math.PI / 180) * 48).toFixed(3)}
                  stroke="#ff4fd8"
                  strokeWidth="2.5"
                />
              ) : null}
            </svg>
            <div style={{ fontSize: 11, opacity: 0.85, maxWidth: 420 }}>
              EPG compass: 16 labeled wedges using processed labels and classification side, arranged anatomically.
              Order is fixed to match the reference slice diagram (top= L5, top-left=R5, right of L5=R4, then L6).
            </div>
          </div>
        ) : null}
        {error ? <div style={{ color: '#f99', fontSize: 12 }}>{error}</div> : null}
      </div>
      <div ref={sceneContainerRef} style={{ minHeight: 0 }} />
    </div>
  );
}
