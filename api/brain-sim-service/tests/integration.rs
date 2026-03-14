//! Integration test: create sim, run step, verify output.
use brain_sim_service::sim::{BrainSim, FlyInput};

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
    };
    let (activity, activity_sparse, motor_left, motor_right, motor_fwd, _timing) =
        sim.step(1.0 / 30.0, fly, vec![], vec![]);
    assert_eq!(activity.len(), 3);
    assert!(activity.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0));
    assert!(motor_left.is_finite());
    assert!(motor_right.is_finite());
    assert!(motor_fwd.is_finite());
    assert!(activity_sparse.values().all(|v| v.is_finite()));
}
