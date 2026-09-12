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
      def: { name: "layout_presets", description: "The layouts the editor lays out from a few numbers (corner camps, lanes, arena, bound course, town) with their parameters and the locations they make ({p} a player, {n} a number). Prefer one over painting by hand when the shape fits.", inputSchema: obj({}) },
      writes: false,
      run: () => presetsText(),
    },
    {
      def: { name: "layout_preset", description: "Lay a preset over the whole map: terrain with fitting ramps and bridges, named locations, a start per human, decoration. Replaces the terrain and clears objects; triggers and settings stay. `params` as strings (see layout_presets). One undo step.", inputSchema: obj({ preset: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } }, ["preset"]) },
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
        name: "paint_shapes", description: "Paint terrain as shapes in tiles, later over earlier; each shape has an `op`: ground, rect (x, y, w, h, cut), diamond / ellipse (cx, cy, rx, ry), polygon (points), stroke (points, width; a river's `bridges` [[x, y], …] get the channel, banks and bridge fitted; optional bank, bankWidth), border (width), plateau (a rect with ramps [\"sw\" / \"se\"] cut and fitted), lane (points, width, wall, wallWidth), ramp (x, y, side), bridge (x, y, along). All but ramp and bridge take a terrain id. `originX` / `originY` shift every coordinate; `clear` empties the shapes' rectangle first (off by default); `locations` and `units` go on afterwards. Read guide \"terrain\" first for how ramps, bridges, banks and lifted doodads behave. One undo step.",
        inputSchema: obj({
          shapes: { type: "array", items: { type: "object", properties: { op: { type: "string", enum: SHAPE_OPS }, terrain: { type: "integer" } }, required: ["op"], additionalProperties: true } },
          originX: { type: "integer" }, originY: { type: "integer" },
          clear: { type: "boolean" },
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
      def: { name: "place_ramp", description: "Fit one of the tileset's ramps on a cliff already there, near a tile, going down sw or se (the only ways ramps go). Needs a straight diagonal cliff run; a plateau shape makes one.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" }, side: { type: "string", enum: ["sw", "se"] } }, ["x", "y", "side"]) },
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
      def: { name: "place_bridge", description: "Fit one of the tileset's bridges over a diagonal water channel already there, near a tile. Where the tileset has no bridge the editor can place (Badlands, Installation, Ash World) leave a gap of ground instead. A stroke with `bridges` in paint_shapes does channel and bridge in one.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" } }, ["x", "y"]) },
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
        name: "place_base", description: "Lay a mineral line and geyser round a 4 × 3 town hall footprint (top-left x, y) on the ring the game mines fastest from, along `direction` (a compass point seen from the hall; default away from the centre), turning to the nearest side that fits and saying so. `player` places that player's start at the hall (omit x, y to use the start it has); `hall` places a town hall by name. Use this for every mineral line.",
        inputSchema: obj({
          x: { type: "integer" },
          y: { type: "integer" },
          player: { type: "integer" },
          direction: { type: "string", enum: [...DIRECTIONS] },
          minerals: { type: "integer" },
          geysers: { type: "integer" },
          amount: { type: "integer" },
          gas: { type: "integer" },
          geyserSide: { type: "string", enum: ["auto", "left", "right"] },
          hall: { type: "string" },
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
      def: { name: "bases", description: "Every base in one call: per start location the player, hall footprint, mineral line (positions, amounts), geysers, the line's side and the open side, the nearest other start; then the expansions with no start. Read this before working on bases.", inputSchema: obj({}) },
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
      def: { name: "find_site", description: "The nearest blocks of `w` × `h` flat ground to a point (default the centre; `radius` 40). `purpose` building (buildable, walkable, one height; about 14 × 11 for a base — the answer gives the hall for place_base) or terrain (one height to paint over; doodads do not count). Reachable from every start unless anyStart is false. Up to five, a block apart.", inputSchema: obj({ w: { type: "integer" }, h: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" }, radius: { type: "integer" }, purpose: { type: "string", enum: ["building", "terrain"] }, anyStart: { type: "boolean" } }, ["w", "h"]) },
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
      def: { name: "reachable", description: "Whether a ground unit can walk between two ends (a location by name or a tile), by flood fill; says how many tiles the start reaches and the nearest walkable tile when an end is not walkable. To prove a bridge is the only crossing, ask again with ignoreBridges true and expect no.", inputSchema: obj({ fromLocation: { type: "string" }, toLocation: { type: "string" }, fromX: { type: "integer" }, fromY: { type: "integer" }, toX: { type: "integer" }, toY: { type: "integer" }, ignoreBridges: { type: "boolean" } }) },
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
      def: { name: "scenario_rules", description: "Rules the game applies silently, checked on the map: a slot that owns nothing (defeated at once, its triggers never run), a human without a start, time counted without hyper triggers. fix: true gives an ownerless computer an Overlord.", inputSchema: obj({ fix: { type: "boolean" } }) },
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
