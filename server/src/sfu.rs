//! The WebRTC half: one tokio task owning every `Rtc` instance and the UDP
//! sockets, so no locking is needed around WebRTC state.
//!
//! `str0m` is sans-IO, which imposes one rule the whole module is shaped
//! around: every mutation of an `Rtc` must be followed by draining
//! `poll_output` until it returns `Output::Timeout`, before that instance is
//! mutated again.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use str0m::change::SdpOffer;
use str0m::media::{Direction, MediaData, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot};

use crate::state::PlayerId;

/// How long the loop sleeps when no connection has a deadline of its own.
const IDLE_POLL: Duration = Duration::from_millis(100);

pub enum SfuCmd {
    /// The slot is assigned before the command is sent, so nothing flows back
    /// except the answer.
    Join {
        id: PlayerId,
        slot: usize,
        offer: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Leave {
        id: PlayerId,
    },
}

/// A UDP socket paired with the address advertised for it. The two differ when
/// `PUBLIC_IP` names an address the host cannot bind: packets are then reported
/// as having arrived at the advertised address, which is what `str0m` matches
/// against its local candidates.
pub struct Endpoint {
    pub socket: Arc<UdpSocket>,
    pub advertised: SocketAddr,
}

struct Packet {
    data: Vec<u8>,
    source: SocketAddr,
    destination: SocketAddr,
}

struct Peer {
    id: PlayerId,
    slot: usize,
    rtc: Rtc,
    /// The client's `sendonly` m-line, the one carrying its mic.
    mic: Option<Mid>,
    /// `listen[s]` is the m-line this connection gave to slot `s`, built from
    /// the order the `sendonly` m-lines were announced. `str0m` withholds
    /// `MediaAdded` until SRTP is ready, so this stays empty until the
    /// connection is up, and writes to a peer that is not ready are dropped.
    listen: Vec<Mid>,
    deadline: Instant,
    /// Bring-up only: whether this connection has delivered a mic frame, and
    /// which slots have ever been written to it.
    heard_from: bool,
    written: Vec<bool>,
}

/// Media to hand to listeners, queued rather than handled inline: writing to a
/// listener produces output of its own, and handling that inline would grow
/// the call stack with the lobby.
struct Forward {
    from_slot: usize,
    data: MediaData,
}

struct Sfu {
    /// Keyed by advertised address, which is what `Transmit::source` carries.
    sockets: HashMap<SocketAddr, Arc<UdpSocket>>,
    candidates: Vec<Candidate>,
    peers: Vec<Peer>,
    slot_count: usize,
}

/// Starts the SFU task and returns the handle the WebSocket tasks use.
pub fn spawn(
    endpoints: Vec<Endpoint>,
    candidates: Vec<Candidate>,
    slot_count: usize,
) -> mpsc::Sender<SfuCmd> {
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (packet_tx, packet_rx) = mpsc::channel(256);

    let mut sockets = HashMap::new();
    for endpoint in endpoints {
        sockets.insert(endpoint.advertised, Arc::clone(&endpoint.socket));
        tokio::spawn(read_socket(
            endpoint.socket,
            endpoint.advertised,
            packet_tx.clone(),
        ));
    }

    let sfu = Sfu {
        sockets,
        candidates,
        peers: Vec::new(),
        slot_count,
    };
    tokio::spawn(sfu.run(cmd_rx, packet_rx));
    cmd_tx
}

/// One reader per socket, so the main loop can await a single channel instead
/// of a set of sockets that changes with the host's interfaces.
async fn read_socket(socket: Arc<UdpSocket>, advertised: SocketAddr, out: mpsc::Sender<Packet>) {
    let mut buf = vec![0u8; 2000];
    loop {
        match socket.recv_from(&mut buf).await {
            Ok((n, source)) => {
                let packet = Packet {
                    data: buf[..n].to_vec(),
                    source,
                    destination: advertised,
                };
                if out.send(packet).await.is_err() {
                    return;
                }
            }
            Err(err) => eprintln!("udp recv on {advertised} failed: {err}"),
        }
    }
}

impl Sfu {
    async fn run(mut self, mut cmds: mpsc::Receiver<SfuCmd>, mut packets: mpsc::Receiver<Packet>) {
        loop {
            let next = self.next_deadline();
            tokio::select! {
                packet = packets.recv() => {
                    match packet {
                        Some(packet) => self.handle_packet(packet).await,
                        None => return,
                    }
                }
                cmd = cmds.recv() => {
                    match cmd {
                        Some(cmd) => self.handle_cmd(cmd).await,
                        None => return,
                    }
                }
                _ = tokio::time::sleep_until(next.into()) => self.handle_timeouts().await,
            }
            self.peers.retain(|peer| {
                if !peer.rtc.is_alive() {
                    eprintln!("rtc closed {}", peer.id);
                }
                peer.rtc.is_alive()
            });
        }
    }

    fn next_deadline(&self) -> Instant {
        let idle = Instant::now() + IDLE_POLL;
        self.peers
            .iter()
            .map(|peer| peer.deadline)
            .min()
            .unwrap_or(idle)
            .min(idle)
    }

    async fn handle_cmd(&mut self, cmd: SfuCmd) {
        match cmd {
            SfuCmd::Join {
                id,
                slot,
                offer,
                reply,
            } => {
                let answer = self.negotiate(&id, slot, &offer);
                let accepted = answer.is_ok();
                let _ = reply.send(answer);
                if accepted {
                    // Draining the fresh instance is what delivers the
                    // `MediaAdded` events that fill in its m-lines.
                    let last = self.peers.len() - 1;
                    self.drain(last).await;
                }
            }
            SfuCmd::Leave { id } => {
                // Dropping the instance tears the connection down.
                self.peers.retain(|peer| peer.id != id);
            }
        }
    }

    fn negotiate(&mut self, id: &PlayerId, slot: usize, offer: &str) -> Result<String, String> {
        let offer = SdpOffer::from_sdp_string(offer).map_err(|err| format!("bad offer: {err}"))?;

        let mut rtc = Rtc::builder().set_ice_lite(true).build(Instant::now());
        for candidate in &self.candidates {
            rtc.add_local_candidate(candidate.clone());
        }
        let answer = rtc
            .sdp_api()
            .accept_offer(offer)
            .map_err(|err| format!("offer rejected: {err}"))?;

        self.peers.push(Peer {
            id: id.clone(),
            slot,
            rtc,
            mic: None,
            listen: Vec::new(),
            deadline: Instant::now(),
            heard_from: false,
            written: vec![false; self.slot_count],
        });
        eprintln!("rtc negotiated {id} slot={slot}");
        Ok(answer.to_sdp_string())
    }

    async fn handle_packet(&mut self, packet: Packet) {
        let Ok(contents) = packet.data.as_slice().try_into() else {
            return;
        };
        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source: packet.source,
                destination: packet.destination,
                contents,
            },
        );

        // `accepts` is how one UDP port is demultiplexed across connections.
        // A linear scan over 16 peers costs nothing, and packets nobody claims
        // are dropped: the browser's first STUN often arrives before the offer.
        let Some(index) = self.peers.iter().position(|peer| peer.rtc.accepts(&input)) else {
            return;
        };
        self.feed(index, input).await;
    }

    async fn handle_timeouts(&mut self) {
        let now = Instant::now();
        for index in 0..self.peers.len() {
            if self.peers[index].deadline <= now {
                self.feed(index, Input::Timeout(now)).await;
            }
        }
    }

    async fn feed(&mut self, index: usize, input: Input<'_>) {
        if let Err(err) = self.peers[index].rtc.handle_input(input) {
            eprintln!("input for {} failed: {err}", self.peers[index].id);
            self.peers[index].rtc.disconnect();
            return;
        }
        self.drain(index).await;
    }

    /// Drains one connection, then hands each frame it produced to every
    /// other connection. Each write is itself a mutation, so a listener is
    /// drained before the next listener is touched, and frames the listeners
    /// produce in turn go back on the queue instead of nesting.
    async fn drain(&mut self, index: usize) {
        let mut forwards = VecDeque::new();
        self.poll_until_timeout(index, &mut forwards).await;

        while let Some(forward) = forwards.pop_front() {
            for listener in 0..self.peers.len() {
                // A player is never sent their own voice; their own slot
                // stays idle in their own connection.
                if self.peers[listener].slot == forward.from_slot {
                    continue;
                }
                if write_to(&mut self.peers[listener], forward.from_slot, &forward.data) {
                    self.poll_until_timeout(listener, &mut forwards).await;
                }
            }
        }
    }

    async fn poll_until_timeout(&mut self, index: usize, forwards: &mut VecDeque<Forward>) {
        let slot_count = self.slot_count;
        loop {
            let peer = &mut self.peers[index];
            if !peer.rtc.is_alive() {
                return;
            }
            match peer.rtc.poll_output() {
                Ok(Output::Transmit(transmit)) => {
                    match self.sockets.get(&transmit.source) {
                        Some(socket) => {
                            if let Err(err) =
                                socket.send_to(&transmit.contents, transmit.destination).await
                            {
                                eprintln!("udp send to {} failed: {err}", transmit.destination);
                            }
                        }
                        None => eprintln!("no socket bound for source {}", transmit.source),
                    }
                }
                Ok(Output::Timeout(at)) => {
                    peer.deadline = at;
                    return;
                }
                Ok(Output::Event(event)) => handle_event(peer, event, slot_count, forwards),
                Err(err) => {
                    eprintln!("poll for {} failed: {err}", peer.id);
                    peer.rtc.disconnect();
                    return;
                }
            }
        }
    }
}

fn handle_event(
    peer: &mut Peer,
    event: Event,
    slot_count: usize,
    forwards: &mut VecDeque<Forward>,
) {
    match event {
        Event::Connected => eprintln!("rtc connected {}", peer.id),
        Event::IceConnectionStateChange(IceConnectionState::Disconnected) => peer.rtc.disconnect(),
        Event::MediaAdded(media) => match media.direction {
            // Directions are from the server's side of the connection: the
            // client's one sendonly m-line reads as recvonly here. A browser
            // that offers its mic as sendrecv lands here too.
            Direction::RecvOnly | Direction::SendRecv => peer.mic = Some(media.mid),
            Direction::SendOnly => {
                peer.listen.push(media.mid);
                if peer.listen.len() == slot_count {
                    eprintln!(
                        "rtc m-lines {} mic={:?} slots={}",
                        peer.id, peer.mic, slot_count
                    );
                }
            }
            other => eprintln!(
                "rtc m-line {} on {} has unusable direction {other:?}",
                media.mid, peer.id
            ),
        },
        Event::MediaData(data) => {
            if peer.mic == Some(data.mid) {
                if !peer.heard_from {
                    peer.heard_from = true;
                    eprintln!("rtc first mic frame from {} slot={}", peer.id, peer.slot);
                }
                forwards.push_back(Forward {
                    from_slot: peer.slot,
                    data,
                });
            }
        }
        _ => {}
    }
}

/// Writes one Opus frame to the m-line this listener gave to `slot`.
fn write_to(listener: &mut Peer, slot: usize, data: &MediaData) -> bool {
    let Some(&mid) = listener.listen.get(slot) else {
        return false;
    };
    let Some(writer) = listener.rtc.writer(mid) else {
        return false;
    };
    // Payload types are negotiated per connection and need not agree, so the
    // listener's own type is the only correct one here.
    let Some(pt) = writer.match_params(data.params) else {
        return false;
    };
    if let Err(err) = writer.write(pt, data.network_time, data.time, data.data.clone()) {
        eprintln!("write to {} failed: {err}", listener.id);
        listener.rtc.disconnect();
        return false;
    }
    if let Some(first) = listener.written.get_mut(slot) {
        if !*first {
            *first = true;
            eprintln!("rtc {} now hears slot {slot} pt={pt}", listener.id);
        }
    }
    true
}
