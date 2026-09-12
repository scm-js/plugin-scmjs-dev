/**
 * Reading a map's bases and finding room for a new one: what the assistant used to
 * assemble from a list of every resource and a screenshot per base, over ten or more
 * rounds, answered in one. Pure over tile arrays so the tests need no map.
 */
import type { Direction } from "../protocol";
import { angleDirection, DIRECTIONS } from "./plan";

export interface ResourceUnit { index: number; kind: "mineral" | "geyser"; tx: number; ty: number; amount: number }

export interface ResourceCluster {
  minerals: ResourceUnit[];
  geysers: ResourceUnit[];
  /** The mean tile of its resources. */
  cx: number;
  cy: number;
  /** The tiles the resources cover (x1, y1 exclusive). */
  x0: number; y0: number; x1: number; y1: number;
}

/** Resources grouped by nearness: two are in one cluster when a chain of them lies within `gap` tiles of each other. */
export function clusterResources(units: readonly ResourceUnit[], gap = 5): ResourceCluster[] {
  const parent = units.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    if (Math.abs(units[i].tx - units[j].tx) <= gap && Math.abs(units[i].ty - units[j].ty) <= gap) parent[find(i)] = find(j);
  }
  const groups = new Map<number, ResourceUnit[]>();
  units.forEach((u, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(u); else groups.set(r, [u]); });
  return [...groups.values()].map((g) => {
    const xs = g.map((u) => u.tx), ys = g.map((u) => u.ty);
    return {
      minerals: g.filter((u) => u.kind === "mineral"),
      geysers: g.filter((u) => u.kind === "geyser"),
      cx: xs.reduce((a, b) => a + b, 0) / g.length,
      cy: ys.reduce((a, b) => a + b, 0) / g.length,
      x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1,
    };
  }).sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

/** The compass point of a vector in screen coordinates (y down): 0,-1 is north. */
export function compassOf(dx: number, dy: number): Direction {
  return angleDirection(Math.atan2(dy, dx));
}

/** The point across the compass. */
export function oppositeOf(d: Direction): Direction {
  return DIRECTIONS[(DIRECTIONS.indexOf(d) + 4) % 8];
}

export interface SiteMask {
  width: number;
  height: number;
  /** 1 where a tile may be part of a site. */
  ok: Uint8Array;
}

export interface Site { x: number; y: number; distance: number }

/**
 * Top-left tiles of every `w × h` block whose tiles are all ok, nearest to `near` first
 * (by the block's centre), within `radius` tiles of it. A summed-area table makes each
 * block one subtraction, so the whole map is scanned.
 */
export function scanSites(mask: SiteMask, w: number, h: number, near: { x: number; y: number }, radius: number, limit = 5): Site[] {
  const { width, height, ok } = mask;
  if (w < 1 || h < 1 || w > width || h > height) return [];
  const W = width + 1;
  const sum = new Int32Array(W * (height + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) sum[(y + 1) * W + x + 1] = ok[y * width + x] + sum[y * W + x + 1] + sum[(y + 1) * W + x] - sum[y * W + x];
  const block = (x: number, y: number) => sum[(y + h) * W + x + w] - sum[y * W + x + w] - sum[(y + h) * W + x] + sum[y * W + x];
  const out: Site[] = [];
  const x0 = Math.max(0, Math.floor(near.x - radius - w / 2)), x1 = Math.min(width - w, Math.ceil(near.x + radius - w / 2));
  const y0 = Math.max(0, Math.floor(near.y - radius - h / 2)), y1 = Math.min(height - h, Math.ceil(near.y + radius - h / 2));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (block(x, y) !== w * h) continue;
    const dx = x + w / 2 - near.x, dy = y + h / 2 - near.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= radius) out.push({ x, y, distance });
  }
  out.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  // Sites that overlap a nearer one say nothing new: keep those at least a block apart.
  const kept: Site[] = [];
  for (const s of out) {
    if (kept.some((k) => Math.abs(k.x - s.x) < w && Math.abs(k.y - s.y) < h)) continue;
    kept.push(s);
    if (kept.length >= limit) break;
  }
  return kept;
}
