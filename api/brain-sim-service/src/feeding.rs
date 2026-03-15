use std::collections::{HashMap, HashSet};

pub const FOOD_SUGAR_CAPACITY: f64 = 100.0;
pub const FEED_DURATION_SEC: f64 = 5.0;
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

    pub fn take_sugar(&mut self, source_id: &str, requested: f64) -> f64 {
        if requested <= 0.0 {
            return 0.0;
        }
        let remaining = self
            .sugar_by_id
            .entry(source_id.to_string())
            .or_insert(FOOD_SUGAR_CAPACITY);
        if *remaining <= 0.0 {
            return 0.0;
        }
        let taken = requested.min(*remaining);
        *remaining -= taken;
        taken
    }

    pub fn depleted(&self, source_id: &str) -> bool {
        self.sugar_by_id
            .get(source_id)
            .map(|v| *v <= 0.0)
            .unwrap_or(true)
    }
}
