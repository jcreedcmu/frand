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

Movement, and everyone hearing everyone else at full volume. Distance does
not affect gain yet.

The server logs one line per connection as it comes up (`rtc m-lines`,
`rtc connected`), one the first time a microphone produces a frame, and one
the first time each slot is written to a given listener, which is enough to
place a silence problem without a packet capture.
