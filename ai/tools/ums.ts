/**
 * The assistant's way into the toolkit and the guides: `guide` reads a genre guide,
 * `ums_kinds` lists what the toolkit builds, `ums_build` builds one system into the
 * map's triggers. The same builders the Scenario workflow runs, so an assistant asked
 * "add kill to cash" and a design that lists it produce the same triggers.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { guideById, guideFor, guideIndex } from "../guides";
import { scriptBridge } from "../script";
import { unitIdByName } from "../facts";
import { buildSystem, dcUnitsFrom, kindsText, ToolkitError, type Params, type Placement, type Tempo, type ToolkitContext } from "../ums";
import { capResult, fail, jsonOf, num, obj, plural, str, type Tool } from "./common";

/**
 * Who is human and who is computer on the open map, which death-counter units and
 * locations it has, and which counters and switches its triggers already use — read
 * afresh for every build, so the system built a moment ago counts as in use for the next.
 */
/** Whether the map's own triggers hold hyper triggers: a trigger of many Wait(0)s. */
export function hasHyperTriggers(api: PluginApi, triggers = api.triggers.list()): boolean {
  return triggers.some((t) => t.actions.filter((a) => a.type === api.consts.triggers.action.Wait && a.time <= 1).length >= 8);
}

/** Whether the map's TrigScript, as last applied, has programs — the map is then built by eudplib and every trigger runs each frame. */
export function hasPrograms(api: PluginApi): boolean {
  return (scriptBridge(api)?.state()?.programs ?? 0) > 0;
}

/** How often the map's triggers run as it stands: every frame with a program, fast with hyper triggers, slowly otherwise. */
export function mapTempo(api: PluginApi, triggers = api.triggers.list()): Tempo {
  return hasPrograms(api) ? "turbo" : hasHyperTriggers(api, triggers) ? "hyper" : "plain";
}

export function toolkitContext(api: PluginApi, options: { tempo?: Tempo; extraLocations?: string[] } = {}): ToolkitContext {
  const players = api.settings.players();
  const humans = players.filter((p) => /human/i.test(p.typeName)).map((p) => p.slot + 1);
  const computers = players.filter((p) => /computer/i.test(p.typeName)).map((p) => p.slot + 1);
  const triggers = api.triggers.list();
  const tempo = options.tempo ?? mapTempo(api, triggers);
  const locations = [...usedLocationNames(api), ...(options.extraLocations ?? [])];
  const used = usedTriggerState(api, triggers);
  const isBuilding = (unit: string) => { const id = unitIdByName(api, unit); return id !== null && api.palette.unitSize(id).building; };
  return { isBuilding, humans: humans.length ? humans : [1], computers, tempo, dcUnits: dcUnitsFrom(api.names.units().map((u) => u.label)), locations, usedDcUnits: used.dcUnits, usedSwitches: used.switches };
}

/**
 * The death-counter units and switches the map's triggers read or write, by the names the
 * toolkit uses — a Deaths condition or Set Deaths action names a unit, a Switch condition
 * or Set Switch action a switch. What a hand-written trigger, a TrigScript build or an
 * earlier system counts on, so a new system stays off it.
 */
export function usedTriggerState(api: PluginApi, triggers = api.triggers.list()): { dcUnits: string[]; switches: string[] } {
  const { condition, action } = api.consts.triggers;
  const units = new Set<number>();
  const switches = new Set<number>();
  for (const t of triggers) {
    for (const c of t.conditions) {
      if (c.type === condition.Deaths) units.add(c.unitId);
      else if (c.type === condition.Switch) switches.add(c.resource);
    }
    for (const a of t.actions) {
      if (a.type === action.SetDeaths) units.add(a.unitId);
      else if (a.type === action.SetSwitch) switches.add(a.target);
    }
  }
  return { dcUnits: [...units].map((id) => api.names.unit(id)), switches: [...switches].map((i) => api.names.switch(i)) };
}

/** The names of the locations in use on the open map (a slot with an area or a name), Anywhere included. */
export function usedLocationNames(api: PluginApi): string[] {
  const scn = api.document.scenario();
  if (!scn) return [];
  const out: string[] = [];
  scn.locations.forEach((l, i) => { if (l.left !== l.right || l.top !== l.bottom || l.nameIndex > 0) out.push(api.names.location(i)); });
  return out;
}

/** Build a system and append its triggers to the map, in one settings transaction; what it wants placed goes on the map in one edit. */
export function addSystem(api: PluginApi, kind: string, params: Params, ctx: ToolkitContext, label = `AI: ${kind}`): { count: number; placed: number; notes: string[] } {
  const built = buildSystem(kind, params, ctx);
  const parsed = built.text.trim() ? api.triggers.text.parse(built.text, { briefing: false }) : [];
  if (parsed.length) api.document.update(label, (tx) => { for (const t of parsed) tx.triggers.add(t.trigger); });
  const placed = built.place.length ? placeInLocations(api, built.place, label) : { placed: 0, notes: [] };
  return { count: parsed.length, placed: placed.placed, notes: [...built.notes, ...placed.notes] };
}

/**
 * Put units on the map inside the locations they are for: each at the first spot, row by
 * row from the location's top-left, that the editor's placement check accepts — ground it
 * may stand on, nothing in the way, the ones placed a moment ago included. One undo step.
 */
export function placeInLocations(api: PluginApi, list: Placement[], label: string): { placed: number; notes: string[] } {
  const scn = api.document.scenario();
  if (!scn) return { placed: 0, notes: [] };
  const notes: string[] = [];
  let placed = 0;
  // The editor's check is on collision boxes, which are smaller than a building's footprint: two Barracks pass it
  // three tiles apart. Here footprints keep a tile between them, so they never overlap and a unit can walk through.
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  api.document.edit(label, (tx) => {
    for (const want of list) {
      const id = unitIdByName(api, want.unit);
      const at = scn.locations.findIndex((_, i) => api.names.location(i).toLowerCase() === want.location.toLowerCase());
      if (id === null || at < 0) { notes.push(`${want.unit} for player ${want.player} was not placed: ${id === null ? "no such unit" : `no location "${want.location}"`}`); continue; }
      const l = scn.locations[at];
      const x0 = Math.min(l.left, l.right), x1 = Math.max(l.left, l.right), y0 = Math.min(l.top, l.bottom), y1 = Math.max(l.top, l.bottom);
      const size = api.palette.unitSize(id);
      // The placement box, in pixels.
      const halfW = size.width / 2, halfH = size.height / 2;
      let left = want.count;
      for (let y = y0 + halfH; left > 0 && y + halfH <= y1; y += TILE_PX) {
        for (let x = x0 + halfW; left > 0 && x + halfW <= x1; x += TILE_PX) {
          const box = { x0: x - halfW - TILE_PX, y0: y - halfH - TILE_PX, x1: x + halfW + TILE_PX, y1: y + halfH + TILE_PX };
          if (boxes.some((b) => box.x0 < b.x1 - TILE_PX && box.x1 - TILE_PX > b.x0 && box.y0 < b.y1 - TILE_PX && box.y1 - TILE_PX > b.y0)) continue;
          if (!tx.canPlaceUnit(id, x, y)) continue;
          boxes.push(box);
          tx.placeUnit(id, want.player - 1, x, y);
          placed++;
          left--;
        }
      }
      if (left > 0) {
        const why = api.query.placement(id, (x0 + x1) / 2, (y0 + y1) / 2)?.reason;
        notes.push(`${left} ${want.unit} for player ${want.player} found no room in "${want.location}"${why ? ` (at its middle: ${why})` : ""}: place ${left === 1 ? "it" : "them"} by hand, or the player starts without`);
      }
    }
  });
  return { placed, notes };
}

const TILE_PX = 32;

export function umsTools(): Tool[] {
  return [
    {
      def: { name: "guide", description: "A guide to read once: \"terrain\" (how the brush, shapes, ramps, bridges, bases and doodads behave — before terrain work), \"basics\" (death counters, hyper triggers, locations, the game's limits), or a genre (madness, defense, rpg, bound, diplomacy, arena, survival; a free description picks the nearest). No id lists them.", inputSchema: obj({ id: { type: "string" } }) },
      describe: (input) => str(input.id) ? `Read the guide: ${str(input.id)}` : "List the guides",
      writes: false,
      run: (input) => {
        const id = str(input.id);
        if (!id) return `The guides:\n${guideIndex()}\n\nAsk for one by id, or describe the map.`;
        const g = guideById(id) ?? guideFor(id);
        return g ? g.text : `No guide matches "${id}". The guides:\n${guideIndex()}`;
      },
    },
    {
      def: { name: "ums_kinds", description: "The toolkit's trigger systems (hyper, spawn, waves, lives, shops, heal, respawn, teleport, kill zones, capture the flag, leaderboards, countdown, last standing, alliances …) with each kind's parameters. Build them with ums_build rather than by hand.", inputSchema: obj({}) },
      writes: false,
      run: () => kindsText(),
    },
    {
      def: { name: "ums_build", description: "Build one toolkit system (see ums_kinds) and append its triggers; `params` as strings — names, digits, comma lists; {p} in a location name is the player number. Problems are reported and nothing added. Not undoable.", inputSchema: obj({ kind: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } }, ["kind"]) },
      describe: (input) => { const p = input.params && typeof input.params === "object" ? Object.entries(input.params as Record<string, unknown>).slice(0, 3).map(([k, v]) => `${k} ${String(v)}`).join(", ") : ""; return `Build ${str(input.kind)}${p ? `: ${p}` : ""}`; },
      report: (result) => { const r = jsonOf(result); return r ? `${plural(num(r.added), "trigger")} added, ${num(r.triggers)} in all` : ""; },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const kind = str(input.kind);
        const raw = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
        const params: Params = {};
        for (const [k, v] of Object.entries(raw)) params[k] = Array.isArray(v) ? v.join(", ") : String(v);
        try {
          const r = addSystem(api, kind, params, toolkitContext(api));
          return capResult({ added: r.count, ...(r.placed ? { placed: r.placed } : {}), triggers: api.triggers.list().length, notes: r.notes });
        } catch (err) {
          if (err instanceof ToolkitError) return fail(`Not built:\n${err.problems.map((p) => `- ${p}`).join("\n")}`);
          return fail(`Not built: ${(err as Error).message}`);
        }
      },
    },
  ];
}
