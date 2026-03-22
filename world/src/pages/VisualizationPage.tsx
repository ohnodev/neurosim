import { type WheelEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import CompactMenu from '../components/CompactMenu';
import { useNotification } from '../contexts/NotificationContext';
import { getApiBase } from '../lib/constants';
import { subscribeNeuroLive, type LiveReplayTick } from '../lib/neuroLiveWsClient';

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

type PenAMetadata = {
  mappingLabel: string;
  penLabel: string;
  hemilineage: string;
  side: string;
  hemibrainType: string;
  x?: number;
  y?: number;
  z?: number;
};

type PenEpgConnection = {
  pen_id: string;
  pen_label: string;
  epg_id: string;
  epg_label?: string;
  weight: number;
  kind: 'excitatory' | 'inhibitory' | 'unsigned_proxy';
  rank: number;
  strength01: number;
  is_proxy_inhibitory?: boolean;
};

function parseCsvLineAll(line: string): string[] {
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
  return out.map((v) => v.trim());
}

/** Per-tick duration in seconds. Prefer meta.dt_sec; else 1ms so 1000 ticks = 1s (replay tick time_sec is often wrong). */
function getReplayDtSec(replay: ReplayData | null): number {
  if (!replay?.ticks?.length) return 0.001;
  const fromMeta = replay.meta?.dt_sec;
  if (typeof fromMeta === 'number' && Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  return 0.001;
}

const HOVER_HIGHLIGHT_COLOR = new THREE.Color(0xffff88);
const HOVER_HIGHLIGHT_GLOW = new THREE.Color(0xffdd44);
const PEN_CONN_EXCIT_FLASH_COLOR = new THREE.Color(0x86f7ff);
const PEN_CONN_INHIBIT_FLASH_COLOR = new THREE.Color(0xff526b);
const PEN_CONN_PROXY_FLASH_COLOR = new THREE.Color(0x9ec5ef);
const PEN_CALCIUM_ACTIVE_COLOR = new THREE.Color(0x4dff9d);
const PEN_CALCIUM_HOT_COLOR = new THREE.Color(0xb8ffd9);
const PEN_CALCIUM_GLOW_COLOR = new THREE.Color(0x48ff9a);

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
  isPenAByIndex: boolean[];
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
  visibility: { epg: boolean; penA: boolean; connections: boolean };
  connectionOpacity: number;
  penControlLabelById: Map<string, string>;
  penHeatByIndex: Float32Array;
  latestSpikeTickById: Map<string, number>;
  lastComputedTick: number;
  lastComputedReplay: ReplayData | null;
  dispose: () => void;
};

type ViewMode = 'biological' | 'compass';
type ReplayDataset = { id: string; label: string; url: string };

const INACTIVE_COLOR = new THREE.Color(0x2e3e5d);
const INACTIVE_RING_COLOR = new THREE.Color(0x6b58a9);
const INACTIVE_EPG_COLOR = new THREE.Color(0x4d6fb6);
const INACTIVE_UPSTREAM_COLOR = new THREE.Color(0x2b4b68);
const INACTIVE_DOWNSTREAM_COLOR = new THREE.Color(0x5a3d2a);
const INACTIVE_DELTA7_COLOR = new THREE.Color(0x5e2b6d);
const INACTIVE_PEN_A_COLOR = new THREE.Color(0x3c4d66);
const HIDDEN_NEURON_COLOR = new THREE.Color(0x1a2435);
const ACTIVE_COLOR = new THREE.Color(0x6eff9e);
const ACTIVE_RING_COLOR = new THREE.Color(0xff4fd8);
const ACTIVE_UPSTREAM_COLOR = new THREE.Color(0x7ad7ff);
const ACTIVE_DOWNSTREAM_COLOR = new THREE.Color(0xffb57a);
const ACTIVE_DELTA7_COLOR = new THREE.Color(0xd08cff);
const EPG_HEAT_ORANGE = new THREE.Color(0xff9f43);
const EPG_HEAT_RED = new THREE.Color(0xff3b30);
const NO_GLOW_COLOR = new THREE.Color(0x000000);
const HORIZONTAL_SCROLL_ROTATE_SPEED = 0.003;
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

function isPenANeuron(neuron: ReplayNeuron): boolean {
  const h = (neuron.hemibrain_type ?? neuron.cell_type ?? '').trim().toUpperCase();
  return h.startsWith('PEN_A');
}

function connectionLineColor(kind: 'excitatory' | 'inhibitory' | 'unsigned_proxy', strength01: number): THREE.Color {
  const t = Math.max(0, Math.min(1, Number.isFinite(strength01) ? strength01 : 0));
  const weak = new THREE.Color(0x77808f);
  const strong = kind === 'inhibitory'
    ? new THREE.Color(0xff5b77)
    : kind === 'unsigned_proxy'
      ? new THREE.Color(0xa7c3e8)
      : new THREE.Color(0x48e2ff);
  return weak.lerp(strong, t);
}

function buildTemplateNeuronsFromStaticCsv(text: string): ReplayNeuron[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLineAll(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const iId = idx('neuron_id');
  const iGroup = idx('group');
  const iProcessed = idx('processed_label');
  const iHb = idx('hemibrain_type');
  const iSide = idx('side');
  const iHemi = idx('hemilineage');
  const iX = idx('x');
  const iY = idx('y');
  const iZ = idx('z');
  if (iId < 0 || iX < 0 || iY < 0 || iZ < 0) return [];
  const out: ReplayNeuron[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLineAll(lines[i]);
    const rootId = (cols[iId] ?? '').replace(/^"|"$/g, '').trim();
    if (!rootId) continue;
    const x = Number((cols[iX] ?? '').replace(/^"|"$/g, '').trim());
    const y = Number((cols[iY] ?? '').replace(/^"|"$/g, '').trim());
    const z = Number((cols[iZ] ?? '').replace(/^"|"$/g, '').trim());
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const group = (cols[iGroup] ?? '').replace(/^"|"$/g, '').trim().toUpperCase();
    const hemibrainType = (cols[iHb] ?? '').replace(/^"|"$/g, '').trim();
    const processedLabel = (cols[iProcessed] ?? '').replace(/^"|"$/g, '').trim();
    out.push({
      root_id: rootId,
      x,
      y,
      z,
      processed_label: processedLabel || hemibrainType,
      is_ring: group === 'EPG',
      is_epg: group === 'EPG',
      side: ((cols[iSide] ?? '').replace(/^"|"$/g, '').trim() || 'unknown'),
      hemibrain_type: hemibrainType,
      cell_type: hemibrainType,
      hemilineage: (cols[iHemi] ?? '').replace(/^"|"$/g, '').trim(),
    });
  }
  return out;
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
const PEN_ACTIVITY_WINDOW_SEC = 0.12;
const PEN_ACTIVITY_REF_HZ = 500;
const PEN_CALCIUM_WINDOW_SEC = 0.35;
const PEN_CALCIUM_DECAY_SEC = 0.11;
const PEN_CALCIUM_GAIN = 0.45;
const PEN_CONN_PROPAGATION_MIN_SEC = 0.002;
const PEN_CONN_PROPAGATION_MAX_SEC = 0.009;
const PEN_COMPASS_Z_OFFSET_BASE = 0.03;
const PEN_COMPASS_Z_OFFSET_ALT = 0.018;
const PEN_COMPASS_NORMALIZED_Z_ALT = 0.12;
const COMPASS_ARROW_RADIUS = 18;
const COMPASS_VIEWBOX_HALF = 60;
const SCENE_BUMP_ARROW_LENGTH = COMPASS_ARROW_RADIUS / COMPASS_VIEWBOX_HALF;
const DELTA7_OPPOSITE_INHIBIT_WEIGHT = 0.55;
const EPG_INACTIVE_BIN_PENALTY = 0.35;
const SHOW_BIOLOGICAL_EPG_COPY = false;
/** If a bin has this fraction of its EPG population active (in window), we point the arrow at that bin center (clear bump signal). */
const EPG_DOMINANT_BIN_THRESHOLD = 0.8;
const PREFERRED_REPLAY_ID = 'neurosim_live';
const DEFAULT_REPLAY_DATASETS: ReplayDataset[] = [
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

const WEBGL_DISABLED_HINT =
  '3D rendering is unavailable in this browser (WebGL disabled). Try Firefox or re-enable Chrome hardware acceleration.';

function canUseWebGLContext(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2', { antialias: false });
    if (gl2) return true;
    const gl =
      canvas.getContext('webgl', { antialias: false }) ||
      canvas.getContext('experimental-webgl', { antialias: false });
    return gl != null;
  } catch {
    return false;
  }
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
  visibility: { epg: boolean; penA: boolean; connections: boolean },
  connectionOpacity: number,
  penEpgConnections: PenEpgConnection[],
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
  const onWheelRotate = (event: globalThis.WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    if (Math.abs(event.deltaX) < 0.5) return;
    controls.rotateLeft(event.deltaX * HORIZONTAL_SCROLL_ROTATE_SPEED);
    controls.update();
    event.preventDefault();
  };
  renderer.domElement.addEventListener('wheel', onWheelRotate, { passive: false });

  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  let compassCenter: { x: number; y: number; z: number } | null = null;
  let compassBaseRadius: number | null = null;
  const aligned = computeAlignedPoints(neurons, viewMode !== 'biological');
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
      const penLeftIndices: number[] = [];
      const penRightIndices: number[] = [];
      for (let i = 0; i < neurons.length; i += 1) {
        const n = neurons[i]!;
        if (n.is_epg) continue;
        if (isPenANeuron(n)) {
          if ((n.side ?? '').toLowerCase() === 'left') penLeftIndices.push(i);
          else penRightIndices.push(i);
          continue;
        }
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
      penLeftIndices.sort((a, b) => (neurons[a]?.root_id ?? '').localeCompare(neurons[b]?.root_id ?? ''));
      penRightIndices.sort((a, b) => (neurons[a]?.root_id ?? '').localeCompare(neurons[b]?.root_id ?? ''));
      const penRadius = baseRadius * 2.05;
      // Left PEN_a on left semicircle (90deg -> 270deg), right PEN_a on right semicircle (-90deg -> 90deg).
      for (let i = 0; i < penLeftIndices.length; i += 1) {
        const idx = penLeftIndices[i]!;
        const t = penLeftIndices.length <= 1 ? 0.5 : i / (penLeftIndices.length - 1);
        const angle = (Math.PI * 0.5) + (Math.PI * t);
        aligned[idx]!.x = cxCompass + Math.cos(angle) * penRadius;
        aligned[idx]!.y = cyCompass + Math.sin(angle) * penRadius;
        const zAlt = i % 2 === 0 ? PEN_COMPASS_Z_OFFSET_ALT : -PEN_COMPASS_Z_OFFSET_ALT;
        aligned[idx]!.z = czCompass + PEN_COMPASS_Z_OFFSET_BASE + zAlt;
      }
      for (let i = 0; i < penRightIndices.length; i += 1) {
        const idx = penRightIndices[i]!;
        const t = penRightIndices.length <= 1 ? 0.5 : i / (penRightIndices.length - 1);
        const angle = (-Math.PI * 0.5) + (Math.PI * t);
        aligned[idx]!.x = cxCompass + Math.cos(angle) * penRadius;
        aligned[idx]!.y = cyCompass + Math.sin(angle) * penRadius;
        const zAlt = i % 2 === 0 ? PEN_COMPASS_Z_OFFSET_ALT : -PEN_COMPASS_Z_OFFSET_ALT;
        aligned[idx]!.z = czCompass + PEN_COMPASS_Z_OFFSET_BASE + zAlt;
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
  const isPenAByIndex: boolean[] = new Array(n).fill(false);
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
    isPenAByIndex[i] = isPenANeuron(neuron);
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
      ? (visibility.epg ? INACTIVE_EPG_COLOR.clone().multiplyScalar(0.42) : HIDDEN_NEURON_COLOR)
      : isPenANeuron(neuron)
        ? (visibility.penA ? INACTIVE_PEN_A_COLOR : HIDDEN_NEURON_COLOR)
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
  if (viewMode === 'compass') {
    const penCompassIndices: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (isPenAByIndex[i]) penCompassIndices.push(i);
    }
    // Alternate PEN_a depth in rendered (normalized) space so rings are visibly de-planarized.
    penCompassIndices.sort((a, b) => {
      const aa = Math.atan2(positions[a * 3 + 1]!, positions[a * 3]!);
      const bb = Math.atan2(positions[b * 3 + 1]!, positions[b * 3]!);
      return aa - bb;
    });
    for (let k = 0; k < penCompassIndices.length; k += 1) {
      const idx = penCompassIndices[k]!;
      const zAlt = k % 2 === 0 ? PEN_COMPASS_NORMALIZED_Z_ALT : -PEN_COMPASS_NORMALIZED_Z_ALT;
      positions[idx * 3 + 2] += zAlt;
    }
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
  let penEpgConnectionLines: THREE.LineSegments | null = null;
  let penEpgLineColorAttr: THREE.BufferAttribute | null = null;
  let penEpgLineBaseColors: Float32Array | null = null;
  const penEpgRenderableLinks: Array<{
    penId: string;
    kind: 'excitatory' | 'inhibitory' | 'unsigned_proxy';
    strength01: number;
    from: [number, number, number];
    to: [number, number, number];
    colorOffset: number;
  }> = [];
  let penPulsePoints: THREE.Points | null = null;
  let penPulsePositionAttr: THREE.BufferAttribute | null = null;
  let penPulseColorAttr: THREE.BufferAttribute | null = null;
  if (penEpgConnections.length > 0) {
    const lineVertices: number[] = [];
    const lineColors: number[] = [];
    for (const link of penEpgConnections) {
      const penIdx = idToIndex.get(link.pen_id);
      const epgIdx = idToIndex.get(link.epg_id);
      if (penIdx == null || epgIdx == null) continue;
      const px = positions[penIdx * 3]!;
      const py = positions[penIdx * 3 + 1]!;
      const pz = positions[penIdx * 3 + 2]!;
      const ex = positions[epgIdx * 3]!;
      const ey = positions[epgIdx * 3 + 1]!;
      const ez = positions[epgIdx * 3 + 2]!;
      lineVertices.push(px, py, pz, ex, ey, ez);
      const c = connectionLineColor(link.kind, link.strength01);
      lineColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      penEpgRenderableLinks.push({
        penId: link.pen_id,
        kind: link.kind,
        strength01: Math.max(0, Math.min(1, link.strength01)),
        from: [px, py, pz],
        to: [ex, ey, ez],
        colorOffset: (lineVertices.length / 3 - 2) * 3,
      });
    }
    if (lineVertices.length >= 6) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lineVertices, 3));
      lineGeometry.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
      const lineColorAttr = lineGeometry.getAttribute('color');
      if (lineColorAttr instanceof THREE.BufferAttribute) {
        penEpgLineColorAttr = lineColorAttr;
        penEpgLineBaseColors = new Float32Array(lineColorAttr.array as ArrayLike<number>);
      }
      penEpgConnectionLines = new THREE.LineSegments(
        lineGeometry,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.74,
          depthTest: true,
        }),
      );
      scene.add(penEpgConnectionLines);

      const pulseGeometry = new THREE.BufferGeometry();
      const pulsePositions = new Float32Array(penEpgRenderableLinks.length * 3);
      const pulseColors = new Float32Array(penEpgRenderableLinks.length * 3);
      penPulsePositionAttr = new THREE.BufferAttribute(pulsePositions, 3);
      penPulseColorAttr = new THREE.BufferAttribute(pulseColors, 3);
      pulseGeometry.setAttribute('position', penPulsePositionAttr);
      pulseGeometry.setAttribute('color', penPulseColorAttr);
      pulseGeometry.setDrawRange(0, 0);
      const pulseMaterial = new THREE.PointsMaterial({
        size: 0.024,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      });
      penPulsePoints = new THREE.Points(pulseGeometry, pulseMaterial);
      scene.add(penPulsePoints);
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
    let pickedIndex: number | null = null;
    for (const hit of hits) {
      if (hit?.index == null) continue;
      const idx = hit.index as number;
      if (idx < 0 || idx >= n) continue;
      if (isEpgByIndex[idx] && !state.visibility.epg) continue;
      if (isPenAByIndex[idx] && !state.visibility.penA) continue;
      pickedIndex = idx;
      break;
    }
    if (pickedIndex == null) {
      hoveredNeuronId.current = null;
      onHover?.(null);
      hoverTooltip.style.display = 'none';
      return;
    }
    const idx = pickedIndex;
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
      const penControlLabel = isPenANeuron(neuron) ? state.penControlLabelById.get(neuron.root_id) : undefined;
      if (penControlLabel) lines.push('pen_label: ' + penControlLabel);
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
  bumpArrow.visible = viewMode !== 'biological';
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
    isPenAByIndex,
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
    visibility: { ...visibility },
    connectionOpacity,
    penControlLabelById: new Map<string, string>(),
    penHeatByIndex: new Float32Array(colorAttr.count),
    latestSpikeTickById: new Map<string, number>(),
    lastComputedTick: -1,
    lastComputedReplay: null,
    dispose: () => {},
  };

  let raf = 0;
  const animate = () => {
    const now = performance.now() / 1000;
    state.lastFrameTime = now;
    const currentVisibility = state.visibility;
    const currentConnectionOpacity = Math.max(0, Math.min(1, state.connectionOpacity));
    if (connectionLines) {
      connectionLines.visible = currentVisibility.connections;
      const mat = connectionLines.material as THREE.LineBasicMaterial;
      mat.opacity = 0.6 * currentConnectionOpacity;
    }
    if (penEpgConnectionLines) {
      penEpgConnectionLines.visible = currentVisibility.connections && currentVisibility.epg && currentVisibility.penA;
      const mat = penEpgConnectionLines.material as THREE.LineBasicMaterial;
      mat.opacity = 0.74 * currentConnectionOpacity;
    }
    if (penPulsePoints) {
      penPulsePoints.visible = currentVisibility.connections && currentVisibility.epg && currentVisibility.penA;
      const mat = penPulsePoints.material as THREE.PointsMaterial;
      mat.opacity = 0.95 * currentConnectionOpacity;
    }
    /** Compute brightness purely from replay + currentTick. No React state, no accumulation.
     * Neuron lit for SPIKE_DISPLAY_TICKS after spike; brightness = 1 - (ticks_ago / SPIKE_DISPLAY_TICKS). */
    const replay = state.replay;
    const currentTick = state.currentTick;
    if (state.brightnessByIndex.length !== colorAttr.count) {
      state.brightnessByIndex = new Float32Array(colorAttr.count);
    }
    if (state.penHeatByIndex.length !== colorAttr.count) {
      state.penHeatByIndex = new Float32Array(colorAttr.count);
    }
    const brightnessByIndex = state.brightnessByIndex;
    const penHeatByIndex = state.penHeatByIndex;
    const latestSpikeTickById = state.latestSpikeTickById;
    const shouldRecompute =
      state.lastComputedTick !== currentTick
      || state.lastComputedReplay !== replay;
    if (shouldRecompute) {
      brightnessByIndex.fill(0);
      penHeatByIndex.fill(0);
      latestSpikeTickById.clear();
    }
    if (shouldRecompute && replay?.ticks?.length && currentTick >= 1) {
      const startTick = Math.max(1, currentTick - SPIKE_DISPLAY_TICKS);
      for (let t = currentTick; t >= startTick && t >= 1; t -= 1) {
        for (const id of replay.ticks[t - 1]?.spikes ?? []) {
          if (!latestSpikeTickById.has(id)) latestSpikeTickById.set(id, t);
        }
      }
      for (const [id, spikeTick] of latestSpikeTickById) {
        const idx = idToIndex.get(id);
        if (idx != null && idx < colorAttr.count) {
          const ticksAgo = currentTick - spikeTick;
          const b = Math.max(0, 1 - ticksAgo / SPIKE_DISPLAY_TICKS);
          if (b > (brightnessByIndex[idx] ?? 0)) brightnessByIndex[idx] = b;
        }
      }
      const dtSec = Math.max(0.0001, getReplayDtSec(replay));
      const calciumWindowTicks = Math.max(1, Math.floor(PEN_CALCIUM_WINDOW_SEC / dtSec));
      const calciumDecayTicks = Math.max(1, PEN_CALCIUM_DECAY_SEC / dtSec);
      const calciumStartTick = Math.max(1, currentTick - calciumWindowTicks + 1);
      for (let t = calciumStartTick; t <= currentTick; t += 1) {
        const age = currentTick - t;
        const decay = Math.exp(-age / calciumDecayTicks);
        for (const id of replay.ticks[t - 1]?.spikes ?? []) {
          const idx = idToIndex.get(id);
          if (idx == null || !state.isPenAByIndex[idx]) continue;
          penHeatByIndex[idx] += decay;
        }
      }
      for (let i = 0; i < penHeatByIndex.length; i += 1) {
        const v = penHeatByIndex[i];
        if (v > 0) {
          penHeatByIndex[i] = 1 - Math.exp(-v * PEN_CALCIUM_GAIN);
        }
      }
      state.lastComputedTick = currentTick;
      state.lastComputedReplay = replay;
    } else if (shouldRecompute) {
      state.lastComputedTick = currentTick;
      state.lastComputedReplay = replay;
    }
    const { tempC, tempG, tempEpgInactive, tempEpgHot } = state;
    for (let i = 0; i < colorAttr.count; i += 1) {
      const t = brightnessByIndex[i] ?? 0;
      if (isEpgByIndex[i]) {
        if (!currentVisibility.epg) {
          tempC.copy(HIDDEN_NEURON_COLOR);
        } else {
        tempEpgInactive.copy(INACTIVE_EPG_COLOR).multiplyScalar(0.42);
        if (t <= 0) {
          tempC.copy(tempEpgInactive);
        } else {
          tempEpgHot.copy(tempEpgInactive).lerp(EPG_HEAT_ORANGE, 0.45).lerp(EPG_HEAT_RED, t);
          tempC.copy(tempEpgInactive).lerp(tempEpgHot, t);
        }
        }
      } else if (state.isPenAByIndex[i]) {
        if (!currentVisibility.penA) {
          tempC.copy(HIDDEN_NEURON_COLOR);
        } else {
          const penHeat = Math.max(t, penHeatByIndex[i] ?? 0);
          tempC.copy(INACTIVE_PEN_A_COLOR);
          if (penHeat > 0) {
            tempC.lerp(PEN_CALCIUM_ACTIVE_COLOR, penHeat);
            if (penHeat > 0.65) {
              tempC.lerp(PEN_CALCIUM_HOT_COLOR, (penHeat - 0.65) / 0.35);
            }
          }
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
      if (isEpgByIndex[i] && t > 0) {
        tempG.copy(INACTIVE_EPG_COLOR).lerp(EPG_HEAT_RED, t).multiplyScalar(0.22 + 1.1 * t * t);
      } else if (state.isPenAByIndex[i] && currentVisibility.penA) {
        const penHeat = Math.max(t, penHeatByIndex[i] ?? 0);
        if (penHeat > 0) {
          tempG.copy(PEN_CALCIUM_GLOW_COLOR).multiplyScalar(0.12 + 0.85 * penHeat * penHeat);
        } else {
          tempG.copy(NO_GLOW_COLOR);
        }
      } else {
        tempG.copy(NO_GLOW_COLOR);
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
    bumpArrow.setLength(SCENE_BUMP_ARROW_LENGTH, 0.07, 0.035);
    bumpArrow.setColor(ACTIVE_RING_COLOR);
    const hoveredId = hoveredNeuronId?.current ?? null;
    if (hoveredId != null) {
      const mainIdx = idToIndex.get(hoveredId);
      if (mainIdx != null && mainIdx < colorAttr.count) {
        colorAttr.setXYZ(mainIdx, HOVER_HIGHLIGHT_COLOR.r, HOVER_HIGHLIGHT_COLOR.g, HOVER_HIGHLIGHT_COLOR.b);
        glowColorAttr.setXYZ(mainIdx, HOVER_HIGHLIGHT_GLOW.r, HOVER_HIGHLIGHT_GLOW.g, HOVER_HIGHLIGHT_GLOW.b);
      }
    }
    if (penEpgLineColorAttr && penEpgLineBaseColors && penEpgRenderableLinks.length > 0 && currentVisibility.connections && currentVisibility.epg && currentVisibility.penA) {
      const lineColorArray = penEpgLineColorAttr.array as Float32Array;
      lineColorArray.set(penEpgLineBaseColors);
      let activePulseCount = 0;
      const dtSec = replay ? Math.max(0.0001, getReplayDtSec(replay)) : 0.001;
      const pulsePosArray = penPulsePositionAttr?.array as Float32Array | undefined;
      const pulseColorArray = penPulseColorAttr?.array as Float32Array | undefined;
      for (const link of penEpgRenderableLinks) {
        const spikeTick = latestSpikeTickById.get(link.penId);
        if (spikeTick == null) continue;
        const ageTicks = currentTick - spikeTick;
        if (ageTicks < 0) continue;
        const durationSec = PEN_CONN_PROPAGATION_MIN_SEC + (PEN_CONN_PROPAGATION_MAX_SEC - PEN_CONN_PROPAGATION_MIN_SEC) * link.strength01;
        const durationTicks = Math.max(1, Math.floor(durationSec / dtSec));
        if (ageTicks > durationTicks) continue;
        const progress = Math.max(0, Math.min(1, ageTicks / durationTicks));
        const envelope = Math.pow(1 - progress, 0.55) * (0.2 + 0.8 * link.strength01);
        const flash = link.kind === 'inhibitory'
          ? PEN_CONN_INHIBIT_FLASH_COLOR
          : link.kind === 'unsigned_proxy'
            ? PEN_CONN_PROXY_FLASH_COLOR
            : PEN_CONN_EXCIT_FLASH_COLOR;
        const o = link.colorOffset;
        for (let k = 0; k < 2; k += 1) {
          const baseIndex = o + k * 3;
          lineColorArray[baseIndex] = penEpgLineBaseColors[baseIndex]! + (flash.r - penEpgLineBaseColors[baseIndex]!) * envelope;
          lineColorArray[baseIndex + 1] = penEpgLineBaseColors[baseIndex + 1]! + (flash.g - penEpgLineBaseColors[baseIndex + 1]!) * envelope;
          lineColorArray[baseIndex + 2] = penEpgLineBaseColors[baseIndex + 2]! + (flash.b - penEpgLineBaseColors[baseIndex + 2]!) * envelope;
        }
        if (pulsePosArray && pulseColorArray && activePulseCount < penEpgRenderableLinks.length) {
          const px = link.from[0] + (link.to[0] - link.from[0]) * progress;
          const py = link.from[1] + (link.to[1] - link.from[1]) * progress;
          const pz = link.from[2] + (link.to[2] - link.from[2]) * progress;
          const po = activePulseCount * 3;
          pulsePosArray[po] = px;
          pulsePosArray[po + 1] = py;
          pulsePosArray[po + 2] = pz;
          pulseColorArray[po] = flash.r * envelope;
          pulseColorArray[po + 1] = flash.g * envelope;
          pulseColorArray[po + 2] = flash.b * envelope;
          activePulseCount += 1;
        }
      }
      penEpgLineColorAttr.needsUpdate = true;
      if (penPulsePositionAttr && penPulseColorAttr && penPulsePoints) {
        penPulsePositionAttr.needsUpdate = true;
        penPulseColorAttr.needsUpdate = true;
        (penPulsePoints.geometry as THREE.BufferGeometry).setDrawRange(0, activePulseCount);
      }
    } else if (penPulsePoints) {
      (penPulsePoints.geometry as THREE.BufferGeometry).setDrawRange(0, 0);
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
    renderer.domElement.removeEventListener('wheel', onWheelRotate);
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
    if (penEpgConnectionLines != null) {
      scene.remove(penEpgConnectionLines);
      penEpgConnectionLines.geometry.dispose();
      (penEpgConnectionLines.material as THREE.Material).dispose();
    }
    if (penPulsePoints != null) {
      scene.remove(penPulsePoints);
      penPulsePoints.geometry.dispose();
      (penPulsePoints.material as THREE.Material).dispose();
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
const NEUROSIM_LIVE_MAX_STORED_TICKS = 100_000;
const NEUROSIM_RECORDING_MAX_STORED_TICKS = 300_000;

export default function VisualizationPage() {
  const [fetchedReplay, setFetchedReplay] = useState<ReplayData | null>(null);
  const [templateReplay, setTemplateReplay] = useState<ReplayData | null>(null);
  const [liveReplay, setLiveReplay] = useState<ReplayData | null>(null);
  const [liveTicks, setLiveTicks] = useState<ReplayTick[]>([]);
  const liveTicksRef = useRef<ReplayTick[]>([]);
  const [liveTicksVersion, setLiveTicksVersion] = useState(0);
  const [recordedTicks, setRecordedTicks] = useState<ReplayTick[]>([]);
  const liveReplayTickCountRef = useRef(0);
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
  const [penANeurons, setPenANeurons] = useState<{ left: Array<{ id: string; label: string }>; right: Array<{ id: string; label: string }> }>({ left: [], right: [] });
  const [penARatesById, setPenARatesById] = useState<Record<string, number>>({});
  const [penAMetadataById, setPenAMetadataById] = useState<Record<string, PenAMetadata>>({});
  const [penASpikeStrengthById, setPenASpikeStrengthById] = useState<Record<string, number>>({});
  const [penEpgConnections, setPenEpgConnections] = useState<PenEpgConnection[]>([]);
  const [showPenAMapping, setShowPenAMapping] = useState(false);
  const [copiedPenAId, setCopiedPenAId] = useState<string | null>(null);
  const copyInFlightRef = useRef(false);
  const copyTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const [showCompassInfo, setShowCompassInfo] = useState(false);
  const [showLegendPopover, setShowLegendPopover] = useState(false);
  const [legendVisibility, setLegendVisibility] = useState({ epg: true, penA: true, connections: true });
  const [connectionOpacity, setConnectionOpacity] = useState(0.74);
  const [showRecordMenu, setShowRecordMenu] = useState(false);
  const [bottomControlTab, setBottomControlTab] = useState<'individual' | 'sliders'>('individual');
  const [rightPanelTab, setRightPanelTab] = useState<'mapping' | 'compass'>('mapping');
  const notification = useNotification();
  const liveAfterTickRef = useRef(0);
  const recordingRef = useRef(false);
  useEffect(() => {
    liveTicksRef.current = liveTicks;
  }, [liveTicks]);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      copyInFlightRef.current = false;
      if (copyTimeoutRef.current != null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  const [currentTick, setCurrentTick] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>('compass');
  const selectedReplayId: string = PREFERRED_REPLAY_ID;
  const replay = useMemo(
    () =>
      selectedReplayId === 'neurosim_live'
        ? liveReplay
        : selectedReplayId === 'world_record'
          ? fetchedReplay ?? templateReplay
          : fetchedReplay,
    [selectedReplayId, liveReplay, fetchedReplay, templateReplay],
  );
  const arrowSmoothing = true;
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
  const [sceneError, setSceneError] = useState<string | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const legendPopoverRef = useRef<HTMLDivElement | null>(null);
  const legendTriggerRef = useRef<HTMLButtonElement | null>(null);

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
  const penControlLabelById = useMemo(() => {
    const out = new Map<string, string>();
    for (const { id, label } of penANeurons.left) out.set(id, label);
    for (const { id, label } of penANeurons.right) out.set(id, label);
    for (const [id, metadata] of Object.entries(penAMetadataById)) {
      if (!out.has(id) && metadata.mappingLabel) out.set(id, metadata.mappingLabel);
    }
    return out;
  }, [penANeurons.left, penANeurons.right, penAMetadataById]);
  const selectedReplay = DEFAULT_REPLAY_DATASETS[0];

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
    let cancelled = false;
    fetch('/pen_a_epg_top_connections.json?v=' + Date.now(), { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return null;
        const parsed = (await res.json()) as { connections?: PenEpgConnection[] } | null;
        return parsed;
      })
      .then((parsed) => {
        if (cancelled) return;
        const rows = Array.isArray(parsed?.connections) ? parsed!.connections : [];
        const valid = rows.filter((row) =>
          typeof row?.pen_id === 'string'
          && typeof row?.epg_id === 'string'
          && Number.isFinite(row?.weight)
          && Number.isFinite(row?.strength01)
          && (row!.strength01 >= 0 && row!.strength01 <= 1)
          && (row?.kind === 'excitatory' || row?.kind === 'inhibitory' || row?.kind === 'unsigned_proxy'));
        setPenEpgConnections(valid);
      })
      .catch(() => {
        if (!cancelled) setPenEpgConnections([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setError(null);
        const datasetUrl = selectedReplay?.url;
        if (!datasetUrl) throw new Error('No replay dataset selected');
        const isNeuroSimLive = selectedReplay?.id === 'neurosim_live' || datasetUrl.startsWith('/api/neurosim-replay');
        const isWorldRecord = selectedReplay?.id === 'world_record' || datasetUrl === 'world_record';
        if (isNeuroSimLive) {
          const nodeRes = await fetch('/neurosim_visualization_nodes.csv?v=' + Date.now(), { cache: 'no-store' });
          if (!nodeRes.ok) throw new Error(`Failed to load live node template (${nodeRes.status})`);
          const nodeCsv = await nodeRes.text();
          const templateNeurons = buildTemplateNeuronsFromStaticCsv(nodeCsv);
          if (templateNeurons.length === 0) throw new Error('Live node template CSV is empty');
          if (!active) return;
          setTemplateReplay({
            meta: {
              generated_at: new Date().toISOString(),
              source_csv: 'public:neurosim_visualization_nodes.csv',
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
          liveReplayTickCountRef.current = 0;
          liveEpgSeenRef.current = new Set();
          setLiveEpgUniqueFired(0);
        } else if (isWorldRecord) {
          const nodeRes = await fetch('/neurosim_visualization_nodes.csv?v=' + Date.now(), { cache: 'no-store' });
          if (!nodeRes.ok) throw new Error(`Failed to load node template (${nodeRes.status})`);
          const nodeCsv = await nodeRes.text();
          const templateNeurons = buildTemplateNeuronsFromStaticCsv(nodeCsv);
          if (templateNeurons.length === 0) throw new Error('Node template CSV is empty');
          if (!active) return;
          setTemplateReplay({
            meta: {
              generated_at: new Date().toISOString(),
              source_csv: 'public:neurosim_visualization_nodes.csv',
              ticks: 0,
              unique_fired_neurons: 0,
              ring_neuron_total: 0,
              ring_neuron_unique_fired: 0,
              dt_sec: 0.0008,
              scenario: 'world_record',
            },
            neurons: templateNeurons,
            ticks: [],
          });
          setFetchedReplay(null);
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
      } catch (err) {
        if (!active) return;
        setFetchedReplay(null);
        setTemplateReplay(null);
        liveReplayRef.current = null;
        setLiveReplay(null);
        setLiveTicks([]);
        setRecordedTicks([]);
        liveReplayTickCountRef.current = 0;
        liveEpgSeenRef.current = new Set();
        setLiveEpgUniqueFired(0);
        liveAfterTickRef.current = 0;
        setCurrentTick(0);
        setError((err as Error).message);
      }
    };
    void load();
    return () => { active = false; };
  }, [selectedReplay]);

  useEffect(() => {
    if (selectedReplayId !== 'neurosim_live' || !templateReplay) {
      liveReplayTickCountRef.current = 0;
      liveReplayRef.current = null;
      liveEpgSeenRef.current = new Set();
      setLiveEpgUniqueFired(0);
      setLiveReplay(null);
      return;
    }
    const ticks = liveTicksRef.current;
    const current = liveReplayRef.current;
    const replayMissing = current == null;
    const tickReset = ticks.length < liveReplayTickCountRef.current;
    const dtChanged = (current?.meta.dt_sec ?? liveSettings.dtSec) !== liveSettings.dtSec;
    const fullRebuild = replayMissing || tickReset || dtChanged;
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
  }, [selectedReplayId, templateReplay, liveTicks.length, liveTicksVersion, liveSettings.dtSec, epgLabelMap]);

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
    if (!isNeuroSimLive) return;
    let cancelled = false;
    fetch('/pen_a_neuron_metadata.csv?v=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (cancelled || !text) return;
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
        if (lines.length < 2) return;
        const header = parseCsvLineAll(lines[0]);
        const iId = header.indexOf('neuron_id');
        const iPen = header.indexOf('pen_label');
        const iHemilineage = header.indexOf('hemilineage');
        const iSide = header.indexOf('side');
        const iType = header.indexOf('hemibrain_type');
        if (iId < 0) return;
        const next: Record<string, PenAMetadata> = {};
        for (let i = 1; i < lines.length; i += 1) {
          const cols = parseCsvLineAll(lines[i]);
          const id = (cols[iId] ?? '').replace(/^"|"$/g, '').trim();
          if (!id) continue;
          const toNum = (s: string | undefined) => {
            const n = Number((s ?? '').replace(/^"|"$/g, '').trim());
            return Number.isFinite(n) ? n : undefined;
          };
          const iMapLabel = header.indexOf('mapping_label');
          const iX = header.indexOf('x');
          const iY = header.indexOf('y');
          const iZ = header.indexOf('z');
          next[id] = {
            mappingLabel: (cols[iMapLabel] ?? '').replace(/^"|"$/g, '').trim(),
            penLabel: (cols[iPen] ?? '').replace(/^"|"$/g, '').trim(),
            hemilineage: (cols[iHemilineage] ?? '').replace(/^"|"$/g, '').trim(),
            side: (cols[iSide] ?? '').replace(/^"|"$/g, '').trim(),
            hemibrainType: (cols[iType] ?? '').replace(/^"|"$/g, '').trim(),
            x: toNum(cols[iX]),
            y: toNum(cols[iY]),
            z: toNum(cols[iZ]),
          };
        }
        if (!cancelled) setPenAMetadataById(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isNeuroSimLive]);

  

  useEffect(() => {
    const ids = [...penANeurons.left.map((n) => n.id), ...penANeurons.right.map((n) => n.id)];
    if (!replay || ids.length === 0 || replay.ticks.length === 0) {
      setPenASpikeStrengthById({});
      return;
    }
    const idSet = new Set(ids);
    const endIdx = Math.max(0, Math.min(replay.ticks.length - 1, currentTick - 1));
    const dtSec = Math.max(0.0001, getReplayDtSec(replay));
    const windowTicks = Math.max(120, Math.floor(PEN_ACTIVITY_WINDOW_SEC / dtSec));
    const startIdx = Math.max(0, endIdx - windowTicks + 1);
    const counts: Record<string, number> = {};
    for (let i = startIdx; i <= endIdx; i += 1) {
      for (const id of replay.ticks[i]?.spikes ?? []) {
        if (!idSet.has(id)) continue;
        counts[id] = (counts[id] ?? 0) + 1;
      }
    }
    const ticksObserved = Math.max(1, endIdx - startIdx + 1);
    const expectedAtRefHz = Math.max(1, ticksObserved * dtSec * PEN_ACTIVITY_REF_HZ);
    const normalized: Record<string, number> = {};
    for (const id of ids) {
      normalized[id] = Math.max(0, Math.min(1, (counts[id] ?? 0) / expectedAtRefHz));
    }
    setPenASpikeStrengthById(normalized);
  }, [replay, currentTick, penANeurons.left, penANeurons.right]);

  useEffect(() => {
    if (!isNeuroSimLive || !templateReplay) return;
    setError(null);
    const unsubscribe = subscribeNeuroLive((event) => {
      if (event.type === 'error') {
        setError(event.error);
        return;
      }
      if (event.type === 'status') {
        setError(null);
        const prevLiveAfter = liveAfterTickRef.current;
        const latest = Math.max(0, Math.floor(event.latestTick ?? 0));
        liveAfterTickRef.current = latest;
        setAppliedPenLeft(event.penALeftHz ?? 0);
        setAppliedPenRight(event.penARightHz ?? 0);
        setPenALeftHz(event.penALeftHz ?? 0);
        setPenARightHz(event.penARightHz ?? 0);
        if (event.ratesById && typeof event.ratesById === 'object') {
          setPenARatesById(event.ratesById);
        } else {
          setPenARatesById({});
        }
        if (typeof event.dtSec === 'number' && event.dtSec > 0) {
          setLiveSettings({ dtSec: event.dtSec });
        }
        if (latest < prevLiveAfter) {
          liveTicksRef.current = [];
          setLiveTicks([]);
          setRecordedTicks([]);
        }
        return;
      }
      if (typeof event.dtSec === 'number' && event.dtSec > 0) {
        setError(null);
        setLiveSettings({ dtSec: event.dtSec });
      }
      const batch = (event.ticks ?? []) as LiveReplayTick[];
      if (batch.length === 0) return;
      setError(null);
      const last = batch[batch.length - 1]?.tick;
      if (typeof last === 'number') liveAfterTickRef.current = last;
      const prev = liveTicksRef.current;
      const merged = [...prev, ...batch as ReplayTick[]];
      const trimmed = merged.length > NEUROSIM_LIVE_MAX_STORED_TICKS;
      const next = trimmed ? merged.slice(-NEUROSIM_LIVE_MAX_STORED_TICKS) : merged;
      liveTicksRef.current = next;
      setLiveTicks(next);
      if (trimmed && next.length === prev.length) {
        setLiveTicksVersion((v) => v + 1);
      }
      if (recordingRef.current) {
        setRecordedTicks((prev) => {
          const merged = [...prev, ...batch as ReplayTick[]];
          if (merged.length > NEUROSIM_RECORDING_MAX_STORED_TICKS) {
            return merged.slice(-NEUROSIM_RECORDING_MAX_STORED_TICKS);
          }
          return merged;
        });
      }
    });
    return () => {
      unsubscribe();
    };
  }, [isNeuroSimLive, templateReplay]);

  useEffect(() => {
    if (!replay?.ticks.length || !isNeuroSimLive) return;
    setCurrentTick(replay.ticks.length);
  }, [replay, replay?.ticks.length, isNeuroSimLive]);

  useEffect(() => {
    const container = sceneContainerRef.current;
    if (!container || displayNeurons.length === 0) return;
    if (sceneRef.current) {
      sceneRef.current.dispose();
      sceneRef.current = null;
    }
    if (!canUseWebGLContext()) {
      setSceneError(WEBGL_DISABLED_HINT);
      return;
    }
    setSceneError(null);
    try {
      sceneRef.current = buildScene(
        container,
        displayNeurons,
        viewMode,
        { epg: legendVisibility.epg, penA: legendVisibility.penA, connections: legendVisibility.connections },
        connectionOpacity,
        penEpgConnections,
        undefined,
        epgLabelMap,
        replay ?? null,
      );
    } catch (err) {
      console.error('[VisualizationPage] scene initialization failed', err);
      setSceneError(WEBGL_DISABLED_HINT);
    }
    return () => {
      if (sceneRef.current) {
        sceneRef.current.dispose();
        sceneRef.current = null;
      }
    };
  }, [displayNeurons, viewMode, epgLabelMap, penEpgConnections]);

  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.penControlLabelById = penControlLabelById;
  }, [penControlLabelById]);

  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.visibility = {
      epg: legendVisibility.epg,
      penA: legendVisibility.penA,
      connections: legendVisibility.connections,
    };
  }, [legendVisibility.epg, legendVisibility.penA, legendVisibility.connections]);

  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.connectionOpacity = connectionOpacity;
  }, [connectionOpacity]);

  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.arrowState.smoothingEnabled = arrowSmoothing;
  }, [arrowSmoothing]);

  useEffect(() => {
    if (!showLegendPopover) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (legendPopoverRef.current?.contains(target)) return;
      if (legendTriggerRef.current?.contains(target)) return;
      setShowLegendPopover(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [showLegendPopover]);

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

  const smoothedArrowAngleDeg = sceneRef.current?.arrowState?.angleCurrentDeg;
  const bumpTheta = Number.isFinite(smoothedArrowAngleDeg)
    ? (((smoothedArrowAngleDeg as number) + 360) % 360)
    : (compassStats.bumpAngleDeg != null ? ((compassStats.bumpAngleDeg + 360) % 360) : null);
  const statusLine = replay
    ? `replay=${selectedReplay?.id ?? 'n/a'} | scenario=${replay.meta?.scenario ?? 'n/a'} | decode=vector | ticks=${replay.ticks.length} | sim=${(replay.ticks.length * getReplayDtSec(replay)).toFixed(3)}s | dt=${(getReplayDtSec(replay) * 1000).toFixed(3)}ms | epg fired=${epgUniqueFired ?? 'n/a'} | bump=${compassStats.bumpAngleDeg == null ? 'n/a' : `${compassStats.bumpAngleDeg.toFixed(1)}deg`} (${compassStats.bumpStrength.toFixed(2)}) | top bin=${compassStats.epgTopBinIndex}`
    : 'Loading replay...';
  const statusTitle = replay
    ? `replay=${selectedReplay?.id ?? 'n/a'} | scenario=${replay.meta?.scenario ?? 'n/a'} | decode=vector | neurons=${Array.isArray(replay.neurons) ? replay.neurons.length : displayNeurons.length} | rendered=${displayNeurons.length} | ticks=${replay.ticks.length} | sim=${(replay.ticks.length * getReplayDtSec(replay)).toFixed(3)}s | dt=${(getReplayDtSec(replay) * 1000).toFixed(3)}ms | epg fired=${epgUniqueFired ?? 'n/a'} | bump angle=${compassStats.bumpAngleDeg == null ? 'n/a' : `${compassStats.bumpAngleDeg.toFixed(1)}deg`} | bump strength=${compassStats.bumpStrength.toFixed(3)} | top bin=${compassStats.epgTopBinIndex}`
    : undefined;
  const applyPenAHz = async () => {
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
  };
  const clearAllPenAInputs = () => {
    setPenALeftHz(0);
    setPenARightHz(0);
    const cleared: Record<string, number> = {};
    for (const { id } of penANeurons.left) cleared[id] = 0;
    for (const { id } of penANeurons.right) cleared[id] = 0;
    setPenARatesById(cleared);
    notification.show('Cleared all PEN_a inputs to 0 Hz (not applied)', 'info');
    setTimeout(() => notification.hide(), 2200);
  };
  const handleCopyNeuronId = async (id: string) => {
    if (copyInFlightRef.current) return;
    copyInFlightRef.current = true;
    try {
      await navigator.clipboard.writeText(id);
      if (!isMountedRef.current) {
        copyInFlightRef.current = false;
        return;
      }
      setCopiedPenAId(id);
      if (copyTimeoutRef.current != null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        if (!isMountedRef.current) return;
        setCopiedPenAId((prev) => (prev === id ? null : prev));
        copyInFlightRef.current = false;
        copyTimeoutRef.current = null;
      }, 1200);
    } catch {
      if (isMountedRef.current) {
        setError('Failed to copy neuron ID');
      }
      copyInFlightRef.current = false;
    }
  };
  const preventNumberWheelAdjust = (event: WheelEvent<HTMLElement>) => {
    const target = event.target as EventTarget | null;
    if (target instanceof HTMLInputElement && target.type === 'number' && document.activeElement === target) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  return (
    <div
      className="neurosim-viz"
      onWheelCapture={preventNumberWheelAdjust}
      style={{ height: '100%', width: '100%', background: '#060a14', position: 'relative', overflow: 'hidden' }}
    >
      <div ref={sceneContainerRef} style={{ position: 'absolute', inset: 0 }} />
      <div
        style={{
          position: 'absolute',
          inset: 12,
          zIndex: 15,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
          <CompactMenu />
        </div>
        {sceneError ? (
          <div
            style={{
              alignSelf: 'center',
              maxWidth: 760,
              pointerEvents: 'auto',
              color: '#ffb4b4',
              background: 'rgba(32, 12, 12, 0.85)',
              border: '1px solid rgba(255, 120, 120, 0.35)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 12,
            }}
          >
            {sceneError}
          </div>
        ) : null}
        {isNeuroSimLive && templateReplay ? createPortal((
          <div
            style={{
              position: 'fixed',
              top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
              left: 8,
              zIndex: 21,
              pointerEvents: 'auto',
              display: 'grid',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                position: 'relative',
              }}
            >
              <button
                type="button"
                onClick={() => setViewMode((v) => (v === 'compass' ? 'biological' : 'compass'))}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#d7e8ff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: 0,
                  cursor: 'pointer',
                }}
                title="Toggle view mode"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M1.5 12S5.2 5.5 12 5.5S22.5 12 22.5 12S18.8 18.5 12 18.5S1.5 12 1.5 12Z" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="12" cy="12" r="2.2" fill="currentColor" />
                </svg>
                {viewMode === 'compass' ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M12 4V20M4 12H20" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M7 4C10 4 10 8 13 8C16 8 16 4 19 4M7 20C10 20 10 16 13 16C16 16 16 20 19 20M7 4V20M19 4V20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                )}
              </button>
              <span style={{ fontSize: 12, color: '#b6cfe9', fontWeight: 600 }}>
                View: {viewMode === 'compass' ? 'EPG Compass' : 'Biological'}
              </span>
              <button
                ref={legendTriggerRef}
                type="button"
                aria-label="Toggle legend"
                title="Toggle legend"
                onClick={() => setShowLegendPopover((v) => !v)}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 999,
                  border: '1px solid rgba(150, 185, 235, 0.7)',
                  background: 'rgba(18, 37, 64, 0.95)',
                  color: '#d8e9ff',
                  fontSize: 11,
                  lineHeight: '14px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  padding: 0,
                  fontWeight: 700,
                }}
              >
                i
              </button>
              {showLegendPopover ? (
                <div
                  ref={legendPopoverRef}
                  style={{
                    position: 'absolute',
                    top: 22,
                    left: 0,
                    width: 290,
                    maxWidth: 'min(290px, calc(100vw - 24px))',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid rgba(130,170,225,0.55)',
                    background: 'rgba(10,20,36,0.96)',
                    color: '#d7e8ff',
                    fontSize: 11,
                    lineHeight: 1.35,
                    boxShadow: '0 8px 20px rgba(0,0,0,0.38)',
                    zIndex: 4,
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
                    {viewMode === 'compass' ? 'EPG compass legend' : 'Biological legend'}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={legendVisibility.epg}
                      onChange={(e) => setLegendVisibility((prev) => ({ ...prev, epg: e.target.checked }))}
                    />
                    Show EPG neurons
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={legendVisibility.penA}
                      onChange={(e) => setLegendVisibility((prev) => ({ ...prev, penA: e.target.checked }))}
                    />
                    Show PEN_a neurons
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={legendVisibility.connections}
                      onChange={(e) => setLegendVisibility((prev) => ({ ...prev, connections: e.target.checked }))}
                    />
                    Show connections
                  </label>
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span>Connections opacity</span>
                      <span style={{ color: '#9fc0e6' }}>{Math.round(connectionOpacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(connectionOpacity * 100)}
                      onChange={(e) => setConnectionOpacity(Math.max(0, Math.min(1, Number(e.target.value) / 100)))}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div style={{ color: '#9fc0e6' }}>
                    {viewMode === 'compass'
                      ? 'PEN_a are placed on the outer circle (left/right split).'
                      : 'PEN_a use biological positions; active spikes glow brighter.'}
                  </div>
                  <div style={{ color: '#9fc0e6', marginTop: 4 }}>
                    Thin links: cyan=strong excitatory, pink=most inhibitory/weakest links.
                  </div>
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', position: 'relative' }}>
              <button
                type="button"
                aria-label={showRecordMenu ? 'Hide record tools' : 'Show record tools'}
                onClick={() => setShowRecordMenu((v) => !v)}
                title={showRecordMenu ? 'Hide record tools' : 'Show record tools'}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 6,
                  border: '1px solid rgba(150, 185, 235, 0.55)',
                  background: showRecordMenu ? 'rgba(42, 70, 114, 0.95)' : 'rgba(18, 37, 64, 0.95)',
                  color: '#d8e9ff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h4l1.2-1.4A1.8 1.8 0 0 1 13.1 4h2.8A2.1 2.1 0 0 1 18 6.1V8h1a1 1 0 0 1 1 1v8.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5V8.5Z" stroke="currentColor" strokeWidth="1.7" />
                  <circle cx="12" cy="13" r="3.4" stroke="currentColor" strokeWidth="1.7" />
                </svg>
              </button>
              {showRecordMenu ? (
                <div
                  style={{
                    position: 'absolute',
                    top: 24,
                    left: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: 8,
                    padding: 10,
                    minWidth: 250,
                    border: '1px solid rgba(140,170,220,0.38)',
                    borderRadius: 8,
                    background: 'rgba(8, 16, 30, 0.88)',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    boxShadow: '0 10px 22px rgba(0,0,0,0.36)',
                    zIndex: 3,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: 8,
                      border: '1px solid rgba(126, 165, 222, 0.35)',
                      borderRadius: 8,
                      background: 'linear-gradient(180deg, rgba(19, 33, 56, 0.72) 0%, rgba(10, 21, 38, 0.82) 100%)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setRecording((r) => !r)}
                      style={{ ...controlButtonStyle(recording), width: '100%', justifyContent: 'center' }}
                    >
                      Record {recording ? '(on)' : ''}
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
                            note: `Continuous live sim; rolling capture up to ${NEUROSIM_RECORDING_MAX_STORED_TICKS} ticks; applied PEN_a last L=${appliedPenLeft} R=${appliedPenRight} Hz`,
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
                      style={{ ...controlButtonStyle(false), width: '100%', justifyContent: 'center', fontVariantNumeric: 'tabular-nums' }}
                      disabled={recordedTicks.length === 0}
                    >
                      Download JSON ({recordedTicks.length.toLocaleString()} ticks)
                    </button>
                  </div>
                  <span style={{ fontSize: 11, color: '#7a9cc4' }}>
                    Recording keeps last {NEUROSIM_RECORDING_MAX_STORED_TICKS.toLocaleString()} ticks (rolling window)
                  </span>
                </div>
              ) : null}
            </div>
            
          </div>
        ), document.body) : null}
        {isNeuroSimLive ? createPortal((
          <div
            style={{
              position: 'fixed',
              top: 96,
              right: 12,
              zIndex: 21,
              pointerEvents: 'auto',
            }}
          >
            <button
              type="button"
              aria-label={showPenAMapping ? 'Hide PEN_a neuron ID mapping' : 'Show PEN_a neuron ID mapping'}
              onClick={() => setShowPenAMapping((v) => !v)}
              style={{
                width: 18,
                minHeight: 120,
                borderRadius: 6,
                border: '1px solid #6f8fc0',
                background: showPenAMapping ? '#3a5787' : '#243a5b',
                color: '#eef4ff',
                cursor: 'pointer',
                fontWeight: 700,
                padding: 0,
              }}
              title={showPenAMapping ? 'Hide PEN_a mapping' : 'Show PEN_a mapping'}
            >
              {showPenAMapping ? '›' : '‹'}
            </button>
            {showPenAMapping ? (
              <div
                style={{
                  position: 'absolute',
                  right: 24,
                  top: 0,
                  maxHeight: 220,
                  overflowY: 'auto',
                  minWidth: 320,
                  padding: '8px 10px',
                  border: '1px solid #6f8fc0',
                  borderRadius: 8,
                  background: '#122136',
                  color: '#d9e9ff',
                  boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
                }}
              >
                <div role="tablist" aria-label="Right drawer tabs" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button type="button" onClick={() => setRightPanelTab('mapping')} style={controlButtonStyle(rightPanelTab === 'mapping')}>
                    PEN Mapping
                  </button>
                  <button type="button" onClick={() => setRightPanelTab('compass')} style={controlButtonStyle(rightPanelTab === 'compass')}>
                    EPG Compass
                  </button>
                </div>
                {rightPanelTab === 'mapping' ? (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>PEN_a neuron mapping</div>
                    {penANeurons.left.length === 0 && penANeurons.right.length === 0 ? (
                      <div style={{ fontSize: 11, color: '#f0a050' }}>Loading PEN_a list…</div>
                    ) : (
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #35527a', padding: '2px 4px' }}>Label</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #35527a', padding: '2px 4px' }}>PEN</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #35527a', padding: '2px 4px' }}>Hemilineage</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #35527a', padding: '2px 4px' }}>Side</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #35527a', padding: '2px 4px' }}>Neuron ID</th>
                          </tr>
                        </thead>
                        <tbody>
                          {penANeurons.left.map(({ label, id }) => (
                            <tr key={`map-left-${id}`}>
                              <td style={{ padding: '2px 4px', color: '#b8d4ff' }}>{label}</td>
                              <td style={{ padding: '2px 4px', color: '#a8c4ea' }}>{penAMetadataById[id]?.penLabel || '-'}</td>
                              <td style={{ padding: '2px 4px', color: '#9bb8de' }}>{penAMetadataById[id]?.hemilineage || '-'}</td>
                              <td style={{ padding: '2px 4px', color: '#9bb8de' }}>{penAMetadataById[id]?.side || (label.startsWith('L') ? 'left' : 'right')}</td>
                              <td style={{ padding: '2px 4px', color: '#8fb5e3', fontFamily: 'monospace' }}>
                                <span>{id}</span>
                                <button
                                  type="button"
                                  onClick={() => void handleCopyNeuronId(id)}
                                  aria-label={copiedPenAId === id ? 'Copied neuron ID' : 'Copy neuron ID'}
                                  title={copiedPenAId === id ? 'Copied' : 'Copy neuron ID'}
                                  style={{
                                    marginLeft: 6,
                                    width: 18,
                                    height: 18,
                                    border: '1px solid #5e7daa',
                                    borderRadius: 4,
                                    background: copiedPenAId === id ? '#2f6b3f' : '#1a2b45',
                                    color: '#d9e9ff',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    verticalAlign: 'middle',
                                    padding: 0,
                                  }}
                                >
                                  {copiedPenAId === id ? (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  ) : (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
                                      <path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    </svg>
                                  )}
                                </button>
                              </td>
                            </tr>
                          ))}
                          {penANeurons.right.map(({ label, id }) => (
                            <tr key={`map-right-${id}`}>
                              <td style={{ padding: '2px 4px', color: '#b8d4ff' }}>{label}</td>
                              <td style={{ padding: '2px 4px', color: '#a8c4ea' }}>{penAMetadataById[id]?.penLabel || '-'}</td>
                              <td style={{ padding: '2px 4px', color: '#9bb8de' }}>{penAMetadataById[id]?.hemilineage || '-'}</td>
                              <td style={{ padding: '2px 4px', color: '#9bb8de' }}>{penAMetadataById[id]?.side || (label.startsWith('L') ? 'left' : 'right')}</td>
                              <td style={{ padding: '2px 4px', color: '#8fb5e3', fontFamily: 'monospace' }}>
                                <span>{id}</span>
                                <button
                                  type="button"
                                  onClick={() => void handleCopyNeuronId(id)}
                                  aria-label={copiedPenAId === id ? 'Copied neuron ID' : 'Copy neuron ID'}
                                  title={copiedPenAId === id ? 'Copied' : 'Copy neuron ID'}
                                  style={{
                                    marginLeft: 6,
                                    width: 18,
                                    height: 18,
                                    border: '1px solid #5e7daa',
                                    borderRadius: 4,
                                    background: copiedPenAId === id ? '#2f6b3f' : '#1a2b45',
                                    color: '#d9e9ff',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    verticalAlign: 'middle',
                                    padding: 0,
                                  }}
                                >
                                  {copiedPenAId === id ? (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  ) : (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
                                      <path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    </svg>
                                  )}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </>
                ) : (
                  <div style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
                    <svg
                      width="152"
                      height="152"
                      viewBox="-60 -60 120 120"
                      style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8 }}
                    >
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
                      {legendVisibility.epg ? compassStats.epgBins.map((v, i) => {
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
                      }) : null}
                      {legendVisibility.penA ? penANeurons.left.map(({ id, label }, i, arr) => {
                        const t = arr.length <= 1 ? 0.5 : i / (arr.length - 1);
                        const angle = (Math.PI * 0.65) + (Math.PI * 0.7 * t);
                        const radius = 55;
                        const x = Math.cos(angle) * radius;
                        const y = Math.sin(angle) * radius;
                        const s = Math.max(0, Math.min(1, penASpikeStrengthById[id] ?? 0));
                        const isActive = s > 0.08;
                        const fill = isActive ? 'rgba(0, 255, 110, 0.98)' : 'rgba(76, 95, 122, 0.92)';
                        return (
                          <g key={`pen-left-compass-${id}`}>
                            <circle cx={x.toFixed(3)} cy={y.toFixed(3)} r={isActive ? '3.3' : '2.2'} fill={fill} stroke={isActive ? 'rgba(220,255,225,0.98)' : 'rgba(170,190,220,0.45)'} strokeWidth={isActive ? '0.9' : '0.45'} />
                            <text x={(x - 5.2).toFixed(3)} y={(y - 3.0).toFixed(3)} fill={isActive ? 'rgba(225,255,230,1)' : 'rgba(185,205,235,0.8)'} fontSize="3.2" fontWeight="700">
                              {label}
                            </text>
                          </g>
                        );
                      }) : null}
                      {legendVisibility.penA ? penANeurons.right.map(({ id, label }, i, arr) => {
                        const t = arr.length <= 1 ? 0.5 : i / (arr.length - 1);
                        const angle = (-Math.PI * 0.35) + (Math.PI * 0.7 * t);
                        const radius = 55;
                        const x = Math.cos(angle) * radius;
                        const y = Math.sin(angle) * radius;
                        const s = Math.max(0, Math.min(1, penASpikeStrengthById[id] ?? 0));
                        const isActive = s > 0.08;
                        const fill = isActive ? 'rgba(0, 255, 110, 0.98)' : 'rgba(76, 95, 122, 0.92)';
                        return (
                          <g key={`pen-right-compass-${id}`}>
                            <circle cx={x.toFixed(3)} cy={y.toFixed(3)} r={isActive ? '3.3' : '2.2'} fill={fill} stroke={isActive ? 'rgba(220,255,225,0.98)' : 'rgba(170,190,220,0.45)'} strokeWidth={isActive ? '0.9' : '0.45'} />
                            <text x={(x + 2.9).toFixed(3)} y={(y - 3.0).toFixed(3)} fill={isActive ? 'rgba(225,255,230,1)' : 'rgba(185,205,235,0.8)'} fontSize="3.2" fontWeight="700">
                              {label}
                            </text>
                          </g>
                        );
                      }) : null}
                      {legendVisibility.epg && bumpTheta != null ? (
                        <line
                          x1="0"
                          y1="0"
                          x2={(Math.cos(bumpTheta * Math.PI / 180) * COMPASS_ARROW_RADIUS).toFixed(3)}
                          y2={(-Math.sin(bumpTheta * Math.PI / 180) * COMPASS_ARROW_RADIUS).toFixed(3)}
                          stroke="#ff4fd8"
                          strokeWidth="2.5"
                        />
                      ) : null}
                    </svg>
                    <button
                      type="button"
                      onClick={() => setShowCompassInfo((v) => !v)}
                      title="EPG compass info"
                      aria-label="Toggle EPG compass info"
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 6,
                        width: 18,
                        height: 18,
                        borderRadius: 999,
                        border: '1px solid rgba(150, 185, 235, 0.7)',
                        background: 'rgba(18, 37, 64, 0.95)',
                        color: '#d8e9ff',
                        fontSize: 12,
                        lineHeight: '16px',
                        textAlign: 'center',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 700,
                      }}
                    >
                      i
                    </button>
                    {showCompassInfo ? (
                      <div
                        style={{
                          position: 'absolute',
                          top: 34,
                          right: 0,
                          width: 280,
                          maxWidth: 'min(280px, calc(100vw - 56px))',
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid rgba(130,170,225,0.55)',
                          background: 'rgba(10,20,36,0.96)',
                          color: '#d7e8ff',
                          fontSize: 11,
                          lineHeight: 1.35,
                          boxShadow: '0 8px 20px rgba(0,0,0,0.38)',
                          zIndex: 2,
                        }}
                      >
                        EPG compass: 16 labeled wedges using processed labels and classification side, arranged anatomically.
                        Order is fixed to match the reference slice diagram (top= L5, top-left=R5, right of L5=R4, then L6).
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ), document.body) : null}
        {error ? <div style={{ color: '#f99', fontSize: 12, pointerEvents: 'auto' }}>{error}</div> : null}
      </div>
      <div
        className="viz-bottom-status"
        title={statusTitle}
        style={{
          position: 'fixed',
          left: 12,
          right: 12,
          bottom: 10,
          zIndex: 19,
          overflowX: 'auto',
          overflowY: 'hidden',
          whiteSpace: 'nowrap',
          fontSize: 12,
          lineHeight: '18px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          color: 'rgba(228, 238, 255, 0.92)',
          padding: '4px 8px',
          borderRadius: 8,
          border: '1px solid rgba(120,150,200,0.26)',
          background: 'rgba(8, 16, 30, 0.5)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          pointerEvents: 'auto',
        }}
      >
        {statusLine}
      </div>
      {isNeuroSimLive && templateReplay ? (
        <div
          style={{
            position: 'fixed',
            left: 12,
            right: 12,
            bottom: 44,
            zIndex: 19,
            display: 'grid',
            gap: 8,
            pointerEvents: 'auto',
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <div role="tablist" aria-label="PEN_a control mode tabs" style={{ display: 'flex', gap: 8 }}>
              <button
                id="pena-tab-individual"
                role="tab"
                aria-selected={bottomControlTab === 'individual'}
                aria-controls="pena-panel-individual"
                type="button"
                onClick={() => setBottomControlTab('individual')}
                style={controlButtonStyle(bottomControlTab === 'individual')}
              >
                Individual L/R
              </button>
              <button
                id="pena-tab-sliders"
                role="tab"
                aria-selected={bottomControlTab === 'sliders'}
                aria-controls="pena-panel-sliders"
                type="button"
                onClick={() => setBottomControlTab('sliders')}
                style={controlButtonStyle(bottomControlTab === 'sliders')}
              >
                Sliders
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => void applyPenAHz()}
                disabled={applyBusy}
                style={{
                  ...controlButtonStyle(false),
                  background: 'linear-gradient(145deg, rgba(44,120,255,0.9) 0%, rgba(106,72,255,0.88) 100%)',
                  borderColor: 'rgba(158, 188, 255, 0.88)',
                  color: '#f6faff',
                  boxShadow: '0 0 16px rgba(88,140,255,0.5), 0 0 28px rgba(120,80,255,0.28)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  opacity: applyBusy ? 0.75 : 1,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12L10 17L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Apply
              </button>
              <button
                type="button"
                onClick={clearAllPenAInputs}
                style={{
                  ...controlButtonStyle(false),
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 7H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M9 7V5h6v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M8 10V18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M12 10V18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M16 10V18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M7 7L8 20h8l1-13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Clear all
              </button>
            </div>
          </div>
          {bottomControlTab === 'individual' ? (
            <div
              id="pena-panel-individual"
              role="tabpanel"
              aria-labelledby="pena-tab-individual"
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                alignItems: 'stretch',
              }}
            >
              <div
                style={{
                  flex: '1 1 320px',
                  minWidth: 280,
                  borderRadius: 10,
                  border: '1px solid rgba(96, 168, 255, 0.5)',
                  background: 'linear-gradient(145deg, rgba(18,42,78,0.72) 0%, rgba(10,25,46,0.66) 100%)',
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)',
                  boxShadow: '0 10px 22px rgba(0,0,0,0.34)',
                  padding: '8px 10px',
                }}
              >
                <div style={{ marginBottom: 4, fontWeight: 700, fontSize: 12, color: '#9fd1ff' }}>Left (L1-L10)</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {penANeurons.left.map(({ id, label }) => (
                    <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ minWidth: 24, color: '#dbeaff' }}>{label}</span>
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
              <div
                style={{
                  flex: '1 1 320px',
                  minWidth: 280,
                  borderRadius: 10,
                  border: '1px solid rgba(255, 136, 136, 0.5)',
                  background: 'linear-gradient(145deg, rgba(74,28,36,0.68) 0%, rgba(40,16,22,0.63) 100%)',
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)',
                  boxShadow: '0 10px 22px rgba(0,0,0,0.34)',
                  padding: '8px 10px',
                }}
              >
                <div style={{ marginBottom: 4, fontWeight: 700, fontSize: 12, color: '#ffb0b0' }}>Right (R1-R10)</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {penANeurons.right.map(({ id, label }) => (
                    <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ minWidth: 24, color: '#ffe1e1' }}>{label}</span>
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
          ) : (
          <div
            id="pena-panel-sliders"
            role="tabpanel"
            aria-labelledby="pena-tab-sliders"
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              alignItems: 'stretch',
            }}
          >
            <div
              style={{
                flex: '1 1 320px',
                minWidth: 280,
                borderRadius: 10,
                border: '1px solid rgba(96, 168, 255, 0.5)',
                background: 'linear-gradient(145deg, rgba(18,42,78,0.72) 0%, rgba(10,25,46,0.66) 100%)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 10px 22px rgba(0,0,0,0.34)',
                padding: '8px 10px',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: '#9fd1ff', marginBottom: 6 }}>Left PEN_a (Hz)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={Math.min(200, penALeftHz)}
                  onChange={(e) => setPenALeftHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={penALeftHz}
                  onChange={(e) => setPenALeftHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                  style={{ width: 58, padding: '3px 5px', fontSize: 12 }}
                />
              </div>
              <div style={{ marginTop: 5, fontSize: 11, color: '#8dbde7' }}>Applied: {appliedPenLeft} Hz</div>
            </div>
            <div
              style={{
                flex: '1 1 320px',
                minWidth: 280,
                borderRadius: 10,
                border: '1px solid rgba(255, 136, 136, 0.5)',
                background: 'linear-gradient(145deg, rgba(74,28,36,0.68) 0%, rgba(40,16,22,0.63) 100%)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                boxShadow: '0 10px 22px rgba(0,0,0,0.34)',
                padding: '8px 10px',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: '#ffb0b0', marginBottom: 6 }}>Right PEN_a (Hz)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={Math.min(200, penARightHz)}
                  onChange={(e) => setPenARightHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={penARightHz}
                  onChange={(e) => setPenARightHz(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                  style={{ width: 58, padding: '3px 5px', fontSize: 12 }}
                />
              </div>
              <div style={{ marginTop: 5, fontSize: 11, color: '#f0aaaa' }}>Applied: {appliedPenRight} Hz</div>
            </div>
          </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
