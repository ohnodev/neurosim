/**
 * Vanilla Three.js scene - runs entirely outside React.
 * Driven by refs; no React re-renders in the 3D pipeline.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { lerpFlyState } from './flyInterpolation';
import type { Snapshot } from './flyInterpolation';
import type { FlyState } from './simWsClient';
import type { WorldSource } from '../../../api/src/world';

export interface InterpolationDebugStats {
  fps: number;
  bufferLen: number;
  tDisplay: number;
  speed: number;
  rangeStart: number;
  rangeEnd: number;
}

export type CameraMode = 'god' | 'fly';

export interface ThreeSceneRefs {
  latestFliesRef: { current: FlyState[] };
  interpolatedBySimRef: { current: FlyState[] };
  debugStatsRef: { current: InterpolationDebugStats | null };
  cameraModeRef: { current: CameraMode };
  followSimIndexRef: { current: number | undefined };
  sourcesRef: { current: WorldSource[] };
  snapshotBufferRef: { current: Snapshot[] };
  targetRef: { current: { x: number; y: number; z: number; heading: number } | null };
}

const ARENA_SIZE = 48;
const LERP_RATE = 0.45;
const MAX_DELTA = 0.05;
const LANDING_Z_THRESHOLD = 1.2;
const LANDING_Z_BOOST = 4;
/** Wing animation: start as soon as fly leaves ground (z > 0.5), stop when back at rest */
const FLY_THRESHOLD_UP = 0.5;
const FLY_THRESHOLD_DOWN = 0.5;
const HEADING_LERP_RATE = 25;
const HEADING_SNAP_RAD = Math.PI * 0.5; // Snap to velocity when turn > 90°
const MIN_MOVEMENT_SQ = 1e-8; // Update heading on any movement so reversals respond instantly
const WING_ANIM_NAMES = ['wing-leftAction', 'wing-rightAction'];
const PULL_CLOSER_RATE = 1.1;
const FLY_VIEW_DISTANCE = 3;
const FLY_SCALE = 0.08;
/** Sim ground level (z=0.35); map to Three.js y=0 so fly rests on ground */
const GROUND_Z = 0.35;

function createCameraButton(
  slot: HTMLElement,
  cameraModeRef: { current: CameraMode }
): { el: HTMLButtonElement; update: (mode: CameraMode) => void } {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fly-viewer__camera-toggle';
  btn.title = 'Follow current fly';
  btn.style.cssText =
    'padding:6px 10px;font-size:11px;font-family:var(--font-mono,monospace);background:rgba(0,0,0,0.85);color:#aaf;border:1px solid rgba(100,100,140,0.3);border-radius:6px;cursor:pointer';
  const update = (mode: CameraMode) => {
    cameraModeRef.current = mode;
    btn.textContent = mode === 'god' ? 'Fly view' : 'God view';
    btn.title = mode === 'god' ? 'Follow current fly' : 'Orbit view';
    btn.style.background = mode === 'fly' ? 'rgba(35, 70, 138, 0.6)' : 'rgba(0,0,0,0.85)';
  };
  btn.addEventListener('click', () => {
    update(cameraModeRef.current === 'god' ? 'fly' : 'god');
  });
  update('god');
  slot.appendChild(btn);
  return { el: btn, update };
}

export function initThreeScene(
  container: HTMLElement | null,
  refs: ThreeSceneRefs,
  buttonSlot: HTMLElement | null
): { dispose: () => void; updateButton: (mode: CameraMode) => void } {
  const noop = () => {};
  if (!container) return { dispose: noop, updateButton: noop };

  let cameraButton: { el: HTMLButtonElement; update: (mode: CameraMode) => void } | null = null;
  if (buttonSlot) {
    cameraButton = createCameraButton(buttonSlot, refs.cameraModeRef);
  }
  const updateButton = (mode: CameraMode) => {
    if (cameraButton) {
      cameraButton.update(mode);
    }
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(8, 6, 8);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 10, 5);
  dirLight.castShadow = true;
  scene.add(dirLight);

  const groundGeom = new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x2d5a27, roughness: 0.9, metalness: 0.05 });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.maxDistance = 1000;
  controls.target.set(0, 0, 0);

  const sourcesGroup = new THREE.Group();
  scene.add(sourcesGroup);

  const fliesGroup = new THREE.Group();
  scene.add(fliesGroup);

  let flyTemplate: THREE.Group | null = null;
  let flyClips: THREE.AnimationClip[] = [];
  let appleTemplate: THREE.Group | null = null;
  const mixers: THREE.AnimationMixer[] = [];
  const flyInstances: {
    group: THREE.Group;
    mixer: THREE.AnimationMixer;
    prevPos: { x: number; y: number };
    heading: number;
    targetHeading: number;
    wasFlying: boolean;
    initialized: boolean;
    wingActions: THREE.AnimationAction[];
  }[] = [];

  const loader = new GLTFLoader();
  loader.load(
    '/models/fly-animated/fly2-animation.glb',
    (gltf) => {
      const src = gltf.scene;
      flyTemplate = src.clone(true);
      flyClips = gltf.animations;
    },
    undefined,
    (err) => console.error('[threeScene] fly load error:', err)
  );
  loader.load(
    '/models/low-poly_apple/scene.gltf',
    (gltf) => {
      appleTemplate = gltf.scene.clone(true);
    },
    undefined,
    (err) => console.error('[threeScene] apple load error:', err)
  );

  let flyStates: FlyState[] = [];
  let lastSources: WorldSource[] = [];
  const smoothDeltaRef = { current: 0.016 };
  const timer = new THREE.Timer();
  let rafId = 0;
  let disposed = false;

  function disposeObject3D(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => { m.dispose(); });
        else o.material?.dispose();
      }
    });
  }

  /** Clone object tree and give each mesh its own geometry/material so dispose doesn't break shared refs. */
  function cloneWithOwnResources(obj: THREE.Object3D): THREE.Object3D {
    const clone = obj.clone(true);
    clone.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (o.geometry) o.geometry = o.geometry.clone();
        if (Array.isArray(o.material)) o.material = o.material.map((m) => m.clone());
        else if (o.material) o.material = o.material.clone();
      }
    });
    return clone;
  }

  function createSourceObject(s: WorldSource): THREE.Object3D {
    if (s.type === 'food' && appleTemplate) {
      const clone = cloneWithOwnResources(appleTemplate);
      clone.scale.setScalar(1.2);
      return clone;
    }
    const geom = new THREE.SphereGeometry(0.8, 24, 24);
    const mat =
      s.type === 'food'
        ? new THREE.MeshStandardMaterial({ color: 0xe8a838 })
        : new THREE.MeshStandardMaterial({ color: 0x4488ff, emissive: 0x4488ff, emissiveIntensity: 0.6 });
    return new THREE.Mesh(geom, mat);
  }

  function updateWorldSources(sources: WorldSource[]): void {
    while (sourcesGroup.children.length > 0) {
      const c = sourcesGroup.children[0];
      sourcesGroup.remove(c);
      disposeObject3D(c);
    }
    for (const s of sources) {
      const obj = createSourceObject(s);
      obj.position.set(s.x, s.z, s.y);
      sourcesGroup.add(obj);
    }
  }

  function ensureFlyCount(count: number) {
    while (flyInstances.length > count) {
      const inst = flyInstances.pop()!;
      const mixIdx = mixers.indexOf(inst.mixer);
      if (mixIdx >= 0) mixers.splice(mixIdx, 1);
      fliesGroup.remove(inst.group);
      inst.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry?.dispose();
          if (Array.isArray(o.material)) o.material.forEach((m) => { m.dispose(); });
          else o.material?.dispose();
        }
      });
    }
    while (flyInstances.length < count && flyTemplate && flyClips.length > 0) {
      const clone = cloneWithOwnResources(flyTemplate) as THREE.Group;
      clone.scale.setScalar(FLY_SCALE);
      const instMixer = new THREE.AnimationMixer(clone);
      mixers.push(instMixer);
      const instWingActions = WING_ANIM_NAMES.map((name) => {
        const clip = flyClips.find((c) => c.name === name);
        return clip ? instMixer.clipAction(clip) : (null as unknown as THREE.AnimationAction);
      }).filter(Boolean) as THREE.AnimationAction[];
      fliesGroup.add(clone);
      flyInstances.push({
        group: clone,
        mixer: instMixer,
        prevPos: { x: 0, y: 0 },
        heading: 0,
        targetHeading: 0,
        wasFlying: false,
        initialized: false,
        wingActions: instWingActions,
      });
    }
  }

  function loop(timestamp?: number) {
    if (disposed) return;
    rafId = requestAnimationFrame(loop);

    timer.update(timestamp);
    const rawDelta = timer.getDelta();
    const rawCapped = Math.min(rawDelta, MAX_DELTA);
    smoothDeltaRef.current += (rawCapped - smoothDeltaRef.current) * 0.1;
    const cappedDelta = smoothDeltaRef.current;

    const target = refs.latestFliesRef.current;
    if (target.length > 0) {
      const alpha = Math.min(1, 1 - Math.exp(-LERP_RATE * cappedDelta));
      const cur = flyStates;
      const result: FlyState[] = [];
      for (let i = 0; i < target.length; i++) {
        const t = target[i]!;
        const s = cur[i];
        const tz = t.z ?? 1;
        const zAlpha = tz < LANDING_Z_THRESHOLD ? Math.min(1, alpha * LANDING_Z_BOOST) : undefined;
        result.push(s ? lerpFlyState(s, t, alpha, zAlpha) : t);
      }
      flyStates = result;
      refs.interpolatedBySimRef.current = result;

      const tDisplay = result[0]?.t ?? 0;
      const buf = refs.snapshotBufferRef.current;
      let sources: WorldSource[] = refs.sourcesRef.current;
      for (let i = buf.length - 1; i >= 0; i--) {
        const snap = buf[i]!;
        if (snap.t <= tDisplay && snap.sources != null) {
          sources = snap.sources;
          break;
        }
      }
      if (sources !== lastSources) {
        lastSources = sources;
        updateWorldSources(sources);
      }

      refs.debugStatsRef.current = {
          fps: rawDelta > 0 ? 1 / rawDelta : 0,
          bufferLen: buf.length,
          tDisplay,
          speed: 1,
          rangeStart: buf[0]?.t ?? 0,
          rangeEnd: buf[buf.length - 1]?.t ?? 0,
        };
    } else {
      flyStates = [];
      refs.interpolatedBySimRef.current = [];
      refs.debugStatsRef.current = null;
      const fallbackSources = refs.sourcesRef.current;
      if (fallbackSources !== lastSources) {
        lastSources = fallbackSources;
        updateWorldSources(fallbackSources);
      }
    }

    ensureFlyCount(flyStates.length);

    for (let i = 0; i < flyInstances.length; i++) {
      const inst = flyInstances[i]!;
      const state = flyStates[i];
      if (!state || !inst.group) continue;

      const x = state.x ?? 0;
      const y = state.y ?? 0;
      const z = state.z ?? 0;
      const wasFlying = inst.wasFlying;
      const isFlying = wasFlying ? z > FLY_THRESHOLD_DOWN : z > FLY_THRESHOLD_UP;

      const dx = x - inst.prevPos.x;
      const dy = y - inst.prevPos.y;
      inst.prevPos = { x, y };
      const moveSq = dx * dx + dy * dy;
      if (moveSq > MIN_MOVEMENT_SQ) {
        const velocityHeading = Math.atan2(dx, dy) + Math.PI;
        inst.targetHeading = velocityHeading;
        let d = velocityHeading - inst.heading;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(d) > HEADING_SNAP_RAD) {
          inst.heading = velocityHeading;
        } else {
          const headingAlpha = Math.min(1, 1 - Math.exp(-HEADING_LERP_RATE * Math.min(cappedDelta, 0.05)));
          inst.heading += d * headingAlpha;
        }
      }
      if (!inst.initialized) {
        inst.heading = inst.targetHeading;
        inst.initialized = true;
      }

      const visualZ = Math.max(0, z - GROUND_Z);
      inst.group.position.set(x, visualZ, y);
      inst.group.rotation.y = inst.heading;

      if (isFlying !== inst.wasFlying) {
        inst.wasFlying = isFlying;
        for (const action of inst.wingActions) {
          if (isFlying) {
            action.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveTimeScale(2).play();
          } else {
            action.stop();
          }
        }
      }
    }

    for (const m of mixers) m.update(cappedDelta);

    if (refs.cameraModeRef.current === 'fly') {
      const idx = refs.followSimIndexRef.current ?? -1;
      const fly = refs.interpolatedBySimRef.current[idx] as { x?: number; y?: number; z?: number } | undefined;
      let want: THREE.Vector3;
      if (fly && typeof fly.x === 'number' && typeof fly.y === 'number' && typeof fly.z === 'number') {
        const vz = Math.max(0, (fly.z ?? 0) - GROUND_Z);
        want = new THREE.Vector3(fly.x, vz, fly.y);
      } else {
        const t = refs.targetRef.current;
        if (t) {
          const vz = Math.max(0, (t.z ?? 0) - GROUND_Z);
          want = new THREE.Vector3(t.x, vz, t.y);
        } else {
          want = controls.target;
        }
      }
      const deltaPos = want.clone().sub(controls.target);
      controls.target.copy(want);
      camera.position.add(deltaPos);

      const dist = camera.position.distanceTo(controls.target);
      if (dist > FLY_VIEW_DISTANCE) {
        const dir = camera.position.clone().sub(controls.target).normalize();
        const desired = controls.target.clone().add(dir.multiplyScalar(FLY_VIEW_DISTANCE));
        const pullAlpha = Math.min(1, 1 - Math.exp(-PULL_CLOSER_RATE * cappedDelta));
        camera.position.lerp(desired, pullAlpha);
      }
    }

    controls.update(cappedDelta);
    renderer.render(scene, camera);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  updateWorldSources(refs.sourcesRef.current);
  rafId = requestAnimationFrame(loop);

  const dispose = () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    controls.dispose();
    renderer.dispose();
    groundGeom.dispose();
    groundMat.dispose();
    container.removeChild(renderer.domElement);
    if (cameraButton) {
      cameraButton.el.remove();
    }
    for (const inst of flyInstances) {
      disposeObject3D(inst.group);
    }
    for (const c of sourcesGroup.children.slice()) {
      sourcesGroup.remove(c);
      disposeObject3D(c);
    }
    if (flyTemplate) disposeObject3D(flyTemplate);
    if (appleTemplate) disposeObject3D(appleTemplate);
  };
  return { dispose, updateButton };
}
