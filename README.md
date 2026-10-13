# frand

A small prototype of proximity voice chat in rust/typescript.

## Running locally

Frontend:

    cd web
    npm install
    npm run watch

Server:

    cd server
    cargo run

Then open http://localhost:8080

## Reaching it from another machine

Browsers grant microphone and WebRTC access only in a secure context, so a
second machine on the LAN needs https. Generate a certificate whose SAN names
the address that machine will type:

    cd server
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout key.pem -out cert.pem \
      -subj "/CN=192.168.1.69" \
      -addext "subjectAltName=IP:192.168.1.69,DNS:localhost"

`cargo run` serves https when both `server/cert.pem` and `server/key.pem` are
present, and plain http otherwise; `TLS_CERT` and `TLS_KEY` override the paths.
Accepting the browser's warning once also covers the `wss://` signalling.

Media is separate from the web server: UDP 9001 has to be reachable too.
