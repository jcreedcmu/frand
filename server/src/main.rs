mod proto;
mod state;
mod ws;

use std::str::FromStr;
use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;

use state::Lobby;

#[tokio::main]
async fn main() {
    let http_port: u16 = from_env("HTTP_PORT", 8080);
    let max_players: usize = from_env("MAX_PLAYERS", 16);
    let web_root = std::env::var("WEB_ROOT")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../web").to_string());

    let lobby = Arc::new(Lobby::new(max_players));
    let app = Router::new()
        .route("/ws", get(ws::upgrade))
        .fallback_service(ServeDir::new(&web_root).append_index_html_on_directories(true))
        .with_state(lobby);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", http_port))
        .await
        .expect("http port is free");
    eprintln!("serving {web_root} on http://localhost:{http_port} (max_players={max_players})");
    axum::serve(listener, app).await.expect("server runs");
}

fn from_env<T: FromStr>(key: &str, default: T) -> T {
    match std::env::var(key) {
        Ok(raw) => raw.parse().unwrap_or_else(|_| panic!("{key} is invalid: {raw}")),
        Err(_) => default,
    }
}
