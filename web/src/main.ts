import { buildChains } from './audio.js';
import type { Chain } from './audio.js';
import type { Conn, Player } from './net.js';
import { connect } from './net.js';
import { draw, prepare, toWorld } from './render.js';
import { createOffer } from './rtc.js';

const nameInput = document.getElementById('name') as HTMLInputElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;
const canvas = document.getElementById('world') as HTMLCanvasElement;
const sinks = document.getElementById('sinks') as HTMLDivElement;
const ctx2d = prepare(canvas);

let conn: Conn | null = null;
let chains: Chain[] = [];

joinButton.addEventListener('click', join);
nameInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') join();
});

canvas.addEventListener('click', (ev) => {
  if (!conn) return;
  const { x, y } = toWorld(canvas, ev);
  conn.move(x, y);
});

/**
 * Everything is behind the Join button because an `AudioContext` created
 * outside a user gesture starts suspended, and `getUserMedia` wants a gesture
 * too.
 */
async function join(): Promise<void> {
  if (conn) return;
  joinButton.disabled = true;
  const name = nameInput.value.trim() || 'anon';

  try {
    status.textContent = 'starting audio...';
    const audio = new AudioContext();
    await audio.resume();

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    status.textContent = 'connecting...';
    let deliverAnswer: (sdp: string) => void = () => {};
    const answer = new Promise<string>((resolve) => {
      deliverAnswer = resolve;
    });

    conn = await connect(name, {
      onState: describe,
      onAnswer: (sdp) => deliverAnswer(sdp),
      onClose: () => {
        conn = null;
        chains = [];
        joinButton.disabled = false;
        status.textContent = 'disconnected';
      },
    });

    status.textContent = 'negotiating...';
    const { pc, sdp } = await createOffer(mic.getAudioTracks()[0], conn.slotCount);
    chains = buildChains(audio, pc, conn.slotCount, sinks);
    conn.sendOffer(sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: await answer });

    nameInput.disabled = true;
    describe(conn.players);
  } catch (err) {
    conn = null;
    joinButton.disabled = false;
    status.textContent = `failed: ${(err as Error).message}`;
  }
}

/** The slot is worth showing: it is what the server log lines are keyed by. */
function describe(players: Player[]): void {
  if (!conn) return;
  const me = players.find((p) => p.id === conn?.myId);
  const others = players.filter((p) => p.id !== conn?.myId).length;
  status.textContent =
    `${conn.myId} in slot ${me?.slot ?? '?'}, hearing ${others} of ${chains.length} slots`;
}

function frame(): void {
  if (conn) draw(ctx2d, conn.players, conn.myId);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
