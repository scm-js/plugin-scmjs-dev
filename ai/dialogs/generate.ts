/**
 * Tools ▸ AI ▸ Generate Map…: a whole map from a prompt. The model returns a plan in
 * the layout language; the dialog shows it as a coloured grid with the designer's
 * notes and the bases, and Apply renders it onto a new map (made first, so the model
 * can be told which terrains the tileset has) or the open one when it is the same
 * size. Afterwards the same dialog refines: what to change, plus a picture of the
 * result and what the editor found wrong, go back to the model for a revised plan.
 */
import { msg, t, translate } from "../../i18n";
import type { TilesetId } from "@scm-js/plugin-api";
import type { MapPlan, MapPlanInput, SymmetryMode } from "../../protocol";
import { SYMMETRY_MODES } from "../../protocol";
import { doodadCategoryNames, imageInput, pixelsPerTileFor, terrainVocab, unitNames } from "../facts";
import { renderPlan, summarizeRender, type Rendered } from "../render";
import { chips, h, hex, ledgerLine, noteList, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";
import { openReview } from "./review";

const SIZES = [64, 96, 128, 160, 192, 256];
const EXAMPLES = [
  "A two-player jungle map with mains on high ground in opposite corners, a natural below each with one ramp, and a wide open centre with two island expansions.",
  "Four players, rotational symmetry, a lake in the middle with four bridges, thirds along the edges, dense trees around the mains.",
  "A tight two-player badlands map: narrow chokes, three tiers of height, a contested gold expansion in the centre.",
];

const TILESETS: { id: string; label: string }[] = [
  { id: "badlands", label: msg("Badlands") }, { id: "platform", label: msg("Space Platform") }, { id: "install", label: msg("Installation") }, { id: "ashworld", label: msg("Ashworld") },
  { id: "jungle", label: msg("Jungle") }, { id: "desert", label: msg("Desert") }, { id: "ice", label: msg("Ice") }, { id: "twilight", label: msg("Twilight") },
];

const SYMMETRY_LABELS: Record<SymmetryMode | "auto", string> = {
  auto: msg("Let the model choose"), none: msg("None"), "mirror-x": msg("Mirror left ↔ right"), "mirror-y": msg("Mirror top ↔ bottom"), rot180: msg("Rotate 180°"),
  rot90: msg("Rotate 90° (square)"), diag: msg("Diagonal mirror (square)"), antidiag: msg("Other diagonal (square)"), quad: msg("Mirror both ways"), octo: msg("Eight-fold (square)"),
};

/** Tiles per cell for a map: 32-ish cells along the longer side. */
export function cellSizeFor(width: number, height: number): number {
  return Math.max(2, Math.round(Math.max(width, height) / 32));
}

export function openGenerate(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;
  const info = api.document.info();
  const state = {
    prompt: "",
    width: info?.width ?? 128,
    height: info?.height ?? 128,
    tileset: (info?.tileset as string | undefined) ?? "jungle",
    players: 2,
    symmetry: "auto" as SymmetryMode | "auto",
    target: (info ? "open" : "new") as "new" | "open",
    plan: null as MapPlan | null,
    rendered: null as Rendered | null,
    /**
     * The history as it stood right after the last apply, and how many steps the apply put on
     * it — the render, a doodad put-back, and the name where the editor records table writes.
     * While the history still reads so, that many undos take exactly that apply back.
     */
    mark: null as { undo: string | null; undoDepth: number; steps: number } | null,
    refine: "",
  };

  api.ui.dialog({
    title: t("Generate Map"),
    size: "lg",
    tall: true,
    mount(body, dialog) {
      const root = styled(body);
      const runner = new Runner(ctx);

      const promptField = textarea({ placeholder: t("What kind of map? Say how many players, the feel of the terrain, where the bases go, anything the layout should have."), rows: 4 });
      promptField.addEventListener("input", () => { state.prompt = promptField.value; });
      const widthSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.width, onChange: (v) => { state.width = Number(v); syncTarget(); } });
      const heightSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.height, onChange: (v) => { state.height = Number(v); syncTarget(); } });
      const tilesetSel = w.select(TILESETS.map((ts) => ({ value: ts.id, label: translate(ts.label) })), { value: state.tileset, onChange: (v) => { state.tileset = v; syncTarget(); } });
      const playersSel = w.select([2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) })), { value: state.players, onChange: (v) => { state.players = Number(v); } });
      const symSel = w.select((["auto", ...SYMMETRY_MODES] as (SymmetryMode | "auto")[]).map((m) => ({ value: m, label: translate(SYMMETRY_LABELS[m]) })), { value: state.symmetry, onChange: (v) => { state.symmetry = v as SymmetryMode | "auto"; } });
      const targetSel = w.select([{ value: "new", label: t("A new map") }, { value: "open", label: t("The open map") }], { value: state.target, onChange: (v) => { state.target = v as "new" | "open"; } });
      const targetHint = h("div", { className: "ai-hint" });
      const syncTarget = () => {
        const cur = api.document.info();
        const same = !!cur && cur.width === state.width && cur.height === state.height && cur.tileset === state.tileset;
        (targetSel.options[1] as HTMLOptionElement).disabled = !same;
        if (!same && state.target === "open") { state.target = "new"; targetSel.value = "new"; }
        targetHint.textContent = same
          ? t("Into the open map: its terrain and objects inside the plan's area are replaced. One undo step.")
          : t("A new blank map of this size and tileset is made first, so the model can be told which terrains it has. An open map with unsaved changes asks before it goes.");
      };
      syncTarget();

      const preview = h("div", null);
      const afterwards = h("div", { className: "ai-btns", hidden: true });
      const applyButton = w.button(t("Apply"), { primary: true, onClick: () => void apply() });
      const refineField = textarea({ placeholder: t("What should change? (\"more room around the naturals\", \"swap the lake for a plateau\")"), rows: 2 });
      refineField.addEventListener("input", () => { state.refine = refineField.value; });
      const refineButton = w.button(t("Refine"), { onClick: () => void generate(true) });
      const reviewButton = w.button(t("Review it…"), { onClick: () => { dialog.close(); openReview(ctx); } });
      const refineBox = h("div", { hidden: true }, w.group(t("Refine"), refineField, h("div", { className: "ai-btns" }, refineButton, reviewButton), h("div", { className: "ai-hint" }, t("The revised plan replaces the applied one: the previous render is undone first when nothing else was edited in between."))));

      const generateButton = w.button(t("Generate"), { primary: true, onClick: () => void generate(false) });

      const showPlan = (plan: MapPlan, findings: string[] = []) => {
        preview.replaceChildren();
        const terrains = api.terrain.types();
        const legendRow = h("div", { className: "ai-legend" });
        for (const [ch, id] of Object.entries(plan.legend)) {
          const ty = terrains.find((x) => x.id === id);
          legendRow.append(h("span", null, h("i", { style: `background:${hex(api.terrain.terrainColor(id) ?? 0x444444)}` }), `${ch} ${ty?.name ?? id}`));
        }
        const grid = h("div", { className: "ai-grid" });
        for (const row of plan.grid) {
          const line = h("div", null);
          for (const ch of row) {
            const id = plan.legend[ch];
            line.append(h("span", { className: "ai-cell", style: `background:${id === undefined ? "#000" : hex(api.terrain.terrainColor(id) ?? 0x444444)}`, title: ch }));
          }
          grid.append(line);
        }
        const bases = plan.bases.map((b) => b.player
          ? t("{kind} (player {player}) at {x},{y}, minerals to the {direction}, {minerals} patches, {geysers, plural, one {# geyser} other {# geysers}}", { kind: b.kind, player: b.player, x: b.x, y: b.y, direction: b.mineralDirection, minerals: b.minerals, geysers: b.geysers })
          : t("{kind} at {x},{y}, minerals to the {direction}, {minerals} patches, {geysers, plural, one {# geyser} other {# geysers}}", { kind: b.kind, x: b.x, y: b.y, direction: b.mineralDirection, minerals: b.minerals, geysers: b.geysers }));
        preview.append(
          w.group(`${plan.name} — ${plan.symmetry === "none" ? t("no symmetry") : translate(SYMMETRY_LABELS[plan.symmetry])}`,
            h("div", { className: "ai-hint" }, plan.description),
            grid, legendRow,
            plan.notes.length ? h("details", { open: true }, h("summary", null, t("Designer's notes")), h("div", { className: "ai-body" }, noteList(plan.notes))) : null,
            bases.length ? h("details", null, h("summary", null, t("{n, plural, one {# base} other {# bases}} listed (mirrored on apply)", { n: bases.length })), h("div", { className: "ai-body" }, noteList(bases))) : null,
            plan.ramps.length || plan.doodads.length || plan.units.length || plan.locations.length
              ? h("div", { className: "ai-hint" }, t("{ramps, plural, one {# ramp} other {# ramps}}, {rules, plural, one {# decoration rule} other {# decoration rules}}, {units, plural, one {# unit} other {# units}}, {locations, plural, one {# location} other {# locations}}.", { ramps: plan.ramps.length, rules: plan.doodads.length, units: plan.units.length, locations: plan.locations.length }))
              : null,
            findings.length ? h("details", { open: true }, h("summary", null, t("{n, plural, one {# thing} other {# things}} to know", { n: findings.length })), h("div", { className: "ai-body" }, noteList(findings))) : null,
          ),
        );
        afterwards.hidden = false;
      };

      const ensureMap = async (): Promise<boolean> => {
        if (state.target === "open" && api.document.isOpen()) return true;
        const ok = await api.document.create({ width: state.width, height: state.height, tileset: state.tileset as TilesetId, name: "Untitled Scenario" });
        if (!ok) { runner.idle(t("Kept the open map.")); return false; }
        state.target = "open";
        targetSel.value = "open";
        syncTarget();
        return true;
      };

      const generate = async (refine: boolean) => {
        if (!state.prompt.trim() && !refine) { promptField.focus(); runner.idle(t("Say what kind of map you want first.")); return; }
        if (!(await ensureMap())) return;
        await api.tileset.load();
        const cur = api.document.info()!;
        const cellSize = cellSizeFor(cur.width, cur.height);
        const input: MapPlanInput = {
          prompt: refine && state.refine.trim() ? `${state.prompt}\n\nChange this: ${state.refine.trim()}` : state.prompt,
          width: cur.width,
          height: cur.height,
          tileset: cur.tileset,
          terrains: terrainVocab(api),
          doodadCategories: doodadCategoryNames(api),
          unitNames: unitNames(api),
          players: state.players,
          symmetry: state.symmetry,
          cellSize,
        };
        if (refine && state.plan) {
          const findings = state.rendered?.findings ?? [];
          const blob = state.rendered ? await api.document.renderImage({ pixelsPerTile: pixelsPerTileFor(cur.width, cur.height, 4) }) : null;
          input.previous = { plan: state.plan, findings, image: blob ? await imageInput(blob) : undefined };
        }
        generateButton.setBusy(true);
        refineButton.setBusy(true);
        try {
          const r = await runRecipe(ctx, runner, "map-plan", input);
          if (!r) return;
          state.plan = r.output;
          showPlan(r.output);
          preview.scrollIntoView({ block: "nearest" });
        } finally {
          generateButton.setBusy(false);
          refineButton.setBusy(false);
        }
      };

      const apply = async () => {
        if (!state.plan || !api.document.isOpen()) return;
        if (state.rendered && state.mark) {
          const now = api.document.history();
          const intact = now.undo === state.mark.undo && now.undoDepth === state.mark.undoDepth;
          if (!intact && !(await api.ui.confirm(t("The map was edited since the last plan was applied. Apply the new plan on top of it?"), { title: t("Generate Map"), confirmLabel: t("Apply on top") }))) return;
          if (intact) for (let i = 0; i < state.mark.steps; i++) api.document.undo();
        }
        const depthBefore = api.document.history().undoDepth;
        const rendered = renderPlan(api, state.plan, { originX: 0, originY: 0, label: t("AI: {name}", { name: state.plan.name }), clearArea: true });
        if (!rendered) return;
        state.rendered = rendered;
        if (state.plan.name || state.plan.description) {
          api.document.update(t("AI: name and description"), (tx) => { tx.properties({ name: state.plan!.name, description: state.plan!.description }); });
        }
        // Marked after the name: on an editor that records table writes it is a step of this apply too.
        const after = api.document.history();
        state.mark = { undo: after.undo, undoDepth: after.undoDepth, steps: Math.max(1, after.undoDepth - depthBefore) };
        showPlan(state.plan, rendered.findings);
        refineBox.hidden = false;
        runner.idle(t("Applied: {summary}. Edit ▸ Undo takes it back.", { summary: summarizeRender(rendered) }));
        api.ui.status(t("AI: {summary}", { summary: summarizeRender(rendered) }));
      };

      root.append(
        w.group(t("What to make"),
          promptField,
          ((labels: string[]) => chips(labels, (label) => {
            const i = labels.indexOf(label);
            promptField.value = EXAMPLES[Math.max(0, i)];
            state.prompt = promptField.value;
          }))([t("Example: two-player jungle"), t("Example: four-player lake"), t("Example: tight badlands")]),
          w.form([
            { label: t("Size"), field: h("div", { className: "ai-btns" }, widthSel, "×", heightSel) },
            { label: t("Tileset"), field: tilesetSel },
            { label: t("Players"), field: playersSel },
            { label: t("Symmetry"), field: symSel },
            { label: t("Into"), field: targetSel },
          ]),
          targetHint,
          h("div", { className: "ai-btns" }, generateButton),
        ),
        runner.el,
        preview,
        afterwards,
        refineBox,
        ledgerLine(ctx),
      );
      afterwards.append(applyButton, h("span", { className: "ai-hint" }, t("Renders the plan onto the map as one undo step, then names the map after it.")));
      promptField.focus();
      return () => { runner.dispose(); };
    },
    buttons: [{ label: t("Close") }],
  });
}
