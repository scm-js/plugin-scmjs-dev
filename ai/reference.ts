/**
 * The reference: what the assistant needs to know that does not change from turn to
 * turn, in three layers the server caches as three system blocks, ordered from the most
 * shared to the most specific so the cache serves the widest audience each can:
 *
 * - `game`: the editor's conventions, the unit table (default names, sizes, kinds), the
 *   upgrades and technologies, the trigger condition and action names, the text format
 *   and the script language. The same text for every map on vanilla data, so one cache
 *   entry serves everyone on the server for an hour.
 * - `tileset`: the terrains, the doodad categories and the sprite groups. One entry per
 *   tileset.
 * - `map`: the map's name, size, description, players, the names it gives units,
 *   upgrades or technologies, and whether it has a script. Small, and the only layer a
 *   change to the map rewrites.
 *
 * The long tables — unit stats and weapons, every doodad, every trigger argument with
 * its values — are not in the layers; the `reference` tool answers them on demand, since
 * every turn pays to read the layers and most turns need none of that.
 * `gatherReference` memoises per scenario object and the builders are deterministic.
 */
import type { PluginApi, Scenario } from "@scm-js/plugin-api";
import { bridgePairOf, rampPairsOf } from "./ramps";
import { scriptBridge } from "./script";
import { BRIDGE_CHANNEL } from "./shapes";

export interface ReferenceParts {
  mapName: string;
  description: string;
  width: number;
  height: number;
  tileset: string;
  versionLabel: string;
  /** The playable slots, one line each. */
  players: string[];
  terrains: { id: number; name: string; height: number; buildable: boolean }[];
  /** The terrain pairs the editor fits ramps between, low → high, by name. */
  ramps?: { low: string; high: string }[];
  /** What the editor's bridges stand on and span, by name, with the channel width in tiles; null when it can place none. */
  bridges?: { ground: string; water: string; channel: number } | null;
  doodadCategories: { name: string; doodads: { id: number; name: string; width: number; height: number }[] }[];
  /** `name` is the game's; `customName` what this map calls it, when it does. */
  units: { id: number; name: string; customName?: string; race: string; width: number; height: number; building: boolean; flyer: boolean; hitPoints: number; shields: number; armor: number; minerals: number; gas: number; buildTime: number; weapons: string }[];
  upgrades: { id: number; name: string }[];
  techs: { id: number; name: string }[];
  conditions: { name: string; args: { label: string; kind: string }[] }[];
  actions: { name: string; args: { label: string; kind: string }[] }[];
  briefingActions: { name: string; args: { label: string; kind: string }[] }[];
  choices: { kind: string; labels: string[] }[];
  aiScripts: string[];
  sprites: { label: string; count: number }[];
  hasScript: boolean;
}

const ENUM_KINDS = ["player", "comparison", "modifier", "unitState", "order", "alliance", "resource", "score", "switchState", "switchAction", "textFlags"] as const;

function terrainName(api: PluginApi, id: number): string {
  return api.terrain.types().find((t) => t.id === id)?.name ?? `terrain ${id}`;
}

export function gatherReference(api: PluginApi): ReferenceParts {
  const defs = api.triggers.defs;
  const races: Record<string, string> = { zerg: "Z", terran: "T", protoss: "P" };
  const units: ReferenceParts["units"] = [];
  for (const t of api.settings.unitTypes()) {
    const size = api.palette.unitSize(t.id);
    const d = t.defaults ?? t;
    units.push({
      id: t.id, name: t.name, ...(t.customName ? { customName: api.names.unit(t.id) } : {}), race: races[String(api.data.race(t.id)).toLowerCase()] ?? "-",
      width: size.width, height: size.height, building: size.building, flyer: size.flyer,
      hitPoints: d.hitPoints, shields: d.shields, armor: d.armor, minerals: d.mineralCost, gas: d.gasCost, buildTime: d.buildTime,
      weapons: d.weapons.map((w) => `${w.name} ${w.damage}${w.bonus ? `+${w.bonus}` : ""}`).join("; "),
    });
  }
  const sig = (name: string, args: { label: string; kind: string }[]) => ({ name, args: args.map((a) => ({ label: a.label, kind: a.kind })) });
  const { renamed: _renamed, ...map } = gatherMap(api);
  return {
    ...map,
    tileset: api.tileset.name(),
    terrains: api.terrain.types().map((t) => ({ id: t.id, name: t.name, height: t.height, buildable: t.buildable })),
    ramps: rampPairsOf(api).map((p) => ({ low: terrainName(api, p.low), high: terrainName(api, p.high) })),
    bridges: (() => { const b = bridgePairOf(api); return b ? { ground: terrainName(api, b.ground), water: terrainName(api, b.water), channel: b.channel ?? BRIDGE_CHANNEL } : null; })(),
    doodadCategories: api.palette.doodadCategories().map((c) => ({ name: c.name, doodads: c.doodads.map((d) => ({ id: d.id, name: d.name, width: d.width, height: d.height })) })),
    units,
    upgrades: api.names.upgrades().map((u) => ({ id: u.value, name: u.label })),
    techs: api.names.techs().map((t) => ({ id: t.value, name: t.label })),
    conditions: defs.conditions().map((c) => sig(c.name, c.args)),
    actions: defs.actions(false).map((a) => sig(a.name, a.args)),
    briefingActions: defs.actions(true).map((a) => sig(a.name, a.args)),
    choices: ENUM_KINDS.map((kind) => ({ kind, labels: defs.choices(kind).map((c) => c.label) })),
    aiScripts: defs.choices("aiScript").map((c) => c.label),
    sprites: api.palette.spriteGroups().map((g) => ({ label: g.label, count: g.ids.length })),
  };
}

const TEXT_FORMAT = `Trigger("Player 1", "Force 2"){
Conditions:
  Bring("Current Player", "Any unit", "Beacon Alpha", At least, 1);
  Switch("Switch 3", set);
Actions:
  Display Text Message(Always Display, "You found it!");
  Create Unit(1, "Zerg Zergling", 4, "Spawn", "Player 2");
  Set Deaths("Player 1", "Terran Marine", Add, 5);
  ; Set Switch("Switch 3", clear);
  Preserve Trigger();
}`;

const SCRIPT_SHORT = `const beacon = Bring(CurrentPlayer, Units.AnyUnit, Locations["Beacon Alpha"], "At least", 1);
trigger([P1, Players.Force2], [beacon], [DisplayText("Always Display", "You found it!"), PreserveTrigger()], ["Preserve"]);

let wave = 0;                       // a death counter
while (true) {                       // structured code compiles to death-counter triggers
  if (Bring(P1, Units.AnyUnit, Locations.Beacon, ">=", 1)) { CreateUnit(P2, Units.ZergZergling, 4, Locations.Spawn); wave += 1; }
  if (wave >= 10) Defeat();
  Wait(2000);
}`;

export type ReferenceLayers = [game: string, tileset: string, map: string];

/** The three layers, as Markdown-ish plain text. Deterministic over their input. */
export function buildReferenceLayers(p: ReferenceParts): ReferenceLayers {
  return [gameLayer(p), tilesetLayer(p), mapLayer(p)];
}

/** The layers joined, for anything that wants one text. */
export function buildReference(p: ReferenceParts): string {
  return buildReferenceLayers(p).join("\n\n");
}

function gameLayer(p: ReferenceParts): string {
  const out: string[] = [];
  out.push("# Reference: the editor and the game");
  out.push("");
  out.push("## Conventions");
  out.push("- Tools take tile coordinates (x right, y down, 0-based) and tile rects x0,y0 inclusive to x1,y1 exclusive. A unit's position is its centre.");
  out.push("- Players in tools are 1–8; 12 is Neutral (resources, critters). Settings tools also take \"default\" for a table's default column.");
  out.push("- Names are the editor's: units and terrains as listed, locations and switches as the map names them. Ids are accepted where names are.");
  out.push("- Every writing tool is one undo step (settings changes are transactions outside undo). Prefer one tool call per thing asked for, several calls per turn when they are independent.");
  out.push("- The reference tool has the long tables this block leaves out: unit stats, costs and weapons (part \"units\"); every doodad by category (\"doodads\"); every trigger condition, action and briefing action with its arguments and their values, and the AI scripts (\"triggers\"). Read \"triggers\" before writing triggers you have not written in this conversation.");
  out.push("");
  out.push("## Units (id: name | race | size in tiles | kind). Stats, costs and weapons: reference \"units\"; unit_type shows the map's own values.");
  for (const u of p.units) {
    const kind = u.building ? "building" : u.flyer ? "flyer" : "ground";
    out.push(`${u.id}: ${u.name} | ${u.race} | ${u.width}×${u.height} | ${kind}`);
  }
  out.push("");
  out.push("## Upgrades (set_upgrade)");
  out.push(p.upgrades.map((u) => `${u.id} ${u.name}`).join("; "));
  out.push("");
  out.push("## Technologies (set_tech)");
  out.push(p.techs.map((t) => `${t.id} ${t.name}`).join("; "));
  out.push("");
  out.push(`## Trigger conditions: ${p.conditions.map((c) => c.name).join("; ")}`);
  out.push(`## Trigger actions: ${p.actions.map((a) => a.name).join("; ")}`);
  out.push(`## Briefing actions: ${p.briefingActions.map((a) => a.name).join("; ")}`);
  out.push("");
  out.push("## Text trigger format (list_triggers_text, add_triggers_text, replace_trigger)");
  out.push("One Trigger block per trigger: the players it runs for in the header, conditions and actions one per line ending in a semicolon, names in double quotes, enumerated values bare (their spellings are in reference \"triggers\"). A leading `;` disables a line. Example:");
  out.push("```");
  out.push(TEXT_FORMAT);
  out.push("```");
  out.push("");
  out.push("## Trigger script (compile_script, build_script)");
  out.push("A TypeScript subset. Read script_declarations once for this map's names (Units.*, Locations.*, Switches.*, Players.*, every condition and action as a function). Raw triggers are trigger(players, conditions, actions, flags?); any other top-level code (let, if, while, functions) is lowered to death-counter triggers. Every argument must be a compile-time constant; there is no Math and no arrays beyond literals.");
  out.push("```ts");
  out.push(SCRIPT_SHORT);
  out.push("```");
  return out.join("\n");
}

function tilesetLayer(p: ReferenceParts): string {
  const out: string[] = [];
  out.push(`# Reference: the ${p.tileset} tileset`);
  out.push("");
  out.push("## Terrains (paint_terrain ids; height 0 low, 1 mid, 2 high)");
  for (const t of p.terrains) out.push(`- ${t.id}: ${t.name} — height ${t.height}${t.buildable ? ", buildable" : ", not buildable"}`);
  if (p.ramps) out.push(`- Ramps the editor can fit (down south-west or south-east only): ${p.ramps.length ? p.ramps.map((r) => `${r.low} → ${r.high}`).join(", ") : "none"}`);
  if (p.bridges !== undefined) out.push(`- Bridges: ${p.bridges ? `the editor fits one over a diagonal channel of ${p.bridges.water} ${p.bridges.channel} tiles wide between ${p.bridges.ground} banks (a bridge shape in paint_shapes paints the channel and fits it)` : "none the editor can place on this tileset; a crossing is a gap of ground in the water"}`);
  out.push("- A shore or cliff between two terrains takes about three tiles either side of the boundary; water narrower than about ten tiles is all shore.");
  out.push("");
  out.push("## Doodad categories (scatter_doodads takes a category; place_doodads a name or id — the names are in reference \"doodads\")");
  out.push(p.doodadCategories.map((c) => `${c.name} (${c.doodads.length})`).join("; "));
  if (p.sprites.length) out.push(`- Pure sprites (place_sprites kind "pure"): ${p.sprites.map((g) => `${g.label} (${g.count})`).join(", ")}`);
  return out.join("\n");
}

function mapLayer(p: ReferenceParts): string {
  const out: string[] = [];
  out.push(`# Reference: "${p.mapName || "this map"}" — ${p.width} × ${p.height} tiles, tileset ${p.tileset}, ${p.versionLabel}`);
  out.push(`Description: ${p.description || "(none)"}`);
  out.push(`Players (${p.players.length}):`);
  for (const line of p.players) out.push(`  ${line}`);
  const renamed = p.units.filter((u) => u.customName);
  if (renamed.length) {
    out.push("Units this map renames (use either name):");
    for (const u of renamed) out.push(`  ${u.id}: ${u.name} is called "${u.customName}"`);
  }
  out.push(p.hasScript ? "This map has a trigger script: build_script replaces its block, so send the whole script back with your changes." : "This map has no trigger script yet.");
  return out.join("\n");
}

export type ReferencePart = "units" | "doodads" | "triggers";
export const REFERENCE_PARTS: readonly ReferencePart[] = ["units", "doodads", "triggers"];

/** One of the long tables, for the reference tool. */
export function buildReferenceDetail(p: ReferenceParts, part: ReferencePart): string {
  const out: string[] = [];
  switch (part) {
    case "units":
      out.push("## Units (id: name | race | size in tiles | kind | hp/shields/armor | minerals/gas | build frames | weapons). units.dat values; unit_type shows the map's own.");
      for (const u of p.units) {
        const kind = u.building ? "building" : u.flyer ? "flyer" : "ground";
        out.push(`${u.id}: ${u.name}${u.customName ? ` ("${u.customName}" here)` : ""} | ${u.race} | ${u.width}×${u.height} | ${kind} | ${u.hitPoints}/${u.shields}/${u.armor} | ${u.minerals}/${u.gas} | ${u.buildTime}${u.weapons ? ` | ${u.weapons}` : ""}`);
      }
      break;
    case "doodads":
      out.push(`## Doodads of the ${p.tileset} tileset (place_doodads takes a name or id; scatter_doodads takes a category)`);
      for (const c of p.doodadCategories) out.push(`- ${c.name} (${c.doodads.length}): ${c.doodads.map((d) => `${d.name} [${d.id}] ${d.width}×${d.height}`).join(", ")}`);
      break;
    case "triggers":
      out.push("## Trigger conditions (name(argument: kind, …))");
      for (const c of p.conditions) out.push(`- ${c.name}(${c.args.map((a) => `${a.label}: ${a.kind}`).join(", ")})`);
      out.push("");
      out.push("## Trigger actions");
      for (const a of p.actions) out.push(`- ${a.name}(${a.args.map((x) => `${x.label}: ${x.kind}`).join(", ")})`);
      out.push("");
      out.push("## Briefing actions");
      for (const a of p.briefingActions) out.push(`- ${a.name}(${a.args.map((x) => `${x.label}: ${x.kind}`).join(", ")})`);
      out.push("");
      out.push("## Argument values by kind");
      for (const c of p.choices) if (c.labels.length) out.push(`- ${c.kind}: ${c.labels.join(", ")}`);
      out.push("- unit: a unit name from the reference, or the groups Any unit, Men, Buildings, Factories");
      out.push("- location: a location name of this map (list_locations); switch: a switch name or \"Switch N\" (1-based); text / wav: a string; number / amount / count / duration / percent: an integer (duration in milliseconds, 1000 per second at Fastest is about 24 frames)");
      if (p.aiScripts.length) { out.push(""); out.push(`## AI scripts (Run AI Script): ${p.aiScripts.join("; ")}`); }
      break;
  }
  return out.join("\n");
}

/** The map layer's inputs, gathered fresh each turn: they are what an edit can change. */
function gatherMap(api: PluginApi): Pick<ReferenceParts, "mapName" | "description" | "width" | "height" | "versionLabel" | "players" | "hasScript"> & { renamed: { id: number; name: string; customName: string }[] } {
  const info = api.document.info();
  const starts = new Set(api.query.startLocations().map((s) => s.owner));
  const players = api.settings.players()
    .filter((p) => p.typeName !== "Inactive" && p.typeName !== "Unused")
    .map((p) => `${p.slot + 1}: ${p.typeName}, ${p.raceName}${p.force !== null ? `, force ${p.force + 1}${p.forceName ? ` "${p.forceName}"` : ""}` : ""}${starts.has(p.slot) ? ", has a start location" : ""}`);
  const renamed: { id: number; name: string; customName: string }[] = [];
  for (const t of api.settings.unitTypes()) if (t.customName) renamed.push({ id: t.id, name: t.name, customName: api.names.unit(t.id) });
  return {
    mapName: info?.name ?? "",
    description: info?.description ?? "",
    width: info?.width ?? 0,
    height: info?.height ?? 0,
    versionLabel: api.settings.version()?.label ?? "",
    players,
    hasScript: !!scriptBridge(api)?.state()?.source,
    renamed,
  };
}

const cache = new WeakMap<Scenario, { tileset: string; parts: ReferenceParts; layers: ReferenceLayers }>();

/**
 * The open map's parts and layers. The game and tileset layers are built once per
 * scenario object and tileset — nothing an edit does changes them; the map layer is
 * rebuilt every turn from what an edit can change (a rename, a player, a unit's custom
 * name) and replaced only when its text differs, so the server's cache of it holds
 * until the map really changed.
 */
function cached(api: PluginApi): { parts: ReferenceParts; layers: ReferenceLayers } | undefined {
  const scn = api.document.scenario();
  if (!scn) return undefined;
  const tileset = api.tileset.name();
  let hit = cache.get(scn);
  if (!hit || hit.tileset !== tileset) {
    const parts = gatherReference(api);
    hit = { tileset, parts, layers: buildReferenceLayers(parts) };
    cache.set(scn, hit);
    return hit;
  }
  const { renamed, ...fresh } = gatherMap(api);
  const units = hit.parts.units.map((u) => {
    const r = renamed.find((x) => x.id === u.id);
    if (r) return u.customName === r.customName ? u : { ...u, customName: r.customName };
    if (u.customName) { const { customName: _dropped, ...rest } = u; return rest; }
    return u;
  });
  const parts: ReferenceParts = { ...hit.parts, ...fresh, units };
  const map = mapLayer(parts);
  if (map !== hit.layers[2]) {
    hit.parts = parts;
    hit.layers = [hit.layers[0], hit.layers[1], map];
  }
  return hit;
}

/** The layers for the open map, for the request. */
export function referenceFor(api: PluginApi): ReferenceLayers | undefined {
  return cached(api)?.layers;
}

/** One of the long tables for the open map, for the reference tool. */
export function referenceDetailFor(api: PluginApi, part: ReferencePart): string | undefined {
  const c = cached(api);
  return c ? buildReferenceDetail(c.parts, part) : undefined;
}
