/// `V_REST` and `V_RESET` are intentionally equal so spikes/refractory
/// perform a direct reset to baseline (`v_rest == v_reset` behavior).
pub const V_REST: f32 = -52.0;
pub const V_RESET: f32 = -52.0;
pub const V_THRESH: f32 = -45.0;
pub const TAU_MEM_MS: f32 = 20.0;
pub const TAU_SYN_MS: f32 = 5.0;
pub const RECURRENT_SCALE: f32 = 0.275;
pub const REFRACT_MS: f32 = 2.2;
