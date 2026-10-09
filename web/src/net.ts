export type Player = {
  id: string;
  name: string;
  slot: number;
  x: number;
  y: number;
};

type ServerMsg =
  | { t: 'welcome'; id: string; slot_count: number }
  | { t: 'rejected'; reason: string }
  | { t: 'state'; players: Player[] };

export type Conn = {
  myId: string;
  slotCount: number;
  /** Latest authoritative snapshot. */
  players: Player[];
  move(x: number, y: number): void;
};

export type Handlers = {
  onState(players: Player[]): void;
  onClose(): void;
};

/** Opens the socket and resolves once the server has welcomed us. */
export function connect(name: string, handlers: Handlers): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('name', name);

    const ws = new WebSocket(url);
    let conn: Conn | null = null;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      switch (msg.t) {
        case 'welcome':
          conn = {
            myId: msg.id,
            slotCount: msg.slot_count,
            players: [],
            move: (x, y) => ws.send(JSON.stringify({ t: 'move', x, y })),
          };
          resolve(conn);
          break;
        case 'rejected':
          reject(new Error(msg.reason));
          break;
        case 'state':
          if (conn) {
            conn.players = msg.players;
            handlers.onState(msg.players);
          }
          break;
      }
    };
    ws.onerror = () => reject(new Error('could not reach the server'));
    ws.onclose = () => {
      reject(new Error('disconnected'));
      if (conn) handlers.onClose();
    };
  });
}
