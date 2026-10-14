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

## Deploying to a server

`./deploy.sh` builds locally and installs the result on a remote host over
ssh: the binary, the web assets, and a systemd unit serving https with a
certificate already on the host.

    FRAND_HOST=frand.example.com \
    FRAND_PUBLIC_IP=203.0.113.7 \
    FRAND_TLS_CERT=/opt/frand/tls/cert.pem \
    FRAND_TLS_KEY=/opt/frand/tls/key.pem \
    ./deploy.sh

The host, DNS, firewall, and the certificate are set up once by hand. See
[DEPLOY.md](DEPLOY.md).
