//! Focused test: load real connectome, create sim, run 30 steps.
//! Proves the Rust service can simulate flies. Run with: cargo test -p brain-sim-service test_flies_simulate
use brain_sim_service::connectome;
use brain_sim_service::sim::{BrainSim, FlyInput, SourceInput};
use std::path::Path;

#[test]
fn test_flies_simulate() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let connectome_path = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("data/connectome-subset.json"))
        .filter(|p| p.exists())
        .expect("connectome-subset.json not found (run from neurosim root)");

    let template = connectome::load_connectome(&connectome_path).expect("load connectome");
    assert!(!template.neuron_ids.is_empty());
    assert!(!template.edges_pre.is_empty());

    let mut sim = BrainSim::new(
        template.neuron_ids.clone(),
        template.edges_pre.clone(),
        template.edges_post.clone(),
        template.edges_weight.clone(),
        template.sensory_indices.clone(),
        template.motor_left.clone(),
        template.motor_right.clone(),
        template.motor_unknown.clone(),
    );

    let dt = 1.0 / 30.0;
    let mut t = 0.0f64;
    let mut x = 2.0f64;
    let mut hunger = 80.0f64;

    for _ in 0..30 {
        let fly = FlyInput {
            x,
            y: 1.0,
            z: 0.35,
            heading: 0.0,
            t,
            hunger,
            health: 100.0,
            rest_time_left: 0.0,
            dead: false,
        };
        let food = vec![SourceInput {
            id: "food1".to_string(),
            x: 3.0,
            y: 1.0,
            radius: 2.5,
        }];
        let (activity, activity_sparse, motor_left, motor_right, motor_fwd, _timing, _fly_out) =
            sim.step(dt, fly, food);

        assert_eq!(activity.len(), template.neuron_ids.len());
        assert!(activity.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0));
        assert!(motor_left.is_finite() && motor_right.is_finite() && motor_fwd.is_finite());
        assert!(activity_sparse.values().all(|v| v.is_finite()));

        t += dt;
        x += 0.01 * (motor_left + motor_right + motor_fwd);
        hunger = (hunger - 0.5 * dt).max(0.0);
    }
}
