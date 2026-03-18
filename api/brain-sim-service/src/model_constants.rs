/// LIF and synapse constants; match Brian2 / fly-brain (Shiu et al. Nature 2024).
/// Recurrent input = synapse_count * W_SYN (one scale from the model, no extra tuning).
pub const V_REST: f32 = -52.0;
pub const V_RESET: f32 = -52.0;
pub const V_THRESH: f32 = -45.0;
pub const TAU_MEM_MS: f32 = 20.0;
pub const TAU_SYN_MS: f32 = 5.0;
/// Default weight per synapse (w_syn), matching Python runtime (W_SYN_MV=0.339).
/// Override with NEUROSIM_W_SYN to tune.
pub const W_SYN: f32 = 0.339;
/// Python parity: additional multiplier for EPG->EPG recurrent contributions.
/// 1.0 disables boost; Python service currently uses 4.0.
pub const EPG_RECURRENCE_BOOST: f32 = 4.0;
/// Refractory period in ms after a spike. Brian2 equivalent: NeuronGroup(..., refractory=2.2*ms).
/// Python/fly-brain use the same value (tRefrac = 2.2). During refractory, the neuron cannot spike.
pub const REFRACT_MS: f32 = 2.2;
