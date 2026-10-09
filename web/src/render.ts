import {
  DOT_GROWTH,
  FULL_GAIN_RADIUS,
  SILENCE_RADIUS,
  WORLD_H,
  WORLD_W,
} from './consts.js';
import type { Spatial } from './audio.js';
import type { Player } from './net.js';

const DOT_RADIUS = 14;

export function prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  canvas.width = WORLD_W;
  canvas.height = WORLD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  return ctx;
}

/** Canvas is displayed scaled, so clicks need the element's current size. */
export function toWorld(
  canvas: HTMLCanvasElement,
  ev: MouseEvent,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * WORLD_W,
    y: ((ev.clientY - rect.top) / rect.height) * WORLD_H,
  };
}

/**
 * Each dot carries its slot index, gain, and cutoff, which is what makes
 * "does this sound right" answerable by looking: the numbers separate a slot
 * mapping problem from a distance one from an audio graph one.
 */
export function draw(
  ctx: CanvasRenderingContext2D,
  players: Player[],
  myId: string,
  spatial: Spatial[],
  levels: number[],
): void {
  ctx.clearRect(0, 0, WORLD_W, WORLD_H);

  const me = players.find((p) => p.id === myId);
  if (me) drawRings(ctx, me);

  for (const p of players) {
    const mine = p.id === myId;

    // Size tracks how loud this player is right now, which is approximate by
    // design: it is there to tell you who is talking at a glance.
    const radius = DOT_RADIUS * (1 + DOT_GROWTH * (levels[p.slot] ?? 0));

    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = mine ? '#7fb2ff' : '#8f98a8';
    ctx.fill();
    if (mine) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#e8e8ea';
      ctx.stroke();
    }

    const heard = spatial[p.slot];
    const label = mine
      ? `${p.name} [${p.slot}]`
      : `${p.name} [${p.slot}] ${heard.gain.toFixed(2)} ${kilohertz(heard.cutoff)}`;
    ctx.fillStyle = '#e8e8ea';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, p.x, p.y - radius - 8);
  }
}

function kilohertz(hz: number): string {
  return `${(hz / 1000).toFixed(1)}k`;
}

/** Full volume and no filtering inside the inner ring, silence outside the
 *  outer one. */
function drawRings(ctx: CanvasRenderingContext2D, me: Player): void {
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  for (const radius of [FULL_GAIN_RADIUS, SILENCE_RADIUS]) {
    ctx.beginPath();
    ctx.arc(me.x, me.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = radius === FULL_GAIN_RADIUS ? '#4d6b99' : '#3a4250';
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
