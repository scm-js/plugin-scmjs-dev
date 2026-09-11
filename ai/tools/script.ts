/** The trigger script, the view, the history and the selection. */
import { capResult, fail, ints, num, obj, plural, rectOf, str, TILE, type Tool } from "./common";
import { describeDiagnostic, NO_SCRIPT_PLUGIN, scriptBridge } from "../script";

export const DECLARATIONS_WINDOW = 60_000;

/** A window of a long text, whole when it fits, else with a first line saying where the rest starts. */
export function windowOf(text: string, offset: number, size: number): string {
  if (text.length <= size && offset === 0) return text;
  const slice = text.slice(offset, offset + size);
  const next = offset + slice.length;
  return `${text.length} characters in all; showing ${offset}–${next}${next < text.length ? `; ask again with offset=${next} for the rest` : ""}.\n\n${slice}`;
}

export function scriptTools(): Tool[] {
  return [
    {
      def: { name: "script_state", description: "The map's TrigScript: whether there is one, its files, whether the built block is intact.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => { const script = scriptBridge(api); if (!script) return fail(NO_SCRIPT_PLUGIN); const s = script.state(); return s ? capResult({ hasScript: !!s.files, stale: s.stale, unbuilt: s.unbuilt, block: s.block, files: s.files }, 60_000) : "No map is open."; },
    },
    {
      def: { name: "script_declarations", description: "TrigScript's declarations for this map (a .d.ts): the library, every unit, location, switch and player by name, every condition and action as a function. Long; read once before writing a script. Comes in windows of 60,000 characters: the first line says where to ask again with `offset` for the rest.", inputSchema: obj({ offset: { type: "integer", description: "the character to start at; the previous window's answer says which" } }) },
      writes: false,
      run: (input, { api }) => { const script = scriptBridge(api); if (!script) return fail(NO_SCRIPT_PLUGIN); return windowOf(script.declarations({ compact: true }), Math.max(0, Math.round(num(input.offset))), DECLARATIONS_WINDOW); },
    },
    {
      def: { name: "compile_script", description: "Check a TrigScript (ordinary TypeScript that runs to record triggers; read script_declarations first) without building it: type-check it, run it, lower its programs. Returns diagnostics or the trigger count. `source` is main.ts; the map's other script files stay as they are.", inputSchema: obj({ source: { type: "string" } }, ["source"]) },
      describe: (input) => `Type-check the script (${plural(str(input.source).split("\n").length, "line")})`,
      writes: false,
      run: async (input, { api }) => {
        const script = scriptBridge(api);
        if (!script) return fail(NO_SCRIPT_PLUGIN);
        const r = await script.compile(str(input.source));
        return r.ok ? `Compiles: ${r.triggers.length} triggers${r.programs.length ? `, ${r.programs.length === 1 ? "a program" : `${r.programs.length} programs`} of ${r.programs.reduce((n, p) => n + p.count, 0)}` : ""}.` : fail(capResult({ errors: r.diagnostics.map(describeDiagnostic) }));
      },
    },
    {
      def: { name: "build_script", description: "Run a TrigScript and, when it is clean, build it into the map (replacing the script's previous block; `takeOver` replaces every trigger — ask first). Stores the source with the map as main.ts. Not undoable.", inputSchema: obj({ source: { type: "string" }, takeOver: { type: "boolean" } }, ["source"]) },
      describe: (input) => `Build the script (${plural(str(input.source).split("\n").length, "line")})${input.takeOver === true ? ", replacing every trigger" : ""}`,
      writes: true,
      settings: true,
      run: async (input, { api }) => {
        const script = scriptBridge(api);
        if (!script) return fail(NO_SCRIPT_PLUGIN);
        const r = await script.build(str(input.source), { takeOver: input.takeOver === true });
        return r.block ? `Built ${r.block.count} triggers at #${r.block.start + 1}.` : fail(capResult({ errors: r.compiled.diagnostics.map(describeDiagnostic) }));
      },
    },
    {
      def: { name: "undo", description: "Undo the last change (yours or the user's). Returns what was undone.", inputSchema: obj({}) },
      writes: true,
      run: (_i, { api }) => { const label = api.document.undo(); return label ? `Undid: ${label}.` : "Nothing to undo."; },
    },
    {
      def: { name: "redo", description: "Redo the last undone change. Returns what was redone.", inputSchema: obj({}) },
      writes: true,
      run: (_i, { api }) => { const label = api.document.redo(); return label ? `Redid: ${label}.` : "Nothing to redo."; },
    },
    {
      def: { name: "go_to", description: "Scroll the user's view to a tile, or to a unit / location by index.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" }, unit: { type: "integer" }, location: { type: "integer" } }) },
      describe: (input) => input.unit !== undefined ? `Go to unit #${num(input.unit)}` : input.location !== undefined ? `Go to location #${num(input.location)}` : `Go to ${num(input.x)},${num(input.y)}`,
      writes: false,
      run: (input, { api }) => {
        if (input.unit !== undefined) api.view.goTo({ kind: "unit", index: Math.round(num(input.unit)) });
        else if (input.location !== undefined) api.view.goTo({ kind: "location", index: Math.round(num(input.location)) });
        else api.view.goTo({ kind: "tile", x: Math.round(num(input.x)), y: Math.round(num(input.y)) });
        return "Done.";
      },
    },
    {
      def: { name: "select", description: "Show the user something: select units, sprites, doodads or locations by index (switching to that layer), or mark a tile rect. Pass an empty list to clear.", inputSchema: obj({ units: { type: "array", items: { type: "integer" } }, sprites: { type: "array", items: { type: "integer" } }, doodads: { type: "array", items: { type: "integer" } }, locations: { type: "array", items: { type: "integer" } }, x0: { type: "integer" }, y0: { type: "integer" }, x1: { type: "integer" }, y1: { type: "integer" } }) },
      describe: (input) => { const parts = (["units", "sprites", "doodads", "locations"] as const).filter((k) => Array.isArray(input[k])).map((k) => `${ints(input[k]).length} ${k}`); if (input.x0 !== undefined && input.x1 !== undefined) parts.push(`the area ${num(input.x0)},${num(input.y0)}–${num(input.x1)},${num(input.y1)}`); return parts.length ? `Select ${parts.join(", ")}` : "Clear the selection"; },
      writes: false,
      run: (input, { api }) => {
        const done: string[] = [];
        if (Array.isArray(input.units)) { api.selection.setLayer("units"); api.selection.setUnits(ints(input.units)); done.push(`${ints(input.units).length} units`); }
        if (Array.isArray(input.sprites)) { api.selection.setLayer("sprites"); api.selection.setSprites(ints(input.sprites)); done.push(`${ints(input.sprites).length} sprites`); }
        if (Array.isArray(input.doodads)) { api.selection.setLayer("doodads"); api.selection.setDoodads(ints(input.doodads)); done.push(`${ints(input.doodads).length} doodads`); }
        if (Array.isArray(input.locations)) { api.selection.setLayer("locations"); api.selection.setLocations(ints(input.locations)); done.push(`${ints(input.locations).length} locations`); }
        if (input.x0 !== undefined && input.x1 !== undefined) { const r = rectOf(input, api); api.selection.markArea(r); api.view.center((r.x0 + r.x1) / 2 * TILE, (r.y0 + r.y1) / 2 * TILE); done.push(`area ${r.x0},${r.y0}–${r.x1},${r.y1}`); }
        return done.length ? `Selected ${done.join(", ")}.` : "Nothing to select.";
      },
    },
  ];
}
