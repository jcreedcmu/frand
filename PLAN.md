# frand: proximity voice chat prototype

A minimal multiplayer sandbox whose purpose is to validate that
proximity-based voice chat feels good for a group of 5-8 friends.
Players are dots on a flat plane. Clicking the plane moves your dot
there immediately. Everyone hears everyone else at a volume determined
by distance.

Out of scope:
- nontrivial game mechanics
- security
- moderation,
- matchmaking
- anti-cheat
- lobby scaling

## Assumptions

- No more than 16 concurrent players, a number fixed at startup.
- Players are on desktop machines with ordinary residential broadband,
- Outbound UDP to an arbitrary port works.
- Players are trusted. There is no authentication.

## Architecture

```
browser (TypeScript)                      server: Rust binary
┌──────────────────────────┐              ┌────────────────────────────┐
│ canvas render            │              │ axum                       │
│ click -> position        │              │   static files             │
│ offer / answer           │<--- wss ---->│   game socket              │
│                          │              │   player positions (Mutex) │
│                          │              │   slot assignment          │
│ RTCPeerConnection        │              ├────────────────────────────┤
│  1 sendonly (mic)        │              │ str0m task                 │
│  16 recvonly             │----- UDP --->│   one Rtc per player       │
│ WebAudio: 16x src->gain  │ (DTLS-SRTP)  │   forward Opus payloads    │
└──────────────────────────┘              └────────────────────────────┘
```

The two halves live in one process and talk over an `mpsc` channel.
The SFU half, built on `str0m`, decrypts incoming RTP, forwards the
Opus payloads to every other participant, and re-encrypts per
connection. It never decodes audio. Spatial processing happens in the
browser.

### Authority model

The server owns every player's position. Clients send a click target
and render what comes back. Movement is instantaneous, so there is no
integration step and no tick loop: a `move` message updates one
position and triggers one broadcast.

Your own dot does not move until the round trip completes. That is
intended, not a defect to paper over later.

## Slots

A player gets an **id** (`p1`, `p2`, and so on from a counter) that
names them in snapshots, and a **slot**, an integer in `0..16` that
routes their audio.

Slots are global and exist before anyone occupies them. Every
connection is negotiated with 17 audio m-lines: one `sendonly` for the
client's mic, then 16 `recvonly`, one per slot. Whoever holds slot 3 is
written to m-line 3 of every other connection. Your own slot stays idle
in your own connection.

So a join or a leave never renegotiates, the client's 16 audio chains
are built once and never torn down, and assignment needs no message of
its own, since the `state` snapshot already lists every player and each
entry carries its slot. An unoccupied slot carries no traffic and sits
at zero gain. Raising the cap costs a few hundred bytes of SDP and an
idle gain node per slot.

Mids are opaque strings chosen by the offerer, so both sides derive the
slot-to-m-line mapping from position rather than assuming Chrome names
them `"0"` through `"16"`.

## Protocol

JSON text frames over one WebSocket. Signaling rides the same socket as
game state, so there is no second connection.

Client connects to `/ws?name=jcreed`.

Server to client:

```jsonc
{ "t": "welcome", "id": "p3", "slot_count": 16 }

// instead of welcome when the lobby is full, then the socket closes
{ "t": "rejected", "reason": "lobby full" }

{ "t": "answer", "sdp": "..." }

// on any position change, and once after welcome
{ "t": "state", "players": [
    { "id": "p3", "name": "jcreed", "slot": 2, "x": 812.0, "y": 377.5 } ] }
```

Client to server:

```jsonc
{ "t": "offer", "sdp": "..." }
{ "t": "move", "x": 900.0, "y": 410.0 }
```

`slot_count` is the only lobby configuration that has to travel on the
wire. World bounds and falloff radii are plain constants on both sides,
the server needing its copy only to clamp clicks.

A player is created when the WebSocket opens and destroyed when it
closes. There is no persistence: a dropped client returns as a new
player with a new id and possibly a different slot.

## Server

`server/`, single crate, no workspace.

Dependencies: `str0m`, `axum` with `ws`, `tokio` with
`rt-multi-thread`/`macros`/`net`/`time`/`sync`, `serde` +
`serde_json`, `tower-http` with `fs`, `if-addrs`. Logging is
`eprintln!`.

`str0m` is pre-1.0 and its API moves between releases, so pin an exact
version. Its default crypto backend is `aws-lc-rs`, which needs a C
toolchain and cmake; the `rust-crypto` feature is pure Rust if that
build is inconvenient.

```
server/
  Cargo.toml
  src/main.rs     axum setup, routes, static file serving
  src/proto.rs    serde types for the messages above
  src/state.rs    World, Player, slot table, snapshot serialization
  src/ws.rs       per-connection task
  src/sfu.rs      the str0m task: Rtc instances, forwarding
```

### Two halves

The halves share nothing but ids and slot numbers.

**Game state** is an `Arc<Mutex<World>>` plus a
`tokio::sync::watch::channel::<String>` holding the latest serialized
snapshot. A mutation takes the lock, applies the change, serializes one
snapshot, and publishes it; readers take the channel and never the
lock, which is why a plain `Mutex` suffices. Serializing once per
change keeps the cost flat in player count, and `watch` keeps only the
latest value, so a slow client misses snapshots instead of needing lag
handling.

`World` holds the player map and a `[Option<PlayerId>; 16]` slot table.
Joining takes the lowest free index, or fails when there is none.

**The SFU** is one tokio task owning the UDP socket and every `Rtc`, so
no locking is needed around WebRTC state. WebSocket tasks reach it over
an `mpsc`:

```rust
enum SfuCmd {
    Join { id: PlayerId, slot: usize, offer: String,
           reply: oneshot::Sender<String> },
    Leave { id: PlayerId },
}
```

Nothing flows back except the answer, since the slot is assigned before
the command is sent.

### ICE-lite and candidates

`Rtc::builder().set_ice_lite(true)`. The server never gathers
candidates and never sends connectivity checks; the browser is the
controlling agent, sends its checks to the advertised candidates, and
the server replies to whatever source address they arrived from. So
there is no trickling and no ICE in the protocol, and the client needs
neither a STUN server nor a wait for gathering before it offers.

At startup, advertise every address the server might be reachable at
and let the client's checks decide, which is what a non-lite agent
does:

```rust
for addr in local_addresses()? {           // e.g. via the if-addrs crate
    rtc.add_local_candidate(Candidate::host((addr, udp_port), "udp")?);
}
```

An unreachable candidate costs one failed check of a couple hundred
milliseconds while a reachable one succeeds in parallel, so offering a
private LAN address alongside a public one is harmless, and a VPS with
its public address on an interface needs no configuration at all.

`PUBLIC_IP` is an override for what enumeration cannot see: a host
behind NAT, including EC2 and GCE instances, which only ever hold a
private address locally. Print the final candidate list at startup.

### The event loop

`str0m` is sans-IO, so the loop is explicit. It enforces one rule worth
repeating here because violating it produces subtle breakage: **every
mutation of an `Rtc` must be followed by draining `poll_output` until
it returns `Output::Timeout`, before the next mutation of that
instance.**

```rust
loop {
    tokio::select! {
        r = socket.recv_from(&mut buf) => { /* route to one Rtc */ }
        _ = sleep_until(next_deadline)  => { /* Input::Timeout */ }
        Some(cmd) = cmds.recv()         => { /* Join / Leave */ }
    }
}
```

**Routing.** Build the `Input::Receive` and find its owner by asking
each instance `rtc.accepts(&input)`. A linear scan over 16 peers costs
nothing; packets nobody accepts are dropped.

**Timeouts.** Each instance reports its next deadline during the drain.
Keep them in a map, sleep until the minimum, and on firing feed
`Input::Timeout(now)` to every instance past its deadline.

**Draining.** Send every `Output::Transmit` to its destination, collect
every `Output::Event`, then drop any peer whose `rtc.is_alive()` is
false.

**Avoid recursion.** Handling an event from peer A mutates peer B,
whose drain yields more events. Push events onto one queue and process
it in a loop, or the call stack grows with the lobby.

### Forwarding

`Event::MediaData` carries one Opus frame from one player. Write it to
that player's slot in every other connection:

```rust
let slot = peers[&sender_id].slot;
for (listener_id, listener) in peers.iter_mut() {
    if *listener_id == sender_id { continue }
    let mid = listener.recv_mids[slot];
    let Some(writer) = listener.rtc.writer(mid) else { continue };
    let pt = writer.payload_params().next().unwrap().pt();
    writer.write(pt, data.network_time, data.time, &data.data)?;
    drain(&mut listener.rtc, &socket)?;   // the mutation rule applies
}
```

`recv_mids` is built during the join drain from the `Event::MediaAdded`
sequence, dropping the first (the client's mic) so that `recv_mids[s]`
is the m-line for slot `s`.

Two things that are easy to get wrong:

- **Payload type is per connection.** Each peer negotiates its own
  Opus payload type, and they need not agree. Always write with the
  *listener's* payload type, from that writer's `payload_params()`,
  never the sender's.
- **Every `write` is a mutation**, so the listener's output must be
  drained before anything else touches that instance.

The frame-level `writer` API leaves SSRC allocation, sequence
numbering, and the RTCP that governs the receiver's jitter buffer to
`str0m`, and for Opus one frame is one packet so frame granularity
loses nothing. Payloads are forwarded byte for byte, so Opus in-band
FEC and DTX work end to end with no involvement from this code.

### Slot lifecycle

Joining takes the lowest free slot, leaving frees it, and a seventeenth
connection gets `rejected` and a closed socket before any WebRTC setup
begins.

Prefer a never-used slot while any remain. Reassigning a slot makes the
outgoing RTP timestamp jump on a stream every receiver already has
open, which can briefly upset their jitter buffers. If that proves
audible, keep a per-slot timestamp offset, set on assignment to the
difference between the last timestamp written to the slot and the new
occupant's current one, and add it to everything written afterward.

## Frontend

`web/`, TypeScript with no bundler, no UI framework, and no WebRTC
library. The only dependency is `typescript`: `tsc --watch` emits ES
modules into `web/dist`, which axum serves directly in development and
production alike.

```
web/
  index.html      canvas, join button, hidden <div id="sinks">
  src/main.ts     join flow, render loop
  src/net.ts      WebSocket, snapshot store
  src/rtc.ts      RTCPeerConnection setup, offer/answer
  src/audio.ts    the 16 audio chains
  src/render.ts   canvas drawing, click to world coords
```

### Join flow

Everything sits behind a Join button, because an `AudioContext` created
outside a user gesture starts suspended and `getUserMedia` wants a
gesture too.

1. `new AudioContext()`, then `await ctx.resume()`
2. `getUserMedia({ audio: { echoCancellation: true,
   noiseSuppression: true, autoGainControl: true } })`
3. open the WebSocket, await `welcome`
4. build the peer connection and send the offer
5. await `answer`, `setRemoteDescription`
6. start the render loop

### Peer connection

```ts
const pc = new RTCPeerConnection({ iceServers: [] });
pc.addTrack(micTrack);                     // m-line 0, our mic
for (let i = 0; i < slotCount; i++)
    pc.addTransceiver('audio', { direction: 'recvonly' });
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
ws.send(JSON.stringify({ t: 'offer', sdp: offer.sdp }));
```

`iceServers: []` because the only candidate that matters is the
server's, which arrives in the answer. The offer goes out immediately
without waiting for gathering, since an ice-lite server ignores the
client's candidates. Negotiation happens exactly once: no
`negotiationneeded` handling, no renegotiation, no ICE restart.

### The audio chains

Sixteen chains, one per slot, built once from transceiver position:
slot `s` is `pc.getTransceivers()[s + 1]`. They are permanent for the
session, since which player a chain carries comes from the snapshot.

```
MediaStreamSource -> GainNode -> ctx.destination
```

```ts
type Chain = {
  sink: HTMLAudioElement;   // muted, keeps the track flowing
  source: MediaStreamAudioSourceNode;
  gain: GainNode;           // later: panner, filter in between
};
```

Two non-obvious requirements:

- The `MediaStream` must **also** be assigned to an `HTMLAudioElement`
  with `muted = true`, kept alive in the DOM. Chrome will not pull
  audio from a WebRTC track into Web Audio otherwise, and the symptom
  is silence with no error. Append these to `#sinks`.
- Never route the local mic into the graph. Monitoring your own mic is
  immediate feedback.

### Distance to gain

Recomputed when a `state` snapshot arrives, which is the only time
anything relevant changes:

```ts
const gains = new Array(slotCount).fill(0);
for (const p of players) {
  if (p.id === myId) continue;
  gains[p.slot] = clamp01(
    (SILENCE_RADIUS - dist(me, p)) / (SILENCE_RADIUS - FULL_GAIN_RADIUS));
}
gains.forEach((g, s) =>
  chains[s].gain.gain.setTargetAtTime(g, ctx.currentTime, 0.05));
```

Use `setTargetAtTime`, not an assignment to `.value`, which steps the
gain and produces audible zipper noise. With instantaneous movement the
50ms constant turns what would be a click on every teleport into a fast
fade; it is the knob to turn if transitions sound abrupt or mushy, and
a vacated slot fades to zero through the same path.

Falloff is linear to start, and swapping in an inverse or exponential
curve is a one-line change. A full lobby is 15 simultaneous voices, so
radii that feel right with four people will be too generous with
sixteen.

### Rendering

Canvas 2D. Each player is a circle at its authoritative position; the
local player is outlined. Draw two rings around the local player at
`FULL_GAIN_RADIUS` and `SILENCE_RADIUS` so falloff is visible while
moving, which makes "does this sound right" answerable by looking. A
click converts canvas coordinates to world coordinates and sends a
`move`.

During bring-up, label each dot with its slot index and current gain.
Seeing both makes it clear whether a silence problem is in the slot
mapping, the distance math, or the audio graph.

## Deployment

One binary and one open UDP port. Three things must be reachable from a
player's browser: the frontend over HTTPS, the game WebSocket over WSS,
and the media port over UDP.

The first two are ordinary HTTPS serving. Anything that terminates TLS
with a valid certificate and proxies WebSockets is fine, and this plan
does not specify one. Two facts constrain the choice: `getUserMedia`
requires a secure context, so HTTPS is not optional for anyone off the
host machine; and media is UDP with no certificate involved, since
DTLS-SRTP keys are self-signed and their fingerprints travel in the
SDP, so an ingress forwarding only HTTP and WebSocket will carry
signaling but not media.

```
UDP_PORT=9001
HTTP_PORT=8080
MAX_PLAYERS=16
# PUBLIC_IP=203.0.113.7   # only when behind NAT
```

Resource use is small. A full 16-player lobby is 16 inbound streams and
240 outbound, roughly 8 Mbps and about 12,000 encrypt-and-send
operations per second, with no codec work anywhere in the server. The
smallest VPS tier is adequate.

Local development needs no certificate, since `localhost` is a secure
context: `tsc --watch` on one side, the server on `:8080` serving
`web/dist`, and the loopback candidate doing the work.

## Build order

Each step ends in something runnable, and each isolates one failure
domain.

**1. Movement, no audio.** WebSocket, broadcast on change, canvas,
click to move. Done when two browser tabs show each other's dots
jumping to clicked positions.

**2. One-way audio, two clients.** One browser publishes its mic, the
server forwards to exactly one listener, hardcoded. This brings up ICE,
DTLS, the str0m loop, and the forwarding path with the fewest moving
parts. Done when one tab can hear the other.

**3. All-to-all at unity gain.** Real slot allocation, join and leave,
full lobby. Done when 5-8 friends on their own machines can all hear
each other.

**4. Distance gain.** Wire positions into the gain nodes, draw the
radius rings. Done when moving away from someone audibly fades them out
and the falloff feels right after tuning the two radii.

**5. Filters and panning.** Insert a `StereoPannerNode` and a
`BiquadFilterNode` into each chain. Low-pass cutoff driven by distance
gives a muffled-at-range effect that reads as more natural than gain
alone. `PannerNode` with HRTF is the richer option and needs a facing
direction added to the protocol.
