use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::proto::{ClientMsg, ServerMsg};
use crate::state::Lobby;

#[derive(Deserialize)]
pub struct JoinQuery {
    #[serde(default)]
    name: String,
}

pub async fn upgrade(
    ws: WebSocketUpgrade,
    Query(query): Query<JoinQuery>,
    State(lobby): State<Arc<Lobby>>,
) -> Response {
    ws.on_upgrade(move |socket| run(socket, lobby, query.name))
}

async fn run(socket: WebSocket, lobby: Arc<Lobby>, name: String) {
    let name = if name.is_empty() {
        "anon".to_string()
    } else {
        name
    };
    let (mut out, mut inc) = socket.split();

    let Some((id, slot)) = lobby.join(name.clone()) else {
        let msg = ServerMsg::Rejected {
            reason: "lobby full",
        };
        let _ = out.send(Message::Text(msg.to_json().into())).await;
        let _ = out.close().await;
        eprintln!("rejected {name}: lobby full");
        return;
    };
    eprintln!("join {id} name={name} slot={slot}");

    // Subscribed after joining, so the current value already includes us.
    let mut snapshots = lobby.subscribe();
    let welcome = ServerMsg::Welcome {
        id: &id,
        slot_count: lobby.slot_count(),
    };
    let first = snapshots.borrow_and_update().clone();
    if out.send(Message::Text(welcome.to_json().into())).await.is_ok()
        && out.send(Message::Text(first.into())).await.is_ok()
    {
        serve(&mut out, &mut inc, &lobby, &id, &mut snapshots).await;
    }

    lobby.leave(&id);
    eprintln!("leave {id}");
}

async fn serve(
    out: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    inc: &mut futures_util::stream::SplitStream<WebSocket>,
    lobby: &Lobby,
    id: &str,
    snapshots: &mut tokio::sync::watch::Receiver<String>,
) {
    loop {
        tokio::select! {
            changed = snapshots.changed() => {
                if changed.is_err() {
                    return;
                }
                let snapshot = snapshots.borrow_and_update().clone();
                if out.send(Message::Text(snapshot.into())).await.is_err() {
                    return;
                }
            }
            frame = inc.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMsg>(&text) {
                            Ok(ClientMsg::Move { x, y }) => lobby.move_to(id, x, y),
                            Err(err) => eprintln!("bad message from {id}: {err}"),
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        eprintln!("socket error for {id}: {err}");
                        return;
                    }
                }
            }
        }
    }
}
