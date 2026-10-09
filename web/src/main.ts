import type { Conn } from './net.js';
import { connect } from './net.js';
import { draw, prepare, toWorld } from './render.js';

const nameInput = document.getElementById('name') as HTMLInputElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;
const canvas = document.getElementById('world') as HTMLCanvasElement;
const ctx = prepare(canvas);

let conn: Conn | null = null;

joinButton.addEventListener('click', join);
nameInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') join();
});

canvas.addEventListener('click', (ev) => {
  if (!conn) return;
  const { x, y } = toWorld(canvas, ev);
  conn.move(x, y);
});

async function join(): Promise<void> {
  if (conn) return;
  joinButton.disabled = true;
  status.textContent = 'connecting...';

  const name = nameInput.value.trim() || 'anon';
  try {
    conn = await connect(name, {
      onState: () => {},
      onClose: () => {
        conn = null;
        joinButton.disabled = false;
        status.textContent = 'disconnected';
      },
    });
  } catch (err) {
    joinButton.disabled = false;
    status.textContent = `failed: ${(err as Error).message}`;
    return;
  }

  nameInput.disabled = true;
  status.textContent = `${name} is ${conn.myId}, slot count ${conn.slotCount}`;
}

function frame(): void {
  if (conn) draw(ctx, conn.players, conn.myId);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
