/**
 * Lightweight Three.js 3D scatter for brain activity. No Plotly.
 * Neuron positions → points, activity → vertex colors, auto-rotate.
 */
import * as THREE from 'three';
import { computeColor } from '../../../shared/lib/brainPlotColors';
import type { NeuronWithPosition } from '../../../shared/lib/brainTypes';

const COLOR_SCALE: [number, string][] = [
  [0, '#888888'],
  [0.3, '#4a7de8'],
  [0.5, '#e8b84a'],
  [0.7, '#e85a4a'],
  [1, '#ff8c7a'],
];

const RGB_LOOKUP_SIZE = 256;
function buildRgbLookup(): [number, number, number][] {
  const hexToRgb = (hex: string): [number, number, number] => {
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!m) return [0.5, 0.5, 0.5];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  };
  const out: [number, number, number][] = [];
  for (let i = 0; i < RGB_LOOKUP_SIZE; i++) {
    const t = i / (RGB_LOOKUP_SIZE - 1);
    if (t <= 0) { out.push(hexToRgb(COLOR_SCALE[0]![1])); continue; }
    if (t >= 1) { out.push(hexToRgb(COLOR_SCALE[COLOR_SCALE.length - 1]![1])); continue; }
    for (let j = 0; j < COLOR_SCALE.length - 1; j++) {
      const [a, cA] = COLOR_SCALE[j]!;
      const [b, cB] = COLOR_SCALE[j + 1]!;
      if (t >= a && t <= b) {
        const s = (t - a) / (b - a);
        const [r1, g1, b1] = hexToRgb(cA);
        const [r2, g2, b2] = hexToRgb(cB);
        out.push([r1 + s * (r2 - r1), g1 + s * (g2 - g1), b1 + s * (b2 - b1)]);
        break;
      }
    }
  }
  return out;
}

const RGB_LOOKUP = buildRgbLookup();
function colormapLookup(t: number): [number, number, number] {
  const i = Math.max(0, Math.min(RGB_LOOKUP_SIZE - 1, Math.floor(t * (RGB_LOOKUP_SIZE - 0.001))));
  return RGB_LOOKUP[i]!;
}

function hasPosition(n: NeuronWithPosition): n is NeuronWithPosition & { x: number; y: number; z: number } {
  return (
    typeof n.x === 'number' && Number.isFinite(n.x) &&
    typeof n.y === 'number' && Number.isFinite(n.y) &&
    typeof n.z === 'number' && Number.isFinite(n.z)
  );
}

export interface BrainPointsRefs {
  activityRef: { current: Record<string, number> };
  activitiesRef: { current: (Record<string, number> | undefined)[] };
  followSimIndexRef: { current: number | undefined };
}

const ROTATE_SPEED = 0.15;
const ZOOM = 0.65; // Ortho extent (smaller = zoomed in)

export function initBrainPoints(
  container: HTMLElement,
  refs: BrainPointsRefs,
  neurons: NeuronWithPosition[],
  onReady?: () => void
): () => void {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a12);

  const camera = new THREE.OrthographicCamera(-ZOOM, ZOOM, ZOOM, -ZOOM, 0.1, 10);
  camera.position.set(0, 0, 2);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  container.appendChild(renderer.domElement);

  let points: THREE.Points | null = null;
  let colorAttr: THREE.BufferAttribute | null = null;
  let ids: string[] = [];
  let sides: string[] = [];
  let disposed = false;
  let animationId: number;
  let lastActivityRef: Record<string, number> | null = null;
  let lastFrameTime = 0;

  function getActivity(): Record<string, number> {
    const idx = refs.followSimIndexRef.current;
    const acts = refs.activitiesRef.current;
    if (idx != null && acts && acts[idx] != null) return acts[idx]!;
    return refs.activityRef.current;
  }

  function updateColors(): void {
    if (!colorAttr || !points || disposed) return;
    const activity = getActivity();
    lastActivityRef = activity;
    for (let i = 0; i < ids.length; i++) {
      const v = computeColor(activity, ids[i]!, sides[i] ?? '');
      const [r, g, b] = colormapLookup(v);
      colorAttr.setXYZ(i, r, g, b);
    }
    colorAttr.needsUpdate = true;
  }

  function animate(timestamp?: number): void {
    if (disposed) return;
    animationId = requestAnimationFrame(animate);
    const deltaSeconds = lastFrameTime === 0 ? 0 : ((timestamp ?? performance.now()) - lastFrameTime) / 1000;
    lastFrameTime = timestamp ?? performance.now();
    if (points) {
      points.rotation.y += ROTATE_SPEED * deltaSeconds;
      const activity = getActivity();
      if (activity !== lastActivityRef) updateColors();
    }
    renderer.render(scene, camera);
  }

  function doResize(): void {
    if (disposed) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    const ratio = w / h;
    camera.left = -ratio * ZOOM;
    camera.right = ratio * ZOOM;
    camera.top = ZOOM;
    camera.bottom = -ZOOM;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(doResize);
  resizeObserver.observe(container);
  doResize();

  const withPos = neurons.filter(hasPosition);
  if (withPos.length > 0) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of withPos) {
      const px = p.x!, py = p.y!, pz = p.z!;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);

    const positions = new Float32Array(withPos.length * 3);
    const colors = new Float32Array(withPos.length * 3);
    ids = withPos.map((p) => p.root_id);
    sides = withPos.map((p) => (p.side ?? '').toLowerCase());

    for (let i = 0; i < withPos.length; i++) {
      const p = withPos[i]!;
      positions[i * 3] = (p.x! - cx) / scale;
      positions[i * 3 + 1] = (p.y! - cy) / scale;
      positions[i * 3 + 2] = (p.z! - cz) / scale;
      const [r, g, b] = colormapLookup(0);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    colorAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('color', colorAttr);

    const material = new THREE.PointsMaterial({
      size: 0.03,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: false,
    });

    points = new THREE.Points(geometry, material);
    scene.add(points);
    lastActivityRef = null;
    updateColors();
  }
  onReady?.();

  animate();

  return () => {
    disposed = true;
    lastActivityRef = null;
    cancelAnimationFrame(animationId);
    resizeObserver.disconnect();
    if (points) {
      scene.remove(points);
      points.geometry.dispose();
      (points.material as THREE.Material).dispose();
    }
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  };
}
