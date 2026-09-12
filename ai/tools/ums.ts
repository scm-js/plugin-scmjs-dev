/**
 * The assistant's way into the toolkit and the guides: `guide` reads a genre guide,
 * `ums_kinds` lists what the toolkit builds, `ums_build` builds one system into the
 * map's triggers. The same builders the Scenario workflow runs, so an assistant asked
 * "add kill to cash" and a design that lists it produce the same triggers.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { guideById, guideFor, guideIndex } from "../guides";
import { buildSystem, dcUnitsFrom, kindsText, ToolkitError, type Params, type ToolkitContext } from "../ums";
import { capResult, fail, jsonOf, num, obj, plural, str, type Tool } from "./common";

/**
 * Who is human and who is computer on the open map, which death-counter units and
 * locations it has, and which counters and switches its triggers already use — read
 * afresh for every build, so the system built a moment ago counts as in use for the next.
 */
export function toolkitContext(api: PluginApi, options: { hyper?: boolean; extraLocations?: string[] } = {}): ToolkitContext {
  const players = api.settings.players();
  const humans = players.filter((p) => /human/i.test(p.typeName)).map((p) => p.slot + 1);
  const computers = players.filter((p) => /computer/i.test(p.typeName)).map((p) => p.slot + 1);
  const triggers = api.triggers.list();
  const hyper = options.hyper ?? triggers.some((t) => t.actions.filter((a) => a.type === api.consts.triggers.action.Wait && a.time <= 1).length >= 8);
  const locations = [...usedLocationNames(api), ...(options.extraLocations ?? [])];
  const used = usedTriggerState(api, triggers);
  return { humans: humans.length ? humans : [1], computers, hyper, dcUnits: dcUnitsFrom(api.names.units().map((u) => u.label)), locations, usedDcUnits: used.dcUnits, usedSwitches: used.switches };
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

/** Build a system and append its triggers to the map, in one settings transaction. */
export function addSystem(api: PluginApi, kind: string, params: Params, ctx: ToolkitContext, label = `AI: ${kind}`): { count: number; notes: string[] } {
  const built = buildSystem(kind, params, ctx);
  const parsed = api.triggers.text.parse(built.text, { briefing: false });
  api.document.update(label, (tx) => { for (const t of parsed) tx.triggers.add(t.trigger); });
  return { count: parsed.length, notes: built.notes };
}

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
      def: { name: "ums_kinds", description: "The toolkit's trigger systems (hyper, spawn, waves, lives, shops, heal, respawn, teleport, kill zones, leaderboards, countdown, last standing, alliances …) with each kind's parameters. Build them with ums_build rather than by hand.", inputSchema: obj({}) },
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
          return capResult({ added: r.count, triggers: api.triggers.list().length, notes: r.notes });
        } catch (err) {
          if (err instanceof ToolkitError) return fail(`Not built:\n${err.problems.map((p) => `- ${p}`).join("\n")}`);
          return fail(`Not built: ${(err as Error).message}`);
        }
      },
    },
  ];
}
