/**
 * World page: 3 stable compass positions (11PM, 3PM, 8PM) and PEN_a Hz presets.
 * Matches visualization page live sim exactly: same PEN_a list (from API /pen-a-neurons),
 * same L1/L2/L6 = left[0], left[1], left[5] at 50 Hz when 11PM.
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

/** Same dt as visualization live sim (NEUROSIM_LIVE_DT_SEC). */
export const WORLD_SIM_DT_SEC = 0.0001;

/**
 * Build ratesById for each of the 3 positions.
 * 11PM: L1, L2, L6 (left[0], left[1], left[5]) at 50 Hz — same as viz when you set L1=50, L2=50, L6=50 and Apply.
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
