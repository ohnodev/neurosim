//! Integration test: create sim, run step, verify output.
use brain_sim_service::sim::{BrainSim, FlyInput};

#[test]
fn test_create_and_step() {
    let neuron_ids = vec!["a".into(), "b".into(), "c".into()];
    let connections = vec![
        ("a".into(), "b".into(), 1.0),
        ("b".into(), "c".into(), 1.0),
    ];
    let mut sim = BrainSim::new(
        neuron_ids,
        connections,
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
    let (activity, activity_sparse, motor_left, motor_right, motor_fwd) =
        sim.step(1.0 / 30.0, fly, vec![], vec![]);
    assert_eq!(activity.len(), 3);
    assert!(activity.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 0.5));
    assert!(motor_left.is_finite());
    assert!(motor_right.is_finite());
    assert!(motor_fwd.is_finite());
    assert!(activity_sparse.values().all(|v| v.is_finite()));
}
