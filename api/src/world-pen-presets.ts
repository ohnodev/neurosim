/**
 * World page: 3 stable compass positions (11PM, 3PM, 8PM) and PEN_a Hz presets.
 * All other L/R PEN_a neurons are 0; only the listed neurons get the given Hz.
 */

export type WorldCompassPosition = '11PM' | '3PM' | '8PM';

/** Clock positions in degrees (math convention: 0 = 3 o'clock, 90 = 12 o'clock). */
export const WORLD_COMPASS_DEG: Record<WorldCompassPosition, number> = {
  '11PM': 330,
  '3PM': 90,
  '8PM': 240,
};

/** 120° between positions. */
export const WORLD_COMPASS_STEP_DEG = 120;

export interface PenABySide {
  left: string[];
  right: string[];
}

/**
 * Build ratesById for each of the 3 positions. L1 = left[0], L2 = left[1], ... L10 = left[9];
 * R1 = right[0], ... R10 = right[9]. All neurons not listed are 0.
 */
export function getWorldPenPresets(penABySide: PenABySide): Record<WorldCompassPosition, Record<string, number>> {
  const { left, right } = penABySide;
  const empty = (): Record<string, number> => ({});

  const preset11PM = empty();
  if (left[0]) preset11PM[left[0]] = 50;
  if (left[1]) preset11PM[left[1]] = 50;
  if (left[5]) preset11PM[left[5]] = 50;

  const preset3PM = empty();
  if (left[2]) preset3PM[left[2]] = 50;
  if (right[5]) preset3PM[right[5]] = 70;

  const preset8PM = empty();
  if (left[3]) preset8PM[left[3]] = 50;
  if (left[8]) preset8PM[left[8]] = 50;
  if (right[0]) preset8PM[right[0]] = 60;

  return {
    '11PM': preset11PM,
    '3PM': preset3PM,
    '8PM': preset8PM,
  };
}

/** Order for snapping: 11PM, 3PM, 8PM. */
export const WORLD_COMPASS_POSITIONS: WorldCompassPosition[] = ['11PM', '3PM', '8PM'];
