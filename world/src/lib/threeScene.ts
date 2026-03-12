/**
 * Vanilla Three.js scene - runs entirely outside React.
 * Driven by refs; no React re-renders in the 3D pipeline.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { lerpFlyState } from './flyInterpolation';
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
  targetRef: { current: { x: number; y: number; z: number; heading: number } | null };
}

const ARENA_SIZE = 48;
const LERP_RATE = 0.45;
const MAX_DELTA = 0.05;
const LANDING_Z_THRESHOLD = 1.0;
const LANDING_Z_BOOST = 2;
const FLY_THRESHOLD_UP = 1.15;
const FLY_THRESHOLD_DOWN = 1.0;
const HEADING_LERP_RATE = 6;
const HEADING_DEAD_ZONE = 0.15;
const MIN_MOVEMENT_SQ = 0.001;
const WING_ANIM_NAMES = ['wing-leftAction', 'wing-rightAction'];
const PULL_CLOSER_RATE = 1.1;
const FLY_VIEW_DISTANCE = 3;
const FLY_SCALE = 0.08;

export function initThreeScene(
  container: HTMLElement | null,
  refs: ThreeSceneRefs
): () => void {
  if (!container) return () => {};

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
  const clock = new THREE.Clock();
  let rafId = 0;
  let disposed = false;

  function disposeObject3D(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose();
      }
    });
  }

  function createSourceObject(s: WorldSource): THREE.Object3D {
    if (s.type === 'food' && appleTemplate) {
      const clone = appleTemplate.clone(true);
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
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material?.dispose();
        }
      });
    }
    while (flyInstances.length < count && flyTemplate && flyClips.length > 0) {
      const clone = flyTemplate.clone(true);
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

  function loop() {
    if (disposed) return;
    rafId = requestAnimationFrame(loop);

    const rawDelta = clock.getDelta();
    const rawCapped = Math.min(rawDelta, MAX_DELTA);
    smoothDeltaRef.current += (rawCapped - smoothDeltaRef.current) * 0.1;
    const cappedDelta = smoothDeltaRef.current;

    const sources = refs.sourcesRef.current;
    if (sources !== lastSources) {
      lastSources = sources;
      updateWorldSources(sources);
    }

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

      refs.debugStatsRef.current = {
          fps: rawDelta > 0 ? 1 / rawDelta : 0,
          bufferLen: 0,
          tDisplay: result[0]?.t ?? 0,
          speed: 1,
          rangeStart: 0,
          rangeEnd: 0,
        };
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
        const newTarget = Math.atan2(dx, dy) + Math.PI;
        let diff = newTarget - inst.targetHeading;
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(diff) > HEADING_DEAD_ZONE) inst.targetHeading = newTarget;
      }
      if (!inst.initialized) {
        inst.heading = inst.targetHeading;
        inst.initialized = true;
      }

      inst.group.position.set(x, z, y);

      const headingAlpha = Math.min(1, 1 - Math.exp(-HEADING_LERP_RATE * Math.min(cappedDelta, 0.05)));
      let d = inst.targetHeading - inst.heading;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      inst.heading += d * headingAlpha;
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
        want = new THREE.Vector3(fly.x, fly.z, fly.y);
      } else {
        const t = refs.targetRef.current;
        if (t) {
          want = new THREE.Vector3(t.x, t.z, t.y);
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

  return () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    controls.dispose();
    renderer.dispose();
    groundGeom.dispose();
    groundMat.dispose();
    container.removeChild(renderer.domElement);
    for (const inst of flyInstances) {
      inst.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry?.dispose();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material?.dispose();
        }
      });
    }
  };
}
