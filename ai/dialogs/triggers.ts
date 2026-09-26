/**
 * Tools ▸ AI ▸ Write Triggers…: a trigger script from a description. The model gets
 * the map's own `.d.ts` (every unit, location, switch and player by name) and writes
 * a TrigScript; the dialog checks and runs it there, sends the
 * compiler's complaints back for up to two repair rounds, shows the script, and
 * Build installs it the way TrigScript's own Build does.
 */
import { t } from "../../i18n";
import type { TriggersInput } from "../../protocol";
import { diagnosticLabel, existingTriggersFor, handTriggers, noScriptPluginMessage, repairDiagnostic, scriptBridge, type CompileResult } from "../script";
import { h, ledgerLine, noteList, Runner, runRecipe, styled, taskFor, textarea, type Ctx } from "../ui";

const REPAIR_ROUNDS = 2;

export function openTriggers(ctx: Ctx) {
  const { api } = ctx;
  const bridge = scriptBridge(api);
  if (!bridge) { void api.ui.alert(noScriptPluginMessage(), { title: t("Write Triggers") }); return; }
  const w = api.ui.widgets;
  const state = { prompt: "", script: "", summary: "", compiled: null as CompileResult | null };

  api.ui.dialog({
    title: t("Write Triggers"),
    size: "lg",
    tall: true,
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const existing = bridge.state();
      const hasScript = !!existing?.source;
      const promptField = textarea({ placeholder: t("What should happen? (\"each player gets 10 marines at their start every 30 seconds until minute 5\", \"victory when a player has 50 kills\", \"a countdown that ends the game in a draw\")"), rows: 4 });
      promptField.addEventListener("input", () => { state.prompt = promptField.value; });
      const extend = w.checkbox(t("Extend the map's current script"), { value: hasScript, disabled: !hasScript });
      const takeOver = w.checkbox(t("Replace every trigger on the map with the script (the hand-made ones are folded into it first)"), { value: false });
      const scriptField = textarea({ rows: 14, code: true, placeholder: t("The script appears here. Edit it before building if you like.") });
      scriptField.addEventListener("input", () => { state.script = scriptField.value; state.compiled = null; diagnostics.replaceChildren(); });
      const summary = h("div", { className: "ai-hint" });
      const diagnostics = h("div", null);
      const buildButton = w.button(t("Build"), { primary: true, onClick: () => void build() });
      const checkButton = w.button(t("Check"), { onClick: () => void check() });
      const openEditor = w.button(t("Open TrigScript"), { ghost: true, onClick: () => bridge.open() });
      const after = h("div", { className: "ai-btns", hidden: true }, buildButton, checkButton, openEditor);

      const showDiagnostics = (r: CompileResult) => {
        diagnostics.replaceChildren();
        if (r.ok) { diagnostics.append(h("div", { className: "ai-ok" }, r.programs.length
          ? t("Compiles: {n, plural, one {# trigger} other {# triggers}}, {programs, plural, one {a program} other {# programs}} of {inPrograms, plural, one {# trigger} other {# triggers}}.", { n: r.triggers.length, programs: r.programs.length, inPrograms: r.programs.reduce((n, p) => n + p.count, 0) })
          : t("Compiles: {n, plural, one {# trigger} other {# triggers}}.", { n: r.triggers.length }))); return; }
        diagnostics.append(h("div", { className: "ai-bad" }, t("{n, plural, one {# error} other {# errors}}:", { n: r.diagnostics.length })), noteList(r.diagnostics.map(diagnosticLabel), "ai-bad"));
      };

      const check = async (): Promise<CompileResult | null> => {
        try {
          const r = await bridge.compile(state.script);
          state.compiled = r;
          showDiagnostics(r);
          return r;
        } catch (err) {
          diagnostics.replaceChildren(h("div", { className: "ai-bad" }, t("Compiler: {message}", { message: (err as Error).message })));
          return null;
        }
      };

      const generate = async () => {
        if (!state.prompt.trim()) { promptField.focus(); runner.idle(t("Say what the triggers should do first.")); return; }
        const declarations = bridge.declarations({ compact: true });
        const input: TriggersInput = {
          prompt: state.prompt,
          declarations,
          script: extend.input.checked && existing?.source ? existing.source : undefined,
          existingTriggers: existingTriggersFor(api, handTriggers(api, existing?.block)),
          // The person is at the dialog: the map's blocks are cached for the hour, not five minutes.
          iterative: true,
        };
        // The script and its repair rounds are one task under the scenario ceiling, as a build's are: a repair that went round in circles used to be three full-price calls with no ceiling over them.
        const task = taskFor("triggers", ctx.settings().scenarioCeilingUsd);
        let r = await runRecipe(ctx, runner, "triggers", input, { task });
        if (!r) return;
        let script = r.output.script;
        state.summary = r.output.summary;
        state.script = script;
        scriptField.value = script;
        summary.textContent = state.summary;
        let compiled = await check();
        for (let round = 0; compiled && !compiled.ok && round < REPAIR_ROUNDS; round++) {
          runner.idle(t("The script has {n, plural, one {# error} other {# errors}}; asking for a repair ({round} of {rounds})…", { n: compiled.diagnostics.length, round: round + 1, rounds: REPAIR_ROUNDS }));
          r = await runRecipe(ctx, runner, "triggers", { ...input, repair: { script, diagnostics: compiled.diagnostics.map(repairDiagnostic) } }, { task });
          if (!r) return;
          script = r.output.script;
          state.script = script;
          state.summary = r.output.summary || state.summary;
          scriptField.value = script;
          summary.textContent = state.summary;
          compiled = await check();
        }
        after.hidden = false;
        if (compiled && !compiled.ok) runner.idle(t("The script still has errors. Fix them here or in TrigScript, then Build."));
      };

      const build = async () => {
        if (!state.script.trim()) return;
        const r = await bridge.build(state.script, { takeOver: takeOver.input.checked });
        state.compiled = r.compiled;
        showDiagnostics(r.compiled);
        if (r.block) {
          runner.idle(t("Built {n, plural, one {# trigger} other {# triggers}} into the map (#{first}–#{last}). The source is kept with the map; TrigScript shows it.", { n: r.block.count, first: r.block.start + 1, last: r.block.start + r.block.count }));
          api.ui.status(t("AI: built {n, plural, one {# trigger} other {# triggers}} from the script.", { n: r.block.count }));
        } else runner.idle(t("Not built: the script has errors."));
      };

      root.append(
        w.group(t("What the triggers should do"),
          promptField, extend, takeOver,
          h("div", { className: "ai-hint" }, t("The model is given this map's names: {starts, plural, one {# start location} other {# start locations}}, {triggers, plural, one {# existing trigger} other {# existing triggers}}, and every unit, location and switch as it is called here.", { starts: api.query.startLocations().length, triggers: api.triggers.list().length })),
          h("div", { className: "ai-btns" }, w.button(t("Write"), { primary: true, onClick: () => void generate() })),
        ),
        runner.el,
        w.group(t("The script"), summary, scriptField, diagnostics, after),
        ledgerLine(ctx),
      );
      promptField.focus();
      return () => runner.dispose();
    },
    buttons: [{ label: t("Close") }],
  });
}
