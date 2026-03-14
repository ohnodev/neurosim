import * as THREE from 'three';

export interface LowLodFlyConfig {
  bodySize: [number, number, number];
  headSize: [number, number, number];
  wingSize: [number, number, number];
  bodyColor: number;
  headColor: number;
  wingColor: number;
  wingBaseAngle: number;
  wingFlapAmplitude: number;
  wingFlapSpeed: number;
}

export interface LowLodFlyResources {
  bodyGeom: THREE.BoxGeometry;
  headGeom: THREE.BoxGeometry;
  wingGeom: THREE.BoxGeometry;
  bodyMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  wingMat: THREE.MeshStandardMaterial;
  config: LowLodFlyConfig;
}

export interface LowLodFlyProxy {
  group: THREE.Group;
  wingPivotL: THREE.Group;
  wingPivotR: THREE.Group;
}

export function createLowLodFlyResources(config: LowLodFlyConfig): LowLodFlyResources {
  return {
    bodyGeom: new THREE.BoxGeometry(...config.bodySize),
    headGeom: new THREE.BoxGeometry(...config.headSize),
    wingGeom: new THREE.BoxGeometry(...config.wingSize),
    bodyMat: new THREE.MeshStandardMaterial({
      color: config.bodyColor,
      roughness: 0.95,
      metalness: 0.03,
    }),
    headMat: new THREE.MeshStandardMaterial({
      color: config.headColor,
      roughness: 0.95,
      metalness: 0.02,
    }),
    wingMat: new THREE.MeshStandardMaterial({
      color: config.wingColor,
      roughness: 0.9,
      metalness: 0.02,
    }),
    config,
  };
}

export function createLowLodFlyProxy(resources: LowLodFlyResources): LowLodFlyProxy {
  const g = new THREE.Group();
  const body = new THREE.Mesh(resources.bodyGeom, resources.bodyMat);
  const head = new THREE.Mesh(resources.headGeom, resources.headMat);
  const wingL = new THREE.Mesh(resources.wingGeom, resources.wingMat);
  const wingR = new THREE.Mesh(resources.wingGeom, resources.wingMat);
  const wingPivotL = new THREE.Group();
  const wingPivotR = new THREE.Group();

  head.position.set(0, 0.02, -0.38);
  wingPivotL.position.set(-0.12, 0.12, -0.04);
  wingPivotR.position.set(0.12, 0.12, -0.04);
  wingL.position.set(-0.21, 0, 0);
  wingR.position.set(0.21, 0, 0);

  wingPivotL.rotation.z = -resources.config.wingBaseAngle;
  wingPivotR.rotation.z = resources.config.wingBaseAngle;

  wingPivotL.add(wingL);
  wingPivotR.add(wingR);
  g.add(body, head, wingPivotL, wingPivotR);

  return { group: g, wingPivotL, wingPivotR };
}

export function applyLowLodWingPose(
  proxy: LowLodFlyProxy,
  resources: LowLodFlyResources,
  isFlying: boolean,
  timeMs: number,
  seed: number
): void {
  const { wingBaseAngle, wingFlapAmplitude, wingFlapSpeed } = resources.config;
  if (isFlying) {
    const flap = Math.sin((timeMs + seed) * wingFlapSpeed) * wingFlapAmplitude;
    proxy.wingPivotL.rotation.z = -wingBaseAngle + flap;
    proxy.wingPivotR.rotation.z = wingBaseAngle - flap;
    return;
  }
  proxy.wingPivotL.rotation.z = -wingBaseAngle;
  proxy.wingPivotR.rotation.z = wingBaseAngle;
}

export function disposeLowLodFlyResources(resources: LowLodFlyResources): void {
  resources.bodyGeom.dispose();
  resources.headGeom.dispose();
  resources.wingGeom.dispose();
  resources.bodyMat.dispose();
  resources.headMat.dispose();
  resources.wingMat.dispose();
}
