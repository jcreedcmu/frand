mod proto;
mod sfu;
mod state;
mod ws;

use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use str0m::Candidate;
use tokio::net::UdpSocket;
use tower_http::services::ServeDir;

use sfu::Endpoint;
use state::Lobby;
use ws::App;

#[tokio::main]
async fn main() {
    let http_port: u16 = from_env("HTTP_PORT", 8080);
    let udp_port: u16 = from_env("UDP_PORT", 9001);
    let max_players: usize = from_env("MAX_PLAYERS", 16);
    let web_root = std::env::var("WEB_ROOT")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../web").to_string());

    str0m::crypto::from_feature_flags().install_process_default();

    let endpoints = media_endpoints(udp_port).await;
    let candidates: Vec<Candidate> = endpoints
        .iter()
        .filter_map(|endpoint| Candidate::host(endpoint.advertised, "udp").ok())
        .collect();
    for candidate in &candidates {
        eprintln!("media candidate {}", candidate.addr());
    }
    if candidates.is_empty() {
        panic!("no usable media address; set PUBLIC_IP");
    }

    let app = App {
        lobby: Arc::new(Lobby::new(max_players)),
        sfu: sfu::spawn(endpoints, candidates, max_players),
    };
    let router = Router::new()
        .route("/ws", get(ws::upgrade))
        .fallback_service(ServeDir::new(&web_root).append_index_html_on_directories(true))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", http_port))
        .await
        .expect("http port is free");
    eprintln!("serving {web_root} on http://localhost:{http_port} (max_players={max_players})");
    axum::serve(listener, router).await.expect("server runs");
}

/// One socket per advertised address. `str0m` discards STUN whose destination
/// does not match a local candidate exactly, so a wildcard socket reporting
/// `0.0.0.0` would never finish ICE; binding per address keeps the reported
/// destination concrete.
///
/// `PUBLIC_IP` covers what enumeration cannot see, a host behind NAT that
/// only ever holds a private address locally. That address cannot be bound,
/// so the socket takes the wildcard and advertises the public address.
async fn media_endpoints(udp_port: u16) -> Vec<Endpoint> {
    if let Ok(raw) = std::env::var("PUBLIC_IP") {
        let ip: IpAddr = raw.parse().unwrap_or_else(|_| panic!("PUBLIC_IP is invalid: {raw}"));
        let socket = bind(SocketAddr::from(([0, 0, 0, 0], udp_port))).await;
        return vec![Endpoint {
            socket,
            advertised: SocketAddr::new(ip, udp_port),
        }];
    }

    let interfaces = if_addrs::get_if_addrs().expect("can enumerate interfaces");
    let mut endpoints = Vec::new();
    for interface in interfaces {
        // IPv6 is skipped along with link-local addresses: the former needs a
        // separate socket family for no gain here, the latter is not a
        // candidate str0m will accept.
        let IpAddr::V4(ip) = interface.ip() else {
            continue;
        };
        if interface.is_link_local() {
            continue;
        }
        let addr = SocketAddr::new(IpAddr::V4(ip), udp_port);
        endpoints.push(Endpoint {
            socket: bind(addr).await,
            advertised: addr,
        });
    }
    endpoints
}

async fn bind(addr: SocketAddr) -> Arc<UdpSocket> {
    let socket = UdpSocket::bind(addr)
        .await
        .unwrap_or_else(|err| panic!("cannot bind {addr}: {err}"));
    Arc::new(socket)
}

fn from_env<T: FromStr>(key: &str, default: T) -> T {
    match std::env::var(key) {
        Ok(raw) => raw.parse().unwrap_or_else(|_| panic!("{key} is invalid: {raw}")),
        Err(_) => default,
    }
}
