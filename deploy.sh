#!/usr/bin/env bash
#
# Builds frand locally and installs it on a remote host: the release binary,
# the web assets, and a systemd unit. Safe to re-run; a redeploy is the same
# command.
#
# `./deploy.sh --stop` stops the service and leaves it stopped across reboots,
# needing nothing but FRAND_HOST. What was installed stays on the host, so a
# later run with no argument brings it back.
#
#   FRAND_HOST=frand.example.com \
#   FRAND_PUBLIC_IP=203.0.113.7 \
#   ./deploy.sh
#
# FRAND_HOST is an ssh destination reached by key. A bare hostname logs in
# as root; spelling out a different user is an error, since installing
# needs root. FRAND_DOMAIN is the public name, and defaults to the host part
# of FRAND_HOST; set it when the two differ.
#
# Setting FRAND_TLS_CERT and FRAND_TLS_KEY to paths on the remote host makes
# the server terminate TLS itself, and Caddy is left out of the deploy
# entirely. FRAND_HTTP_PORT is then the public port and defaults to 443.
#
# Optional: FRAND_REMOTE_DIR (/opt/frand), FRAND_HTTP_PORT (8080, or 443 with
# a certificate), FRAND_UDP_PORT (9001), FRAND_MAX_PLAYERS (16),
# FRAND_HTTPS_PORT (443, the port Caddy serves on), FRAND_SERVICE (frand),
# FRAND_USER (frand), FRAND_SKIP_CADDY (unset) to leave Caddy config alone.

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

STOP=""
case ${1:-} in
  --stop) STOP=yes ;;
  "") ;;
  *)
    echo "deploy.sh: unknown argument $1" >&2
    echo "usage: deploy.sh [--stop]" >&2
    exit 1
    ;;
esac

# Stopping reaches the host and nothing else, so it needs neither the address
# media is advertised on nor anything the build would want.
required=(FRAND_HOST)
[ -n "$STOP" ] || required+=(FRAND_PUBLIC_IP)
missing=()
for name in "${required[@]}"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "deploy.sh: unset variables: ${missing[*]}" >&2
  echo "see the comment at the top of $0" >&2
  exit 1
fi

REMOTE_DIR=${FRAND_REMOTE_DIR:-/opt/frand}
UDP_PORT=${FRAND_UDP_PORT:-9001}
MAX_PLAYERS=${FRAND_MAX_PLAYERS:-16}
HTTPS_PORT=${FRAND_HTTPS_PORT:-443}
SERVICE=${FRAND_SERVICE:-frand}
RUN_AS=${FRAND_USER:-frand}
MARKER="# managed by frand deploy.sh"

# Installing writes to /etc and /opt and drives systemd, so the login is root.
# A destination naming some other user is taken at its word and rejected below.
case $FRAND_HOST in
  *@*) TARGET=$FRAND_HOST ;;
  *) TARGET=root@$FRAND_HOST ;;
esac

# The ssh destination has to resolve here and nowhere else, so it can be an
# alias or an address; the public name is what a player types and what the
# certificate is issued for. They are usually one name.
DOMAIN=${FRAND_DOMAIN:-${TARGET#*@}}

# Two ways to reach a secure context: a certificate the server reads itself,
# or Caddy in front obtaining one of its own. With a certificate the server
# is the public endpoint, so its port defaults to the https one.
if [ -n "${FRAND_TLS_CERT:-}" ] || [ -n "${FRAND_TLS_KEY:-}" ]; then
  if [ -z "${FRAND_TLS_CERT:-}" ] || [ -z "${FRAND_TLS_KEY:-}" ]; then
    echo "deploy.sh: FRAND_TLS_CERT and FRAND_TLS_KEY go together" >&2
    exit 1
  fi
  TLS=yes
  HTTP_PORT=${FRAND_HTTP_PORT:-443}
  PORT=$HTTP_PORT
else
  TLS=""
  HTTP_PORT=${FRAND_HTTP_PORT:-8080}
  PORT=$HTTPS_PORT
fi
case $PORT in
  443) URL=https://$DOMAIN ;;
  *) URL=https://$DOMAIN:$PORT ;;
esac

tools=(ssh)
[ -n "$STOP" ] || tools+=(rsync cargo npm objdump)
for tool in "${tools[@]}"; do
  command -v "$tool" >/dev/null || { echo "deploy.sh: $tool is not installed" >&2; exit 1; }
done
if [ -z "$STOP" ] && [ ! -d "$root/web/node_modules" ]; then
  echo "deploy.sh: web/node_modules is missing; run 'npm install' in web/ first" >&2
  exit 1
fi

remote() { ssh "$TARGET" "$@"; }

uid=$(remote 'id -u') || { echo "deploy.sh: cannot ssh to $TARGET" >&2; exit 1; }
if [ "$uid" != 0 ]; then
  echo "deploy.sh: $TARGET logs in as uid $uid; root is required" >&2
  exit 1
fi

if [ -n "$STOP" ]; then
  echo "== stopping $SERVICE on $TARGET"
  if ! remote "systemctl disable --now $SERVICE"; then
    echo "deploy.sh: could not stop $SERVICE on $TARGET" >&2
    exit 1
  fi
  echo "== stopped, and left disabled"
  exit 0
fi

echo "== building"
(cd "$root/web" && npm run build)
(cd "$root/server" && cargo build --release)

# glibc is forward compatible only: a binary linked here runs on the remote
# host if the host's glibc is at least as new as this machine's.
need=$(objdump -T "$root/server/target/release/frand" |
  grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -uV | tail -1 | cut -d_ -f2)
have=$(remote 'ldd --version | head -1 | grep -oE "[0-9]+\.[0-9]+$"' || true)
if [ -z "$have" ]; then
  echo "deploy.sh: cannot read the glibc version on $TARGET" >&2
  exit 1
fi
if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | tail -1)" != "$have" ]; then
  echo "deploy.sh: binary needs glibc $need, $TARGET has $have" >&2
  exit 1
fi

echo "== uploading to $TARGET:$REMOTE_DIR"
remote "mkdir -p $REMOTE_DIR/web"
rsync -a "$root/server/target/release/frand" "$TARGET:$REMOTE_DIR/frand"
rsync -a "$root/web/index.html" "$TARGET:$REMOTE_DIR/web/index.html"
rsync -a --delete "$root/web/dist/" "$TARGET:$REMOTE_DIR/web/dist/"

echo "== installing $SERVICE.service"
remote "id -u $RUN_AS >/dev/null 2>&1 ||
  useradd --system --no-create-home --shell /usr/sbin/nologin $RUN_AS"

tls_env=""
caps=""
if [ -n "$TLS" ]; then
  tls_env="Environment=TLS_CERT=$FRAND_TLS_CERT
Environment=TLS_KEY=$FRAND_TLS_KEY
"
  # The key under /etc/letsencrypt is readable by root alone, so a copy owned
  # by the service user is the usual answer; either way it is worth knowing
  # before the server panics on it at startup.
  for path in "$FRAND_TLS_CERT" "$FRAND_TLS_KEY"; do
    if ! remote "test -e '$path'"; then
      echo "deploy.sh: $path does not exist on $TARGET" >&2
      exit 1
    fi
    if ! remote "runuser -u $RUN_AS -- test -r '$path'"; then
      echo "deploy.sh: $RUN_AS cannot read $path on $TARGET" >&2
      exit 1
    fi
  done
fi
if [ "$HTTP_PORT" -lt 1024 ]; then
  caps="AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
"
fi
remote "tee /etc/systemd/system/$SERVICE.service >/dev/null" <<EOF
$MARKER
[Unit]
Description=frand proximity voice chat
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$REMOTE_DIR/frand
Environment=HTTP_PORT=$HTTP_PORT
Environment=UDP_PORT=$UDP_PORT
Environment=MAX_PLAYERS=$MAX_PLAYERS
Environment=PUBLIC_IP=$FRAND_PUBLIC_IP
Environment=WEB_ROOT=$REMOTE_DIR/web
${tls_env}User=$RUN_AS
Restart=on-failure
${caps}NoNewPrivileges=yes
ProtectSystem=strict
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

if [ -z "$TLS" ] && [ -z "${FRAND_SKIP_CADDY:-}" ]; then
  if ! remote 'command -v caddy >/dev/null'; then
    echo "deploy.sh: caddy is not installed on $TARGET" >&2
    echo "install it from https://caddyserver.com/docs/install," \
      "or set FRAND_SKIP_CADDY=1 and proxy $HTTP_PORT yourself" >&2
    exit 1
  fi
  # Replaceable: absent, ours already, or the welcome page the apt package
  # installs, which is the only Caddyfile referring to /usr/share/caddy.
  if ! remote "test ! -e /etc/caddy/Caddyfile ||
      grep -qF '$MARKER' /etc/caddy/Caddyfile ||
      grep -qF /usr/share/caddy /etc/caddy/Caddyfile"; then
    echo "deploy.sh: /etc/caddy/Caddyfile was written by something else" >&2
    echo "move it aside, or set FRAND_SKIP_CADDY=1 and proxy $HTTP_PORT yourself" >&2
    exit 1
  fi
  echo "== installing the Caddy site for $DOMAIN"
  # Port 80 stays Caddy's whatever the site is served on: the certificate is
  # obtained over the HTTP-01 challenge, which has no other port it can use.
  global=""
  [ "$HTTPS_PORT" = 443 ] || global="{
	https_port $HTTPS_PORT
}
"
  remote "tee /etc/caddy/Caddyfile >/dev/null" <<EOF
$MARKER
$global$DOMAIN {
	reverse_proxy localhost:$HTTP_PORT
}
EOF
  remote "systemctl reload-or-restart caddy"
fi

echo "== restarting $SERVICE"
remote "systemctl daemon-reload &&
  systemctl enable $SERVICE &&
  systemctl restart $SERVICE"
sleep 2
if ! remote "systemctl is-active --quiet $SERVICE"; then
  echo "deploy.sh: $SERVICE is not running:" >&2
  remote "journalctl -u $SERVICE -n 30 --no-pager" >&2
  exit 1
fi

# The advertised candidate is the one address a browser will try for media, so
# it is worth reading back rather than trusting PUBLIC_IP.
echo "== media candidates"
remote "journalctl -u $SERVICE --since '1 min ago' --no-pager |
  grep -F 'media candidate' | sort -u"

# Media is UDP straight to the host, never through Caddy, so a firewall that
# blocks the port leaves signalling working and every voice silent.
if remote "command -v ufw >/dev/null && ufw status | grep -q '^Status: active'"; then
  remote "ufw status | grep -qE '^$UDP_PORT/udp +ALLOW'" ||
    echo "note: ufw is active and $UDP_PORT/udp is not allowed; media will not arrive" >&2
fi

echo "== $URL"
