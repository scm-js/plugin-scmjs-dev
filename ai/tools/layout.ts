/**
 * The assistant's way into the layout work Make Scenario does: a preset laid out from
 * a few numbers, a shape plan painted where it is asked, a ramp or a bridge fitted where
 * the tileset's own placement rule says one fits, and the two questions a picture cannot
 * settle — can a unit walk from here to there, and does every player who must act own
 * something. "Make this a two-lane defense", "put a plateau with a ramp in the north-west",
 * "is the goal reachable from the spawn" are one call each.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { MapPlan, Shape } from "../../protocol";
import { doodadCategoryNames, terrainVocab, unitIdByName } from "../facts";
import { buildPreset, presetById, presetsText, presetSpecs, PresetError } from "../presets";
import { bridgeFootprints, bridgePairOf, bridgesOf, fitDoodad, fitRamp, rampPairsOf, rampsOf, VERIFIED_RAMPS } from "../ramps";
import { floodFrom, nearestWalkable, reachTouches, walkMask } from "../reach";
import { renderPlan, summarizeRender } from "../render";
import { shapesRect, shiftShapes } from "../shapes";
import { fitBase } from "../bases";
import { clusterResources, compassOf, oppositeOf, scanSites, type ResourceCluster, type ResourceUnit } from "../sites";
import { centreOf, DEFAULT_GAS, DEFAULT_MINERALS, GEYSER, HALL, inMap, MINERAL_FIELDS, mineralLooks, NEUTRAL, outwardDirection, rectAt, snapAngle, START_LOCATION, VESPENE_GEYSER, type TileRect as Footprint } from "../layout";
import { angleDirection, directionAngle, DIRECTIONS } from "../plan";
import { capResult, fail, jsonOf, list, noSuchUnit, num, obj, ownerOf, plural, str, tally, TILE, type Tool } from "./common";

/** Human and computer slots, 1-based, from the settings. */
function slots(api: PluginApi): { humans: number[]; computers: number[] } {
  const players = api.settings.players();
  return {
    humans: players.filter((p) => /human/i.test(p.typeName)).map((p) => p.slot + 1),
    computers: players.filter((p) => /computer/i.test(p.typeName)).map((p) => p.slot + 1),
  };
}

/** A tile point from `x`/`y`, or a location's centre from `location`. */
function pointOf(api: PluginApi, input: Record<string, unknown>, prefix: string): { x: number; y: number; label: string } | string {
  const name = str(input[`${prefix}Location`] ?? input[prefix]);
  const xk = `${prefix}X`, yk = `${prefix}Y`;
  if (input[xk] !== undefined && input[yk] !== undefined) return { x: Math.round(num(input[xk])), y: Math.round(num(input[yk])), label: `${Math.round(num(input[xk]))},${Math.round(num(input[yk]))}` };
  if (!name) return `give ${prefix} as a location name (${prefix}Location) or a tile (${xk}, ${yk})`;
  const scn = api.document.scenario();
  if (!scn) return "no map is open";
  const index = scn.locations.findIndex((l, i) => (l.left !== l.right || l.nameIndex > 0) && api.names.location(i).toLowerCase() === name.toLowerCase());
  if (index < 0) return `no location is called "${name}" (see list_locations)`;
  const l = scn.locations[index];
  return { x: Math.floor((Math.min(l.left, l.right) + Math.max(l.left, l.right)) / 2 / TILE), y: Math.floor((Math.min(l.top, l.bottom) + Math.max(l.top, l.bottom)) / 2 / TILE), label: name };
}

/** The shape ops paint_shapes takes, as the compiler knows them. */
export const SHAPE_OPS = ["ground", "rect", "diamond", "ellipse", "polygon", "stroke", "border", "plateau", "lane", "ramp", "bridge"] as const;

/**
 * The shapes a paint_shapes call gives, with the op read from `op` or the names a
 * caller reaches for instead (`type`, `kind`, `shape`); or what is wrong with them.
 */
export function readShapes(raw: unknown): Shape[] | string {
  const given = list<Record<string, unknown>>(raw).filter((s) => s && typeof s === "object");
  if (!given.length) return "No shapes were given.";
  const shapes: Shape[] = [];
  for (const [i, s] of given.entries()) {
    const op = [s.op, s.type, s.kind, s.shape].find((v) => typeof v === "string") as string | undefined;
    if (!op || !(SHAPE_OPS as readonly string[]).includes(op)) return `Shape ${i + 1} ${op ? `has an op "${op}" that is not one of` : "names no op; each shape needs an op, one of"}: ${SHAPE_OPS.join(", ")}.`;
    shapes.push({ ...(s as object), op } as Shape);
  }
  return shapes;
}

export function layoutTools(): Tool[] {
  return [
    {
      def: { name: "layout_presets", description: "The layouts the editor lays out by itself from a few numbers — corner camps around an arena, lanes from spawns to a goal, a walled arena, a bound's course of stretches, a town with a chain of regions — with each one's parameters and the locations it makes ({p} a player number, {n} a lane, stretch or region number). Use layout_preset to lay one out; prefer a preset over painting terrain by hand whenever the map's shape is one of these.", inputSchema: obj({}) },
      writes: false,
      run: () => presetsText(),
    },
    {
      def: { name: "layout_preset", description: "Lay a preset out over the whole map: the terrain (with ramps and bridges that fit, where the tileset has them), the named locations, a start location per human player, a little decoration. Replaces the terrain and clears units, doodads and sprites first; triggers and settings stay. `params` are the preset's parameters as strings (see layout_presets). One undo step.", inputSchema: obj({ preset: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } }, ["preset"]) },
      describe: (input) => { const p = input.params && typeof input.params === "object" ? Object.entries(input.params as Record<string, unknown>).slice(0, 3).map(([k, v]) => `${k} ${String(v)}`).join(", ") : ""; return `Lay out the ${str(input.preset)} preset${p ? `: ${p}` : ""}`; },
      report: (result) => { const r = jsonOf(result); return r ? `${String(r.laidOut)}${Array.isArray(r.locations) ? `; ${plural(r.locations.length, "location")}` : ""}` : ""; },
      writes: true,
      run: (input, { api }) => {
        const id = str(input.preset);
        if (!presetById(id)) return fail(`No preset is called "${id}". The presets:\n${presetSpecs().map((p) => p.id).join(", ")}`);
        const info = api.document.info();
        if (!info) return fail("No map is open.");
        const raw = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) params[k] = Array.isArray(v) ? v.join(", ") : String(v);
        const { humans } = slots(api);
        let plan: MapPlan;
        let notes: string[];
        try {
          const built = buildPreset(id, params, { width: info.width, height: info.height, terrains: terrainVocab(api), rampPairs: rampPairsOf(api), bridgePair: bridgePairOf(api), humans: humans.length ? humans : [1], doodadCategories: doodadCategoryNames(api) });
          plan = built.plan; notes = built.notes;
        } catch (err) {
          if (err instanceof PresetError) return fail(`Not laid out:\n${err.problems.map((p) => `- ${p}`).join("\n")}`);
          throw err;
        }
        const rendered = renderPlan(api, plan, { originX: 0, originY: 0, label: `AI: ${id} layout`, clearArea: true });
        if (!rendered) return "The layout could not be rendered.";
        return capResult({ laidOut: summarizeRender(rendered), locations: plan.locations.map((l) => `${l.name} [${l.x0},${l.y0}-${l.x1},${l.y1}]`), notes: [...notes, ...rendered.findings] });
      },
    },
    {
      def: {
        name: "paint_shapes",
        description: "Paint terrain as shapes, in map tiles, in order (later over earlier). Each shape is an object whose `op` names it: ground (the whole map), rect (x, y, w, h, optional cut: isometric corner cut in rows), diamond / ellipse (cx, cy, rx, ry), polygon (points), stroke (points, width: a band — a river, a road, a wall; a river carries its bridges as `bridges`: [[x, y], …] — the editor bends the river onto the 2:1 diagonal a bridge spans through each site, narrows it to the channel, paints the banks and fits the bridge, so the water reaches the bridge from both sides; optional `bank` terrain id and `bankWidth` paint a band either side, bent with the river), border (width), plateau (like rect, plus ramps: which lower corners get a ramp down, \"sw\" and/or \"se\" — the game's ramps go down south-west or south-east and nowhere else; the editor cuts the corner into the diagonal edge a ramp fits, paints the pair the tileset has ramps for either side, and fits the ramp), lane (points, width, wall terrain id, wallWidth: a walkable band with walls either side, continuous by construction; the width is the walkable core kept), ramp (x, y, side: on a cliff already there), bridge (x, y, along \"se\" or \"sw\": a stamp over whatever is there — a channel of the bridge's water along the 2:1 diagonal, about 30 tiles long, with 8 tiles of the bridge's ground either side — then the bridge; a river drawn separately must be brought to both ends of the channel as water, and the result says when it is not. Prefer a stroke with bridges). Every shape but ramp and bridge names a terrain id (see list_terrains). Painting the ground under a doodad removes it (the result names it): paint water before placing a bridge, and keep later strokes — whose round ends reach half their width past each point — off a bridge's tiles. Bridges exist only where the reference's tileset block says the editor can place one (every tileset but Badlands, Installation and Ash World); elsewhere leave a gap of ground for a crossing. Only the tiles the shapes cover change; `originX`/`originY` shift every coordinate, for shapes written relative to an area's corner. `clear` removes the units, doodads and sprites inside the rectangle the shapes touch first (the whole map for `ground` or `border`); leave it off unless the area is meant to start empty — repainting ground under a unit keeps the unit. Optional `locations` ([{name, x0, y0, x1, y1}] in tiles) and `units` ([{unit, player, x, y}]) go on afterwards. One undo step.",
        inputSchema: obj({
          shapes: { type: "array", items: { type: "object", properties: { op: { type: "string", enum: SHAPE_OPS }, terrain: { type: "integer" } }, required: ["op"], additionalProperties: true } },
          originX: { type: "integer" }, originY: { type: "integer" },
          clear: { type: "boolean", description: "remove units, doodads and sprites inside the shapes' rectangle first; default false" },
          locations: { type: "array", items: { type: "object", additionalProperties: true } },
          units: { type: "array", items: { type: "object", additionalProperties: true } },
        }, ["shapes"]),
      },
      describe: (input) => { const ops = list(input.shapes).map((sh) => str(sh.op)).filter(Boolean); return ops.length ? `Paint ${plural(ops.length, "shape")}: ${tally(ops)}` : "Paint shapes"; },
      report: (result) => { const r = jsonOf(result); return r ? String(r.painted) : ""; },
      writes: true,
      run: (input, { api }) => {
        const info = api.document.info();
        if (!info) return fail("No map is open.");
        const shapes = readShapes(input.shapes);
        if (typeof shapes === "string") return fail(shapes);
        const dx = Math.round(num(input.originX)), dy = Math.round(num(input.originY));
        const locations = list<Record<string, unknown>>(input.locations).map((l) => ({ name: str(l.name, "Location"), x0: Math.round(num(l.x0)) + dx, y0: Math.round(num(l.y0)) + dy, x1: Math.round(num(l.x1)) + dx, y1: Math.round(num(l.y1)) + dy }));
        const units = list<Record<string, unknown>>(input.units).map((u) => ({ unit: str(u.unit), player: Math.round(num(u.player, 12)), x: Math.round(num(u.x)) + dx, y: Math.round(num(u.y)) + dy }));
        const plan: MapPlan = {
          name: "", description: "", symmetry: "none", cellSize: 1, columns: info.width, rows: info.height, legend: {}, grid: [],
          shapes: shiftShapes(shapes, dx, dy), bases: [], ramps: [], doodads: [], units, locations, notes: [],
        };
        const rendered = renderPlan(api, plan, { originX: 0, originY: 0, label: "AI: paint shapes", clearArea: input.clear === true, clearRect: shapesRect(plan.shapes ?? [], info.width, info.height) });
        if (!rendered) return "The shapes could not be rendered.";
        return capResult({ painted: summarizeRender(rendered), notes: rendered.findings });
      },
    },
    {
      def: { name: "place_ramp", description: "Fit one of the tileset's ramps on a cliff already on the map, near a tile, going down south-west or south-east (the only ways the game's ramps go). Tries every ramp within a few tiles with the editor's own placement rule and takes the nearest fit. A ramp fits only a straight diagonal cliff run facing south, between ground the tileset has a ramp for — a tile-aligned cliff takes none; to make such an edge, paint a plateau with paint_shapes instead.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" }, side: { type: "string", enum: ["sw", "se"] } }, ["x", "y", "side"]) },
      describe: (input) => `Fit a ramp near ${num(input.x)},${num(input.y)} facing ${str(input.side) === "se" ? "south-east" : "south-west"}`,
      report: (result) => { const r = jsonOf(result); return r ? String(r.placed) : ""; },
      writes: true,
      run: (input, { api }) => {
        const ramps = rampsOf(api);
        if (!ramps.length) return "This tileset has no ramp doodads the editor can read.";
        const side = str(input.side) === "se" ? "se" : "sw";
        const x = Math.round(num(input.x)), y = Math.round(num(input.y));
        const tileset = api.document.info()?.tileset ?? "";
        const fit = fitRamp({ x, y, direction: side }, ramps, (id, tx, ty) => api.query.doodadPlacement(id, tx, ty)?.ok === true);
        if (!fit) {
          const pairs = (VERIFIED_RAMPS[tileset] ?? []).map(([lo, hi]) => `${lo} → ${hi}`).join(", ") || "none the brush's cliffs can take";
          return fail(`No ramp fits within 12 tiles of ${x},${y} going ${side}. A ramp needs a straight diagonal cliff run facing ${side === "sw" ? "south-west" : "south-east"}, between ground this tileset has ramps for (${pairs}). Paint a plateau with a ramps parameter through paint_shapes to make such an edge.`);
        }
        const r = api.document.edit("AI: place ramp", (tx) => { tx.placeDoodad(fit.doodadId, fit.tx, fit.ty); });
        return capResult({ placed: `${fit.name} at ${fit.tx},${fit.ty} (${fit.width}×${fit.height})`, notes: r.notes });
      },
    },
    {
      def: { name: "place_bridge", description: "Fit one of the tileset's bridges over water already on the map, near a tile. The reference's tileset block says whether this tileset has a bridge the editor can place (Badlands' bridges it cannot; Installation and Ash World have none); where it cannot, leave a gap of ground in the water for a crossing. A bridge spans only a diagonal channel of the width the bridges were drawn for; to make such a channel, use a bridge shape in paint_shapes, which paints it and fits the bridge in one go.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" } }, ["x", "y"]) },
      describe: (input) => `Fit a bridge near ${num(input.x)},${num(input.y)}`,
      report: (result) => { const r = jsonOf(result); return r ? String(r.placed) : ""; },
      writes: true,
      run: (input, { api }) => {
        const bridges = bridgesOf(api);
        if (!bridges.length) return "This tileset has no bridges.";
        if (!bridgePairOf(api)) return "This tileset's bridges need bank pieces the isometric brush does not draw, so no bridge can be placed here. For a crossing, leave a gap of ground in the water.";
        const x = Math.round(num(input.x)), y = Math.round(num(input.y));
        const fit = fitDoodad({ x, y }, bridges, (id, tx, ty) => api.query.doodadPlacement(id, tx, ty)?.ok === true, { dx: 14, dy: 10 });
        if (!fit) return fail(`No bridge fits within 14 tiles of ${x},${y}. The water there is not a diagonal channel of the width this tileset's bridges span; a bridge shape in paint_shapes paints one and fits the bridge.`);
        const r = api.document.edit("AI: place bridge", (tx) => { tx.placeDoodad(fit.doodadId, fit.tx, fit.ty); });
        return capResult({ placed: `${fit.name} at ${fit.tx},${fit.ty} (${fit.width}×${fit.height})`, notes: r.notes });
      },
    },
    {
      def: {
        name: "place_base",
        description: "Lay a base's resources round a town hall footprint (4 × 3 tiles, top-left at x,y — a start location's box) the way the Melee Wizard does: the mineral patches on the ring three tiles from the hall, where the game mines fastest, spread round `direction` (a compass point, where the line lies seen from the hall; default away from the map's centre) and wrapping the hall's corners like Blizzard's own lines; the geyser on the same ring just past the line's end. Positions the editor refuses (cliffs, water, the map's edge, units already there) are left out and the line closes over them; when that side has no whole line it turns to the nearest direction that does, and the result says so. Give `player` to place that player's start location at the hall (or omit x,y to lay round the start location the player already has), `hall` to place a town hall by name for the player too. Use this for every mineral line rather than placing patches one by one.",
        inputSchema: obj({
          x: { type: "integer", description: "the hall footprint's left tile" },
          y: { type: "integer", description: "the hall footprint's top tile" },
          player: { type: "integer", description: "1-based; gets a start location at the hall" },
          direction: { type: "string", enum: [...DIRECTIONS] },
          minerals: { type: "integer", description: "patches, default 8" },
          geysers: { type: "integer", description: "0–2, default 1" },
          amount: { type: "integer", description: "minerals per patch, default 1500" },
          gas: { type: "integer", description: "gas per geyser, default 5000" },
          geyserSide: { type: "string", enum: ["auto", "left", "right"], description: "which end of the line the geyser takes, seen from the hall" },
          hall: { type: "string", description: "a town hall unit to place for the player: Command Center, Nexus or Hatchery" },
        }),
      },
      describe: (input) => `Lay a base${input.player !== undefined ? ` for Player ${num(input.player)}` : ""}${input.x !== undefined ? ` at ${num(input.x)},${num(input.y)}` : ""}${str(input.direction) ? `, line to the ${str(input.direction)}` : ""}`,
      report: (result) => { const r = jsonOf(result); if (!r) return ""; const p = (r.placed ?? {}) as Record<string, number>; const parts = [`${plural(num(p.minerals), "patch").replace("patchs", "patches")}, ${plural(num(p.geysers), "geyser")} to the ${String(r.direction)}`]; if (Array.isArray(r.notes) && r.notes.length) parts.push(String(r.notes[0])); return parts.join("; "); },
      writes: true,
      run: (input, { api }) => {
        const info = api.document.info();
        const scn = api.document.scenario();
        if (!info || !scn) return fail("No map is open.");
        const player = input.player === undefined ? null : ownerOf(input.player, -1);
        if (player !== null && (player < 0 || player > 7)) return fail("player must be 1–8.");
        let hall: Footprint;
        if (input.x !== undefined && input.y !== undefined) {
          hall = { x: Math.round(num(input.x)), y: Math.round(num(input.y)), w: HALL.w, h: HALL.h };
        } else {
          if (player === null) return "Give the hall's top-left tile (x, y), or a player whose start location to lay round.";
          const start = scn.units.find((u) => u.unitId === START_LOCATION && u.owner === player);
          if (!start) return `Player ${player + 1} has no start location; give the hall's top-left tile (x, y) to place one.`;
          hall = rectAt(start.x, start.y, HALL);
        }
        if (!inMap(hall, info.width, info.height)) return `A ${HALL.w} × ${HALL.h} hall at ${hall.x},${hall.y} hangs off the map.`;
        const centre = centreOf(hall);
        const askedDirection = str(input.direction).toLowerCase();
        if (askedDirection && !(DIRECTIONS as readonly string[]).includes(askedDirection)) return fail(`direction must be a compass point: ${DIRECTIONS.join(", ")}.`);
        const direction = askedDirection ? directionAngle(askedDirection as (typeof DIRECTIONS)[number]) : snapAngle(outwardDirection(centre.x, centre.y, info.width, info.height));
        const minerals = Math.max(0, Math.min(12, Math.round(num(input.minerals, 8))));
        const geysers = Math.max(0, Math.min(2, Math.round(num(input.geysers, 1))));
        const amount = Math.max(0, Math.round(num(input.amount, DEFAULT_MINERALS)));
        const gas = Math.max(0, Math.round(num(input.gas, DEFAULT_GAS)));
        const geyserSide = str(input.geyserSide) === "left" ? "left" : str(input.geyserSide) === "right" ? "right" : "auto";
        const hallUnit = str(input.hall) ? unitIdByName(api, str(input.hall)) : null;
        if (str(input.hall) && hallUnit === null) return noSuchUnit(api, str(input.hall));
        if (hallUnit !== null && player === null) return "A hall needs a player to own it.";
        // The editor's own check, on the map as it is now: ground, the edge, and the units already there.
        const fits = (r: Footprint) => {
          const c = centreOf(r);
          const id = r.w === GEYSER.w && r.h === GEYSER.h ? VESPENE_GEYSER : MINERAL_FIELDS[0];
          return api.query.placement(id, c.x, c.y)?.problem === null;
        };
        const fitted = fitBase(hall, { minerals, geysers, geyserSide, direction, fits });
        const { layout } = fitted;
        const startHere = scn.units.some((u) => u.unitId === START_LOCATION && Math.abs(u.x - centre.x) < TILE && Math.abs(u.y - centre.y) < TILE);
        const placed = { start: 0, hall: 0, minerals: 0, geysers: 0 };
        const notes: string[] = [];
        api.document.edit("AI: place base", (tx) => {
          if (hallUnit !== null && player !== null) {
            if (tx.canPlaceUnit(hallUnit, centre.x, centre.y)) { tx.placeUnit(hallUnit, player, centre.x, centre.y); placed.hall++; }
            else notes.push(`${api.names.unit(hallUnit)} refused at ${hall.x},${hall.y}: ${api.query.placement(hallUnit, centre.x, centre.y)?.reason ?? "does not fit"}`);
          }
          if (player !== null && !startHere) {
            if (tx.canPlaceUnit(START_LOCATION, centre.x, centre.y)) { tx.placeUnit(START_LOCATION, player, centre.x, centre.y); placed.start++; }
            else notes.push(`start location refused at ${hall.x},${hall.y}: ${api.query.placement(START_LOCATION, centre.x, centre.y)?.reason ?? "does not fit"}`);
          }
          const resource = (id: number, r: Footprint, value: number): boolean => {
            const c = centreOf(r);
            if (!tx.canPlaceUnit(id, c.x, c.y)) return false;
            const index = tx.placeUnit(id, NEUTRAL, c.x, c.y);
            tx.updateUnits([index], (rec) => ({ resourceAmount: value, validStates: rec.validStates | api.consts.unit.used.Resources }));
            return true;
          };
          const looks = mineralLooks(layout.minerals);
          layout.minerals.forEach((r, i) => { if (resource(looks[i], r, amount)) placed.minerals++; });
          for (const r of layout.geysers) if (resource(VESPENE_GEYSER, r, gas)) placed.geysers++;
        });
        const laid = angleDirection(fitted.direction);
        if (fitted.turned) notes.push(`the ${angleDirection(direction)} side had no whole line, so the line lies ${laid} instead`);
        if (layout.short.minerals > 0) notes.push(`${layout.short.minerals} patch${layout.short.minerals === 1 ? "" : "es"} had no room on the ring`);
        if (layout.short.geysers > 0) notes.push(`${layout.short.geysers} geyser${layout.short.geysers === 1 ? "" : "s"} had no room on the ring`);
        const refused = layout.minerals.length + layout.geysers.length - placed.minerals - placed.geysers;
        if (refused > 0) notes.push(`${refused} resource${refused === 1 ? "" : "s"} refused by the editor at the last moment`);
        return capResult({
          hall: { x: hall.x, y: hall.y, w: HALL.w, h: HALL.h },
          direction: laid,
          placed,
          minerals: layout.minerals.map((r) => `${r.x},${r.y}`),
          geysers: layout.geysers.map((r) => `${r.x},${r.y}`),
          ...(notes.length ? { notes } : {}),
        });
      },
    },
    {
      def: { name: "bases", description: "Every base on the map in one call: for each start location its player, the town hall footprint (4 × 3 tiles, what place_base and the start's box use), the mineral patches and geysers round it with their positions and amounts, which side of the hall the mineral line lies on and which side is open (the approach — where a bunker or a wall goes), and the nearest other start; then the expansions (resource clusters with no start). Read this before working on bases instead of listing units and screenshotting each one.", inputSchema: obj({}) },
      describe: () => "Read the map's bases",
      report: (result) => { const r = jsonOf(result); return r ? `${plural(list(r.bases).length, "base")}, ${plural(list(r.expansions).length, "expansion")}` : ""; },
      writes: false,
      run: (_input, { api }) => {
        const info = api.document.info();
        const scn = api.document.scenario();
        if (!info || !scn) return fail("No map is open.");
        const resources: ResourceUnit[] = [];
        scn.units.forEach((u, index) => {
          const kind = (MINERAL_FIELDS as readonly number[]).includes(u.unitId) ? "mineral" : u.unitId === VESPENE_GEYSER ? "geyser" : null;
          if (kind) resources.push({ index, kind, tx: Math.floor(u.x / TILE), ty: Math.floor(u.y / TILE), amount: u.resourceAmount });
        });
        const clusters = clusterResources(resources);
        const starts = api.query.startLocations();
        const claimed = new Set<ResourceCluster>();
        const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
        const bases = starts.map((s) => {
          const hall = rectAt(s.x, s.y, HALL);
          const hc = { x: hall.x + hall.w / 2, y: hall.y + hall.h / 2 };
          let best: ResourceCluster | null = null;
          for (const c of clusters) if (!claimed.has(c) && dist(hc.x, hc.y, c.cx, c.cy) <= 12 && (!best || dist(hc.x, hc.y, c.cx, c.cy) < dist(hc.x, hc.y, best.cx, best.cy))) best = c;
          if (best) claimed.add(best);
          const others = starts.filter((o) => o !== s).map((o) => ({ player: o.owner + 1, distance: Math.round(dist(s.tx, s.ty, o.tx, o.ty)) })).sort((a, b) => a.distance - b.distance);
          const lineSide = best ? compassOf(best.cx - hc.x, best.cy - hc.y) : null;
          const amounts = best ? best.minerals.map((m) => m.amount) : [];
          return {
            player: s.owner + 1,
            start: { x: s.tx, y: s.ty },
            hall: { x: hall.x, y: hall.y, w: hall.w, h: hall.h },
            ...(best ? {
              minerals: { count: best.minerals.length, amount: amounts.length ? (Math.min(...amounts) === Math.max(...amounts) ? Math.min(...amounts) : `${Math.min(...amounts)}–${Math.max(...amounts)}`) : 0, tiles: `${best.x0},${best.y0}–${best.x1},${best.y1}` },
              geysers: best.geysers.map((g) => ({ x: g.tx, y: g.ty, amount: g.amount })),
              lineSide, openSide: lineSide ? oppositeOf(lineSide) : null,
            } : { minerals: { count: 0 }, geysers: [], lineSide: null, openSide: null, note: "no resources within 12 tiles" }),
            ...(others.length ? { nearestStart: others[0] } : {}),
          };
        });
        const expansions = clusters.filter((c) => !claimed.has(c) && c.minerals.length + c.geysers.length >= 2).map((c) => ({ centre: { x: Math.round(c.cx), y: Math.round(c.cy) }, minerals: c.minerals.length, geysers: c.geysers.length, tiles: `${c.x0},${c.y0}–${c.x1},${c.y1}` }));
        return capResult({ map: `${info.width} × ${info.height}`, bases, expansions, note: "the open side is across the hall from the mineral line; ramps are not read here — reachable and terrain_at say where the ground drops" });
      },
    },
    {
      def: { name: "find_site", description: "Where a block of `w` × `h` tiles of flat ground fits, nearest a point first. `purpose` \"building\" (default) wants buildable, walkable ground on one height — for a new base ask for about 14 × 11 (a hall with its mineral ring; the answer gives the hall's top-left for place_base), for a building its footprint; \"terrain\" wants ground on one height to paint over — a plateau, a lane, a pit — and does not mind doodads, since painting lifts them. Every site is reachable on foot from every start location unless `anyStart` is false; `near` defaults to the map's centre, `radius` to 40 tiles. Up to five sites at least a block apart, with the ground's terrain and height. Use this instead of probing tiles one at a time with terrain_at and placement_ok.", inputSchema: obj({ w: { type: "integer" }, h: { type: "integer" }, x: { type: "integer", description: "near this tile" }, y: { type: "integer" }, radius: { type: "integer" }, purpose: { type: "string", enum: ["building", "terrain"] }, anyStart: { type: "boolean", description: "false: no reachability requirement" } }, ["w", "h"]) },
      describe: (input) => `Find ${num(input.w)} × ${num(input.h)} of ${str(input.purpose) === "terrain" ? "flat" : "open"} ground${input.x !== undefined ? ` near ${num(input.x)},${num(input.y)}` : " near the centre"}`,
      report: (result) => { const r = jsonOf(result); return r ? plural(list(r.sites).length, "site") : ""; },
      writes: false,
      run: (input, { api }) => {
        const info = api.document.info();
        const scn = api.document.scenario();
        if (!info || !scn) return fail("No map is open.");
        if (!api.tileset.isLoaded()) return fail("The tileset graphics are not loaded.");
        const w = Math.max(1, Math.round(num(input.w))), h = Math.max(1, Math.round(num(input.h)));
        const near = { x: input.x === undefined ? info.width / 2 : num(input.x), y: input.y === undefined ? info.height / 2 : num(input.y) };
        const radius = Math.max(1, Math.round(num(input.radius, 40)));
        const requireStarts = input.anyStart !== false;
        const forTerrain = str(input.purpose) === "terrain";
        // Reachable from every start: the intersection of the floods, on the walk mask.
        const mask = walkMask(api);
        if (!mask) return fail("The map's walkability cannot be read.");
        const starts = api.query.startLocations();
        let reach: Uint8Array | null = null;
        if (requireStarts && starts.length) {
          for (const s of starts) {
            const from = mask.walk[s.ty * mask.width + s.tx] ? { x: s.tx, y: s.ty } : nearestWalkable(mask, s.tx, s.ty);
            const r = from ? floodFrom(mask, from.x, from.y) : new Uint8Array(mask.width * mask.height);
            if (!reach) reach = r; else for (let i = 0; i < reach.length; i++) reach[i] &= r[i];
          }
        }
        // One mask per height, so a block is flat as well as buildable and walkable.
        const tileCache = new Map<number, { ok: boolean; height: number }>();
        // To build on: buildable and walkable. To paint over: level ground or a doodad on it (not water, not a cliff's edge tiles).
        const at = (i: number) => { let t = tileCache.get(scn.tiles[i]); if (!t) { const ti = api.terrain.tileInfo(scn.tiles[i]); t = { ok: !!ti && (forTerrain ? (ti.kind === "terrain" || ti.kind === "doodad") && ti.walkable >= 8 : ti.buildable && ti.walkable >= 8), height: ti?.height ?? 0 }; tileCache.set(scn.tiles[i], t); } return t; };
        const found: { x: number; y: number; distance: number; height: number }[] = [];
        for (const height of [0, 1, 2]) {
          const ok = new Uint8Array(info.width * info.height);
          for (let i = 0; i < ok.length; i++) { const t = at(i); ok[i] = t.ok && t.height === height && (!reach || reach[i]) ? 1 : 0; }
          for (const s of scanSites({ width: info.width, height: info.height, ok }, w, h, near, radius, 8)) found.push({ ...s, height });
        }
        found.sort((a, b) => a.distance - b.distance);
        const sites: unknown[] = [];
        for (const s of found) {
          if (sites.length >= 5) break;
          if ((sites as { x: number; y: number }[]).some((k) => Math.abs(k.x - s.x) < w && Math.abs(k.y - s.y) < h)) continue;
          const hall = { x: s.x + Math.floor((w - HALL.w) / 2), y: s.y + Math.floor((h - HALL.h) / 2) };
          const terrainId = api.terrain.terrainAt(s.x + Math.floor(w / 2), s.y + Math.floor(h / 2));
          sites.push({ x: s.x, y: s.y, w, h, ...(w >= HALL.w && h >= HALL.h ? { hall } : {}), distance: Math.round(s.distance), height: s.height, terrain: api.terrain.types().find((t) => t.id === terrainId)?.name ?? terrainId });
        }
        if (!sites.length) return capResult({ sites: [], note: `no ${w} × ${h} block of flat, buildable, walkable ground${reach ? " reachable from every start" : ""} within ${radius} tiles of ${Math.round(near.x)},${Math.round(near.y)}; try a smaller block, a larger radius or another point` });
        return capResult({ near: { x: Math.round(near.x), y: Math.round(near.y) }, radius, reachableFromEveryStart: !!reach, sites });
      },
    },
    {
      def: { name: "reachable", description: "Whether a ground unit can walk from one place to another, by flood-filling the map's walkable tiles: a lane from its spawn to its goal, a base from its ramp to the middle, a bound from start to finish. Each end is a location by name (fromLocation / toLocation) or a tile (fromX, fromY / toX, toY). Answers yes or no, how many tiles the start reaches, and where the nearest walkable tile is when an end stands on unwalkable ground. A yes does not prove a barrier holds: a broken river answers yes too. To prove a river or wall is crossed only at its bridge, ask twice — plainly (yes) and with ignoreBridges true, which counts the tiles under every bridge as water (no).", inputSchema: obj({ fromLocation: { type: "string" }, toLocation: { type: "string" }, fromX: { type: "integer" }, fromY: { type: "integer" }, toX: { type: "integer" }, toY: { type: "integer" }, ignoreBridges: { type: "boolean" } }) },
      describe: (input) => `Can units walk from ${str(input.fromLocation) || `${num(input.fromX)},${num(input.fromY)}`} to ${str(input.toLocation) || `${num(input.toX)},${num(input.toY)}`}${input.ignoreBridges === true ? " without the bridges" : ""}?`,
      report: (result) => { const r = jsonOf(result); return r ? (r.reachable ? `yes, ${plural(num(r.tilesReachedFromStart), "tile")} reached` : `no: ${String(r.to)}`) : ""; },
      writes: false,
      run: (input, { api }) => {
        const ignoreBridges = input.ignoreBridges === true;
        const blocked = ignoreBridges ? bridgeFootprints(api) : [];
        const mask = walkMask(api, blocked);
        if (!mask) return fail("No map is open, or the tileset graphics are not loaded.");
        const from = pointOf(api, input, "from"), to = pointOf(api, input, "to");
        if (typeof from === "string") return from;
        if (typeof to === "string") return to;
        const fromWalkable = mask.walk[from.y * mask.width + from.x] === 1;
        const start = fromWalkable ? from : nearestWalkable(mask, from.x, from.y);
        if (!start) return `${from.label} is not walkable and nothing walkable lies within 6 tiles of it.`;
        const reach = floodFrom(mask, start.x, start.y);
        const toWalkable = mask.walk[to.y * mask.width + to.x] === 1;
        const target = toWalkable ? to : nearestWalkable(mask, to.x, to.y);
        // A location's centre may be a shore tile; the location's whole box counts.
        const scn = api.document.scenario()!;
        const toIndex = scn.locations.findIndex((l, i) => (l.left !== l.right || l.nameIndex > 0) && api.names.location(i).toLowerCase() === to.label.toLowerCase());
        const box = toIndex >= 0 ? { x0: Math.floor(Math.min(scn.locations[toIndex].left, scn.locations[toIndex].right) / TILE), y0: Math.floor(Math.min(scn.locations[toIndex].top, scn.locations[toIndex].bottom) / TILE), x1: Math.ceil(Math.max(scn.locations[toIndex].left, scn.locations[toIndex].right) / TILE), y1: Math.ceil(Math.max(scn.locations[toIndex].top, scn.locations[toIndex].bottom) / TILE) } : null;
        const ok = box ? reachTouches(mask, reach, box) : !!target && reach[target.y * mask.width + target.x] === 1;
        let n = 0; for (let i = 0; i < reach.length; i++) n += reach[i];
        return capResult({
          reachable: ok,
          ...(ignoreBridges ? { bridgesIgnored: blocked.length } : {}),
          from: `${from.label}${fromWalkable ? "" : ` (not walkable; started from ${start.x},${start.y})`}`,
          to: `${to.label}${toWalkable ? "" : target ? ` (centre not walkable; nearest walkable ${target.x},${target.y})` : " (not walkable, nothing walkable near)"}`,
          tilesReachedFromStart: n,
        });
      },
    },
    {
      def: { name: "scenario_rules", description: "The game's own rules a scenario breaks silently, checked on the open map: a human or computer slot that owns nothing (defeated at once, and its triggers never run); a human without a start location; a trigger list that counts time without hyper triggers. With fix: true, a computer that owns nothing gets an Overlord in the top-right corner to keep it in the game.", inputSchema: obj({ fix: { type: "boolean" } }) },
      describe: (input) => input.fix === true ? "Check the game's rules and fix what fails" : "Check the game's rules",
      report: (result) => { const r = jsonOf(result); if (!r) return ""; const problems = Array.isArray(r.problems) ? r.problems.filter((x) => x !== "none") : []; const fixed = Array.isArray(r.fixed) ? r.fixed.length : 0; return problems.length ? `${plural(problems.length, "problem")}${fixed ? `, ${fixed} fixed` : ""}` : fixed ? `${fixed} fixed` : "no problems"; },
      writes: true,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return fail("No map is open.");
        const { humans, computers } = slots(api);
        const owned = new Set(scn.units.map((u) => u.owner + 1));
        const problems: string[] = [];
        const fixed: string[] = [];
        for (const p of humans) if (!owned.has(p)) problems.push(`Player ${p} (human) owns no unit; a human is placed by the start location, so check it has one and that the triggers or the melee start give it something`);
        const starts = new Set(api.query.startLocations().map((s) => s.owner + 1));
        for (const p of humans) if (!starts.has(p)) problems.push(`Player ${p} (human) has no start location`);
        const keeper = unitIdByName(api, "Zerg Overlord");
        for (const p of computers) {
          if (owned.has(p)) continue;
          if (input.fix === true && keeper !== null) {
            const px = (scn.width - 2) * TILE, py = (2 + fixed.length * 2) * TILE;
            api.document.edit(`AI: keeper for player ${p}`, (tx) => { tx.placeUnit(keeper, p - 1, px, py); });
            fixed.push(`Player ${p} (computer) owned nothing: an Overlord at ${scn.width - 2},${2 + (fixed.length) * 2} keeps it in the game`);
          } else problems.push(`Player ${p} (computer) owns nothing: it is defeated the moment the game starts and its triggers never run — give it a unit out of the way (fix: true does)`);
        }
        const hyper = scn.triggers.some((t) => t.actions.filter((a) => a.type === api.consts.triggers.action.Wait && a.time <= 1).length >= 8);
        const counters = scn.triggers.some((t) => t.conditions.some((c) => c.type === api.consts.triggers.condition.Deaths) && t.actions.some((a) => a.type === api.consts.triggers.action.SetDeaths));
        if (counters && !hyper) problems.push("triggers count with death counters but the map has no hyper triggers: they tick once every two seconds (add the hyper system with ums_build)");
        return capResult({ problems: problems.length ? problems : ["none"], fixed });
      },
    },
  ];
}
