//! `state` snapshots are not built here: they are serialized once per
//! mutation in `state.rs` and forwarded as text.

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg<'a> {
    Welcome { id: &'a str, slot_count: usize },
    Rejected { reason: &'a str },
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Move { x: f32, y: f32 },
}

impl ServerMsg<'_> {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("message serializes")
    }
}
