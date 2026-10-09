import {
  applySpatial,
  buildChains,
  createMicMeter,
  follow,
  meterLevel,
  slotSpatial,
} from './audio.js';
import type { Chain, Meter, Spatial } from './audio.js';
import type { Conn, Player } from './net.js';
import { connect } from './net.js';
import { draw, prepare, toWorld } from './render.js';
import { createOffer } from './rtc.js';
import { createRoster } from './roster.js';

const nameInput = document.getElementById('name') as HTMLInputElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;
const canvas = document.getElementById('world') as HTMLCanvasElement;
const sinks = document.getElementById('sinks') as HTMLDivElement;
const people = document.getElementById('people') as HTMLDivElement;
const ctx2d = prepare(canvas);
const roster = createRoster(people, () => {
  if (conn) update(conn.players);
});

let conn: Conn | null = null;
let audio: AudioContext | null = null;
let peer: RTCPeerConnection | null = null;
let mic: MediaStream | null = null;
let chains: Chain[] = [];
let spatial: Spatial[] = [];
let micMeter: Meter | null = null;
/** Smoothed level per slot, driving dot size. */
let levels: number[] = [];
/** Our own slot, which carries no audio and so is free for our mic level. */
let mySlot: number | null = null;

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
    audio = new AudioContext();
    await audio.resume();

    mic = await navigator.mediaDevices.getUserMedia({
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
      onState: update,
      onAnswer: (sdp) => deliverAnswer(sdp),
      onClose: () => {
        conn = null;
        teardown();
        joinButton.disabled = false;
        status.textContent = 'disconnected';
      },
    });

    status.textContent = 'negotiating...';
    const { pc, sdp } = await createOffer(mic.getAudioTracks()[0], conn.slotCount);
    peer = pc;
    chains = buildChains(audio, pc, conn.slotCount, sinks);
    micMeter = createMicMeter(audio, mic);
    conn.sendOffer(sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: await answer });

    nameInput.disabled = true;
    update(conn.players);
  } catch (err) {
    conn = null;
    teardown();
    joinButton.disabled = false;
    status.textContent = `failed: ${(err as Error).message}`;
  }
}

/**
 * Rejoining builds a fresh context, peer connection, and set of chains, so
 * the previous ones have to go: an `AudioContext` left open keeps its reverb
 * convolver running, and the sink elements would accumulate in the DOM.
 */
function teardown(): void {
  peer?.close();
  peer = null;
  mic?.getTracks().forEach((track) => track.stop());
  mic = null;
  void audio?.close();
  audio = null;
  micMeter = null;
  sinks.replaceChildren();
  chains = [];
  spatial = [];
  levels = [];
  mySlot = null;
}

/**
 * A snapshot is the only thing that changes a gain, since positions are the
 * only input to the falloff and they only ever arrive this way.
 */
function update(players: Player[]): void {
  if (!conn) return;
  mySlot = players.find((p) => p.id === conn?.myId)?.slot ?? null;
  spatial = slotSpatial(players, conn.myId, conn.slotCount, roster.muted);
  if (audio) applySpatial(audio, chains, spatial);
  roster.update(players, conn.myId, spatial);
  describe(players);
}

/** The slot is worth showing: it is what the server log lines are keyed by. */
function describe(players: Player[]): void {
  if (!conn) return;
  const me = players.find((p) => p.id === conn?.myId);
  const others = players.filter((p) => p.id !== conn?.myId).length;
  const audible = spatial.filter((heard) => heard.gain > 0.01).length;
  status.textContent =
    `${conn.myId} in slot ${me?.slot ?? '?'}, ${audible} of ${others} audible`;
}

function frame(): void {
  if (conn) {
    chains.forEach((chain, slot) => {
      levels[slot] = follow(levels[slot] ?? 0, meterLevel(chain.meter));
    });
    if (mySlot !== null) {
      levels[mySlot] = follow(levels[mySlot] ?? 0, micMeter ? meterLevel(micMeter) : 0);
    }
    draw(ctx2d, conn.players, conn.myId, spatial, levels);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
