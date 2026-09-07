/**
 * Where units can walk, read off the map's tiles: a tile counts as walkable when at
 * least half of its sixteen minitiles are (the VF4 flags the tileset carries), and the
 * flood from a tile goes through its four neighbours. What it answers — can a unit get
 * from here to there on foot — is the question a lane, a bound's path or a base's ramp
 * has to have the right answer to, and the one a picture cannot settle.
 */
import type { PluginApi } from "@scm-js/plugin-api";

export interface WalkMask {
  width: number;
  height: number;
  /** 1 where a unit can stand. */
  walk: Uint8Array;
}

/** The open map's walkable tiles; null without a map or the tileset graphics. */
export function walkMask(api: PluginApi): WalkMask | null {
  const scn = api.document.scenario();
  if (!scn || !api.tileset.isLoaded()) return null;
  const { width, height } = scn;
  const walk = new Uint8Array(width * height);
  const cache = new Map<number, number>();
  for (let i = 0; i < width * height; i++) {
    const id = scn.tiles[i];
    let w = cache.get(id);
    if (w === undefined) { w = (api.terrain.tileInfo(id)?.walkable ?? 0) >= 8 ? 1 : 0; cache.set(id, w); }
    walk[i] = w;
  }
  return { width, height, walk };
}

/** The tiles reachable on foot from (x, y): a mask of the same size, empty when the start itself is not walkable. */
export function floodFrom(mask: WalkMask, x: number, y: number): Uint8Array {
  const { width, height, walk } = mask;
  const seen = new Uint8Array(width * height);
  if (x < 0 || y < 0 || x >= width || y >= height || !walk[y * width + x]) return seen;
  const stack = [y * width + x];
  seen[stack[0]] = 1;
  while (stack.length) {
    const at = stack.pop()!;
    const cx = at % width, cy = Math.floor(at / width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (seen[n] || !walk[n]) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}

/** The nearest walkable tile to (x, y) within `radius`, or null. */
export function nearestWalkable(mask: WalkMask, x: number, y: number, radius = 6): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height || !mask.walk[ny * mask.width + nx]) continue;
    const d = dx * dx + dy * dy;
    if (d < bestD) { best = { x: nx, y: ny }; bestD = d; }
  }
  return best;
}

/** Whether a rect holds any tile of a reach mask. */
export function reachTouches(mask: WalkMask, reach: Uint8Array, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
  for (let y = Math.max(0, r.y0); y < Math.min(mask.height, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(mask.width, r.x1); x++) if (reach[y * mask.width + x]) return true;
  return false;
}
