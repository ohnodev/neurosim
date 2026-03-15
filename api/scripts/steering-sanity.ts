import { createBrainSim } from '../src/brain-sim.js';
import { loadConnectome } from '../src/connectome.js';

type Source = { id: string; type: 'food'; x: number; y: number; z: number; radius: number };

function normalizeAngle(a: number): number {
  let out = a;
  while (out > Math.PI) out -= 2 * Math.PI;
  while (out < -Math.PI) out += 2 * Math.PI;
  return out;
}

async function runScenario(name: string, sources: Source[], steps = 240, dt = 1 / 30): Promise<void> {
  const connectome = loadConnectome();
  const sim = await createBrainSim(connectome, sources, {
    x: 0,
    y: 0,
    z: 1.0,
    heading: 0,
    t: 0,
    hunger: 40,
    health: 100,
  });

  let state = sim.getState();
  let sumTurn = 0;
  let posTurns = 0;
  let negTurns = 0;
  let sumMotorCountDiff = 0;
  let sumMotorMagDiff = 0;
  let sumMotorScaledDiff = 0;

  for (let i = 0; i < steps; i++) {
    const prevHeading = state.fly.heading ?? 0;
    state = await sim.step(dt, { includeActivity: false });
    const nextHeading = state.fly.heading ?? 0;
    const d = normalizeAngle(nextHeading - prevHeading);
    sumTurn += d;
    if (d > 0) posTurns += 1;
    if (d < 0) negTurns += 1;
    sumMotorCountDiff += (state.motorRightCount ?? 0) - (state.motorLeftCount ?? 0);
    sumMotorMagDiff += (state.motorRightMagnitude ?? 0) - (state.motorLeftMagnitude ?? 0);
    sumMotorScaledDiff += (state.motorRight ?? 0) - (state.motorLeft ?? 0);
  }

  const avgTurn = sumTurn / steps;
  const avgCountDiff = sumMotorCountDiff / steps;
  const avgMagDiff = sumMotorMagDiff / steps;
  const avgScaledDiff = sumMotorScaledDiff / steps;
  const dominant = posTurns === negTurns ? 'mixed' : posTurns > negTurns ? 'left(+)' : 'right(-)';
  console.log(
    JSON.stringify({
      scenario: name,
      steps,
      avg_turn_rad_per_step: Number(avgTurn.toFixed(5)),
      cumulative_turn_rad: Number(sumTurn.toFixed(4)),
      turn_sign_pos_steps: posTurns,
      turn_sign_neg_steps: negTurns,
      dominant_turn: dominant,
      avg_motor_count_diff_r_minus_l: Number(avgCountDiff.toFixed(4)),
      avg_motor_mag_diff_r_minus_l: Number(avgMagDiff.toFixed(4)),
      avg_motor_scaled_diff_r_minus_l: Number(avgScaledDiff.toFixed(6)),
      final_heading_rad: Number((state.fly.heading ?? 0).toFixed(4)),
    }),
  );
}

async function main(): Promise<void> {
  const z = 0.35;
  const r = 3.2;
  await runScenario('left-only', [{ id: 'left', type: 'food', x: 0, y: 12, z, radius: r }]);
  await runScenario('right-only', [{ id: 'right', type: 'food', x: 0, y: -12, z, radius: r }]);
  await runScenario('ahead-only', [{ id: 'ahead', type: 'food', x: 12, y: 0, z, radius: r }]);
  await runScenario('both-symmetric', [
    { id: 'left', type: 'food', x: 0, y: 12, z, radius: r },
    { id: 'right', type: 'food', x: 0, y: -12, z, radius: r },
  ]);
}

main().catch((err) => {
  console.error('[steering-sanity] failed:', err);
  process.exitCode = 1;
});
