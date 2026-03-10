/**
 * Shared world definition: attractors (food/light) the fly can sense and steer toward.
 * Same positions used by API (sim) and frontend (rendering).
 */

export interface WorldSource {
  id: string;
  type: 'food' | 'light';
  x: number;
  y: number;
  z: number;
  radius: number; // sense/attract radius
}

export const WORLD_SOURCES: WorldSource[] = [
  { id: 'food1', type: 'food', x: 6, y: 6, z: 2, radius: 12 },
];

export function getWorld() {
  return { sources: WORLD_SOURCES };
}
