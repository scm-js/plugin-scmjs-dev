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
import { bridgePairOf, bridgesOf, fitDoodad, fitRamp, rampPairsOf, rampsOf, VERIFIED_RAMPS } from "../ramps";
import { floodFrom, nearestWalkable, reachTouches, walkMask } from "../reach";
import { renderPlan, summarizeRender } from "../render";
import { shiftShapes } from "../shapes";
import { capResult, list, num, obj, str, TILE, type Tool } from "./common";

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

export function layoutTools(): Tool[] {
  return [
    {
      def: { name: "layout_presets", description: "The layouts the editor lays out by itself from a few numbers — corner camps around an arena, lanes from spawns to a goal, a walled arena, a bound's course of stretches, a town with a chain of regions — with each one's parameters and the locations it makes ({p} a player number, {n} a lane, stretch or region number). Use layout_preset to lay one out; prefer a preset over painting terrain by hand whenever the map's shape is one of these.", inputSchema: obj({}) },
      writes: false,
      run: () => presetsText(),
    },
    {
      def: { name: "layout_preset", description: "Lay a preset out over the whole map: the terrain (with ramps and bridges that fit, where the tileset has them), the named locations, a start location per human player, a little decoration. Replaces the terrain and clears units, doodads and sprites first; triggers and settings stay. `params` are the preset's parameters as strings (see layout_presets). One undo step.", inputSchema: obj({ preset: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } }, ["preset"]) },
      writes: true,
      run: (input, { api }) => {
        const id = str(input.preset);
        if (!presetById(id)) return `No preset is called "${id}". The presets:\n${presetSpecs().map((p) => p.id).join(", ")}`;
        const info = api.document.info();
        if (!info) return "No map is open.";
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
          if (err instanceof PresetError) return `Not laid out:\n${err.problems.map((p) => `- ${p}`).join("\n")}`;
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
        description: "Paint terrain as shapes, in map tiles, in order (later over earlier): ground (the whole map), rect (x, y, w, h, optional cut: isometric corner cut in rows), diamond / ellipse (cx, cy, rx, ry), polygon (points), stroke (points, width: a band — a river, a road, a wall), border (width), plateau (like rect, plus ramps: which lower corners get a ramp down, \"sw\" and/or \"se\" — the game's ramps go down south-west or south-east and nowhere else; the editor cuts the corner into the diagonal edge a ramp fits, paints the pair the tileset has ramps for either side, and fits the ramp), lane (points, width, wall terrain id, wallWidth: a walkable band with walls either side, continuous by construction; the width is the walkable core kept), ramp (x, y, side: on a cliff already there), bridge (x, y, along \"se\" or \"sw\": the editor paints the channel and fits the bridge). Every shape but ramp and bridge names a terrain id (see list_terrains). Only the tiles the shapes cover change; `originX`/`originY` shift every coordinate, for shapes written relative to an area's corner. `clear` removes units, doodads and sprites under the painted area first. Optional `locations` ([{name, x0, y0, x1, y1}] in tiles) and `units` ([{unit, player, x, y}]) go on afterwards. One undo step.",
        inputSchema: obj({
          shapes: { type: "array", items: { type: "object", additionalProperties: true } },
          originX: { type: "integer" }, originY: { type: "integer" },
          clear: { type: "boolean" },
          locations: { type: "array", items: { type: "object", additionalProperties: true } },
          units: { type: "array", items: { type: "object", additionalProperties: true } },
        }, ["shapes"]),
      },
      writes: true,
      run: (input, { api }) => {
        const info = api.document.info();
        if (!info) return "No map is open.";
        const shapes = list<Shape>(input.shapes).filter((s) => s && typeof s === "object" && typeof s.op === "string");
        if (!shapes.length) return "No shapes were given.";
        const dx = Math.round(num(input.originX)), dy = Math.round(num(input.originY));
        const locations = list<Record<string, unknown>>(input.locations).map((l) => ({ name: str(l.name, "Location"), x0: Math.round(num(l.x0)) + dx, y0: Math.round(num(l.y0)) + dy, x1: Math.round(num(l.x1)) + dx, y1: Math.round(num(l.y1)) + dy }));
        const units = list<Record<string, unknown>>(input.units).map((u) => ({ unit: str(u.unit), player: Math.round(num(u.player, 12)), x: Math.round(num(u.x)) + dx, y: Math.round(num(u.y)) + dy }));
        const plan: MapPlan = {
          name: "", description: "", symmetry: "none", cellSize: 1, columns: info.width, rows: info.height, legend: {}, grid: [],
          shapes: shiftShapes(shapes, dx, dy), bases: [], ramps: [], doodads: [], units, locations, notes: [],
        };
        const rendered = renderPlan(api, plan, { originX: 0, originY: 0, label: "AI: paint shapes", clearArea: input.clear === true });
        if (!rendered) return "The shapes could not be rendered.";
        return capResult({ painted: summarizeRender(rendered), notes: rendered.findings });
      },
    },
    {
      def: { name: "place_ramp", description: "Fit one of the tileset's ramps on a cliff already on the map, near a tile, going down south-west or south-east (the only ways the game's ramps go). Tries every ramp within a few tiles with the editor's own placement rule and takes the nearest fit. A ramp fits only a straight diagonal cliff run facing south, between ground the tileset has a ramp for — a tile-aligned cliff takes none; to make such an edge, paint a plateau with paint_shapes instead.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" }, side: { type: "string", enum: ["sw", "se"] } }, ["x", "y", "side"]) },
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
          return `No ramp fits within 12 tiles of ${x},${y} going ${side}. A ramp needs a straight diagonal cliff run facing ${side === "sw" ? "south-west" : "south-east"}, between ground this tileset has ramps for (${pairs}). Paint a plateau with a ramps parameter through paint_shapes to make such an edge.`;
        }
        const r = api.document.edit("AI: place ramp", (tx) => { tx.placeDoodad(fit.doodadId, fit.tx, fit.ty); });
        return capResult({ placed: `${fit.name} at ${fit.tx},${fit.ty} (${fit.width}×${fit.height})`, notes: r.notes });
      },
    },
    {
      def: { name: "place_bridge", description: "Fit one of the tileset's bridges over water already on the map, near a tile. A bridge spans only a diagonal channel of the width the tileset's bridges were drawn for (Jungle and Space Platform have bridges the brush's shores take); to make such a channel, use a bridge shape in paint_shapes, which paints it and fits the bridge in one go.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" } }, ["x", "y"]) },
      writes: true,
      run: (input, { api }) => {
        const bridges = bridgesOf(api);
        if (!bridges.length) return "This tileset has no bridges.";
        const x = Math.round(num(input.x)), y = Math.round(num(input.y));
        const fit = fitDoodad({ x, y }, bridges, (id, tx, ty) => api.query.doodadPlacement(id, tx, ty)?.ok === true, { dx: 14, dy: 10 });
        if (!fit) return `No bridge fits within 14 tiles of ${x},${y}. The water there is not a diagonal channel of the width this tileset's bridges span; a bridge shape in paint_shapes paints one and fits the bridge.`;
        const r = api.document.edit("AI: place bridge", (tx) => { tx.placeDoodad(fit.doodadId, fit.tx, fit.ty); });
        return capResult({ placed: `${fit.name} at ${fit.tx},${fit.ty} (${fit.width}×${fit.height})`, notes: r.notes });
      },
    },
    {
      def: { name: "reachable", description: "Whether a ground unit can walk from one place to another, by flood-filling the map's walkable tiles: a lane from its spawn to its goal, a base from its ramp to the middle, a bound from start to finish. Each end is a location by name (fromLocation / toLocation) or a tile (fromX, fromY / toX, toY). Answers yes or no, how many tiles the start reaches, and where the nearest walkable tile is when an end stands on unwalkable ground.", inputSchema: obj({ fromLocation: { type: "string" }, toLocation: { type: "string" }, fromX: { type: "integer" }, fromY: { type: "integer" }, toX: { type: "integer" }, toY: { type: "integer" } }) },
      writes: false,
      run: (input, { api }) => {
        const mask = walkMask(api);
        if (!mask) return "No map is open, or the tileset graphics are not loaded.";
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
          from: `${from.label}${fromWalkable ? "" : ` (not walkable; started from ${start.x},${start.y})`}`,
          to: `${to.label}${toWalkable ? "" : target ? ` (centre not walkable; nearest walkable ${target.x},${target.y})` : " (not walkable, nothing walkable near)"}`,
          tilesReachedFromStart: n,
        });
      },
    },
    {
      def: { name: "scenario_rules", description: "The game's own rules a scenario breaks silently, checked on the open map: a human or computer slot that owns nothing (defeated at once, and its triggers never run); a human without a start location; a trigger list that counts time without hyper triggers. With fix: true, a computer that owns nothing gets an Overlord in the top-right corner to keep it in the game.", inputSchema: obj({ fix: { type: "boolean" } }) },
      writes: true,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
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
