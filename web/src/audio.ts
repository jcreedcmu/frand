export type Chain = {
  /** Muted, in the DOM, and playing: without it Chrome never pulls the
   *  WebRTC track into Web Audio, and the symptom is silence with no error. */
  sink: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
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
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(ctx.destination);

    chains.push({ sink, source, gain });
  }

  return chains;
}
