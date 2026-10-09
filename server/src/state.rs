use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tokio::sync::watch;

pub const WORLD_W: f32 = 1600.0;
pub const WORLD_H: f32 = 900.0;

pub type PlayerId = String;

#[derive(Serialize)]
pub struct Player {
    pub id: PlayerId,
    pub name: String,
    pub slot: usize,
    pub x: f32,
    pub y: f32,
}

#[derive(Serialize)]
struct Snapshot<'a> {
    t: &'static str,
    players: Vec<&'a Player>,
}

struct World {
    players: HashMap<PlayerId, Player>,
    slots: Vec<Option<PlayerId>>,
    /// Lowest slot index that has never been assigned.
    fresh: usize,
    next_id: u64,
}

impl World {
    fn take_slot(&mut self) -> Option<usize> {
        if self.fresh < self.slots.len() {
            let slot = self.fresh;
            self.fresh += 1;
            return Some(slot);
        }
        self.slots.iter().position(|s| s.is_none())
    }

    fn snapshot(&self) -> String {
        let mut players: Vec<&Player> = self.players.values().collect();
        players.sort_by_key(|p| p.slot);
        serde_json::to_string(&Snapshot { t: "state", players }).expect("snapshot serializes")
    }
}

/// Game state plus the latest serialized snapshot. Mutations take the lock and
/// publish; readers only ever take the watch channel.
pub struct Lobby {
    world: Mutex<World>,
    snapshots: watch::Sender<String>,
}

impl Lobby {
    pub fn new(max_players: usize) -> Self {
        let world = World {
            players: HashMap::new(),
            slots: vec![None; max_players],
            fresh: 0,
            next_id: 0,
        };
        let (snapshots, _) = watch::channel(world.snapshot());
        Lobby {
            world: Mutex::new(world),
            snapshots,
        }
    }

    pub fn slot_count(&self) -> usize {
        self.world.lock().unwrap().slots.len()
    }

    pub fn subscribe(&self) -> watch::Receiver<String> {
        self.snapshots.subscribe()
    }

    /// Assigns an id and a slot, or returns `None` when the lobby is full.
    pub fn join(&self, name: String) -> Option<(PlayerId, usize)> {
        let mut world = self.world.lock().unwrap();
        let slot = world.take_slot()?;
        world.next_id += 1;
        let id = format!("p{}", world.next_id);
        world.slots[slot] = Some(id.clone());
        let (x, y) = spawn_point(slot, world.slots.len());
        world.players.insert(
            id.clone(),
            Player {
                id: id.clone(),
                name,
                slot,
                x,
                y,
            },
        );
        self.snapshots.send_replace(world.snapshot());
        Some((id, slot))
    }

    pub fn leave(&self, id: &str) {
        let mut world = self.world.lock().unwrap();
        if let Some(player) = world.players.remove(id) {
            world.slots[player.slot] = None;
            self.snapshots.send_replace(world.snapshot());
        }
    }

    pub fn move_to(&self, id: &str, x: f32, y: f32) {
        let mut world = self.world.lock().unwrap();
        let Some(player) = world.players.get_mut(id) else {
            return;
        };
        player.x = x.clamp(0.0, WORLD_W);
        player.y = y.clamp(0.0, WORLD_H);
        self.snapshots.send_replace(world.snapshot());
    }
}

/// Spreads initial positions around the middle of the world so that players
/// joining at once are distinguishable before anyone clicks.
fn spawn_point(slot: usize, slot_count: usize) -> (f32, f32) {
    let angle = slot as f32 / slot_count as f32 * std::f32::consts::TAU;
    (
        (WORLD_W / 2.0 + 180.0 * angle.cos()).round(),
        (WORLD_H / 2.0 + 180.0 * angle.sin()).round(),
    )
}
