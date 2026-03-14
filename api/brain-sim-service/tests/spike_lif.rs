use brain_sim_service::sim::{BrainSim, FlyInput, PendingStimInput};

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
    }
}

#[test]
fn spike_propagates_to_downstream_neuron() {
    let neuron_ids = vec!["n0".to_string(), "n1".to_string()];
    let edges_pre = vec![0u32; 32];
    let edges_post = vec![1u32; 32];
    let edges_weight = vec![10.0f32; 32];
    let mut sim = BrainSim::new(
        neuron_ids,
        edges_pre,
        edges_post,
        edges_weight,
        vec![],
        vec![],
        vec![],
        vec![],
    );
    let mut saw_n1 = false;
    for i in 0..50 {
        let mut boosted_ids = Vec::with_capacity(120);
        for _ in 0..120 {
            boosted_ids.push("n0".to_string());
        }
        let pending = vec![PendingStimInput {
            neuron_ids: boosted_ids,
            strength: 2.0,
        }];
        let (_activity, activity_sparse, _ml, _mr, _mf, _timing) =
            sim.step(0.001, default_fly(i as f64 * 0.001), vec![], pending);
        if activity_sparse.contains_key("n1") {
            saw_n1 = true;
            break;
        }
    }

    assert!(saw_n1, "downstream neuron should spike due to recurrent propagation");
}

#[test]
fn refractory_prevents_every_step_spiking() {
    let neuron_ids = vec!["n0".to_string()];
    let mut sim = BrainSim::new(
        neuron_ids,
        vec![],
        vec![],
        vec![],
        vec![],
        vec![],
        vec![],
        vec![],
    );
    let mut spike_steps = Vec::new();
    for i in 0..20 {
        let mut boosted_ids = Vec::with_capacity(120);
        for _ in 0..120 {
            boosted_ids.push("n0".to_string());
        }
        let pending = vec![PendingStimInput {
            neuron_ids: boosted_ids,
            strength: 2.0,
        }];
        let (_activity, activity_sparse, _ml, _mr, _mf, _timing) =
            sim.step(0.001, default_fly(i as f64 * 0.001), vec![], pending);
        if activity_sparse.contains_key("n0") {
            spike_steps.push(i);
        }
    }

    assert!(!spike_steps.is_empty(), "stimulated neuron should spike at least once");
    // Refractory is > 2 steps at dt=1ms, so spikes should not happen every step.
    for window in spike_steps.windows(2) {
        assert!(window[1] - window[0] >= 2);
    }
}

