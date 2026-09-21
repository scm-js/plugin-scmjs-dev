/**
 * Tools ▸ AI ▸ Make Scenario…: "a madness map", "an RPG about a marine lost on a Zerg
 * world" — a whole scenario from a sentence, in steps the person can see and stop:
 *
 * 1. **Design.** The `ums-design` recipe writes the design document — genre, premise,
 *    players and forces, the trigger systems (by toolkit kind), the layout brief, the
 *    objectives and the briefing — once, at high effort, with the genre guide and the
 *    toolkit's catalogue in front of it. The document is shown and can be edited.
 * 2. **Build**, step by step, each step a row that runs, passes or fails on its own: the
 *    map (new or the open one); the terrain and the named locations through `map-plan`
 *    and the plan renderer; players and forces; every system — the toolkit's kinds
 *    instantly, `custom` ones through the `triggers` recipe with the compile loop; the
 *    objectives and the briefing; the name; Check Map.
 * 3. Review it, or hand it to the assistant to iterate.
 *
 * The model's effort is spent where it counts (the design, the layout, the custom
 * triggers) and the mechanics every scenario shares come from code, so a build is a few
 * calls rather than a long conversation — and what it did is a list, not a transcript.
 */
import type { TilesetId } from "@scm-js/plugin-api";
import { MAP_PLAN_PROMPT_MAX, type DesignSystem, type MapPlan, type MapPlanInput, type RecipeOptions, type UmsDesign, type UmsDesignInput } from "../../protocol";
import { doodadCategoryNames, terrainVocab, unitIdByName, unitNames } from "../facts";
import { guideFor } from "../guides";
import { START_LOCATION, TILE, centreOf } from "../layout";
import { buildPreset, presetSpecs, PresetError } from "../presets";
import { bridgePairOf, rampPairsOf } from "../ramps";
import { renderPlan, summarizeRender } from "../render";
import { existingTriggersFor, handTriggers, hasScriptPlugin, repairDiagnostic, scriptBridge, type CompileResult } from "../script";
import { budgetText, buildOutcome, counterBudget, designTempo, keeperFor, outcomeText, systemsToBuild, type BuildOutcome } from "../scenarioBuild";
import { toolkitContext, addSystem, hasPrograms } from "../tools/ums";
import { paramsOf, systemKinds, ToolkitError, waitingOn } from "../ums";
import { chips, h, ledgerLine, noteList, Runner, runRecipe, styled, textarea, type Ctx, taskFor } from "../ui";
import { openReview } from "./review";

const SIZES = [64, 96, 128, 160, 192, 256];
const TILESETS: { id: string; label: string }[] = [
  { id: "badlands", label: "Badlands" }, { id: "platform", label: "Space Platform" }, { id: "install", label: "Installation" }, { id: "ashworld", label: "Ashworld" },
  { id: "jungle", label: "Jungle" }, { id: "desert", label: "Desert" }, { id: "ice", label: "Ice" }, { id: "twilight", label: "Twilight" },
];
const EXAMPLES: Record<string, string> = {
  "a madness map": "A four-player madness map: each player in a walled corner base, zerglings and marines spawning every few seconds and charging the centre, kills paid in minerals, last base standing wins.",
  "an RPG": "An RPG about a marine lost on a Zerg world: a town with a shop and a healer, three regions of rising danger joined by narrow paths, a brood mother at the end. Two players, permadeath off.",
  "a tower defense": "A two-lane tower defense for up to four players: waves walk from the north spawns down the lanes to the goal at the south; players build turrets beside the lanes; twenty waves, shared lives.",
};
const REPAIR_ROUNDS = 2;

type StepState = "pending" | "running" | "done" | "failed" | "skipped";

interface Step {
  label: string;
  /** Shown beside the row while it runs, for a step that takes a while. */
  hint?: string;
  /** Everything after it builds on it: when it fails the rest is not run. */
  vital?: boolean;
  run: () => Promise<string>;
}

/** The build was stopped, or the map in front is no longer the one it was building: thrown between the awaits of a step, caught by the build's loop. */
class BuildEnded extends Error {
  readonly reason: "stopped" | "map";
  constructor(reason: "stopped" | "map") {
    super(reason === "map" ? "the map in front changed, so the build stopped" : "stopped");
    this.reason = reason;
  }
}

/** A system step that cannot build yet: the locations it names are not on the map. Not a failure — it waits. */
class Waiting extends Error {
  readonly locations: string[];
  constructor(locations: string[]) {
    super(`waits for location${locations.length === 1 ? "" : "s"} ${locations.map((l) => `"${l}"`).join(", ")}`);
    this.locations = locations;
  }
}

/** The effort the terrain step asks for: the plan is a coarse grid, so the standard quality runs it at medium rather than the server's high, which spent minutes reasoning on a 32×32 grid. */
export function terrainEffort(quality: string): "low" | "medium" | "high" | undefined {
  return quality === "quick" ? "low" : quality === "thorough" ? "high" : "medium";
}

/**
 * The `map-plan` prompt a design's layout brief becomes: the brief, then every location
 * the systems need, then the scenario rule. Kept under the server's cap: the location
 * purposes go first, the brief's tail last, and only when it would not fit otherwise.
 */
export function layoutPrompt(design: UmsDesign, limit = MAP_PLAN_PROMPT_MAX): string {
  const humans = design.players.filter((p) => p.type === "human");
  const rule = `This is a scenario (UMS), genre ${design.genre}: follow the brief rather than the melee rules. ${humans.length} human player${humans.length === 1 ? "" : "s"} (${humans.map((p) => `player ${p.slot}`).join(", ")}), each needing a start location where the brief puts it; no mining bases unless the brief asks for them.`;
  const assemble = (brief: string, purposes: boolean) => {
    const lines = [brief, ""];
    if (design.locations.length) {
      lines.push("Locations to create, by name (the triggers refer to them — every one must be in the plan's `locations`):");
      for (const l of design.locations) lines.push(purposes ? `- ${l.name}: ${l.purpose}` : `- ${l.name}`);
      lines.push("");
    }
    lines.push(rule);
    return lines.join("\n");
  };
  const brief = design.layoutBrief.trim();
  let text = assemble(brief, true);
  if (text.length > limit) text = assemble(brief, false);
  if (text.length > limit) text = assemble(brief.slice(0, Math.max(0, brief.length - (text.length - limit) - 1)) + "…", false);
  return text;
}

/** `key=value; key=value` for the editable field, and back. */
export function paramsToText(params: { key: string; value: string }[]): string {
  return params.map((p) => `${p.key}=${p.value}`).join("; ");
}
export function textToParams(text: string): { key: string; value: string }[] {
  return text.split(";").map((s) => s.trim()).filter(Boolean).map((s) => { const at = s.indexOf("="); return at < 0 ? { key: s, value: "" } : { key: s.slice(0, at).trim(), value: s.slice(at + 1).trim() }; });
}

export function openScenario(ctx: Ctx, presetPrompt?: string) {
  const { api } = ctx;
  const w = api.ui.widgets;
  const info = api.document.info();
  const state = {
    prompt: presetPrompt ?? "",
    width: info?.width ?? 128,
    height: info?.height ?? 128,
    tileset: (info?.tileset as string | undefined) ?? "jungle",
    players: 4,
    target: (info ? "open" : "new") as "new" | "open",
    design: null as UmsDesign | null,
    refine: "",
    /** What the last build of this design came to; null before one, and again after a new design. */
    built: null as BuildOutcome | null,
  };

  api.ui.dialog({
    title: "Make Scenario",
    size: "lg",
    tall: true,
    mount(body, dialog) {
      const root = styled(body);
      const runner = new Runner(ctx);
      // Open while there is nothing else; a line once a design exists, so the design is what the dialog shows.
      const askSummary = h("summary", null, "What to make");
      const askBox = h("details", { className: "ai-fold", open: true }, askSummary);
      const foldAsk = () => {
        const tileset = TILESETS.find((t) => t.id === state.tileset)?.label ?? state.tileset;
        const excerpt = state.prompt.trim().replace(/\s+/g, " ");
        askSummary.textContent = `What to make: ${excerpt.length > 90 ? `${excerpt.slice(0, 87)}…` : excerpt} · ${state.width}×${state.height} ${tileset} · ${state.players} player${state.players === 1 ? "" : "s"}`;
        askBox.open = false;
      };

      /* ── 1. what to make ── */
      const promptField = textarea({ value: state.prompt, placeholder: "What kind of scenario? A genre and a sentence of story is enough: \"a madness map\", \"an RPG about a lost marine\", \"a four-player tower defense with two lanes\".", rows: 3 });
      promptField.addEventListener("input", () => { state.prompt = promptField.value; });
      const widthSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.width, onChange: (v) => { state.width = Number(v); syncTarget(); } });
      const heightSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.height, onChange: (v) => { state.height = Number(v); syncTarget(); } });
      const tilesetSel = w.select(TILESETS.map((t) => ({ value: t.id, label: t.label })), { value: state.tileset, onChange: (v) => { state.tileset = v; syncTarget(); } });
      const playersSel = w.select([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) })), { value: state.players, onChange: (v) => { state.players = Number(v); } });
      const targetSel = w.select([{ value: "new", label: "A new map" }, { value: "open", label: "The open map" }], { value: state.target, onChange: (v) => { state.target = v as "new" | "open"; } });
      const targetHint = h("div", { className: "ai-hint" });
      const syncTarget = () => {
        const cur = api.document.info();
        const same = !!cur && cur.width === state.width && cur.height === state.height && cur.tileset === state.tileset;
        (targetSel.options[1] as HTMLOptionElement).disabled = !same;
        if (!same && state.target === "open") { state.target = "new"; targetSel.value = "new"; }
        targetHint.textContent = same
          ? "Into the open map: its terrain and objects are replaced by the plan, and the triggers are appended to what is there."
          : "A new blank map of this size and tileset is made first. An open map with unsaved changes asks before it goes.";
      };
      syncTarget();
      const designButton = w.button("Design", { primary: true, onClick: () => void design(false) });
      const scriptNote = h("div", { className: "ai-hint" }, hasScriptPlugin(api) ? "The TrigScript plugin is on: systems the toolkit cannot build are written as scripts." : "The Trigger Script plugin is off: the design will use only the toolkit's systems (hyper triggers, spawns, kill-to-cash, waves, lives, shops, …). Turn it on under Plugins ▸ Manage Plugins… for custom mechanics.");

      /* ── 2. the design ── */
      const designBody = h("div", { className: "ai-body" });
      const designSummary = h("summary", null, "The design");
      const designBox = h("details", { className: "ai-fold", hidden: true, open: true }, designSummary, designBody);
      const refineField = textarea({ placeholder: "What should change in the design? (\"make it two players\", \"add a boss\", \"less income\")", rows: 2 });
      refineField.addEventListener("input", () => { state.refine = refineField.value; });
      const redesignButton = w.button("Design again", { onClick: () => void design(true) });
      const buildButton = w.button("Build", { primary: true, onClick: () => void build() });

      const showDesign = (d: UmsDesign) => {
        designBody.replaceChildren();
        designSummary.textContent = `${d.genre}: ${d.name} — ${d.systems.length} systems, ${d.locations.length} locations, ${d.players.filter((p) => p.type === "human").length} human players${d.target === "remastered" ? ", for Remastered" : ""}`;
        designBox.open = true;
        const nameField = w.text({ value: d.name, onChange: (v) => { d.name = v; } });
        const descField = textarea({ value: d.description, rows: 2 });
        descField.addEventListener("input", () => { d.description = descField.value; });
        const briefField = textarea({ value: d.layoutBrief, rows: Math.min(18, Math.max(6, Math.ceil(d.layoutBrief.length / 100))) });
        briefField.addEventListener("input", () => { d.layoutBrief = briefField.value; });
        const objectivesField = textarea({ value: d.objectives, rows: 3 });
        objectivesField.addEventListener("input", () => { d.objectives = objectivesField.value; });
        const briefingField = textarea({ value: d.briefing.join("\n"), rows: 4 });
        briefingField.addEventListener("input", () => { d.briefing = briefingField.value.split("\n").map((s) => s.trim()).filter(Boolean); });
        // What the map is for is settled here, before a trigger exists: every timer the toolkit builds is counted by it.
        const targetField = w.select([{ value: "classic", label: "Every version of StarCraft (triggers only)" }, { value: "remastered", label: "StarCraft: Remastered (scripts may be programs)" }], { value: d.target ?? "classic", onChange: (v) => { d.target = v as UmsDesign["target"]; showDesign(d); } });
        (targetField.options[1] as HTMLOptionElement).disabled = !hasScriptPlugin(api);
        const tempo = designTempo(d);
        const targetHint = h("div", { className: "ai-hint" }, d.target === "remastered"
          ? `The saved map is built by eudplib and needs Remastered. Every trigger runs each frame, so timers are counted at about 24 cycles a second${d.systems.some((x) => x.kind === "hyper") ? " and the hyper triggers in the list are left out" : ""}.`
          : tempo === "hyper" ? "Triggers only. The design has hyper triggers, so timers are counted at about 12 cycles a second." : "Triggers only, and no hyper triggers: the trigger list runs about every two seconds, and no timer is finer than that.");
        const players = noteList(d.players.map((p) => `Player ${p.slot}: ${p.type}, ${p.race}, force ${p.force} — ${p.role}`));
        const forces = noteList(d.forces.map((f) => `Force ${f.index} "${f.name}"${f.allied ? ", allied" : ""}${f.alliedVictory ? ", allied victory" : ""}${f.sharedVision ? ", shared vision" : ""}`));
        const locations = noteList(d.locations.map((l) => `${l.name} — ${l.purpose}`));
        // The dialog body is the one scroller: a capped list inside it swallows the wheel with thirty systems.
        const systemRows = h("div", { className: "ai-list ai-list-open" });
        const kinds = new Set(systemKinds().map((k) => k.kind));
        d.systems.forEach((s, i) => {
          const params = w.text({ value: paramsToText(s.params), placeholder: "key=value; key=value", onChange: (v) => { s.params = textToParams(v); } });
          const remove = w.button("Remove", { ghost: true, onClick: () => { d.systems.splice(i, 1); showDesign(d); } });
          systemRows.append(h("div", { className: "ai-item" },
            h("span", { className: kinds.has(s.kind) ? "ai-ok" : s.kind === "custom" ? "ai-gold" : "ai-bad", style: "width: 96px; flex: none;", title: kinds.has(s.kind) ? "built by the toolkit" : s.kind === "custom" ? "written as a trigger script" : "not a kind the toolkit has" }, s.kind),
            h("div", { className: "ai-grow" }, h("div", null, s.name), h("div", { className: "ai-dim" }, s.description), s.kind === "custom" ? null : params),
            remove,
          ));
        });
        const parts: (HTMLElement | null)[] = [
          // Build and the change fold first: they are what the person came back to press, and the document is long.
          h("div", { className: "ai-btns" }, buildButton, h("span", { className: "ai-hint" }, "Builds the map from this design: the terrain first (that is the long step), then the players, the systems, the text.")),
          h("details", null, h("summary", null, "Change the design first"), h("div", { className: "ai-body" }, refineField, h("div", { className: "ai-btns" }, redesignButton))),
          w.group(`${d.genre}: ${d.name}`,
            w.form([{ label: "Name", field: nameField }, { label: "Description", field: descField }, { label: "Plays on", field: targetField }]),
            targetHint,
            h("div", { className: "ai-hint" }, d.premise),
          ),
          w.group("Players and forces", players, forces),
          w.group(`Systems (${d.systems.length})`, systemRows, h("div", { className: "ai-hint" }, "Green: the toolkit builds it from the parameters. Gold: written as a trigger script from the description. Edit the parameters here; a location or unit by name, numbers as digits.")),
          w.group(`Layout brief and ${d.locations.length} locations`, briefField, h("details", null, h("summary", null, "Locations the brief must place"), h("div", { className: "ai-body" }, locations))),
          w.group("Objectives and briefing", objectivesField, briefingField),
          d.notes.length ? h("details", null, h("summary", null, "Designer's notes"), h("div", { className: "ai-body" }, noteList(d.notes))) : null,
        ];
        for (const part of parts) if (part) designBody.append(part);
        designBox.hidden = false;
        foldAsk();
      };

      /* ── 3. building ── */
      const stepsBox = w.steps();
      stepsBox.hidden = true;
      // Stops the whole build, not the one call the runner's own Stop would: the steps left are not run, what was built stays.
      const stopButton = w.button("Stop the build", { onClick: () => { building?.abort.abort(); runner.abort(); } });
      stopButton.hidden = true;
      const afterBox = h("div", { className: "ai-btns", hidden: true });
      const findingsBox = h("div", null);
      const addStep = (label: string) => {
        const row = stepsBox.add(label);
        return {
          set(s: StepState, text = "") {
            if (s === "running") row.start(text);
            else if (s === "done") row.done(text);
            else if (s === "failed") row.fail(text);
            else if (s === "skipped") row.skip(text);
            else row.detail(text);
          },
          detail(text: string) { row.detail(text); },
        };
      };

      const ensureMap = async (): Promise<boolean> => {
        if (state.target === "open" && api.document.isOpen()) return true;
        const ok = await api.document.create({ width: state.width, height: state.height, tileset: state.tileset as TilesetId, name: "Untitled Scenario" });
        if (!ok) { runner.idle("Kept the open map."); return false; }
        state.target = "open";
        targetSel.value = "open";
        syncTarget();
        return true;
      };

      const design = async (refine: boolean) => {
        if (!state.prompt.trim()) { promptField.focus(); runner.idle("Say what kind of scenario you want first."); return; }
        // A second press while the first is being prepared would ask twice and pay twice.
        if (runner.busy || designButton.disabled) return;
        designButton.setBusy(true);
        redesignButton.setBusy(true);
        if (!(await ensureMap())) { designButton.setBusy(false); redesignButton.setBusy(false); return; }
        await api.tileset.load();
        const prompt = refine && state.refine.trim() && state.design
          ? `${state.prompt}\n\nThe previous design was:\n${JSON.stringify(state.design)}\n\nChange this: ${state.refine.trim()}`
          : state.prompt;
        const input: UmsDesignInput = {
          prompt,
          width: api.document.info()!.width,
          height: api.document.info()!.height,
          tileset: api.document.info()!.tileset,
          players: state.players,
          terrains: terrainVocab(api),
          unitNames: unitNames(api),
          systemKinds: systemKinds(),
          scriptPlugin: hasScriptPlugin(api),
          guide: guideFor(state.prompt)?.text,
          presets: presetSpecs(),
        };
        designBox.before(runner.el);
        try {
          const r = await runRecipe(ctx, runner, "ums-design", input, { label: refine ? "Changing the design" : "Designing the scenario", task: taskFor("design", ctx.settings().scenarioCeilingUsd) });
          if (!r) return;
          state.design = r.output;
          state.built = null;
          stepsBox.hidden = true;
          afterBox.hidden = true;
          findingsBox.replaceChildren();
          showDesign(r.output);
          designBox.scrollIntoView({ block: "nearest" });
        } finally {
          designButton.setBusy(false);
          redesignButton.setBusy(false);
        }
      };

      /** Write one custom system as a trigger script: the recipe, the compile loop, the build (extending the map's script). */
      let buildTask: RecipeOptions["task"] | undefined;
      /** The build in progress: the map it is for, and its Stop. A build writes for minutes, and only ever into the map it began on. */
      let building: { doc: number | null; abort: AbortController } | null = null;
      const checkBuild = () => {
        if (!building) return;
        if (building.abort.signal.aborted) throw new BuildEnded("stopped");
        if (api.document.id() !== building.doc) throw new BuildEnded("map");
      };
      const writeCustom = async (system: DesignSystem, d: UmsDesign): Promise<string> => {
        const bridge = scriptBridge(api);
        if (!bridge) throw new Error("the TrigScript plugin is off");
        const existing = bridge.state();
        const classic = d.target !== "remastered";
        const rate = classic
          ? `This map is for every version of StarCraft: write triggers only (level 1) — no program(), which would make the map need Remastered. Hyper triggers ${designTempo(d) === "hyper" ? "are on the map, so the trigger list runs about twelve times a second" : "are not on the map, so the trigger list runs about every two seconds"}.`
          : "This map is for StarCraft: Remastered: write this system as a program() (or several). Every trigger on the map runs each frame and there are no hyper triggers.";
        const prompt = `System "${system.name}" of the scenario "${d.name}" (${d.genre}). ${system.description}\n\nThe scenario's premise: ${d.premise}\nLocations on the map: ${d.locations.map((l) => `${l.name} (${l.purpose})`).join("; ")}.\n${rate} Write only this system; the other systems already exist as ordinary triggers.`;
        // The declarations and the hand triggers as the model needs them — a third of what the compiler sees.
        const input = { prompt, declarations: bridge.declarations({ compact: true }), script: existing?.source ?? undefined, existingTriggers: existingTriggersFor(api, handTriggers(api, existing?.block)) };
        // After every wait: Stop, or another map brought to the front, ends the build before anything more is asked for or written.
        let r = await runRecipe(ctx, runner, "triggers", input, { task: buildTask });
        checkBuild();
        if (!r) throw new Error(runner.lastError ?? "the model did not answer");
        let script = r.output.script;
        let compiled: CompileResult = await bridge.compile(script);
        checkBuild();
        // A program on a classic map is an error of the same standing as one the compiler finds: the toolkit's timers were counted for a map without one.
        const faults = (c: CompileResult) => (c.ok && classic && c.programs.length > 0
          ? [{ line: c.programs[0].source.line, column: 1, message: `this map is for every version of StarCraft, and a program() makes it need Remastered and runs every trigger each frame: write the system with trigger() alone (${c.programs.length} program${c.programs.length === 1 ? "" : "s"} found)` }]
          : c.diagnostics.map(repairDiagnostic));
        const bad = (c: CompileResult) => !c.ok || (classic && c.programs.length > 0);
        for (let round = 0; bad(compiled) && round < REPAIR_ROUNDS; round++) {
          r = await runRecipe(ctx, runner, "triggers", { ...input, repair: { script, diagnostics: faults(compiled) } }, { task: buildTask });
          checkBuild();
          if (!r) throw new Error("the model did not answer the repair");
          script = r.output.script;
          compiled = await bridge.compile(script);
          checkBuild();
        }
        if (!compiled.ok) throw new Error(`the script has ${compiled.diagnostics.length} error${compiled.diagnostics.length === 1 ? "" : "s"} after ${REPAIR_ROUNDS} repairs; open TrigScript to fix it`);
        if (classic && compiled.programs.length > 0) throw new Error(`the script still uses program() after ${REPAIR_ROUNDS} repairs, which this map (for every version of StarCraft) cannot have; change the design to Remastered, or open TrigScript to rewrite it`);
        const built = await bridge.build(script, {});
        if (!built.block) throw new Error("the build failed");
        return `${built.block.count} triggers from a script: ${r.output.summary}`;
      };

      const build = async () => {
        const d = state.design;
        if (!d || !(await ensureMap())) return;
        await api.tileset.load();
        // One build is one task under the ceiling: the terrain plan, its repair and every custom system's script share it.
        buildTask = taskFor("build", ctx.settings().scenarioCeilingUsd);
        buildButton.setBusy(true);
        redesignButton.setBusy(true);
        stepsBox.replaceChildren();
        stepsBox.hidden = false;
        afterBox.hidden = true;
        findingsBox.replaceChildren();
        // The design folds away and the progress sits together: the rows, then the clock and the reasoning under them.
        designBox.open = false;
        stepsBox.after(runner.el);
        const findings: string[] = [];
        const cur = api.document.info()!;
        const humans = d.players.filter((p) => p.type === "human").map((p) => p.slot);
        // The design's, not the map's: a Remastered design's timers are right although its programs are written after them.
        const tempo = designTempo(d);
        const locationNames = d.locations.map((l) => l.name);
        const kinds = new Set(systemKinds().map((k) => k.kind));
        const { systems: toBuild, dropped } = systemsToBuild(d);
        for (const s of dropped) findings.push(`${s.name}: left out — on a Remastered map every trigger already runs each frame`);
        // From here on the build belongs to this map: Stop ends it, and so does another map coming to the front.
        building = { doc: api.document.id(), abort: new AbortController() };
        stopButton.hidden = false;

        const steps: Step[] = [];
        steps.push({
          label: "Death counters and switches",
          vital: true,
          run: async () => {
            const budget = counterBudget(d, toolkitContext(api, { tempo, extraLocations: locationNames }));
            if (!budget.ok) throw new Error(budgetText(budget));
            return budgetText(budget);
          },
        });
        const preset = d.layout?.preset ? d.layout : null;
        steps.push({
          label: preset ? `Terrain and locations (${preset.preset} preset)` : "Terrain and locations",
          hint: preset ? "" : "scmjs.dev plans the layout; this takes a few minutes",
          vital: true,
          run: async () => {
            // A preset lays the terrain out here, in a second; only a layout no preset describes goes to the planner.
            let plan: MapPlan;
            if (preset) {
              try {
                const built = buildPreset(preset.preset, Object.fromEntries(preset.params.map((p) => [p.key, p.value])), { width: cur.width, height: cur.height, terrains: terrainVocab(api), rampPairs: rampPairsOf(api), bridgePair: bridgePairOf(api), humans, doodadCategories: doodadCategoryNames(api) });
                plan = { ...built.plan, name: d.name, description: d.description };
                findings.push(...built.notes.map((n) => `${preset.preset}: ${n}`));
              } catch (err) {
                if (err instanceof PresetError) throw new Error(err.problems.join("; "));
                throw err;
              }
            } else {
              plan = await planTerrain();
              checkBuild();
            }
            const rendered = renderPlan(api, plan, { originX: 0, originY: 0, label: `AI: ${d.name} terrain`, clearArea: true });
            if (!rendered) throw new Error("the plan could not be rendered");
            findings.push(...rendered.findings.filter((f) => !f.startsWith("Check Map:")));
            noteMissingLocations();
            return summarizeRender(rendered);
          },
        });
        /** The planner's terrain for a layout no preset describes. */
        const planTerrain = async (): Promise<MapPlan> => {
            const input: MapPlanInput = {
              prompt: layoutPrompt(d), width: cur.width, height: cur.height, tileset: cur.tileset,
              terrains: terrainVocab(api), doodadCategories: doodadCategoryNames(api), unitNames: unitNames(api),
              players: Math.max(1, humans.length), symmetry: "none", cellSize: 1,
              // The shape language: statements the plugin compiles, with the ramps the tileset really has.
              language: "shapes", rampPairs: rampPairsOf(api), bridgePair: bridgePairOf(api) ?? undefined,
            };
            const r = await runRecipe(ctx, runner, "map-plan", input, { label: "Planning the terrain", effort: terrainEffort(ctx.settings().quality), task: buildTask });
            if (!r) throw new Error(runner.lastError ?? "no plan came back");
            return r.output;
        };
        /** The design's locations that are not on the map. A system that names one waits rather than building against a box at the centre, where a goal or a spawn would spoil the game. */
        const missingLocations = () => {
            const have = new Set(api.document.scenario()!.locations.map((_, i) => api.names.location(i).toLowerCase()));
            return locationNames.filter((n) => !have.has(n.toLowerCase()));
        };
        const noteMissingLocations = () => {
            const missing = missingLocations();
            if (missing.length) findings.push(`${missing.length} location${missing.length === 1 ? "" : "s"} the plan did not place: ${missing.join(", ")}. The systems that need them wait; draw the locations (Layers ▸ Locations), then build the waiting systems below.`);
        };
        steps.push({
          label: "Players and forces",
          run: async () => {
            const typeOf = (label: string) => api.names.playerTypes().find((t) => t.label.toLowerCase() === label)?.value;
            const raceOf = (label: string) => api.names.races().find((r) => r.label.toLowerCase() === label)?.value;
            const races: Record<string, string> = { terran: "terran", zerg: "zerg", protoss: "protoss", random: "random", userSelect: "user selectable" };
            let changed = 0;
            api.document.update("AI: players and forces", (tx) => {
              for (let slot = 0; slot < 8; slot++) {
                const p = d.players.find((x) => x.slot === slot + 1);
                if (!p) { if (tx.players.set(slot, { type: typeOf("inactive") ?? 0 })) changed++; continue; }
                if (tx.players.set(slot, { type: typeOf(p.type) ?? 6, race: raceOf(races[p.race] ?? p.race) ?? 5, force: Math.max(0, Math.min(3, p.force - 1)) })) changed++;
              }
              for (const f of d.forces) {
                if (tx.forces.set(f.index - 1, { name: f.name, allied: f.allied, alliedVictory: f.alliedVictory, sharedVision: f.sharedVision })) changed++;
              }
            });
            // Every human needs a start location; one the plan did not place goes at a location named for the player, else spread near the centre.
            const starts = new Set(api.query.startLocations().map((s) => s.owner + 1));
            const missing = humans.filter((p) => !starts.has(p));
            if (missing.length) {
              const scn = api.document.scenario()!;
              api.document.edit("AI: start locations", (tx) => {
                missing.forEach((p, i) => {
                  const named = scn.locations.findIndex((l, li) => new RegExp(`\\b(start|spawn|base|home)\\s*${p}\\b`, "i").test(api.names.location(li)) && (l.left !== l.right));
                  const loc = named >= 0 ? scn.locations[named] : null;
                  const c = loc ? centreOf({ x: Math.floor(Math.min(loc.left, loc.right) / TILE), y: Math.floor(Math.min(loc.top, loc.bottom) / TILE), w: Math.max(1, Math.round(Math.abs(loc.right - loc.left) / TILE)), h: Math.max(1, Math.round(Math.abs(loc.bottom - loc.top) / TILE)) }) : { x: (Math.floor(cur.width / 2) + (i - missing.length / 2) * 6) * TILE, y: Math.floor(cur.height / 2) * TILE };
                  tx.placeUnit(START_LOCATION, p - 1, c.x, c.y);
                });
              });
              findings.push(`start locations for player${missing.length === 1 ? "" : "s"} ${missing.join(", ")} were placed by the editor; check where`);
            }
            // A player who owns nothing when the game starts is defeated on the spot, and a defeated player's triggers
            // never run — so a computer that only spawns things gets a keeper: one flier in the map's corner, out of the way.
            // It is a flier no system of the design names: a wave's victory counts the wave's types, and must not count this.
            const keepers: number[] = [];
            const keeperName = keeperFor(d);
            const keeper = keeperName === null ? null : unitIdByName(api, keeperName);
            const owned = new Set(api.document.scenario()!.units.map((u) => u.owner));
            for (const p of d.players.filter((x) => x.type === "computer")) {
              if (owned.has(p.slot - 1) || keeper === null) continue;
              api.document.edit(`AI: keeper for player ${p.slot}`, (tx) => {
                const px = (cur.width - 2) * TILE, py = (2 + keepers.length * 2) * TILE;
                tx.placeUnit(keeper, p.slot - 1, px, py);
              });
              keepers.push(p.slot);
            }
            if (keepers.length) findings.push(`player${keepers.length === 1 ? "" : "s"} ${keepers.join(", ")} (computer) owned nothing, which would defeat them at once and stop their triggers: a ${keeperName} in the top-right corner keeps them in the game`);
            return `${changed} setting${changed === 1 ? "" : "s"} written, ${humans.length} human player${humans.length === 1 ? "" : "s"}${keepers.length ? `, ${keepers.length} keeper${keepers.length === 1 ? "" : "s"}` : ""}`;
          },
        });
        const systemStepFrom = steps.length;
        for (const s of toBuild) {
          steps.push({
            label: `${s.kind === "custom" ? "Script" : "System"}: ${s.name}`,
            run: async () => {
              if (s.kind === "custom") return writeCustom(s, d);
              if (!kinds.has(s.kind)) throw new Error(`the toolkit has no kind "${s.kind}"`);
              const needs = waitingOn(s, missingLocations());
              if (needs.length) throw new Waiting(needs);
              try {
                const r = addSystem(api, s.kind, paramsOf(s.params), toolkitContext(api, { tempo, extraLocations: locationNames }), `AI: ${s.name}`);
                findings.push(...r.notes.map((n) => `${s.name}: ${n}`));
                return `${r.count} trigger${r.count === 1 ? "" : "s"}`;
              } catch (err) {
                if (err instanceof ToolkitError) throw new Error(err.problems.join("; "));
                throw err;
              }
            },
          });
        }
        if (!d.systems.some((s) => s.kind === "objectives") && d.objectives.trim()) {
          steps.push({ label: "Objectives", run: async () => { const r = addSystem(api, "objectives", { text: d.objectives.replace(/\n/g, "\\n") }, toolkitContext(api, { tempo, extraLocations: locationNames }), "AI: objectives"); return `${r.count} trigger`; } });
        }
        if (d.briefing.length) {
          steps.push({
            label: "Mission briefing",
            run: async () => {
              const actions = api.names.actions(true);
              const typeOf = (label: string, fallback: number) => actions.find((a) => a.label.toLowerCase() === label)?.value ?? fallback;
              api.document.update("AI: mission briefing", (tx) => {
                const t = api.triggers.newTrigger(humans.map((p) => p - 1));
                t.actions = [];
                if (d.objectives.trim()) { const a = api.triggers.newAction(typeOf("mission objectives", 4), true); a.text = tx.strings.intern(d.objectives); t.actions.push(a); }
                for (const line of d.briefing) { const a = api.triggers.newAction(typeOf("text message", 3), true); a.text = tx.strings.intern(line); a.time = 8000; t.actions.push(a); }
                tx.briefing.set([t]);
              });
              return `${d.briefing.length} line${d.briefing.length === 1 ? "" : "s"}`;
            },
          });
        }
        steps.push({ label: "Name and description", run: async () => { api.document.update("AI: name and description", (tx) => { tx.properties({ name: d.name, description: d.description }); }); return d.name; } });
        steps.push({
          label: "Check Map",
          run: async () => {
            const issues = api.query.validate().filter((i) => i.level !== "info");
            for (const i of issues) findings.push(`Check Map: ${i.text}`);
            // The toolkit's timers were counted for a map whose triggers run each frame; that is only so with a program on it.
            if (d.target === "remastered" && toBuild.some((x) => x.kind !== "custom") && !hasPrograms(api)) findings.push("The design is for Remastered, and its timers are counted at 24 trigger cycles a second, but no script on the map has a program: until one does the triggers run every two seconds and every timer is about 48 times slow. Add a program in TrigScript, or set the design to every version and build again.");
            return issues.length ? `${issues.length} thing${issues.length === 1 ? "" : "s"} to look at` : "nothing wrong";
          },
        });

        const rows = steps.map((s) => addStep(s.label));
        stepsBox.scrollIntoView({ block: "nearest" });
        let failed = 0;
        let notRun = 0;
        let ended: BuildEnded | null = null;
        const waiting: number[] = [];
        const leave = (from: number, why: string) => { for (let j = from; j < steps.length; j++) { rows[j].set("skipped", why); notRun++; } };
        for (let i = 0; i < steps.length; i++) {
          // Before every step: a build stopped, or whose map went to the back, writes nothing more.
          try { checkBuild(); } catch (err) { ended = err as BuildEnded; leave(i, "not run"); break; }
          rows[i].set("running", steps[i].hint ?? "");
          // The long steps ask the service: their row carries the same clock as the runner, so the wait is visible where the eye is.
          runner.onTick = (s) => rows[i].detail(`${steps[i].hint ? `${steps[i].hint}; ` : ""}${s} s`);
          try {
            // The code steps take milliseconds; a beat on screen each, so the list is seen to run rather than blink.
            const startedAt = Date.now();
            const text = await steps[i].run();
            const left = 220 - (Date.now() - startedAt);
            if (left > 0) await new Promise((r) => setTimeout(r, left));
            rows[i].set("done", text);
          } catch (err) {
            if (err instanceof Waiting) { waiting.push(i); rows[i].set("skipped", err.message); continue; }
            // Stopped inside the step: a call that was cut short fails with the abort, and means the same.
            if (err instanceof BuildEnded || building.abort.signal.aborted) { ended = err instanceof BuildEnded ? err : new BuildEnded("stopped"); rows[i].set("skipped", "not run: stopped"); notRun++; leave(i + 1, "not run"); break; }
            failed++;
            rows[i].set("failed", (err as Error).message);
            findings.push(`${steps[i].label}: ${(err as Error).message}`);
            if (steps[i].vital) { leave(i + 1, "not run"); break; }
          }
        }
        const builtDoc = building.doc;
        building = null;
        stopButton.hidden = true;
        if (ended?.reason === "map") findings.push("The map in front changed while the scenario was being built, so the build stopped there: nothing is written into a map it did not start on. Bring the map back to the front and build again; what was built stays.");
        /** The waiting systems, once their locations exist: each is tried again and waits on if they still do not. */
        const buildWaiting = async () => {
          if (api.document.id() !== builtDoc) { waitHint.textContent = "These systems belong to the map the scenario was built on; bring it to the front first."; return; }
          const again = waiting.splice(0);
          waitButton.setBusy(true);
          building = { doc: builtDoc, abort: new AbortController() };
          stopButton.hidden = false;
          for (const [n, i] of again.entries()) {
            try { checkBuild(); } catch { waiting.push(...again.slice(n)); break; }
            rows[i].set("running");
            try { rows[i].set("done", await steps[i].run()); } catch (err) {
              if (err instanceof Waiting) { waiting.push(i); rows[i].set("skipped", err.message); }
              else if (err instanceof BuildEnded) { waiting.push(...again.slice(n)); rows[i].set("skipped", "not run: stopped"); break; }
              else { failed++; rows[i].set("failed", (err as Error).message); findings.push(`${steps[i].label}: ${(err as Error).message}`); }
            }
          }
          building = null;
          stopButton.hidden = true;
          waitButton.setBusy(false);
          waitBox.hidden = waiting.length === 0;
          waitHint.textContent = waitingText();
          settle();
        };
        const waitingText = () => `${waiting.length} system${waiting.length === 1 ? "" : "s"} wait${waiting.length === 1 ? "s" : ""} for locations the plan did not place: ${[...new Set(waiting.flatMap((i) => waitingOn(toBuild[i - systemStepFrom] ?? { params: [] }, missingLocations())))].join(", ")}. Draw them, then build.`;
        const waitButton = w.button("Build the waiting systems", { onClick: () => void buildWaiting() });
        const waitHint = h("span", { className: "ai-hint" }, "");
        const waitBox = h("div", { className: "ai-btns", hidden: true }, waitButton, waitHint);
        runner.onTick = null;
        buildButton.setBusy(false);
        redesignButton.setBusy(false);
        /** What the build came to, said the same way in the dialog, on the runner's line and in the editor's status bar — after the build, and again after the waiting systems are tried. */
        const settle = () => {
          const counts = { failed, waiting: waiting.length, notRun, stopped: ended?.reason === "stopped" };
          state.built = buildOutcome(counts);
          const text = outcomeText(d.name, counts);
          afterHint.textContent = `${text} Every edit is an undo step; the settings and triggers are transactions outside undo, as in StarEdit.`;
          runner.idle(text);
          api.ui.status(`AI: ${text}`);
        };
        // Notes, not failures: what a step assumed, skipped or wants looked at. A failed step is its own red row.
        const notes = findings.filter((f) => f.trim());
        if (notes.length) findingsBox.replaceChildren(h("details", { open: failed > 0 || ended !== null }, h("summary", null, `${notes.length} note${notes.length === 1 ? "" : "s"} from the build`), h("div", { className: "ai-body" }, noteList(notes))));
        const afterHint = h("span", { className: "ai-hint" }, "");
        afterBox.replaceChildren(
          w.button("Review it…", { onClick: () => { dialog.close(); openReview(ctx); } }),
          w.button("Open the assistant", { onClick: () => { dialog.close(); api.commands.run("ask", `I just built the scenario "${d.name}" (${d.genre}) from a design: ${d.systems.map((s) => s.name).join(", ")}. Look it over and tell me what to fix first.`); } }),
          afterHint,
        );
        if (waiting.length) { waitHint.textContent = waitingText(); waitBox.hidden = false; afterBox.after(waitBox); }
        afterBox.hidden = false;
        settle();
      };

      const askBody = h("div", { className: "ai-body" },
        promptField,
        chips(Object.keys(EXAMPLES), (label) => { promptField.value = EXAMPLES[label]; state.prompt = promptField.value; }),
        w.form([
          { label: "Size", field: h("div", { className: "ai-btns" }, widthSel, "×", heightSel) },
          { label: "Tileset", field: tilesetSel },
          { label: "Players", field: playersSel },
          { label: "Into", field: targetSel },
        ]),
        targetHint,
        scriptNote,
        h("div", { className: "ai-btns" }, designButton),
      );
      askBox.append(askBody);
      root.append(
        askBox,
        runner.el,
        designBox,
        stepsBox,
        h("div", { className: "ai-btns" }, stopButton),
        findingsBox,
        afterBox,
        ledgerLine(ctx),
      );
      promptField.focus();
      return () => { building?.abort.abort(); runner.dispose(); };
    },
    buttons: [{ label: "Close" }],
  });
}
