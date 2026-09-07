/**
 * The shape language's compiler: a list of statements — ground, rects with isometric
 * corners, diamonds, ellipses, polygons, strokes, borders, plateaus with ramps, lanes —
 * painted in order onto a one-tile grid, which the ordinary renderer then lays with the
 * isometric brush. The model writes twenty statements instead of a thousand cells, and
 * the things a grid cannot promise are promised here: a lane is continuous by
 * construction, a plateau that asks for a ramp gets an edge a ramp can sit on, and a
 * river that names its bridges bends onto the diagonal a bridge spans and narrows to
 * its channel there, so the water reaches the bridge from both sides.
 *
 * Ramps are the reason the corners are cut the way they are. The game's ramps are
 * doodads that fit only on a straight diagonal cliff run, and only the two runs that
 * face south (down-left and down-right) — measured on real tilesets: a plateau painted
 * as a tile-aligned rectangle takes no ramp anywhere, a diamond takes them all along
 * its lower edges. So a plateau's ramp corner is cut at the lattice's 2:1 slope, deep
 * enough for a six-tile ramp, and the pair of terrains the tileset has ramps for is
 * painted either side of the site (the rest of the plateau may be any ground of that
 * height; same-height terrains meet without a cliff). `render.ts` finds the exact tile
 * the ramp fits at afterwards, with the editor's own placement check.
 */
import type { BridgePair, BridgePlan, DoodadPlan, MapPlan, RampPair, RampPlan, RampSide, Shape, TerrainVocab } from "../protocol";
import { LEGEND_CHARS } from "./grid";

export interface ShapeContext {
  width: number;
  height: number;
  terrains: readonly TerrainVocab[];
  /** The pairs the tileset has ramps for; empty when unknown (ramps are then left to the renderer's sampling). */
  rampPairs: readonly RampPair[];
  /** What the tileset's bridges stand on and span; null when it has none. */
  bridgePair?: BridgePair | null;
}

export interface Compiled {
  /** Terrain id per tile, row-major; -1 where nothing was painted. */
  cells: Int32Array;
  ramps: RampPlan[];
  bridges: BridgePlan[];
  findings: string[];
}

/** The width of the water channel a bridge spans when the pair does not say, in tiles across the diagonal. */
export const BRIDGE_CHANNEL = 5;
/** How far the channel and its banks are painted either side of a bridge site, in steps of the 2:1 diagonal (a step is two tiles across and one down). */
export const BRIDGE_REACH = 14;
/** The bank of the bridge's ground painted either side of its channel, in tiles. */
export const BRIDGE_BANK = 8;
/** How far a river with bridges tapers from its own width to the channel beyond each end of the channel, in diagonal steps. */
export const BRIDGE_TAPER = 4;
/** How wide a stroke's bank is either side when it names one and no width, in tiles: what the brush's shores eat. */
export const BANK_WIDTH = 7;
/** What a lane's band grows by so that its walkable core is the width asked for: water shores either side, or cliff edges. */
export const LANE_SHORE_PAD = 7;
export const LANE_CLIFF_PAD = 3;

/** How deep a ramp corner is cut, in rows: the ramp is six tiles square and wants a run longer than itself. */
export const RAMP_CUT = 7;
/** The default isometric corner cut of a rect or plateau, in rows. */
export const DEFAULT_CUT = 2;
/** How wide a band of the ramp pair is painted along a plateau's ramp edge, in tiles. */
export const RAMP_APRON = 22;

type Pt = [number, number];
/** A point of a river with a width there; `bridge` marks the vertices of a bridge's channel, by bridge. */
interface Vertex { p: Pt; w: number; bridge?: number }
interface BridgeSite { x: number; y: number; along?: RampSide }

/** Paint every statement, in order. */
export function compileShapes(shapes: readonly Shape[], ctx: ShapeContext): Compiled {
  const { width, height } = ctx;
  const cells = new Int32Array(width * height).fill(-1);
  const findings: string[] = [];
  const ramps: RampPlan[] = [];
  const bridges: BridgePlan[] = [];
  const known = new Map(ctx.terrains.map((t) => [t.id, t]));
  const put = (x: number, y: number, id: number) => { if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = id; };
  const terrainOf = (s: Shape, what: string): number | null => {
    if (typeof s.terrain !== "number" || !known.has(s.terrain)) { findings.push(`${what} names terrain ${s.terrain}, which this tileset lacks; skipped`); return null; }
    return s.terrain;
  };

  // Lanes that follow one another are one system: every wall first, then every floor, so two lanes that
  // converge (at a defense's goal) do not cut each other's floor with their walls.
  const laneBatch = new Set<number>();
  const laneFloors: (() => void)[] = [];
  shapes.forEach((s, i) => {
    const what = `shape ${i + 1} (${s.op})`;
    if (s.op === "lane" && !laneBatch.has(i)) {
      let j = i;
      while (j < shapes.length && shapes[j].op === "lane") laneBatch.add(j++);
    }
    switch (s.op) {
      case "ground": {
        const id = terrainOf(s, what); if (id === null) return;
        cells.fill(id);
        return;
      }
      case "rect":
      case "plateau": {
        const id = terrainOf(s, what); if (id === null) return;
        const r = rectOf(s);
        if (!r) { findings.push(`${what} has no size; skipped`); return; }
        const cut = Math.max(0, Math.round(s.cut ?? DEFAULT_CUT));
        const sides = s.op === "plateau" ? uniqueSides(s.ramps ?? []) : [];
        const cuts = { nw: cut, ne: cut, sw: sides.includes("sw") ? Math.max(cut, RAMP_CUT) : cut, se: sides.includes("se") ? Math.max(cut, RAMP_CUT) : cut };
        fillCutRect(r, cuts, (x, y) => put(x, y, id));
        for (const side of sides) {
          const pair = pairFor(id, ctx, known);
          if (!pair) { findings.push(`${what}: this tileset has no ramp for ground of that height; the ${side} corner is cut but no ramp will fit`); continue; }
          const site = rampSite(r, cuts, side);
          // The pair either side of the whole cut edge: the plateau's ramp terrain inside, its foot outside, as a wide
          // skirt — the brush puts two tiles of blend between any two grounds and two of cliff between two heights, and a
          // ramp wants flat ground of the pair on both sides of a straight run, so a narrow patch is all edges and no fit.
          const edge = rampEdge(r, cuts, side);
          strokePolyline(edge, RAMP_APRON, (x, y) => { if (x < 0 || y < 0 || x >= width || y >= height) return; put(x, y, insideCutRect(r, cuts, x, y) ? pair.high : pair.low); });
          ramps.push({ x: site.x, y: site.y, direction: side, low: pair.low, high: pair.high });
        }
        return;
      }
      case "diamond": {
        const id = terrainOf(s, what); if (id === null) return;
        if (!radii(s)) { findings.push(`${what} has no radii; skipped`); return; }
        forDiamond(s.cx!, s.cy!, s.rx!, s.ry!, (x, y) => put(x, y, id));
        return;
      }
      case "ellipse": {
        const id = terrainOf(s, what); if (id === null) return;
        if (!radii(s)) { findings.push(`${what} has no radii; skipped`); return; }
        const { cx, cy, rx, ry } = s as Required<Pick<Shape, "cx" | "cy" | "rx" | "ry">>;
        for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
          if (dx * dx + dy * dy <= 1) put(x, y, id);
        }
        return;
      }
      case "polygon": {
        const id = terrainOf(s, what); if (id === null) return;
        const pts = pointsOf(s);
        if (pts.length < 3) { findings.push(`${what} needs three points; skipped`); return; }
        fillPolygon(pts, (x, y) => put(x, y, id));
        return;
      }
      case "stroke":
      case "lane": {
        const id = terrainOf(s, what); if (id === null) return;
        const pts = pointsOf(s);
        if (pts.length < 2) { findings.push(`${what} needs two points; skipped`); return; }
        let w = Math.max(1, s.width ?? 4);
        if (s.op === "lane" && typeof s.wall === "number") {
          if (!known.has(s.wall)) findings.push(`${what} names wall terrain ${s.wall}, which this tileset lacks; laid without walls`);
          else {
            // Measured: the brush's shores eat about three and a half tiles of a band on each side, a cliff about one and a
            // half; and a wall of high ground thinner than six tiles is all edge and no wall. The lane's width is the walkable
            // core it keeps, so the painted band is wider by that much, and the wall at least that thick.
            const cliff = (known.get(s.wall)?.height ?? 0) > (known.get(id)?.height ?? 0);
            w += cliff ? LANE_CLIFF_PAD : LANE_SHORE_PAD;
            const ww = Math.max(cliff ? 6 : 4, s.wallWidth ?? 3);
            strokePolyline(pts, w + 2 * ww, (x, y) => put(x, y, s.wall!));
          }
        }
        if (s.op === "lane") {
          // The floor waits for the batch's last wall.
          const width = w;
          laneFloors.push(() => strokePolyline(pts, width, (x, y) => put(x, y, id)));
          if (!laneBatch.has(i + 1)) { for (const paint of laneFloors) paint(); laneFloors.length = 0; }
          return;
        }
        const sites = s.op === "stroke" ? bridgeSites(s, what, findings) : [];
        if (sites.length === 0) { strokePolyline(pts, w, (x, y) => put(x, y, id)); return; }
        const pair = ctx.bridgePair ?? null;
        if (!pair) { findings.push(`${what}: this tileset has no bridges the editor can place; the river is painted without them — leave a gap of ground for a crossing`); strokePolyline(pts, w, (x, y) => put(x, y, id)); return; }
        const channel = pair.channel ?? BRIDGE_CHANNEL;
        if (id !== pair.water) findings.push(`${what}: this tileset's bridges span ${nameOf(known, pair.water)}, so each channel is painted as that, not ${nameOf(known, id)}`);
        // The river bent through every bridge: the vertices near a site give way to the channel's four —
        // taper in, channel, taper out — so the water arrives at the bridge along the diagonal it spans.
        let verts: Vertex[] = pts.map((p) => ({ p, w }));
        const laid: { site: BridgeSite; along: RampSide; ends: [Pt, Pt]; banked: Vertex[] }[] = [];
        sites.forEach((site, k) => {
          const near = nearestSegment(verts, site);
          const along: RampSide = site.along ?? (near.dir[0] * near.dir[1] >= 0 ? "se" : "sw");
          const d = stepOf(along);
          const ends = channelEnds(site.x, site.y, along);
          // Beyond each end the river widens back over the taper, then runs at its own width for a lead of half its
          // width before it may bend: a bend where the band is still narrowing leaves a notch on the outside of the turn.
          const lead = BRIDGE_TAPER + Math.ceil(w / 2 / Math.hypot(d[0], d[1]));
          const along_ = (from: Pt, steps: number): Pt => [from[0] + d[0] * steps, from[1] + d[1] * steps];
          const outer: [Pt, Pt] = [along_(ends[0], -lead), along_(ends[1], lead)];
          const half = dist(outer[0], outer[1]) / 2;
          const crowd = laid.find((o) => dist([o.site.x, o.site.y], [site.x, site.y]) < 2 * half);
          if (crowd) { findings.push(`${what}: the bridge at ${site.x},${site.y} is within ${Math.round(2 * half)} tiles of the one at ${crowd.site.x},${crowd.site.y}, closer than a channel is long; skipped`); return; }
          const forward = near.dir[0] * d[0] + near.dir[1] * d[1] >= 0;
          const chain: Pt[] = [outer[0], along_(ends[0], -BRIDGE_TAPER), ends[0], ends[1], along_(ends[1], BRIDGE_TAPER), outer[1]];
          if (!forward) chain.reverse();
          const cut = cutAround(verts, [site.x, site.y], half, near.index);
          const channelVerts = chain.map((p, j) => ({ p, w: j === 2 || j === 3 ? channel : w, bridge: k }));
          verts = [...cut.before, ...channelVerts, ...cut.after];
          // The bridge's ground follows the river from where it bends toward the channel to where it bends away, so the bend has a bank and no notch.
          const banked = [...(cut.before.length ? [cut.before[cut.before.length - 1]] : []), ...channelVerts, ...(cut.after.length ? [cut.after[0]] : [])];
          laid.push({ site, along, ends, banked: banked.map((v) => ({ ...v, w: v.w + 2 * BRIDGE_BANK })) });
          findings.push(`${what}: bridge at ${site.x},${site.y} along ${along}; the river narrows to its ${channel}-wide channel from ${fmt(ends[0])} to ${fmt(ends[1])}`);
        });
        if (typeof s.bank === "number") {
          if (!known.has(s.bank)) findings.push(`${what} names bank terrain ${s.bank}, which this tileset lacks; painted without a bank`);
          else { const bw = Math.max(1, s.bankWidth ?? BANK_WIDTH); const bank = s.bank; strokeVarying(verts.map((v) => ({ ...v, w: v.w + 2 * bw })), () => bank, put); }
        }
        for (const b of laid) strokeVarying(b.banked, () => pair.ground, put);
        strokeVarying(verts, (a, b) => (a.bridge !== undefined && a.bridge === b.bridge ? pair.water : id), put);
        for (const b of laid) bridges.push({ x: b.site.x, y: b.site.y, along: b.along, ends: b.ends });
        return;
      }
      case "border": {
        const id = terrainOf(s, what); if (id === null) return;
        const t = Math.max(1, Math.round(s.width ?? 2));
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x < t || y < t || x >= width - t || y >= height - t) put(x, y, id);
        return;
      }
      case "ramp": {
        if (typeof s.x !== "number" || typeof s.y !== "number") { findings.push(`${what} has no position; skipped`); return; }
        const side: RampSide = s.side === "se" ? "se" : "sw";
        const x = Math.round(s.x), y = Math.round(s.y);
        const pair = pairAround(cells, width, height, x, y, ctx, known);
        if (pair) forDiamond(x, y, 8, 4, (px, py) => { if (px < 0 || py < 0 || px >= width || py >= height) return; const here = cells[py * width + px]; const h = known.get(here)?.height; if (h === known.get(pair.high)!.height) put(px, py, pair.high); else if (h === known.get(pair.low)!.height) put(px, py, pair.low); });
        else findings.push(`${what}: no cliff between two heights the tileset has a ramp for lies near ${x},${y}; the renderer will look for one`);
        ramps.push({ x, y, direction: side, ...(pair ? { low: pair.low, high: pair.high } : {}) });
        return;
      }
      case "bridge": {
        if (typeof s.x !== "number" || typeof s.y !== "number") { findings.push(`${what} has no position; skipped`); return; }
        const pair = ctx.bridgePair ?? null;
        if (!pair) { findings.push(`${what}: this tileset has no bridges the editor can place; skipped — leave a gap of ground for a crossing`); return; }
        const along: RampSide = s.along === "sw" ? "sw" : "se";
        const x = Math.round(s.x), y = Math.round(s.y);
        // The channel through the site along the diagonal, banks of the bridge's ground either side, then the
        // water — a stamp over whatever is there, so a river drawn separately has to be brought to its ends.
        const ends = channelEnds(x, y, along);
        const channel = pair.channel ?? BRIDGE_CHANNEL;
        strokePolyline([ends[0], ends[1]], channel + 2 * BRIDGE_BANK, (px, py) => put(px, py, pair.ground));
        strokePolyline([ends[0], ends[1]], channel, (px, py) => put(px, py, pair.water));
        bridges.push({ x, y, along, ends });
        findings.push(`${what}: channel along ${along} from ${fmt(ends[0])} to ${fmt(ends[1])} (${nameOf(known, pair.water)} ${channel} wide, ${nameOf(known, pair.ground)} ${BRIDGE_BANK} tiles either side), painted over what was there; water must reach both ends`);
        return;
      }
      default:
        findings.push(`shape ${i + 1} has an op "${String((s as Shape).op)}" the compiler does not know; skipped`);
    }
  });
  return { cells, ramps, bridges, findings };
}

/**
 * A shape plan as the layout the renderer takes: the compiled cells as a one-tile grid
 * with a legend of the terrains used, the ramps with their pairs, the doodad entries'
 * terrain lists turned into legend characters, and everything else carried across.
 */
export function shapesToLayout(plan: MapPlan, ctx: ShapeContext): { plan: MapPlan; findings: string[] } {
  const compiled = compileShapes(plan.shapes ?? [], ctx);
  const ids = new Map<number, string>();
  const legend: Record<string, number> = {};
  const charFor = (id: number): string => {
    let ch = ids.get(id);
    if (ch === undefined) { ch = LEGEND_CHARS[ids.size] ?? "?"; ids.set(id, ch); legend[ch] = id; }
    return ch;
  };
  const rows: string[] = [];
  for (let y = 0; y < ctx.height; y++) {
    let row = "";
    for (let x = 0; x < ctx.width; x++) { const id = compiled.cells[y * ctx.width + x]; row += id < 0 ? "?" : charFor(id); }
    rows.push(row);
  }
  const doodads: DoodadPlan[] = plan.doodads.map((d) => ({ ...d, on: d.on || [...new Set((d.terrains ?? []).filter((id) => ids.has(id)).map((id) => ids.get(id)!))].join("") }));
  const out: MapPlan = {
    ...plan,
    cellSize: 1, columns: ctx.width, rows: ctx.height, legend, grid: rows,
    ramps: [...compiled.ramps, ...plan.ramps],
    bridges: [...compiled.bridges, ...(plan.bridges ?? [])],
    doodads,
    symmetry: "none",
  };
  return { plan: out, findings: compiled.findings };
}

/* ── Geometry ───────────────────────────────────────────── */

interface R { x0: number; y0: number; x1: number; y1: number }
interface Cuts { nw: number; ne: number; sw: number; se: number }

function rectOf(s: Shape): R | null {
  if (typeof s.x !== "number" || typeof s.y !== "number" || typeof s.w !== "number" || typeof s.h !== "number" || s.w <= 0 || s.h <= 0) return null;
  return { x0: Math.round(s.x), y0: Math.round(s.y), x1: Math.round(s.x + s.w), y1: Math.round(s.y + s.h) };
}

function radii(s: Shape): boolean {
  return typeof s.cx === "number" && typeof s.cy === "number" && typeof s.rx === "number" && typeof s.ry === "number" && s.rx > 0 && s.ry > 0;
}

function pointsOf(s: Shape): Pt[] {
  return (s.points ?? []).filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number").map((p) => [p[0], p[1]] as Pt);
}

function uniqueSides(sides: readonly string[]): RampSide[] {
  const out: RampSide[] = [];
  for (const s of sides) if ((s === "sw" || s === "se") && !out.includes(s)) out.push(s);
  return out;
}

/**
 * Whether a tile is inside a rect whose corners are cut along the lattice's 2:1 slope:
 * a cut of `c` rows removes the triangle where (horizontal distance) + 2 × (vertical
 * distance) from the corner is under 2c.
 */
export function insideCutRect(r: R, cuts: Cuts, x: number, y: number): boolean {
  if (x < r.x0 || y < r.y0 || x >= r.x1 || y >= r.y1) return false;
  const l = x - r.x0, rt = r.x1 - 1 - x, t = y - r.y0, b = r.y1 - 1 - y;
  if (l + 2 * t < 2 * cuts.nw - 1) return false;
  if (rt + 2 * t < 2 * cuts.ne - 1) return false;
  if (l + 2 * b < 2 * cuts.sw - 1) return false;
  if (rt + 2 * b < 2 * cuts.se - 1) return false;
  return true;
}

function fillCutRect(r: R, cuts: Cuts, put: (x: number, y: number) => void) {
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (insideCutRect(r, cuts, x, y)) put(x, y);
}

/** The cut lower edge itself, from its outer end to its inner end. */
export function rampEdge(r: R, cuts: Cuts, side: RampSide): Pt[] {
  const c = side === "sw" ? cuts.sw : cuts.se;
  return side === "sw" ? [[r.x0, r.y1 - c], [r.x0 + 2 * c, r.y1]] : [[r.x1 - 2 * c, r.y1], [r.x1, r.y1 - c]];
}

/** The middle of a plateau's cut lower edge, where its ramp goes. */
export function rampSite(r: R, cuts: Cuts, side: RampSide): { x: number; y: number } {
  const c = side === "sw" ? cuts.sw : cuts.se;
  // The cut edge runs from (x0, y1 - c) to (x0 + 2c, y1) on the left, mirrored on the right.
  return side === "sw" ? { x: r.x0 + c, y: r.y1 - Math.ceil(c / 2) } : { x: r.x1 - 1 - c, y: r.y1 - Math.ceil(c / 2) };
}

/** Every tile of the isometric diamond |dx| / rx + |dy| / ry ≤ 1. */
function forDiamond(cx: number, cy: number, rx: number, ry: number, put: (x: number, y: number) => void) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
    if (Math.abs(x + 0.5 - cx) / rx + Math.abs(y + 0.5 - cy) / ry <= 1) put(x, y);
  }
}

/** Scanline fill of a polygon (even-odd), tile centres. */
function fillPolygon(pts: Pt[], put: (x: number, y: number) => void) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if (ay === by) continue;
      if ((cy >= Math.min(ay, by)) && (cy < Math.max(ay, by))) xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.floor(xs[i]); x < Math.ceil(xs[i + 1]); x++) if (x + 0.5 >= xs[i] && x + 0.5 <= xs[i + 1]) put(x, y);
  }
}

/** The 2:1 step of a diagonal: two tiles across (right for "se", left for "sw") and one down. */
export function stepOf(along: RampSide): Pt {
  return along === "se" ? [2, 1] : [-2, 1];
}

/** The two ends of the channel a bridge at (x, y) wants, `BRIDGE_REACH` steps of the diagonal centred on the site. */
export function channelEnds(x: number, y: number, along: RampSide): [Pt, Pt] {
  const d = stepOf(along);
  return [[x - d[0] * BRIDGE_REACH / 2, y - d[1] * BRIDGE_REACH / 2], [x + d[0] * BRIDGE_REACH / 2, y + d[1] * BRIDGE_REACH / 2]];
}

const fmt = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`;
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const nameOf = (known: Map<number, TerrainVocab>, id: number) => known.get(id)?.name ?? `terrain ${id}`;

/** A stroke's bridge sites: `[x, y]` pairs or `{x, y, along}` objects; anything else is named and dropped. */
function bridgeSites(s: Shape, what: string, findings: string[]): BridgeSite[] {
  const out: BridgeSite[] = [];
  for (const b of s.bridges ?? []) {
    if (Array.isArray(b) && typeof b[0] === "number" && typeof b[1] === "number") out.push({ x: Math.round(b[0]), y: Math.round(b[1]) });
    else if (b && !Array.isArray(b) && typeof b.x === "number" && typeof b.y === "number") out.push({ x: Math.round(b.x), y: Math.round(b.y), ...(b.along === "sw" || b.along === "se" ? { along: b.along } : {}) });
    else findings.push(`${what}: a bridge without x and y; dropped`);
  }
  return out;
}

/** The segment of a polyline nearest a point, with its direction. */
function nearestSegment(verts: readonly Vertex[], at: { x: number; y: number }): { index: number; dir: Pt } {
  let best = 0, bestD = Infinity, dir: Pt = [1, 0];
  for (let i = 0; i + 1 < verts.length; i++) {
    const [ax, ay] = verts[i].p, [bx, by] = verts[i + 1].p;
    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((at.x - ax) * vx + (at.y - ay) * vy) / len2));
    const dx = at.x - (ax + t * vx), dy = at.y - (ay + t * vy);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; dir = [vx, vy]; }
  }
  return { index: best, dir };
}

/**
 * A polyline with the part within `radius` of a point cut out: what lies before the
 * polyline enters that circle and what lies after it leaves, each ending or starting
 * on the circle itself, so a bridge's channel replaces just the stretch of river it
 * needs and the bend into it starts there and not at the previous vertex. A polyline
 * that never enters the circle is split at the segment nearest the point instead.
 */
function cutAround(verts: readonly Vertex[], at: Pt, radius: number, nearest: number): { before: Vertex[]; after: Vertex[] } {
  const inside = (p: Pt) => dist(p, at) < radius;
  let entry: { index: number; p: Pt } | null = null;
  let exit: { index: number; p: Pt } | null = null;
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i].p, b = verts[i + 1].p;
    const roots = circleCrossings(a, b, at, radius);
    if (!inside(a) && !entry && roots.length) entry = { index: i, p: lerp(a, b, roots[0]) };
    if (!inside(b) && roots.length) exit = { index: i, p: lerp(a, b, roots[roots.length - 1]) };
  }
  if (!entry && !exit && !inside(verts[0].p)) return { before: verts.slice(0, nearest + 1), after: verts.slice(nearest + 1) };
  const before = entry ? [...verts.slice(0, entry.index + 1), { ...verts[entry.index], p: entry.p }] : [];
  const after = exit ? [{ ...verts[exit.index + 1], p: exit.p }, ...verts.slice(exit.index + 1)] : [];
  return { before, after };
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Where the segment a→b crosses a circle, as parameters along the segment in (0, 1), in order. */
function circleCrossings(a: Pt, b: Pt, c: Pt, r: number): number[] {
  const vx = b[0] - a[0], vy = b[1] - a[1], fx = a[0] - c[0], fy = a[1] - c[1];
  const A = vx * vx + vy * vy, B = 2 * (fx * vx + fy * vy), C = fx * fx + fy * fy - r * r;
  if (A === 0) return [];
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const q = Math.sqrt(disc);
  return [(-B - q) / (2 * A), (-B + q) / (2 * A)].filter((t) => t > 0 && t < 1);
}

/** A band along a polyline whose width changes from vertex to vertex, each segment in the terrain `terrainOf` gives it. */
function strokeVarying(verts: readonly Vertex[], terrainOf: (a: Vertex, b: Vertex) => number, put: (x: number, y: number, id: number) => void) {
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i], b = verts[i + 1];
    const id = terrainOf(a, b);
    strokeTapered(a.p, b.p, a.w, b.w, (x, y) => put(x, y, id));
  }
}

/**
 * A band from `a` to `b` that is `wa` tiles wide at `a` and `wb` at `b`: the sweep of a
 * disc whose radius changes linearly along the segment, so a tile is inside when some
 * point of the segment is nearer to it than the width there. (Measuring only from the
 * nearest point would leave a notch outside a bend where the band narrows: the sweep
 * holds the whole disc at each end, as the plain stroke's round caps do.)
 */
function strokeTapered(a: Pt, b: Pt, wa: number, wb: number, put: (x: number, y: number) => void) {
  const [ax, ay] = a, [bx, by] = b;
  const half = Math.max(wa, wb) / 2;
  const x0 = Math.floor(Math.min(ax, bx) - half) - 1, x1 = Math.ceil(Math.max(ax, bx) + half) + 1;
  const y0 = Math.floor(Math.min(ay, by) - half) - 1, y1 = Math.ceil(Math.max(ay, by) + half) + 1;
  const vx = bx - ax, vy = by - ay, ha = wa / 2, dh = (wb - wa) / 2;
  // |P − S(t)|² − h(t)² is a quadratic in t; the band holds P when its least value on [0, 1] is not positive.
  const qa = vx * vx + vy * vy - dh * dh;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const fx = x + 0.5 - ax, fy = y + 0.5 - ay;
    const qb = -2 * (fx * vx + fy * vy) - 2 * ha * dh, qc = fx * fx + fy * fy - ha * ha;
    const g = (t: number) => (qa * t + qb) * t + qc;
    const t = qa > 0 ? Math.max(0, Math.min(1, -qb / (2 * qa))) : g(0) <= g(1) ? 0 : 1;
    if (g(t) <= 0) put(x, y);
  }
}

/** A band of `width` tiles along a polyline: every tile whose centre is within width / 2 of a segment. */
function strokePolyline(pts: Pt[], width: number, put: (x: number, y: number) => void) {
  const half = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const x0 = Math.floor(Math.min(ax, bx) - half) - 1, x1 = Math.ceil(Math.max(ax, bx) + half) + 1;
    const y0 = Math.floor(Math.min(ay, by) - half) - 1, y1 = Math.ceil(Math.max(ay, by) + half) + 1;
    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
      const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
      if (dx * dx + dy * dy <= half * half) put(x, y);
    }
  }
}

/* ── Ramp pairs ─────────────────────────────────────────── */

/** The pair to paint at a ramp for a plateau of `terrain`: the one whose high side is that terrain, else one at the same height, else nothing. */
function pairFor(terrain: number, ctx: ShapeContext, known: Map<number, TerrainVocab>): RampPair | null {
  const h = known.get(terrain)?.height;
  return ctx.rampPairs.find((p) => p.high === terrain) ?? ctx.rampPairs.find((p) => known.get(p.high)?.height === h) ?? null;
}

/** For a bare `ramp` statement: the pair matching the two heights painted around the point. */
function pairAround(cells: Int32Array, width: number, height: number, x: number, y: number, ctx: ShapeContext, known: Map<number, TerrainVocab>): RampPair | null {
  const heights = new Map<number, number>();
  for (let dy = -4; dy <= 4; dy++) for (let dx = -8; dx <= 8; dx++) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const h = known.get(cells[py * width + px])?.height;
    if (h !== undefined) heights.set(h, (heights.get(h) ?? 0) + 1);
  }
  const present = [...heights.keys()].sort((a, b) => a - b);
  for (let i = 0; i + 1 < present.length; i++) {
    const lo = present[i], hi = present[i + 1];
    if (hi - lo !== 1) continue;
    const pair = ctx.rampPairs.find((p) => known.get(p.low)?.height === lo && known.get(p.high)?.height === hi);
    if (pair) return pair;
  }
  return null;
}

/** A plan's shape statements as text for a refinement round or a finding. */
export function shapeText(s: Shape): string {
  const parts: string[] = [s.op];
  if (s.terrain !== undefined) parts.push(`terrain ${s.terrain}`);
  if (s.x !== undefined) parts.push(`at ${s.x},${s.y} ${s.w ?? ""}×${s.h ?? ""}`);
  if (s.cx !== undefined) parts.push(`centre ${s.cx},${s.cy} radii ${s.rx}×${s.ry}`);
  if (s.points) parts.push(`points ${s.points.map((p) => p.join(",")).join(" ")}`);
  if (s.width !== undefined) parts.push(`width ${s.width}`);
  if (s.ramps?.length) parts.push(`ramps ${s.ramps.join(",")}`);
  if (s.side) parts.push(`side ${s.side}`);
  if (s.along) parts.push(`along ${s.along}`);
  if (s.bridges?.length) parts.push(`bridges ${s.bridges.map((b) => (Array.isArray(b) ? b.join(",") : `${b.x},${b.y}${b.along ? ` ${b.along}` : ""}`)).join(" ")}`);
  if (s.bank !== undefined) parts.push(`bank ${s.bank}${s.bankWidth !== undefined ? ` ${s.bankWidth} wide` : ""}`);
  return parts.join(" ");
}

/** The same shapes moved by (dx, dy) tiles — for shapes written relative to an area's corner. */
export function shiftShapes(shapes: readonly Shape[], dx: number, dy: number): Shape[] {
  if (!dx && !dy) return [...shapes];
  return shapes.map((s) => {
    const out: Shape = { ...s };
    if (typeof s.x === "number") out.x = s.x + dx;
    if (typeof s.y === "number") out.y = s.y + dy;
    if (typeof s.cx === "number") out.cx = s.cx + dx;
    if (typeof s.cy === "number") out.cy = s.cy + dy;
    if (s.points) out.points = s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]);
    if (s.bridges) out.bridges = s.bridges.map((b) => (Array.isArray(b) ? [b[0] + dx, b[1] + dy] as [number, number] : { ...b, x: b.x + dx, y: b.y + dy }));
    return out;
  });
}
