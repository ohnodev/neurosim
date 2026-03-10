/** Canonical fly state; shared by brain-sim and web simWsClient. */
export interface FlyState {
  x: number;
  y: number;
  z: number;
  heading: number;
  t: number;
  hunger: number;
  /** 0–100; drains when hunger is 0; 0 = dead */
  health?: number;
  /** true when health has drained to 0 */
  dead?: boolean;
  /** 0–1, flight energy; 0 = must rest */
  flyTimeLeft?: number;
  /** seconds left in rest; 0 = not resting */
  restTimeLeft?: number;
  /** max rest duration (seconds) for UI progress */
  restDuration?: number;
  /** true when eating at food source */
  feeding?: boolean;
}
