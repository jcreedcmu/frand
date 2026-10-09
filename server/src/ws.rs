use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot, watch};

use crate::proto::{ClientMsg, ServerMsg};
use crate::sfu::SfuCmd;
use crate::state::Lobby;

#[derive(Clone)]
pub struct App {
    pub lobby: Arc<Lobby>,
    pub sfu: mpsc::Sender<SfuCmd>,
}

#[derive(Deserialize)]
pub struct JoinQuery {
    #[serde(default)]
    name: String,
}

pub async fn upgrade(
    ws: WebSocketUpgrade,
    Query(query): Query<JoinQuery>,
    State(app): State<App>,
) -> Response {
    ws.on_upgrade(move |socket| run(socket, app, query.name))
}

async fn run(socket: WebSocket, app: App, name: String) {
    let name = if name.is_empty() {
        "anon".to_string()
    } else {
        name
    };
    let (mut out, mut inc) = socket.split();

    let Some((id, slot)) = app.lobby.join(name.clone()) else {
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
    let mut snapshots = app.lobby.subscribe();
    let welcome = ServerMsg::Welcome {
        id: &id,
        slot_count: app.lobby.slot_count(),
    };
    let first = snapshots.borrow_and_update().clone();
    if out.send(Message::Text(welcome.to_json().into())).await.is_ok()
        && out.send(Message::Text(first.into())).await.is_ok()
    {
        serve(&mut out, &mut inc, &app, &id, slot, &mut snapshots).await;
    }

    let _ = app.sfu.send(SfuCmd::Leave { id: id.clone() }).await;
    app.lobby.leave(&id);
    eprintln!("leave {id}");
}

async fn serve(
    out: &mut SplitSink<WebSocket, Message>,
    inc: &mut SplitStream<WebSocket>,
    app: &App,
    id: &str,
    slot: usize,
    snapshots: &mut watch::Receiver<String>,
) {
    // Negotiation happens exactly once per connection.
    let mut negotiated = false;

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
                            Ok(ClientMsg::Move { x, y }) => app.lobby.move_to(id, x, y),
                            Ok(ClientMsg::Offer { sdp }) => {
                                if negotiated {
                                    eprintln!("ignoring second offer from {id}");
                                    continue;
                                }
                                negotiated = true;
                                if !answer_offer(out, app, id, slot, sdp).await {
                                    return;
                                }
                            }
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

/// Hands the offer to the SFU and sends back the answer. Returns false when
/// the connection should be torn down.
async fn answer_offer(
    out: &mut SplitSink<WebSocket, Message>,
    app: &App,
    id: &str,
    slot: usize,
    sdp: String,
) -> bool {
    let (reply, answer) = oneshot::channel();
    let cmd = SfuCmd::Join {
        id: id.to_string(),
        slot,
        offer: sdp,
        reply,
    };
    if app.sfu.send(cmd).await.is_err() {
        eprintln!("sfu is gone, cannot negotiate for {id}");
        return false;
    }

    match answer.await {
        Ok(Ok(sdp)) => {
            let msg = ServerMsg::Answer { sdp: &sdp };
            out.send(Message::Text(msg.to_json().into())).await.is_ok()
        }
        Ok(Err(err)) => {
            // Tearing down beats leaving the client waiting for an answer
            // that is never coming.
            eprintln!("negotiation for {id} failed: {err}");
            false
        }
        Err(_) => {
            eprintln!("sfu dropped the reply for {id}");
            false
        }
    }
}
