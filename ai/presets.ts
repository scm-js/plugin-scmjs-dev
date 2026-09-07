/**
 * Layout presets: the terrain of a family of scenarios as a stored shape program.
 * "Corner camps around an arena" is every madness map, most arenas and a good part of
 * the hero-survival maps; "lanes from spawns to a goal" is every defense. Each preset
 * takes a few numbers from the design (how many camps, how wide a lane, walls of water
 * or cliff) and answers a plan in the shape language — shapes, the start locations, and
 * the named locations the triggers refer to — which the ordinary renderer lays out. A
 * design that names a preset gets its terrain in a second and for nothing; the planner
 * is only asked for layouts no preset describes.
 *
 * Terrains are chosen by role from the tileset's vocabulary (its plain buildable ground,
 * its water, the high ground its ramps are known to fit), so a preset reads the same on
 * every tileset and its ramps fit where ramps can fit at all.
 */
import type { BridgePair, LayoutPresetSpec, MapPlan, RampPair, Shape, TerrainVocab } from "../protocol";
import { RAMP_CUT } from "./shapes";

export interface PresetContext {
  width: number;
  height: number;
  terrains: readonly TerrainVocab[];
  rampPairs: readonly RampPair[];
  bridgePair?: BridgePair | null;
  /** Human players, 1-based, in slot order: the camps are handed out in this order. */
  humans: number[];
  /** The tileset's doodad category names, for a little decoration by terrain name. */
  doodadCategories?: readonly string[];
}

export type Params = Record<string, string>;

export interface BuiltPreset {
  plan: MapPlan;
  notes: string[];
}

export class PresetError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(problems.join("; ")); this.name = "PresetError"; this.problems = problems; }
}

/* ── Terrain roles ──────────────────────────────────────── */

export interface Roles {
  ground: number;
  /** Unwalkable ground at height 0 — water, lava, tar, space — or null when the tileset has none. */
  water: number | null;
  /** High ground a ramp is known to lead down from, or the first buildable higher ground. */
  high: number;
  /** A second look for the ground: ruins, mud, rocky ground — or the ground itself. */
  dress: number;
}

const WATER = /water|lava|tar|space|ice$|magma/i;
const DRESS = /ruins|mud|rocky|crags|moguls|flagstone|shale|asphalt|plating|crushed/i;

export function terrainRoles(ctx: Pick<PresetContext, "terrains" | "rampPairs">): Roles {
  const t = ctx.terrains;
  const flats0 = t.filter((x) => x.height === 0 && x.buildable);
  const ground = t.find((x) => x.height === 0 && x.buildable && /^(dirt|jungle|snow|space|grass|substructure)$/i.test(x.name)) ?? flats0[0] ?? t[0];
  const water = t.find((x) => x.height === 0 && !x.buildable && WATER.test(x.name)) ?? null;
  const pair = ctx.rampPairs.find((p) => p.low === ground.id) ?? ctx.rampPairs[0];
  const high = pair ? pair.high : (t.find((x) => x.height > 0 && x.buildable)?.id ?? ground.id);
  const dress = t.find((x) => x.height === 0 && DRESS.test(x.name))?.id ?? ground.id;
  return { ground: ground.id, water: water?.id ?? null, high, dress };
}

/* ── Reading parameters ─────────────────────────────────── */

class Reader {
  readonly problems: string[] = [];
  private readonly params: Params;
  private readonly spec: LayoutPresetSpec;
  constructor(params: Params, spec: LayoutPresetSpec) { this.params = params; this.spec = spec; }
  private raw(name: string): string | undefined { const v = this.params[name]; return v === undefined || v.trim() === "" ? undefined : v.trim(); }
  int(name: string, fallback: number, lo: number, hi: number): number {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    const cleaned = v.replace(/[^0-9.-]/g, "");
    const n = cleaned === "" ? NaN : Number(cleaned);
    if (!Number.isFinite(n)) { this.problems.push(`"${name}" should be a number, not "${v}"`); return fallback; }
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }
  text(name: string, fallback: string): string { return this.raw(name) ?? fallback; }
  choice<T extends string>(name: string, options: readonly T[], fallback: T): T {
    const v = this.raw(name)?.toLowerCase();
    if (v === undefined) return fallback;
    const hit = options.find((o) => o.toLowerCase() === v);
    if (!hit) { this.problems.push(`"${name}" should be one of ${options.join(", ")}, not "${v}"`); return fallback; }
    return hit;
  }
  finish() {
    for (const k of Object.keys(this.params)) if (!this.spec.params.some((p) => p.name === k)) this.problems.push(`"${k}" is not a parameter of ${this.spec.id}`);
    if (this.problems.length) throw new PresetError(this.problems.map((p) => `${this.spec.id}: ${p}`));
  }
}

const P = (name: string, description: string, required = false) => ({ name, description, required });

interface Preset {
  spec: LayoutPresetSpec;
  build(r: Reader, ctx: PresetContext, roles: Roles): { shapes: Shape[]; locations: MapPlan["locations"]; units: MapPlan["units"]; notes: string[] };
}

/* ── Geometry helpers ───────────────────────────────────── */

type Loc = MapPlan["locations"][number];
const loc = (name: string, x0: number, y0: number, w: number, h: number): Loc => ({ name, x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x0 + w), y1: Math.round(y0 + h) });
const start = (player: number, x: number, y: number): MapPlan["units"][number] => ({ unit: "Start Location", player, x: Math.round(x), y: Math.round(y) });

/** Camp positions around the map, in reading order: the four corners (two players get opposite corners), then the four edge middles. */
function campSpots(n: number, W: number, H: number, size: number, margin: number): { x: number; y: number; south: boolean; ramp: "sw" | "se" }[] {
  const nw = { x: margin, y: margin, south: false, ramp: "se" as const };
  const ne = { x: W - margin - size, y: margin, south: false, ramp: "sw" as const };
  const sw = { x: margin, y: H - margin - size, south: true, ramp: "se" as const };
  const se = { x: W - margin - size, y: H - margin - size, south: true, ramp: "sw" as const };
  const edges = [
    { x: (W - size) / 2, y: margin, south: false, ramp: "se" as const },
    { x: (W - size) / 2, y: H - margin - size, south: true, ramp: "sw" as const },
    { x: margin, y: (H - size) / 2, south: false, ramp: "se" as const },
    { x: W - margin - size, y: (H - size) / 2, south: false, ramp: "sw" as const },
  ];
  const all = n === 2 ? [nw, se] : [nw, ne, sw, se, ...edges];
  return all.slice(0, Math.max(1, Math.min(8, n)));
}

/* ── The presets ────────────────────────────────────────── */

const PRESETS: Preset[] = [
  {
    spec: {
      id: "corner-camps",
      description: "One raised camp per player around the edge of the map (corners first), each with a single ramp down that faces south (the game's ramps go no other way), a road from the ramp to a central arena, and water or open ground between. Madness, hero survival, free-for-all arenas.",
      params: [
        P("camps", "how many camps, 2–8 (default: the human players)"),
        P("campSize", "a camp's side in tiles (default 28)"),
        P("arena", "the arena's width in tiles (default a third of the map)"),
        P("between", "what fills the ground between camps and arena: water (default), open, or rocks"),
        P("roads", "yes (default) or no: a road of plain ground from each ramp to the arena"),
        P("hall", "a building placed in each camp for its player, by unit name (\"Terran Command Center\"); none by default"),
      ],
      locations: ["Base {p}", "Spawn {p}", "Beacon {p}", "Arena", "Centre"],
    },
    build(r, ctx, roles) {
      const W = ctx.width, H = ctx.height;
      const camps = r.int("camps", Math.max(2, Math.min(8, ctx.humans.length || 2)), 2, 8);
      const size = r.int("campSize", 28, 16, Math.floor(Math.min(W, H) / 3));
      const arena = r.int("arena", Math.round(Math.min(W, H) / 3), 12, Math.floor(Math.min(W, H) / 2));
      const between = r.choice("between", ["water", "open", "rocks"] as const, "water");
      const roads = r.choice("roads", ["yes", "no"] as const, "yes") === "yes";
      const hall = r.text("hall", "");
      const margin = 3;
      const fill = between === "water" && roles.water !== null ? roles.water : between === "rocks" ? roles.dress : roles.ground;
      const cx = W / 2, cy = H / 2;
      const shapes: Shape[] = [{ op: "ground", terrain: fill }];
      const locations: Loc[] = [];
      const units: MapPlan["units"][] = [];
      const spots = campSpots(camps, W, H, size, margin);
      // Roads first, the arena over them, the camps over everything.
      if (roads) for (const s of spots) {
        const foot = s.ramp === "se" ? [s.x + size - RAMP_CUT - 2, s.y + size + 2] : [s.x + RAMP_CUT + 2, s.y + size + 2];
        // A southern camp's ramp faces away from the middle: its road goes down, then along, then up to the arena.
        const via: [number, number][] = s.south ? [[foot[0], Math.min(H - 6, foot[1] + 8)], [cx + (s.x < cx ? -arena / 2 - 6 : arena / 2 + 6), Math.min(H - 6, foot[1] + 8)]] : [];
        shapes.push({ op: "stroke", terrain: roles.ground, points: [[foot[0], foot[1]], ...via, [cx, cy]], width: 10 });
      }
      shapes.push({ op: "diamond", terrain: roles.ground, cx, cy, rx: arena / 2 + 6, ry: arena / 4 + 3 });
      shapes.push({ op: "diamond", terrain: roles.dress, cx, cy, rx: arena / 2, ry: arena / 4 });
      spots.forEach((s, i) => {
        const p = ctx.humans[i] ?? i + 1;
        shapes.push({ op: "plateau", terrain: roles.high, x: s.x, y: s.y, w: size, h: size, ramps: [s.ramp] });
        locations.push(loc(`Base ${p}`, s.x, s.y, size, size));
        const spawnX = s.ramp === "se" ? s.x + size - RAMP_CUT * 2 - 8 : s.x + RAMP_CUT * 2 + 2;
        locations.push(loc(`Spawn ${p}`, spawnX, s.y + size - RAMP_CUT - 8, 6, 6));
        locations.push(loc(`Beacon ${p}`, s.ramp === "se" ? s.x + 3 : s.x + size - 6, s.y + 3, 3, 3));
        units.push([start(p, s.x + size / 2, s.y + size / 2 - 6)]);
        if (hall) units.push([{ unit: hall, player: p, x: Math.round(s.x + size / 2), y: Math.round(s.y + size / 2 + 2) }]);
      });
      locations.push(loc("Arena", cx - arena / 2, cy - arena / 4, arena, arena / 2));
      locations.push(loc("Centre", cx - 4, cy - 3, 8, 6));
      const notes = [`${camps} camp${camps === 1 ? "" : "s"} of ${size}×${size}, ramps facing south as the game's do; the southern camps' roads run around to the arena`];
      if (between === "water" && roles.water === null) notes.push("this tileset has no water; open ground between the camps instead");
      return { shapes, locations, units: units.flat(), notes };
    },
  },
  {
    spec: {
      id: "lanes",
      description: "Lanes for a defense: each lane a walkable band from a spawn at the north edge to one goal at the south, walled by water or cliff so the waves stay in it, with a build yard for each player beside the lanes and a hire pad by each yard. Tower defense, marine defense, sunken defense.",
      params: [
        P("lanes", "how many lanes, 1–4 (default 2)"),
        P("laneWidth", "the lane's width in tiles (default 5)"),
        P("wall", "what walls the lanes: water (default) or cliff"),
        P("bends", "yes or no (default): a bend in each lane"),
      ],
      locations: ["Spawn {n}", "Lane {n} Mid", "Goal", "Yard {p}", "Pad {p}"],
    },
    build(r, ctx, roles) {
      const W = ctx.width, H = ctx.height;
      const lanes = r.int("lanes", 2, 1, 4);
      const width = r.int("laneWidth", 5, 4, 10);
      const wall = r.choice("wall", ["water", "cliff"] as const, "water");
      const bends = r.choice("bends", ["yes", "no"] as const, "no") === "yes";
      const wallTerrain = wall === "water" && roles.water !== null ? roles.water : roles.high;
      const shapes: Shape[] = [{ op: "ground", terrain: roles.ground }];
      const locations: Loc[] = [];
      const units: MapPlan["units"][number][] = [];
      const goalW = Math.min(W - 8, 12 * lanes + 8);
      const goalX = W / 2 - goalW / 2, goalY = H - 14;
      const laneXs = Array.from({ length: lanes }, (_, i) => Math.round(W * (i + 1) / (lanes + 1)));
      // The goal's enclosure goes down first: a block of wall the lanes cut into, so nothing leaves the goal but by a lane.
      const enclosure = wall === "water" ? 6 : 8;
      shapes.push({ op: "rect", terrain: wallTerrain, x: goalX - enclosure, y: goalY - enclosure, w: goalW + 2 * enclosure, h: H - goalY + enclosure, cut: 0 });
      // The floor is the tileset's unbuildable dressing where it has one, so a turret wall cannot block a lane.
      const floor = roles.dress !== roles.ground && ctx.terrains.find((t) => t.id === roles.dress)?.buildable === false ? roles.dress : roles.ground;
      laneXs.forEach((lx, i) => {
        // A bend goes away from the middle, so two lanes never cross. The lane starts off the map's top edge, so
        // the shores' rounding at its end cannot close the spawn.
        const bendX = lx + (lx < W / 2 ? -1 : lx > W / 2 ? 1 : (i % 2 ? -1 : 1)) * Math.min(14, W / 8);
        const pts: [number, number][] = bends
          ? [[lx, -6], [lx, H * 0.35], [bendX, H * 0.5], [lx, H * 0.65], [W / 2 + (lx - W / 2) * 0.3, goalY + 5]]
          : [[lx, -6], [lx, goalY - 6], [W / 2 + (lx - W / 2) * 0.3, goalY + 5]];
        shapes.push({ op: "lane", terrain: floor, points: pts, width, wall: wallTerrain, wallWidth: wall === "water" ? 4 : 6 });
        locations.push(loc(`Spawn ${i + 1}`, lx - 3, 3, 6, 6));
        locations.push(loc(`Lane ${i + 1} Mid`, (bends ? bendX : lx) - width, H / 2 - 4, width * 2, 8));
      });
      // The goal is a pocket the lanes end in, painted after them so the walls do not close it.
      shapes.push({ op: "rect", terrain: floor, x: goalX, y: goalY, w: goalW, h: 10, cut: 2 });
      locations.push(loc("Goal", goalX + 2, goalY + 2, goalW - 4, 6));
      // Yards: one per human, in the strips between and beside the lanes, top to bottom.
      const strips: number[] = [];
      for (let i = 0; i <= lanes; i++) strips.push(Math.round(((laneXs[i - 1] ?? 0) + (laneXs[i] ?? W)) / 2));
      ctx.humans.forEach((p, i) => {
        const sx = strips[i % strips.length], sy = 16 + Math.floor(i / strips.length) * 30;
        const yw = 14, yh = 12;
        locations.push(loc(`Yard ${p}`, sx - yw / 2, sy, yw, yh));
        locations.push(loc(`Pad ${p}`, sx - 2, sy + yh + 2, 4, 3));
        units.push(start(p, sx, sy + yh / 2));
      });
      return { shapes, locations, units, notes: [`${lanes} lane${lanes === 1 ? "" : "s"} ${width} wide walled by ${wall === "water" && roles.water === null ? "cliff (no water in this tileset)" : wall}, one goal at the south edge`] };
    },
  },
  {
    spec: {
      id: "arena",
      description: "A walled arena in the middle of the map — a floor of plain ground ringed by water or cliff that nothing crosses on foot — with a spawn spot inside it on each player's side and a lobby for each player outside, where their start location is. Micro arenas, duels, round-based fights, hero arenas.",
      params: [
        P("size", "the arena's width in tiles (default half the map)"),
        P("sides", "2 (west and east) or 4 (west, east, north, south) spawn sides (default: 2 for up to two players, else 4)"),
        P("wall", "what rings the arena: water (default) or cliff"),
      ],
      locations: ["Arena", "Centre", "Spawn {p}", "Lobby {p}"],
    },
    build(r, ctx, roles) {
      const W = ctx.width, H = ctx.height;
      const humans = ctx.humans.length ? ctx.humans : [1, 2];
      const size = r.int("size", Math.round(Math.min(W, H) / 2), 16, Math.min(W, H) - 24);
      const sides = r.int("sides", humans.length <= 2 ? 2 : 4, 2, 4) >= 3 ? 4 : 2;
      const wall = r.choice("wall", ["water", "cliff"] as const, "water");
      const wallTerrain = wall === "water" && roles.water !== null ? roles.water : roles.high;
      const cx = W / 2, cy = H / 2, half = size / 2, ring = 5;
      const shapes: Shape[] = [
        { op: "ground", terrain: roles.ground },
        { op: "rect", terrain: wallTerrain, x: cx - half - ring, y: cy - half / 2 - ring, w: size + 2 * ring, h: half + 2 * ring, cut: 3 },
        { op: "rect", terrain: roles.dress, x: cx - half, y: cy - half / 2, w: size, h: half, cut: 2 },
      ];
      const locations: Loc[] = [loc("Arena", cx - half, cy - half / 2, size, half), loc("Centre", cx - 4, cy - 3, 8, 6)];
      const units: MapPlan["units"] = [];
      // Spawn spots just inside the wall on each side; lobbies just outside, in the same order.
      const inner: [number, number][] = [[cx - half + 6, cy], [cx + half - 6, cy], [cx, cy - half / 2 + 5], [cx, cy + half / 2 - 5]];
      const outer: [number, number][] = [[cx - half - ring - 10, cy], [cx + half + ring + 10, cy], [cx, cy - half / 2 - ring - 8], [cx, cy + half / 2 + ring + 8]];
      humans.forEach((p, i) => {
        const side = i % sides;
        const [sx, sy] = inner[side], [lx, ly] = outer[side];
        const shift = Math.floor(i / sides) * 8;
        locations.push(loc(`Spawn ${p}`, sx - 3 + shift, sy - 3, 6, 6));
        locations.push(loc(`Lobby ${p}`, lx - 5 + shift, ly - 4, 10, 8));
        units.push(start(p, lx + shift, ly));
      });
      return { shapes, locations, units, notes: [`an arena ${size} wide ringed by ${wall === "water" && roles.water === null ? "cliff (no water in this tileset)" : wall}, spawns on ${sides} sides, lobbies outside`] };
    },
  },
  {
    spec: {
      id: "bound",
      description: "A bound's course: a narrow path of plain ground winding back and forth across a map of water, from a start at the bottom-left to a finish at the top-right, cut into stretches. Each stretch is a field of spots laid back to back along the path — every spot a slab across the whole path, or split into lanes side by side — with safe ground before and after it and a checkpoint at its end. Spots are numbered along the course, lane by lane within a slab, so a stretch's spots are one run of numbers; explosions that roll along a stretch, alternate lanes, or fire a whole stretch at once are patterns over that run. Bounds, obstacle courses, dodge maps.",
      params: [
        P("width", "the path's width in tiles (default 4)"),
        P("legs", "how many times the path crosses the map, 2–8 (default 5)"),
        P("stretches", "obstacle fields along the course, 1–12 (default 5); a checkpoint follows each but the last"),
        P("spotsPerStretch", "slabs in a field, back to back along the path (default 8)"),
        P("lanes", "spots side by side across the path, 1–3 (default 1: one slab spans the path)"),
      ],
      locations: ["Start", "Finish", "Checkpoint {n}", "Stretch {n}", "Spot {n}"],
    },
    build(r, ctx, roles) {
      const W = ctx.width, H = ctx.height;
      const width = r.int("width", 4, 3, 8);
      const legs = r.int("legs", 5, 2, 8);
      const stretches = r.int("stretches", 5, 1, 12);
      const perStretch = r.int("spotsPerStretch", 8, 1, 30);
      const lanes = r.int("lanes", 1, 1, 3);
      const fill = roles.water ?? roles.dress;
      const m = 8;
      // Back and forth: leg 0 runs east along the bottom, leg 1 west one band up, and so on.
      const band = (H - 2 * m) / (legs - 1);
      const pts: [number, number][] = [];
      for (let i = 0; i < legs; i++) {
        const y = H - m - i * band;
        const left: [number, number] = [m, y], right: [number, number] = [W - m, y];
        pts.push(...(i % 2 === 0 ? [left, right] : [right, left]));
      }
      const shapes: Shape[] = [
        { op: "ground", terrain: fill },
        { op: "stroke", terrain: roles.ground, points: pts, width },
        { op: "diamond", terrain: roles.ground, cx: pts[0][0], cy: pts[0][1], rx: 8, ry: 4 },
        { op: "diamond", terrain: roles.ground, cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1], rx: 8, ry: 4 },
      ];
      // Points along the path at a distance from its start, with the direction there.
      const segs: { a: [number, number]; b: [number, number]; len: number }[] = [];
      let total = 0;
      for (let i = 0; i + 1 < pts.length; i++) { const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); segs.push({ a: pts[i], b: pts[i + 1], len }); total += len; }
      const at = (d: number): { x: number; y: number; vertical: boolean } => {
        let left = Math.max(0, Math.min(total, d));
        for (const s of segs) { if (left <= s.len) { const t = s.len ? left / s.len : 0; return { x: s.a[0] + (s.b[0] - s.a[0]) * t, y: s.a[1] + (s.b[1] - s.a[1]) * t, vertical: Math.abs(s.b[1] - s.a[1]) > Math.abs(s.b[0] - s.a[0]) }; } left -= s.len; }
        return { x: pts[pts.length - 1][0], y: pts[pts.length - 1][1], vertical: false };
      };
      const locations: Loc[] = [loc("Start", pts[0][0] - 4, pts[0][1] - 3, 8, 6), loc("Finish", pts[pts.length - 1][0] - 4, pts[pts.length - 1][1] - 3, 8, 6)];
      // The course after the start pad and before the finish pad is cut into equal sections; a field takes the
      // middle of each, safe ground either side, the checkpoint after the field.
      const pad = 10;
      const usable = Math.max(1, total - 2 * pad);
      const section = usable / stretches;
      const slab = 2;
      const fieldLen = Math.min(section * 0.7, perStretch * slab);
      const across = width + 2;
      const laneAcross = across / lanes;
      let spot = 1;
      const stretchLocs: Loc[] = [];
      const checkpointLocs: Loc[] = [];
      for (let sIdx = 0; sIdx < stretches; sIdx++) {
        const fieldStart = pad + section * sIdx + (section - fieldLen) / 2;
        const slabs = Math.max(1, Math.round(fieldLen / slab));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < slabs; i++) {
          const c = at(fieldStart + (i + 0.5) * slab);
          for (let lane = 0; lane < lanes; lane++) {
            const off = -across / 2 + lane * laneAcross;
            const l = c.vertical
              ? loc(`Spot ${spot++}`, c.x + off, c.y - slab / 2, laneAcross, slab)
              : loc(`Spot ${spot++}`, c.x - slab / 2, c.y + off, slab, laneAcross);
            locations.push(l);
            x0 = Math.min(x0, l.x0); y0 = Math.min(y0, l.y0); x1 = Math.max(x1, l.x1); y1 = Math.max(y1, l.y1);
          }
        }
        stretchLocs.push({ name: `Stretch ${sIdx + 1}`, x0, y0, x1, y1 });
        if (sIdx < stretches - 1) { const c = at(fieldStart + fieldLen + Math.min(6, (section - fieldLen) / 4)); checkpointLocs.push(loc(`Checkpoint ${sIdx + 1}`, c.x - 2, c.y - 2, 4, 4)); }
      }
      locations.push(...checkpointLocs, ...stretchLocs);
      const humans = ctx.humans.length ? ctx.humans : [1];
      const units = humans.map((p, i) => start(p, pts[0][0] - 2 + (i % 4) * 2, pts[0][1] - 1 + Math.floor(i / 4) * 2));
      return { shapes, locations, units, notes: [`a path ${width} wide in ${legs} legs, ${stretches} stretch${stretches === 1 ? "" : "es"} of up to ${perStretch} slab${perStretch === 1 ? "" : "s"}${lanes > 1 ? ` in ${lanes} lanes` : ""} (${spot - 1} spots, numbered along the course), a checkpoint after each stretch; water either side${roles.water === null ? " (no water in this tileset: unbuildable ground instead)" : ""}`] };
    },
  },
  {
    spec: {
      id: "town-regions",
      description: "An RPG's world: a town on one corner of a map of water — with a shop spot and a heal spot — and a chain of regions of rising danger joined by paths, each region a broad island with a gate where its path arrives, the last region the boss room in the far corner. Start locations in the town. Linear RPGs, adventure maps, dungeon crawls.",
      params: [
        P("regions", "regions between the town and the boss room, 1–6 (default 3)"),
        P("boss", "yes (default) or no: a boss room at the end"),
        P("town", "which corner holds the town: sw (default), nw, se, ne"),
      ],
      locations: ["Town", "Shop", "Heal", "Region {n}", "Gate {n}", "Path {n}", "Boss Room"],
    },
    build(r, ctx, roles) {
      const W = ctx.width, H = ctx.height;
      const regions = r.int("regions", 3, 1, 6);
      const boss = r.choice("boss", ["yes", "no"] as const, "yes") === "yes";
      const corner = r.choice("town", ["sw", "nw", "se", "ne"] as const, "sw");
      const fill = roles.water ?? roles.dress;
      const m = 14;
      const townAt: [number, number] = [corner.includes("w") ? m + 6 : W - m - 6, corner.includes("s") ? H - m - 4 : m + 4];
      const endAt: [number, number] = [corner.includes("w") ? W - m - 6 : m + 6, corner.includes("s") ? m + 4 : H - m - 4];
      // The chain of blobs: the town, the regions, the boss room, spread along a gentle zigzag from corner to corner.
      const stops = regions + (boss ? 2 : 1);
      const centres: [number, number][] = [];
      for (let i = 0; i < stops; i++) {
        const t = i / (stops - 1);
        const wobble = (i % 2 ? 1 : -1) * Math.min(12, W / 10) * (i === 0 || i === stops - 1 ? 0 : 1);
        centres.push([townAt[0] + (endAt[0] - townAt[0]) * t + wobble * (corner.includes("s") ? 1 : -1) * 0.5, townAt[1] + (endAt[1] - townAt[1]) * t + wobble * 0.5]);
      }
      const shapes: Shape[] = [{ op: "ground", terrain: fill }];
      for (let i = 0; i + 1 < centres.length; i++) shapes.push({ op: "stroke", terrain: roles.ground, points: [centres[i], centres[i + 1]], width: 6 });
      const rx = Math.min(18, W / 7), ry = rx / 2;
      centres.forEach(([x, y], i) => {
        const big = i === 0 ? 1.3 : 1;
        shapes.push({ op: "diamond", terrain: roles.ground, cx: x, cy: y, rx: rx * big, ry: ry * big });
        if (i > 0) shapes.push({ op: "diamond", terrain: roles.dress, cx: x, cy: y, rx: rx * 0.5, ry: ry * 0.5 });
      });
      const locations: Loc[] = [];
      const [tx, ty] = centres[0];
      locations.push(loc("Town", tx - rx * 1.3, ty - ry * 1.3, rx * 2.6, ry * 2.6));
      locations.push(loc("Shop", tx - rx * 0.8, ty - 1, 3, 3), loc("Heal", tx + rx * 0.8 - 3, ty - 1, 3, 3));
      centres.slice(1).forEach(([x, y], i) => {
        const n = i + 1;
        const last = boss && n === centres.length - 1;
        locations.push(loc(last ? "Boss Room" : `Region ${n}`, x - rx, y - ry, rx * 2, ry * 2));
        // The gate: where the path from the previous stop arrives.
        const [px, py] = centres[i];
        const gx = x + (px - x) * (rx / Math.max(1, Math.hypot(px - x, (py - y) * 2))), gy = y + (py - y) * (rx / Math.max(1, Math.hypot(px - x, (py - y) * 2)));
        if (!last) locations.push(loc(`Gate ${n}`, gx - 3, gy - 2, 6, 4));
        locations.push(loc(`Path ${n}`, Math.min(px, x) - 2, Math.min(py, y) - 2, Math.abs(px - x) + 4, Math.abs(py - y) + 4));
      });
      const humans = ctx.humans.length ? ctx.humans : [1];
      const units = humans.map((p, i) => start(p, tx - 3 + (i % 4) * 2, ty + 3 + Math.floor(i / 4) * 2));
      return { shapes, locations, units, notes: [`a town in the ${corner} corner, ${regions} region${regions === 1 ? "" : "s"} along a path${boss ? " and a boss room" : ""} toward the far corner; water between${roles.water === null ? " (no water: unbuildable ground)" : ""}`] };
    },
  },
];

export function presetSpecs(): LayoutPresetSpec[] {
  return PRESETS.map((p) => p.spec);
}

export function presetById(id: string): LayoutPresetSpec | null {
  return PRESETS.find((p) => p.spec.id === id)?.spec ?? null;
}

/** The locations a preset makes, with the players and lanes filled in, for a design's checker or a prompt. */
export function presetLocationNames(spec: LayoutPresetSpec, humans: number[], lanes = 4): string[] {
  const out: string[] = [];
  for (const name of spec.locations) {
    if (name.includes("{p}")) for (const p of humans) out.push(name.replace("{p}", String(p)));
    else if (name.includes("{n}")) for (let n = 1; n <= lanes; n++) out.push(name.replace("{n}", String(n)));
    else out.push(name);
  }
  return out;
}

/** Lay a preset out: a shape plan with its locations and start locations, or a `PresetError` naming what was wrong. */
export function buildPreset(id: string, params: Params, ctx: PresetContext): BuiltPreset {
  const preset = PRESETS.find((p) => p.spec.id === id);
  if (!preset) throw new PresetError([`no layout preset called "${id}" (the plugin has ${PRESETS.map((p) => p.spec.id).join(", ")})`]);
  const r = new Reader(params, preset.spec);
  const roles = terrainRoles(ctx);
  const out = preset.build(r, ctx, roles);
  r.finish();
  const plan: MapPlan = {
    name: "", description: "", symmetry: "none",
    cellSize: 1, columns: ctx.width, rows: ctx.height, legend: {}, grid: [],
    shapes: out.shapes, bases: [], ramps: [], doodads: decoration(ctx, roles), units: out.units, locations: out.locations, notes: out.notes,
  };
  return { plan, notes: out.notes };
}

/**
 * A little decoration: the doodad category named like a terrain goes on that terrain
 * (Jungle's "Jungle" trees on Jungle, "Water" on Water), sparse on the ground so the
 * roads and camps stay open, thicker in the water where nothing walks. The renderer
 * then keeps every doodad to flat ground of its terrain.
 */
export function decoration(ctx: Pick<PresetContext, "terrains" | "doodadCategories">, roles: Roles): MapPlan["doodads"] {
  const categories = ctx.doodadCategories ?? [];
  const name = (id: number) => ctx.terrains.find((t) => t.id === id)?.name ?? "";
  const match = (terrain: number) => categories.find((c) => c.toLowerCase() === name(terrain).toLowerCase()) ?? null;
  const out: MapPlan["doodads"] = [];
  const ground = match(roles.ground);
  if (ground) out.push({ category: ground, on: "", terrains: [roles.ground], density: 0.06 });
  if (roles.water !== null) { const water = match(roles.water); if (water) out.push({ category: water, on: "", terrains: [roles.water], density: 0.15 }); }
  if (roles.dress !== roles.ground) { const dress = match(roles.dress); if (dress) out.push({ category: dress, on: "", terrains: [roles.dress], density: 0.08 }); }
  const high = match(roles.high);
  if (high) out.push({ category: high, on: "", terrains: [roles.high], density: 0.04 });
  return out;
}

/** The catalogue as text for a prompt or a tool answer. */
export function presetsText(): string {
  return PRESETS.map((p) => `${p.spec.id}: ${p.spec.description}\n${p.spec.params.map((x) => `  - ${x.name}${x.required ? " (required)" : ""}: ${x.description}`).join("\n")}\n  makes locations: ${p.spec.locations.join(", ")}`).join("\n\n");
}
