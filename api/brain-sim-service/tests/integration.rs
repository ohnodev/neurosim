//! Integration test: create sim, run step, verify output.
use brain_sim_service::sim::{BrainSim, FlyInput};
use std::time::Instant;

#[test]
fn test_create_and_step() {
    let neuron_ids = vec!["a".into(), "b".into(), "c".into()];
    let mut sim = BrainSim::new(
        neuron_ids,
        vec![0, 1],
        vec![1, 2],
        vec![1.0, 1.0],
        vec![0],
        vec![2],
        vec![],
        vec![],
        vec![],
        vec![],
        vec![],
    );
    let fly = FlyInput {
        x: 0.0,
        y: 0.0,
        z: 0.35,
        heading: 0.0,
        t: 0.0,
        hunger: 100.0,
        health: 100.0,
        rest_time_left: 0.0,
        dead: false,
    };
    let (activity, activity_sparse, _spike_ids, motor_left, motor_right, motor_fwd, _cl, _cr, _cf, _mlm, _mrm, _mfm, _timing, _fly_out) =
        sim.step(1.0 / 30.0, fly, vec![]);
    assert_eq!(activity.len(), 3);
    assert!(activity.iter().all(|v: &f32| v.is_finite() && *v >= 0.0 && *v <= 1.0));
    assert!(motor_left.is_finite());
    assert!(motor_right.is_finite());
    assert!(motor_fwd.is_finite());
    assert!(activity_sparse.values().all(|v: &f64| v.is_finite()));
}

/// Benchmark: 1000 steps with tiny (3-neuron) sim. Run with: cargo test bench_1000_steps_tiny -- --nocapture
#[test]
#[ignore]
fn bench_1000_steps_tiny() {
    let neuron_ids = vec!["a".into(), "b".into(), "c".into()];
    let mut sim = BrainSim::new(
        neuron_ids,
        vec![0, 1],
        vec![1, 2],
        vec![1.0, 1.0],
        vec![0],
        vec![2],
        vec![],
        vec![],
        vec![],
        vec![],
        vec![],
    );
    let dt = 0.0001;
    let mut fly = FlyInput {
        x: 0.0,
        y: 0.0,
        z: 0.35,
        heading: 0.0,
        t: 0.0,
        hunger: 100.0,
        health: 100.0,
        rest_time_left: 0.0,
        dead: false,
    };
    let n = 1000u32;
    let t0 = Instant::now();
    for _ in 0..n {
        let (_a, _as, _s, _ml, _mr, _mf, _cl, _cr, _cf, _mlm, _mrm, _mfm, _timing, fly_out) =
            sim.step(dt, fly, vec![]);
        fly = FlyInput {
            x: fly_out.x,
            y: fly_out.y,
            z: fly_out.z,
            heading: fly_out.heading,
            t: fly_out.t,
            hunger: fly_out.hunger,
            health: fly_out.health,
            rest_time_left: fly_out.rest_time_left,
            dead: fly_out.dead,
        };
    }
    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "[bench] tiny sim 1000 steps: {:.2} ms total, {:.4} ms/tick",
        elapsed_ms,
        elapsed_ms / n as f64
    );
    assert!(fly.t > 0.0);
}
