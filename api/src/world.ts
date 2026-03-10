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
  { id: 'food1', type: 'food', x: 8, y: 8, z: 2, radius: 12 },
  { id: 'food2', type: 'food', x: -6, y: 10, z: 2, radius: 12 },
  { id: 'food3', type: 'food', x: 5, y: -7, z: 2, radius: 12 },
  { id: 'light1', type: 'light', x: -5, y: -5, z: 3, radius: 15 },
];

export function getWorld() {
  return { sources: WORLD_SOURCES };
}
