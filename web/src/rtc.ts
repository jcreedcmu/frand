/**
 * One negotiation per session: m-line 0 is our mic, then one recvonly m-line
 * per slot. Nothing here renegotiates, so there is no `negotiationneeded`
 * handling and no ICE restart.
 */
export async function createOffer(
  mic: MediaStreamTrack,
  slotCount: number,
): Promise<{ pc: RTCPeerConnection; sdp: string }> {
  // No STUN: the only candidate that matters is the server's, and it arrives
  // in the answer. An ice-lite server ignores ours, so the offer can go out
  // without waiting for gathering.
  const pc = new RTCPeerConnection({ iceServers: [] });
  // addTransceiver, not addTrack: the latter negotiates m-line 0 as sendrecv,
  // which makes the server read it as a slot rather than as the mic.
  pc.addTransceiver(mic, { direction: 'sendonly' });
  for (let i = 0; i < slotCount; i++) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (!offer.sdp) throw new Error('browser produced an offer with no sdp');
  return { pc, sdp: offer.sdp };
}
