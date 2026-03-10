/**
 * Dynamic world: attractors (food/light) the fly can sense and steer toward.
 * API spawns food periodically and removes it when eaten.
 */

export interface WorldSource {
  id: string;
  type: 'food' | 'light';
  x: number;
  y: number;
  z: number;
  radius: number;
}

const ARENA = 24;
const GROUND_Z = 0.35;

const sources: WorldSource[] = [];
let nextFoodId = 1;

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function spawnFood(): WorldSource | null {
  if (sources.filter((s) => s.type === 'food').length >= 2) return null;
  const id = `food${nextFoodId++}`;
  const source: WorldSource = {
    id,
    type: 'food',
    x: randomInRange(-ARENA + 2, ARENA - 2),
    y: randomInRange(-ARENA + 2, ARENA - 2),
    z: GROUND_Z,
    radius: 12,
  };
  sources.push(source);
  return source;
}

export function removeFood(id: string): void {
  const idx = sources.findIndex((s) => s.id === id);
  if (idx >= 0) sources.splice(idx, 1);
}

export function getSources(): WorldSource[] {
  return sources.slice();
}

export function getWorld() {
  return { sources };
}
