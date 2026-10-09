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

Then open http://localhost:8080 in two tabs and join with different names.
`localhost` is a secure context, so no certificate is needed for
`getUserMedia`, and the loopback media candidate does the work.

Environment: `HTTP_PORT` (8080), `UDP_PORT` (9001), `MAX_PLAYERS` (16),
`WEB_ROOT` (the `web/` directory next to the crate), and `PUBLIC_IP` for a
host behind NAT whose public address does not appear on any local interface.

## What works so far

Movement, and one direction of audio: whoever holds slot 0 is heard by
whoever holds slot 1. Every tab's status line names its own slot, so a silent
tab in slot 2 is expected rather than broken.
