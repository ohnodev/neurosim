use brain_sim_service::sim::{BrainSim, FlyInput, SourceInput};

fn default_fly(t: f64) -> FlyInput {
    FlyInput {
        x: 0.0,
        y: 0.0,
        z: 0.35,
        heading: 0.0,
        t,
        hunger: 30.0,
        health: 100.0,
        rest_time_left: 0.0,
        dead: false,
    }
}

#[test]
fn sensory_path_runs_with_recurrent_edges() {
    let neuron_ids = vec!["n0".to_string(), "n1".to_string()];
    let edges_pre = vec![0u32; 32];
    let edges_post = vec![1u32; 32];
    let edges_weight = vec![10.0f32; 32];
    let mut sim = BrainSim::new(
        neuron_ids,
        edges_pre,
        edges_post,
        edges_weight,
        vec![0],
        vec![],
        vec![],
        vec![],
    );
    for i in 0..120 {
        let sources = vec![SourceInput {
            id: "food-1".to_string(),
            x: 1.2,
            y: 0.0,
            radius: 2.5,
        }];
        let (_activity, activity_sparse, ml, mr, mf, timing, fly_out) =
            sim.step(0.001, default_fly(i as f64 * 0.001), sources);
        assert!(ml.is_finite() && mr.is_finite() && mf.is_finite());
        assert!(timing.compute_ms.is_finite());
        assert!(timing.kernel_ms.is_finite());
        assert!(timing.recurrent_ms.is_finite());
        assert!(timing.lif_ms.is_finite());
        assert!(timing.readout_ms.is_finite());
        assert!(fly_out.t.is_finite());
        assert!(fly_out.hunger.is_finite());
        assert!(fly_out.health.is_finite());
        assert!(activity_sparse.values().all(|v| v.is_finite()));
    }
}

#[test]
fn sensory_only_single_neuron_step_is_stable() {
    let neuron_ids = vec!["n0".to_string()];
    let mut sim = BrainSim::new(
        neuron_ids,
        vec![],
        vec![],
        vec![],
        vec![0],
        vec![],
        vec![],
        vec![],
    );
    let mut last_t = 0.0;
    for i in 0..200 {
        let sources = vec![SourceInput {
            id: "food-1".to_string(),
            x: 1.2,
            y: 0.0,
            radius: 2.5,
        }];
        let (_activity, activity_sparse, ml, mr, mf, timing, fly_out) =
            sim.step(0.001, default_fly(i as f64 * 0.001), sources);
        assert!(ml.is_finite() && mr.is_finite() && mf.is_finite());
        assert!(timing.compute_ms.is_finite());
        assert!(timing.kernel_ms.is_finite());
        assert!(timing.recurrent_ms.is_finite());
        assert!(timing.lif_ms.is_finite());
        assert!(timing.readout_ms.is_finite());
        assert!(fly_out.t >= last_t);
        last_t = fly_out.t;
        assert!(activity_sparse.values().all(|v| v.is_finite()));
    }
}

