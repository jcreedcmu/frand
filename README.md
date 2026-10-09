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

Then open http://localhost:8080 in two tabs, join with different names,
and click to move.

Environment: `HTTP_PORT` (8080), `MAX_PLAYERS` (16), `WEB_ROOT` (the
`web/` directory next to the crate).
