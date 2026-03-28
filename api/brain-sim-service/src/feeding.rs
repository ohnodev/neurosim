use std::collections::{HashMap, HashSet};

// Tune sugar so one max world feeding lock window can deplete one source.
pub const FOOD_SUGAR_CAPACITY: f64 = 99.0;
pub const FEED_DURATION_SEC: f64 = 1.2;
pub const FEED_SUGAR_PER_SEC: f64 = FOOD_SUGAR_CAPACITY / FEED_DURATION_SEC;
pub const HUNGER_PER_SUGAR: f64 = 0.5;
pub const HEALTH_PER_SUGAR: f64 = 0.5;

#[derive(Default)]
pub struct FoodState {
    sugar_by_id: HashMap<String, f64>,
}

impl FoodState {
    pub fn sync<I>(&mut self, source_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        let live_ids: HashSet<String> = source_ids.into_iter().collect();
        self.sugar_by_id.retain(|id, _| live_ids.contains(id));
        for id in live_ids {
            self.sugar_by_id.entry(id).or_insert(FOOD_SUGAR_CAPACITY);
        }
    }

    pub fn take_sugar_with_depletion(&mut self, source_id: &str, requested: f64) -> (f64, bool) {
        if requested <= 0.0 {
            return (0.0, false);
        }
        let Some(remaining) = self.sugar_by_id.get_mut(source_id) else {
            return (0.0, false);
        };
        if *remaining <= 0.0 {
            return (0.0, false);
        }
        let was_positive = *remaining > 0.0;
        let taken = requested.min(*remaining);
        *remaining -= taken;
        let just_depleted = was_positive && *remaining <= 0.0;
        (taken, just_depleted)
    }

    pub fn take_sugar(&mut self, source_id: &str, requested: f64) -> f64 {
        self.take_sugar_with_depletion(source_id, requested).0
    }

    pub fn depleted(&self, source_id: &str) -> bool {
        self.sugar_by_id
            .get(source_id)
            .map(|v| *v <= 0.0)
            .unwrap_or(true)
    }
}
