# Deploying frand

Three things have to be reachable from a player's browser: the page over
https, the signalling WebSocket over wss, and the media port over UDP. The
server covers the first two itself, reading a certificate from disk, so
nothing is proxying it. Media goes straight to the host on `UDP_PORT`.

`./deploy.sh` does the repeatable part: build, upload, systemd unit, restart.
Everything below it is one-time setup it deliberately leaves alone.

## The host

Any x86_64 Linux box with a public IPv4 address and inbound UDP allowed. A
full 16-player lobby is 16 inbound streams and 240 outbound, around 8 Mbps,
with no codec work in the server, so the smallest tier any provider sells is
enough.

Prefer a provider that binds the public address to the interface directly, as
Hetzner, DigitalOcean, Vultr, and Linode do: the server then enumerates it and
advertises it without help. On AWS and GCP the instance holds only a private
address, so `FRAND_PUBLIC_IP` is doing the real work and the elastic or
external address goes there.

Nothing is cross-compiled. The host's glibc has to be at least as new as the
build machine's, since glibc is forward compatible only. Ubuntu 22.04 and
newer, Debian 12 and newer, and Rocky or Alma 9 all qualify for a build made
on Ubuntu 22.04; Debian 11, Ubuntu 20.04, and anything on musl such as Alpine
do not. The version a build actually requires is

    objdump -T server/target/release/frand |
      grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -1

against `ldd --version` on the host. `deploy.sh` compares the two before it
uploads anything.

## DNS

One `A` record pointing the name at the host's public address. That name is
also what the certificate is issued for, so it has to be settled before the
certificate is requested.

The record has to resolve to the host and not to a CDN. A name proxied through
Cloudflare resolves to Cloudflare's addresses, which terminate TLS themselves
and forward no UDP, so the page would load and no one would be audible. Check
what the world sees:

    dig +short frand.example.com

A zone whose other names are proxied is the case to watch, since the proxy is
usually on by default when a record is added.

## Firewall

Open the port the server listens on and `UDP_PORT` for media:

    ufw allow 22/tcp
    ufw allow 443/tcp
    ufw allow 9001/udp
    ufw enable

Port 80 is not involved anywhere: the certificate comes from a DNS challenge
and the server has no plain-http listener.

Most providers have a second firewall of their own, in a web console and
independent of `ufw`. The UDP rule has to exist in both. A lobby where
everyone connects and nobody is audible is almost always one of these two
layers.

## The certificate

Let's Encrypt proves control of a name three ways, and two of them want a
port: HTTP-01 needs 80, TLS-ALPN-01 needs 443. DNS-01 wants neither, which is
what makes it the right one here. It asks for a TXT record instead, so the
host needs no open port at all to be issued a certificate, and anything else
already serving 80 or 443 on that machine stays untouched.

    apt install -y certbot
    certbot certonly --manual --preferred-challenges dns -d frand.example.com

It prints one `_acme-challenge` TXT record to create and waits. Add the record,
give it a moment to resolve, then let certbot continue.

The service runs as an unprivileged user, and `/etc/letsencrypt/archive` is
readable by root alone, so the live symlinks cannot be used from the unit
directly. Copy the pair somewhere the service user can read:

    useradd --system --no-create-home --shell /usr/sbin/nologin frand
    install -d -m 0755 /opt/frand/tls
    install -m 0644 -o frand \
      /etc/letsencrypt/live/frand.example.com/fullchain.pem /opt/frand/tls/cert.pem
    install -m 0600 -o frand \
      /etc/letsencrypt/live/frand.example.com/privkey.pem /opt/frand/tls/key.pem

`deploy.sh` creates that user too if it is missing, and checks both files exist
and are readable by it before writing the unit, so a permissions mistake stops
the deploy rather than turning into a panic at startup.

## Renewal

A certificate issued this way lasts 90 days and cannot renew on its own, since
the TXT record has to be written again by hand:

    certbot certonly --manual --preferred-challenges dns \
      -d frand.example.com --force-renewal

Repeat the two `install` commands afterwards and restart the service. The
certificate is read once at startup, so nothing picks up a new one until then:

    systemctl restart frand

Turn off `certbot.timer`, which would otherwise wake twice a day to renew a
certificate it has no way to renew:

    systemctl disable --now certbot.timer

Automating this means letting certbot write the TXT record through an API
token, with a plugin matching the DNS provider, such as
`python3-certbot-dns-cloudflare`. The restart then belongs in a
`--deploy-hook`.

## Deploying

    FRAND_HOST=frand.example.com \
    FRAND_PUBLIC_IP=203.0.113.7 \
    FRAND_TLS_CERT=/opt/frand/tls/cert.pem \
    FRAND_TLS_KEY=/opt/frand/tls/key.pem \
    ./deploy.sh

The first two are required and the script stops if either is unset.
`FRAND_HOST` is an ssh destination reached by key, logging in as root: a bare
hostname gets `root@` prepended, and naming a different user is an error, since
installing writes to `/etc` and `/opt` and drives systemd. `FRAND_PUBLIC_IP`
becomes the candidate in the SDP, so it has to be the address a browser can
reach rather than whatever the host calls itself.

The ssh destination and the public name are usually the same name, which is
why `FRAND_DOMAIN` defaults to the host part of `FRAND_HOST`. They are free to
differ: the destination has to resolve on the machine running the script and
nowhere else, so it can be an ssh alias or an address, while the public name is
what a player types and what the certificate covers. Set `FRAND_DOMAIN` only
when it is not the name you ssh to.

Giving the certificate paths is what puts the server in front: it reads them
itself, `FRAND_HTTP_PORT` becomes the public port and defaults to 443, and the
unit gains `CAP_NET_BIND_SERVICE` so an unprivileged service can bind it.

The rest have defaults: `FRAND_REMOTE_DIR` (`/opt/frand`), `FRAND_UDP_PORT`
(9001), `FRAND_MAX_PLAYERS` (16), `FRAND_SERVICE` (`frand`), and `FRAND_USER`
(`frand`).

Stopping the service is `./deploy.sh --stop`, which needs only `FRAND_HOST`
and leaves it stopped across reboots. What was installed stays on the host, so
a later run with no argument brings it back; removing it properly means
deleting the unit, `/opt/frand`, the service user, the certificate, and the
firewall rules.

A redeploy is the same command. The script uploads the binary and `web/dist`
over ssh, rewrites the unit, and restarts the service, so a configuration
change is a matter of changing a variable and running it again.

## Checking it worked

The script prints the candidates the server advertised and fails loudly if the
service did not come up. The candidate list is the one output worth reading
every time: it should be the public address and nothing else.

In the journal, a connection that is fully working logs `rtc negotiated`, then
`rtc connected`, then `rtc first mic frame`, then one `now hears slot` per
other player:

    journalctl -u frand -f

Signalling that works while audio stays silent stops after `rtc negotiated`,
which means ICE never completed and the UDP port is unreachable.

Certificate trouble comes in three shapes. One the server cannot read or parse
is a panic on startup naming the file. One whose path does not exist is not an
error at all: the server reports finding no certificate and serves plain http
on that port, which a browser asking for https calls a protocol error. An
expired one is a browser warning with nothing in the journal.

## With 80 and 443 free

On a host with nothing else serving them, Caddy is less work than the above:
leave `FRAND_TLS_CERT` and `FRAND_TLS_KEY` unset and `deploy.sh` writes a
Caddy site proxying `FRAND_HTTP_PORT` (8080) instead, serving on
`FRAND_HTTPS_PORT` (443). Caddy obtains the certificate over HTTP-01 and
renews it with no attention, which is the part worth having. It needs the
package installed from the vendor repository, and `FRAND_SKIP_CADDY=1` turns
that half of the deploy off again.
