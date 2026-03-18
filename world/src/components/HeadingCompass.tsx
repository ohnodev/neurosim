/**
 * Exact copy of Visualization page compass: ring of EPG points (one per neuron),
 * hover tooltip (ID, hemilineage, flow, class, hemibrain_type, side, bin), same thin pink arrow.
 */
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchCompassEpgData, EPG_COMPASS_BINS, type CompassEpgNeuron } from '../lib/compassEpgData';

const SMOOTH_ALPHA = 0.18;
/** Fixed arrow length — never changes (direction only). */
const ARROW_LEN = 0.8;
const ACTIVE_RING_COLOR = new THREE.Color(0xff4fd8);
const INACTIVE_EPG_COLOR = new THREE.Color(0x4d6fb6);
const EPG_HEAT_ORANGE = new THREE.Color(0xff9f43);
const EPG_HEAT_RED = new THREE.Color(0xff3b30);
const HOVER_HIGHLIGHT_COLOR = new THREE.Color(0xffff88);
const HOVER_HIGHLIGHT_GLOW = new THREE.Color(0xffdd44);
const NO_GLOW_COLOR = new THREE.Color(0x000000);
const POINT_SIZE = 0.032;
const EPG_GLOW_SIZE = 0.13;
const EPG_GLOW_OPACITY = 0.52;
const RAYCASTER_THRESHOLD = 0.04;

function normalizeAngleDeg(deg: number): number {
  let a = deg;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

function shortestAngleLerpDeg(fromDeg: number, toDeg: number, alpha: number): number {
  const delta = normalizeAngleDeg(toDeg - fromDeg);
  return normalizeAngleDeg(fromDeg + delta * alpha);
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

export interface HeadingCompassProps {
  bumpAngleDeg: number | null;
  epgBins?: number[];
  size?: number;
}

export function HeadingCompass({ bumpAngleDeg, epgBins, size }: HeadingCompassProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [epgData, setEpgData] = useState<{ neurons: CompassEpgNeuron[]; positions: Float32Array } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bumpAngleDegRef = useRef<number | null>(null);
  const epgBinsRef = useRef<number[] | undefined>(undefined);
  const hoveredIndexRef = useRef<number | null>(null);
  bumpAngleDegRef.current = bumpAngleDeg;
  epgBinsRef.current = epgBins;

  const fillContainer = size == null;

  useEffect(() => {
    let cancelled = false;
    fetchCompassEpgData()
      .then((data) => {
        if (!cancelled) setEpgData(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load compass data');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !epgData) return;

    const { neurons, positions } = epgData;
    const n = neurons.length;
    if (n === 0) return;

    const w = Math.max(1, fillContainer ? container.clientWidth : size ?? 120);
    const h = Math.max(1, fillContainer ? container.clientHeight : size ?? 120);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a2435);

    const camera = new THREE.PerspectiveCamera(55, w / h, 0.01, 100);
    camera.position.set(0, 0, 1.25);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.1;
    controls.maxDistance = 4;

    const colors = new Float32Array(n * 3);
    const glowColors = new Float32Array(n * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    glowGeometry.setAttribute('color', new THREE.BufferAttribute(glowColors, 3));
    const glowColorAttr = glowGeometry.getAttribute('color') as THREE.BufferAttribute;

    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: POINT_SIZE,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 1.0,
        depthWrite: false,
      }),
    );
    scene.add(points);
    const glowTexture = createGlowTexture();
    const glowPoints = new THREE.Points(
      glowGeometry,
      new THREE.PointsMaterial({
        size: EPG_GLOW_SIZE,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: EPG_GLOW_OPACITY,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        map: glowTexture,
        alphaTest: 0.01,
      }),
    );
    scene.add(glowPoints);

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
    raycaster.params.Points.threshold = RAYCASTER_THRESHOLD;
    const pointer = new THREE.Vector2(2, 2);

    const onPointerMove = (evt: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((evt.clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points, false);
      if (hits.length === 0 || hits[0]?.index == null) {
        hoveredIndexRef.current = null;
        hoverTooltip.style.display = 'none';
        return;
      }
      const idx = hits[0].index as number;
      hoveredIndexRef.current = idx;
      const neuron = neurons[idx];
      if (!neuron) {
        hoverTooltip.style.display = 'none';
        return;
      }
      const lines: string[] = [neuron.root_id];
      if (neuron.hemilineage) lines.push('hemilineage: ' + neuron.hemilineage);
      if (neuron.flow) lines.push('flow: ' + neuron.flow);
      if (neuron.super_class) lines.push('super_class: ' + neuron.super_class);
      if (neuron.class) lines.push('class: ' + neuron.class);
      if (neuron.sub_class) lines.push('sub_class: ' + neuron.sub_class);
      if (neuron.cell_type) lines.push('cell_type: ' + neuron.cell_type);
      if (neuron.hemibrain_type) lines.push('hemibrain_type: ' + neuron.hemibrain_type);
      if (neuron.side) lines.push('side: ' + neuron.side);
      if (neuron.nerve) lines.push('nerve: ' + neuron.nerve);
      if (neuron.binLabel) lines.push('bin: ' + neuron.binLabel);
      hoverTooltip.textContent = lines.join('\n');
      hoverTooltip.style.left = `${Math.max(6, evt.clientX - rect.left + 12)}px`;
      hoverTooltip.style.top = `${Math.max(6, evt.clientY - rect.top + 12)}px`;
      hoverTooltip.style.display = 'block';
    };
    const onPointerLeave = () => {
      hoveredIndexRef.current = null;
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

    const arrowState = { angleCurrentDeg: 0, angleTargetDeg: 0 };

    scene.add(new THREE.AmbientLight(0xffffff, 0.95));

    const tempEpgInactive = INACTIVE_EPG_COLOR.clone().multiplyScalar(0.42);
    const tempEpgHot = new THREE.Color();
    const tempC = new THREE.Color();
    const tempG = new THREE.Color();

    let animationId: number;
    function tick() {
      animationId = requestAnimationFrame(tick);
      const deg = bumpAngleDegRef.current;
      const bins = epgBinsRef.current;
      if (deg != null) arrowState.angleTargetDeg = normalizeAngleDeg(deg);
      arrowState.angleCurrentDeg = shortestAngleLerpDeg(
        arrowState.angleCurrentDeg,
        arrowState.angleTargetDeg,
        SMOOTH_ALPHA,
      );
      const ad = (arrowState.angleCurrentDeg * Math.PI) / 180;
      const dir3 = new THREE.Vector3(Math.cos(ad), Math.sin(ad), 0).normalize();
      bumpArrow.setDirection(dir3);
      bumpArrow.setLength(ARROW_LEN, 0.07, 0.035);
      bumpArrow.setColor(ACTIVE_RING_COLOR);

      const maxVal = bins?.length ? Math.max(1e-8, ...bins) : 1;
      const hoveredIdx = hoveredIndexRef.current;
      for (let i = 0; i < n; i++) {
        const neuron = neurons[i]!;
        const t = bins ? (bins[neuron.bin] ?? 0) / maxVal : 0;
        if (hoveredIdx === i) {
          tempC.copy(HOVER_HIGHLIGHT_COLOR);
          tempG.copy(HOVER_HIGHLIGHT_GLOW);
        } else {
          tempEpgInactive.copy(INACTIVE_EPG_COLOR).multiplyScalar(0.42);
          if (t <= 0) {
            tempC.copy(tempEpgInactive);
          } else {
            tempEpgHot.copy(tempEpgInactive).lerp(EPG_HEAT_ORANGE, 0.45).lerp(EPG_HEAT_RED, t);
            tempC.copy(tempEpgInactive).lerp(tempEpgHot, t);
          }
          if (t <= 0) {
            tempG.copy(NO_GLOW_COLOR);
          } else {
            tempG.copy(INACTIVE_EPG_COLOR).lerp(EPG_HEAT_RED, t).multiplyScalar(0.22 + 1.1 * t * t);
          }
        }
        colorAttr.setXYZ(i, tempC.r, tempC.g, tempC.b);
        glowColorAttr.setXYZ(i, tempG.r, tempG.g, tempG.b);
      }
      colorAttr.needsUpdate = true;
      glowColorAttr.needsUpdate = true;

      controls.update();
      renderer.render(scene, camera);
    }
    tick();

    const ro = new ResizeObserver(() => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(animationId);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      if (container.contains(hoverTooltip)) container.removeChild(hoverTooltip);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      geometry.dispose();
      glowGeometry.dispose();
      (points.material as THREE.Material).dispose();
      (glowPoints.material as THREE.Material).dispose();
      glowTexture.dispose();
    };
  }, [epgData, size, fillContainer]);

  const wrapperStyle = {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    alignItems: 'center' as const,
    gap: 4,
    ...(fillContainer ? { width: '100%', height: '100%', minHeight: 0, position: 'relative' as const } : {}),
  };

  if (loadError) {
    return (
      <div style={wrapperStyle}>
        <div
          style={{
            flex: fillContainer ? 1 : undefined,
            width: fillContainer ? '100%' : size ?? 120,
            minHeight: fillContainer ? 0 : undefined,
            height: fillContainer ? undefined : size ?? 120,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#888',
            fontSize: 11,
          }}
        >
          {loadError}
        </div>
      </div>
    );
  }

  if (!epgData) {
    return (
      <div style={wrapperStyle}>
        <div
          style={{
            flex: fillContainer ? 1 : undefined,
            width: fillContainer ? '100%' : size ?? 120,
            minHeight: fillContainer ? 0 : undefined,
            height: fillContainer ? undefined : size ?? 120,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#888',
            fontSize: 11,
          }}
        >
          Loading compass…
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      <div
        ref={containerRef}
        style={{
          ...(fillContainer
            ? { flex: 1, width: '100%', minHeight: 0, borderRadius: 8, overflow: 'hidden' }
            : { width: size ?? 120, height: size ?? 120, borderRadius: 8, overflow: 'hidden' }),
        }}
        className="heading-compass-three"
      />
    </div>
  );
}
