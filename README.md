# frand

Proximity voice chat prototype. See `PLAN.md`.

## Running locally

Frontend (leave running):

    cd web
    npm install
    npm run watch

Server:

    cd server
    cargo run

Then open http://localhost:8080 and join. `localhost` is a secure context, so
no certificate is needed for `getUserMedia`, and the loopback media candidate
does the work. Testing more than one tab on one machine needs headphones:
every tab shares the same speakers and microphone.

Environment: `HTTP_PORT` (8080), `UDP_PORT` (9001), `MAX_PLAYERS` (16),
`WEB_ROOT` (the `web/` directory next to the crate), and `PUBLIC_IP` for a
host behind NAT whose public address does not appear on any local interface.

Reaching it from other machines needs three things to arrive: the frontend
over HTTPS, the game WebSocket over WSS, and `UDP_PORT` as UDP. An ingress
that forwards only HTTP and WebSocket carries signaling but not media.

## What works so far

All of it: movement, everyone hearing everyone else, and distance driving
volume, stereo position, a low-pass cutoff, and how much of a voice arrives
as reverb rather than directly. A row of checkboxes above the canvas mutes
individual participants for you alone; the server is not told and the other
players cannot tell.

Every tuning knob is in `web/src/consts.ts`. `FULL_GAIN_RADIUS` and
`SILENCE_RADIUS` bound the volume falloff and are drawn as dashed rings
around your own dot, and `GAIN_DROP_DB` sets how much level is lost across
the band between them.
`NEAR_CUTOFF_HZ` and `FAR_CUTOFF_HZ` bound the filter, which spans the whole
distance from zero to `SILENCE_RADIUS` rather than just the falloff band.
`PAN_WIDTH` caps how far a voice moves off centre. Each other dot is
labelled with its slot, gain, and cutoff, so what you are hearing is visible.

Three cues move together. Volume follows an exponential decay, losing
`GAIN_DROP_DB` across the falloff band, which works out to a near constant
drop in decibels per unit distance; the cutoff falls geometrically from 10kHz
to 300Hz; the reverb send rises from nothing to `WET_MAX`. All three are
geometric rather than linear for the same reason: level, pitch, and
reverberation are all heard as ratios, so a curve that is even in amplitude
sounds uneven. The curves live in `slotSpatial` in `web/src/audio.ts` and are
a line each.

The reverb is one bus shared by every slot, with a per-slot send level, and
its impulse response is generated at startup rather than loaded, so there is
no audio asset to ship. `REVERB_SECONDS` and `REVERB_DECAY` set how long the
room rings, `REVERB_PREDELAY` how far away the nearest wall sounds,
`REVERB_TONE_HZ` how bright the tail is, and `REVERB_LEVEL` trims the whole
bus. The defaults are a small room: an RT60 of about half a second.

The server logs one line per connection as it comes up (`rtc m-lines`,
`rtc connected`), one the first time a microphone produces a frame, and one
the first time each slot is written to a given listener, which is enough to
place a silence problem without a packet capture.
