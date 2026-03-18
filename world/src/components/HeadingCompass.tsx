/**
 * 3D heading compass for the world fly panel (Three.js).
 * Matches visualization page: colored wedges from epgBins, ring nodes, bump arrow.
 */
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

const BINS = 16;
const BIN_GAP_RAD = (Math.PI / 180) * 4;

function getWedgeParams(i: number, binCount: number): { a0: number; a1: number; midAngle: number } {
  const wedge = (Math.PI * 2) / binCount - BIN_GAP_RAD;
  const a0 = (i / binCount) * Math.PI * 2 - Math.PI / 2 + BIN_GAP_RAD / 2;
  const a1 = a0 + wedge;
  const midAngle = a0 + wedge / 2;
  return { a0, a1, midAngle };
}

/** Heat color yellow -> orange -> red; returns hex for Three.js. */
function compassHeatHex(v: number): number {
  const t = Math.max(0, Math.min(1, v));
  let r = 255;
  let g = 0;
  let b = 0;
  if (t < 0.5) {
    const u = t / 0.5;
    r = 255;
    g = Math.round(240 - 81 * u);
    b = Math.round(122 - 79 * u);
  } else {
    const u = (t - 0.5) / 0.5;
    r = 255;
    g = Math.round(159 - 100 * u);
    b = Math.round(67 - 19 * u);
  }
  return (r << 16) | (g << 8) | b;
}

const DEFAULT_WEDGE_COLOR = 0x404060;
const NODE_RADIUS = 0.04;
const ARROW_COLOR = 0xff4fd8;

export interface HeadingCompassProps {
  bumpAngleDeg: number | null;
  epgBins?: number[];
  /** Fixed size in px. If omitted, the compass fills its container (100% width/height). */
  size?: number;
}

export function HeadingCompass({ bumpAngleDeg, epgBins, size }: HeadingCompassProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    renderer: THREE.WebGLRenderer;
    wedgeMeshes: THREE.Mesh[];
    nodeMeshes: THREE.Mesh[];
    arrow: THREE.ArrowHelper | null;
  } | null>(null);

  const fillContainer = size == null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = Math.max(1, fillContainer ? container.clientWidth : size ?? 120);
    const h = Math.max(1, fillContainer ? container.clientHeight : size ?? 120);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);

    const zoom = 1.2;
    const camera = new THREE.OrthographicCamera(-zoom, zoom, zoom, -zoom, 0.1, 10);
    camera.position.set(0, 0, 2);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(renderer.domElement);

    const wedgeR0 = 0.5;
    const wedgeR1 = 0.92;
    const nodeR = 0.72;
    const arrowLen = 0.88;

    const wedgeMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < BINS; i++) {
      const { a0, a1 } = getWedgeParams(i, BINS);
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(Math.cos(a0) * wedgeR0, -Math.sin(a0) * wedgeR0);
      shape.lineTo(Math.cos(a0) * wedgeR1, -Math.sin(a0) * wedgeR1);
      shape.lineTo(Math.cos(a1) * wedgeR1, -Math.sin(a1) * wedgeR1);
      shape.lineTo(Math.cos(a1) * wedgeR0, -Math.sin(a1) * wedgeR0);
      shape.lineTo(0, 0);
      const geom = new THREE.ShapeGeometry(shape);
      const mat = new THREE.MeshBasicMaterial({
        color: DEFAULT_WEDGE_COLOR,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      scene.add(mesh);
      wedgeMeshes.push(mesh);
    }

    const ringLinePoints: THREE.Vector3[] = [];
    for (let i = 0; i <= BINS; i++) {
      const { midAngle } = getWedgeParams(i % BINS, BINS);
      ringLinePoints.push(new THREE.Vector3(wedgeR0 * Math.cos(midAngle), -wedgeR0 * Math.sin(midAngle), 0));
    }
    const ringGeom = new THREE.BufferGeometry().setFromPoints(ringLinePoints);
    const ringLine = new THREE.Line(
      ringGeom,
      new THREE.LineBasicMaterial({ color: 0x646478, transparent: true, opacity: 0.4 }),
    );
    scene.add(ringLine);

    const nodeGeom = new THREE.SphereGeometry(NODE_RADIUS, 8, 6);
    const nodeMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < BINS; i++) {
      const { midAngle } = getWedgeParams(i, BINS);
      const mat = new THREE.MeshBasicMaterial({ color: 0x6a8acc });
      const mesh = new THREE.Mesh(nodeGeom, mat);
      mesh.position.set(nodeR * Math.cos(midAngle), -nodeR * Math.sin(midAngle), 0);
      scene.add(mesh);
      nodeMeshes.push(mesh);
    }

    let arrow: THREE.ArrowHelper | null = null;
    const dir = new THREE.Vector3(1, 0, 0);
    const origin = new THREE.Vector3(0, 0, 0);
    arrow = new THREE.ArrowHelper(dir, origin, arrowLen, ARROW_COLOR, 0.2, 0.08);
    scene.add(arrow);

    sceneRef.current = { scene, camera, renderer, wedgeMeshes, nodeMeshes, arrow };

    let animationId: number;
    function tick() {
      animationId = requestAnimationFrame(tick);
      renderer.render(scene, camera);
    }
    tick();

    const ro = new ResizeObserver(() => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(animationId);
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      wedgeMeshes.forEach((m) => {
        (m.geometry as THREE.BufferGeometry).dispose();
        (m.material as THREE.Material).dispose();
      });
      nodeGeom.dispose();
      nodeMeshes.forEach((m) => (m.material as THREE.Material).dispose());
      ringGeom.dispose();
      (ringLine.material as THREE.Material).dispose();
      sceneRef.current = null;
    };
  }, [size, fillContainer]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;

    const maxVal = epgBins?.length ? Math.max(1, ...epgBins) : 1;
    state.wedgeMeshes.forEach((mesh, i) => {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const v = epgBins?.[i] ?? 0;
      if (epgBins) {
        mat.color.setHex(compassHeatHex(v / maxVal));
        mat.opacity = 0.2 + (v / maxVal) * 0.7;
      } else {
        mat.color.setHex(DEFAULT_WEDGE_COLOR);
        mat.opacity = 0.35;
      }
    });

    state.nodeMeshes.forEach((mesh, i) => {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const v = epgBins?.[i] ?? 0;
      if (epgBins && maxVal > 0) {
        const t = v / maxVal;
        mat.color.setHex(compassHeatHex(t));
        mat.opacity = 0.6 + t * 0.4;
      } else {
        mat.color.setHex(0x6a8acc);
        mat.opacity = 0.8;
      }
    });

    if (state.arrow) {
      const theta = bumpAngleDeg != null ? (bumpAngleDeg * Math.PI) / 180 : 0;
      state.arrow.setDirection(new THREE.Vector3(Math.cos(theta), -Math.sin(theta), 0));
      state.arrow.visible = bumpAngleDeg != null;
    }
  }, [bumpAngleDeg, epgBins]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        ...(fillContainer ? { width: '100%', height: '100%', minHeight: 0, position: 'relative' } : {}),
      }}
    >
      <div
        ref={containerRef}
        style={{
          ...(fillContainer
            ? { flex: 1, width: '100%', minHeight: 0, borderRadius: 8, overflow: 'hidden' }
            : { width: size ?? 120, height: size ?? 120, borderRadius: 8, overflow: 'hidden' }),
        }}
        className="heading-compass-three"
      />
      {bumpAngleDeg != null && (
        <span style={{ fontSize: 10, color: '#aaa', flexShrink: 0 }}>{bumpAngleDeg.toFixed(0)}°</span>
      )}
    </div>
  );
}
