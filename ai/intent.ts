/**
 * Where a tool call lands on the map, worked out from its arguments *before* it runs —
 * the rect `paint_terrain` will fill, the tiles `place_units` will use, the ring
 * `place_base` lays resources on, the location
 * `edit_location` will move — so the assistant can show its intent on the map (a teal
 * outline through an overlay while the call runs) and flash the result afterwards
 * (gold, through `api.view.flash`). Pure over the call's input and the scenario's
 * lists; a call with no place on the map answers an empty list.
 */
import type { PluginApi } from "@scm-js/plugin-api";

/** A footprint in tiles: rects (exclusive far edges), and units / locations by index. */
export interface Footprint {
  rects: { x0: number; y0: number; x1: number; y1: number }[];
  units: number[];
  locations: number[];
}

const EMPTY: Footprint = { rects: [], units: [], locations: [] };

const n = (v: unknown, d = NaN): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => Math.round(n(x))).filter((x) => Number.isInteger(x) && x >= 0) : []);

/** The tile rect named by `x0, y0, x1, y1` (or the whole map when none is given and `whole` says so). */
function rectOf(input: Record<string, unknown>, width: number, height: number, whole: boolean): Footprint["rects"] {
  const has = ["x0", "y0", "x1", "y1"].some((k) => input[k] !== undefined);
  if (!has) return whole ? [{ x0: 0, y0: 0, x1: width, y1: height }] : [];
  const x0 = Math.max(0, Math.min(width, Math.round(n(input.x0, 0)))), y0 = Math.max(0, Math.min(height, Math.round(n(input.y0, 0))));
  const x1 = Math.max(x0, Math.min(width, Math.round(n(input.x1, width)))), y1 = Math.max(y0, Math.min(height, Math.round(n(input.y1, height))));
  return x1 > x0 && y1 > y0 ? [{ x0, y0, x1, y1 }] : [];
}

/** One tile per `{ x, y }` entry of a list. */
function tilesOf(list: unknown, width: number, height: number): Footprint["rects"] {
  if (!Array.isArray(list)) return [];
  const out: Footprint["rects"] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const x = Math.round(n((e as Record<string, unknown>).x)), y = Math.round(n((e as Record<string, unknown>).y));
    if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height) out.push({ x0: x, y0: y, x1: x + 1, y1: y + 1 });
  }
  return out;
}

/**
 * The footprint of a tool call. `api` is read only for the map's size and, for calls that
 * name a location by slot, to confirm the slot exists.
 */
export function footprintOf(api: PluginApi, name: string, input: Record<string, unknown>): Footprint {
  const info = api.document.info();
  if (!info) return EMPTY;
  const { width, height } = info;
  switch (name) {
    case "paint_terrain": case "set_fog": case "scatter_doodads":
      return { ...EMPTY, rects: rectOf(input, width, height, false) };
    case "screenshot": case "terrain_at": case "fog_at": case "list_doodads": case "list_sprites":
      return { ...EMPTY, rects: rectOf(input, width, height, name === "screenshot") };
    case "place_units":
      return { ...EMPTY, rects: tilesOf(input.units, width, height) };
    case "place_base": {
      // The hall's 4 × 3 footprint with the resource ring round it: three tiles' gap, then a geyser's 4 × 2 box.
      const x = Math.round(n(input.x)), y = Math.round(n(input.y));
      if (!Number.isInteger(x) || !Number.isInteger(y)) return EMPTY;
      const x0 = Math.max(0, x - 7), y0 = Math.max(0, y - 5), x1 = Math.min(width, x + 4 + 7), y1 = Math.min(height, y + 3 + 5);
      return x1 > x0 && y1 > y0 ? { ...EMPTY, rects: [{ x0, y0, x1, y1 }] } : EMPTY;
    }
    case "place_doodads":
      return { ...EMPTY, rects: tilesOf(input.doodads, width, height) };
    case "place_sprites":
      return { ...EMPTY, rects: tilesOf(input.sprites, width, height) };
    case "move_units": {
      const moves = Array.isArray(input.moves) ? input.moves as Record<string, unknown>[] : [];
      return { ...EMPTY, rects: tilesOf(moves, width, height), units: ints(moves.map((m) => m.index)) };
    }
    case "remove_units": case "update_units":
      return { ...EMPTY, units: ints(input.indices) };
    case "add_location":
      return { ...EMPTY, rects: rectOf(input, width, height, false) };
    case "edit_location": {
      const index = Math.round(n(input.index));
      return { ...EMPTY, rects: rectOf(input, width, height, false), locations: Number.isInteger(index) && index >= 0 ? [index] : [] };
    }
    case "remove_locations":
      return { ...EMPTY, locations: ints(input.indices) };
    case "go_to": {
      const x = n(input.x), y = n(input.y);
      if (Number.isFinite(x) && Number.isFinite(y)) return { ...EMPTY, rects: tilesOf([{ x, y }], width, height) };
      const unit = n(input.unit), location = n(input.location);
      return { ...EMPTY, units: Number.isFinite(unit) ? [unit] : [], locations: Number.isFinite(location) ? [location] : [] };
    }
    case "select": {
      return { ...EMPTY, rects: rectOf(input, width, height, false), units: ints(input.units), locations: ints(input.locations) };
    }
    case "layout_preset":
      return { ...EMPTY, rects: [{ x0: 0, y0: 0, x1: width, y1: height }] };
    case "place_ramp": case "place_bridge": {
      // The fit is tried within a few tiles of the point; the box says where the search is.
      const x = Math.round(n(input.x)), y = Math.round(n(input.y));
      if (!Number.isInteger(x) || !Number.isInteger(y)) return EMPTY;
      const x0 = Math.max(0, x - 4), y0 = Math.max(0, y - 4), x1 = Math.min(width, x + 5), y1 = Math.min(height, y + 5);
      return x1 > x0 && y1 > y0 ? { ...EMPTY, rects: [{ x0, y0, x1, y1 }] } : EMPTY;
    }
    case "paint_shapes":
      return { ...EMPTY, rects: shapesBox(input, width, height) };
    default:
      return EMPTY;
  }
}

/**
 * The box round every shape a `paint_shapes` call names, shifted by its origin — a ground or
 * border shape is the whole map. Each shape's own bounds are read the way the renderer reads
 * them (rect by corner and size, diamond and ellipse by centre and radii, the point shapes by
 * their points plus half their width, ramps and bridges a few tiles round their tile).
 */
function shapesBox(input: Record<string, unknown>, width: number, height: number): Footprint["rects"] {
  if (!Array.isArray(input.shapes)) return [];
  const dx = Math.round(n(input.originX, 0)), dy = Math.round(n(input.originY, 0));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (l: number, t: number, r: number, b: number) => { x0 = Math.min(x0, l); y0 = Math.min(y0, t); x1 = Math.max(x1, r); y1 = Math.max(y1, b); };
  for (const raw of input.shapes) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const op = [s.op, s.type, s.kind, s.shape].find((v) => typeof v === "string");
    switch (op) {
      case "ground": case "border":
        return [{ x0: 0, y0: 0, x1: width, y1: height }];
      case "rect": case "plateau": {
        const x = n(s.x), y = n(s.y), w = n(s.w), h = n(s.h);
        if ([x, y, w, h].every(Number.isFinite)) grow(x, y, x + w, y + h);
        break;
      }
      case "diamond": case "ellipse": {
        const cx = n(s.cx), cy = n(s.cy), rx = n(s.rx), ry = n(s.ry, rx);
        if ([cx, cy, rx, ry].every(Number.isFinite)) grow(cx - rx, cy - ry, cx + rx, cy + ry);
        break;
      }
      case "polygon": case "stroke": case "lane": {
        const half = Math.ceil((op === "polygon" ? 0 : n(s.width, 1) + (op === "lane" ? 2 * n(s.wallWidth, 1) : 0)) / 2);
        if (!Array.isArray(s.points)) break;
        for (const p of s.points) {
          if (!Array.isArray(p)) continue;
          const px = n(p[0]), py = n(p[1]);
          if (Number.isFinite(px) && Number.isFinite(py)) grow(px - half, py - half, px + half + 1, py + half + 1);
        }
        break;
      }
      case "ramp": case "bridge": {
        const x = n(s.x), y = n(s.y);
        if (Number.isFinite(x) && Number.isFinite(y)) grow(x - 4, y - 4, x + 5, y + 5);
        break;
      }
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return [];
  const l = Math.max(0, Math.floor(x0 + dx)), t = Math.max(0, Math.floor(y0 + dy)), r = Math.min(width, Math.ceil(x1 + dx)), b = Math.min(height, Math.ceil(y1 + dy));
  return r > l && b > t ? [{ x0: l, y0: t, x1: r, y1: b }] : [];
}

/**
 * Where the view should go to watch a call: the box round the footprint, in tiles, or null
 * when there is nowhere in particular to go — an empty footprint, or one that is the whole
 * map, which the view would only zoom out for.
 */
export function followBox(api: PluginApi, f: Footprint): { x0: number; y0: number; x1: number; y1: number } | null {
  const info = api.document.info();
  if (!info || footprintEmpty(f)) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (l: number, t: number, r: number, b: number) => { x0 = Math.min(x0, l); y0 = Math.min(y0, t); x1 = Math.max(x1, r); y1 = Math.max(y1, b); };
  for (const r of f.rects) grow(r.x0, r.y0, r.x1, r.y1);
  const scn = f.units.length || f.locations.length ? api.document.scenario() : null;
  if (scn) {
    for (const i of f.units) { const u = scn.units[i]; if (u) grow(Math.floor(u.x / 32), Math.floor(u.y / 32), Math.ceil(u.x / 32) + 1, Math.ceil(u.y / 32) + 1); }
    for (const i of f.locations) {
      const l = scn.locations[i];
      if (l && i !== 63) grow(Math.floor(Math.min(l.left, l.right) / 32), Math.floor(Math.min(l.top, l.bottom) / 32), Math.ceil(Math.max(l.left, l.right) / 32), Math.ceil(Math.max(l.top, l.bottom) / 32));
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(info.width, x1); y1 = Math.min(info.height, y1);
  if (x1 <= x0 || y1 <= y0) return null;
  if (x1 - x0 >= info.width && y1 - y0 >= info.height) return null;
  return { x0, y0, x1, y1 };
}

export function footprintEmpty(f: Footprint): boolean {
  return f.rects.length === 0 && f.units.length === 0 && f.locations.length === 0;
}
