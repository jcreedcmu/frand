import {
  FAR_CUTOFF_HZ,
  FULL_GAIN_RADIUS,
  GAIN_DROP_DB,
  NEAR_CUTOFF_HZ,
  PAN_WIDTH,
  REVERB_DECAY,
  REVERB_LEVEL,
  REVERB_PREDELAY,
  REVERB_SECONDS,
  REVERB_TONE_HZ,
  SILENCE_RADIUS,
  WET_MAX,
} from './consts.js';
import type { Player } from './net.js';

/**
 * Ramp constant for every parameter change. Movement is instantaneous, so
 * this is what turns a click on every teleport into a fast fade; it is the
 * knob to turn if transitions sound abrupt or mushy.
 */
const RAMP_SECONDS = 0.05;

/** Where the bare exponential lands at the silence radius, subtracted out so
 *  the curve reaches silence exactly rather than merely approaching it. */
const DECAY_FLOOR = 10 ** (-GAIN_DROP_DB / 20);

export type Chain = {
  /** Muted, in the DOM, and playing: without it Chrome never pulls the
   *  WebRTC track into Web Audio, and the symptom is silence with no error. */
  sink: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  gain: GainNode;
  /** Straight to the output. */
  dry: GainNode;
  /** To the shared reverb bus. */
  wet: GainNode;
};

/** What one slot's position works out to at the listener's ears. */
export type Spatial = {
  gain: number;
  pan: number;
  cutoff: number;
  /** Share of the signal sent to reverb rather than straight out. */
  wet: number;
};

/**
 * One chain per slot, built once from transceiver position and permanent for
 * the session: slot `s` is `pc.getTransceivers()[s + 1]`, since transceiver 0
 * is our own mic. Which player a chain carries comes from the snapshot, so a
 * join or a leave never rebuilds anything.
 *
 * The local mic is never routed into the graph; monitoring your own mic is
 * immediate feedback.
 */
export function buildChains(
  ctx: AudioContext,
  pc: RTCPeerConnection,
  slotCount: number,
  sinks: HTMLElement,
): Chain[] {
  const transceivers = pc.getTransceivers();
  const chains: Chain[] = [];
  // One reverb for the whole lobby. Each chain sends to it at its own level,
  // which sounds the same as a reverb per slot at a sixteenth of the cost.
  const reverb = createReverbBus(ctx);

  for (let slot = 0; slot < slotCount; slot++) {
    const track = transceivers[slot + 1].receiver.track;
    const stream = new MediaStream([track]);

    const sink = document.createElement('audio');
    sink.srcObject = stream;
    sink.muted = true;
    sink.autoplay = true;
    sinks.appendChild(sink);
    void sink.play().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = NEAR_CUTOFF_HZ;

    const panner = ctx.createStereoPanner();
    panner.pan.value = 0;

    const gain = ctx.createGain();
    // Silent until a snapshot says otherwise.
    gain.gain.value = 0;

    // Distance volume and muting apply before the split, so they govern both
    // paths; what the split changes is only how much of the voice arrives
    // directly versus as a tail.
    const dry = ctx.createGain();
    dry.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0;

    source.connect(filter).connect(panner).connect(gain);
    gain.connect(dry).connect(ctx.destination);
    gain.connect(wet).connect(reverb);

    chains.push({ sink, source, filter, panner, gain, dry, wet });
  }

  return chains;
}

/**
 * Recomputed when a `state` snapshot arrives, which is the only time anything
 * relevant changes. An unoccupied slot stays silent, and a vacated one fades
 * down through the same path.
 */
export function slotSpatial(
  players: Player[],
  myId: string,
  slotCount: number,
  muted: ReadonlySet<string>,
): Spatial[] {
  const spatial: Spatial[] = Array.from({ length: slotCount }, () => ({
    gain: 0,
    pan: 0,
    cutoff: NEAR_CUTOFF_HZ,
    wet: 0,
  }));

  const me = players.find((p) => p.id === myId);
  if (!me) return spatial;

  for (const p of players) {
    if (p.id === myId) continue;
    const dx = p.x - me.x;
    const distance = Math.hypot(dx, p.y - me.y);

    // 0 at the near radius and inside it, 1 at the silence radius.
    const span = SILENCE_RADIUS - FULL_GAIN_RADIUS;
    const far = clamp01((distance - FULL_GAIN_RADIUS) / span);
    // 0 only when standing on someone, 1 at the silence radius: the filter
    // starts working immediately rather than waiting for the falloff band.
    const muffle = clamp01(distance / SILENCE_RADIUS);

    spatial[p.slot] = {
      // A muted player keeps their pan and cutoff; only the level goes, and
      // it goes through the same ramp, so muting fades rather than clicks.
      gain: muted.has(p.id) ? 0 : decay(far),
      // Over the same full range as the filter, so a voice grows muffled and
      // reverberant together rather than in two separate stages.
      wet: WET_MAX * muffle,
      // Direction rather than offset, so someone level with you is centred
      // however far away they are.
      pan: (PAN_WIDTH * dx) / Math.max(distance, 1),
      // Geometric, because cutoff is heard logarithmically: halving it twice
      // sounds like two equal steps, subtracting 5kHz twice does not.
      cutoff: NEAR_CUTOFF_HZ * (FAR_CUTOFF_HZ / NEAR_CUTOFF_HZ) ** muffle,
    };
  }
  return spatial;
}

/** `setTargetAtTime` rather than assignment to `.value`, which steps the
 *  parameter and produces audible zipper noise. */
export function applySpatial(
  ctx: AudioContext,
  chains: Chain[],
  spatial: Spatial[],
): void {
  chains.forEach((chain, slot) => {
    const want = spatial[slot];
    if (!want) return;
    chain.gain.gain.setTargetAtTime(want.gain, ctx.currentTime, RAMP_SECONDS);
    chain.panner.pan.setTargetAtTime(want.pan, ctx.currentTime, RAMP_SECONDS);
    chain.filter.frequency.setTargetAtTime(want.cutoff, ctx.currentTime, RAMP_SECONDS);
    chain.dry.gain.setTargetAtTime(1 - want.wet, ctx.currentTime, RAMP_SECONDS);
    chain.wet.gain.setTargetAtTime(want.wet, ctx.currentTime, RAMP_SECONDS);
  });
}

/** Input node of the shared reverb: send here, it arrives at the output. */
function createReverbBus(ctx: AudioContext): AudioNode {
  const input = ctx.createGain();
  const predelay = ctx.createDelay(1);
  predelay.delayTime.value = REVERB_PREDELAY;

  const convolver = ctx.createConvolver();
  convolver.buffer = impulseResponse(ctx);

  const level = ctx.createGain();
  level.gain.value = REVERB_LEVEL;

  input.connect(predelay).connect(convolver).connect(level).connect(ctx.destination);
  return input;
}

/**
 * Decaying noise, generated rather than loaded so there is no asset to ship.
 * The two channels are independent noise, which decorrelates the tail and
 * spreads it wider than the voice that fed it, and each is run through a
 * one-pole low-pass so the tail is darker than the direct sound.
 */
function impulseResponse(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * REVERB_SECONDS);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const tone = 1 - Math.exp((-2 * Math.PI * REVERB_TONE_HZ) / ctx.sampleRate);

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    let smoothed = 0;
    for (let i = 0; i < length; i++) {
      smoothed += (Math.random() * 2 - 1 - smoothed) * tone;
      samples[i] = smoothed * (1 - i / length) ** REVERB_DECAY;
    }
  }
  return buffer;
}

/**
 * Exponential decay over the falloff band, normalised to be exactly 1 at the
 * near radius and exactly 0 at the silence radius.
 */
function decay(far: number): number {
  const level = 10 ** ((-GAIN_DROP_DB * far) / 20);
  return (level - DECAY_FLOOR) / (1 - DECAY_FLOOR);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
