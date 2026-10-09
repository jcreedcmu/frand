import { WORLD_H, WORLD_W } from './consts.js';
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

export function draw(
  ctx: CanvasRenderingContext2D,
  players: Player[],
  myId: string,
): void {
  ctx.clearRect(0, 0, WORLD_W, WORLD_H);

  for (const p of players) {
    const me = p.id === myId;

    ctx.beginPath();
    ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = me ? '#7fb2ff' : '#8f98a8';
    ctx.fill();
    if (me) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#e8e8ea';
      ctx.stroke();
    }

    ctx.fillStyle = '#e8e8ea';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${p.name} [${p.slot}]`, p.x, p.y - DOT_RADIUS - 8);
  }
}
