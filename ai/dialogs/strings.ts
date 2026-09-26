/**
 * Tools ▸ AI ▸ Rewrite Strings…: the string table under an instruction — translate,
 * fix spelling, shorten, retone. A before/after table with a tick per row; Apply
 * writes the ticked rows back in place (never renumbering, so the triggers that point
 * at them keep pointing). Control bytes below 0x20 travel as `<XX>` both ways.
 */
import { msg, t, translate } from "../../i18n";
import { h, ledgerLine, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";

const PRESETS: { label: string; text: string }[] = [
  { label: msg("Translate to…"), text: "Translate every string to " },
  { label: msg("Fix spelling and grammar"), text: "Fix spelling, grammar and punctuation; change nothing else." },
  { label: msg("Shorten"), text: "Shorten each string as much as it can bear without losing its meaning." },
  { label: msg("In-universe"), text: "Rewrite the messages in the voice of a StarCraft mission briefing: terse, military, in-universe. Keep names and numbers." },
];

type Scope = "all" | "triggers" | "briefing" | "names";

export function escapeControls(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `<${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}>`);
}

export function unescapeControls(s: string): string {
  return s.replace(/<([0-9A-Fa-f]{2})>/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function openStrings(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;

  api.ui.dialog({
    title: t("Rewrite Strings"),
    size: "xl",
    tall: true,
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const instruction = textarea({ placeholder: t("What to do with the strings."), rows: 2 });
      const scope = w.select([
        { value: "all", label: t("Every string in use") },
        { value: "triggers", label: t("Only trigger text (messages, objectives)") },
        { value: "briefing", label: t("Only the mission briefing") },
        { value: "names", label: t("Only names: scenario, forces, units, locations, switches") },
      ], { value: "all" });
      const table = h("table", { className: "ai-table" });
      const tableBox = h("div", { className: "ai-scroll", hidden: true }, table);
      const ticks = new Map<number, HTMLInputElement>();
      let proposed: { index: number; before: string; after: string; usage: string[] }[] = [];
      const applyButton = w.button(t("Apply ticked"), { primary: true, disabled: true, onClick: () => {
        const rows = proposed.filter((p) => ticks.get(p.index)?.checked && p.after !== p.before);
        if (rows.length === 0) return;
        const r = api.document.update(t("AI: rewrite strings"), (tx) => { for (const p of rows) tx.strings.set(p.index, unescapeControls(p.after)); });
        runner.idle(r.changed ? t("Wrote {n, plural, one {# string} other {# strings}} in place. Not an undo step; Scenario ▸ String Editor shows them.", { n: rows.length }) : t("Nothing changed."));
        applyButton.disabled = true;
      } });

      const gather = (): { index: number; text: string; usage: string[] }[] => {
        const usage = api.query.stringUsage();
        const scn = api.document.scenario();
        if (!scn) return [];
        const want = scope.value as Scope;
        const out: { index: number; text: string; usage: string[] }[] = [];
        for (const [index, uses] of usage) {
          const text = api.names.string(index);
          if (!text || !text.trim()) continue;
          const kinds = uses.map((u) => u.label);
          const isTrigger = uses.some((u) => u.kind === "trigger");
          const isBriefing = uses.some((u) => u.kind === "briefing");
          const isName = uses.some((u) => ["name", "description", "force", "unit", "location", "switch"].includes(u.kind));
          if (want === "triggers" && !isTrigger) continue;
          if (want === "briefing" && !isBriefing) continue;
          if (want === "names" && !isName) continue;
          out.push({ index, text: escapeControls(text), usage: kinds });
        }
        return out.sort((a, b) => a.index - b.index);
      };

      const show = () => {
        table.replaceChildren(h("tr", null, h("th", null, ""), h("th", null, "#"), h("th", null, t("Before")), h("th", null, t("After")), h("th", null, t("Used by"))));
        ticks.clear();
        for (const p of proposed) {
          const changed = p.after !== p.before;
          const tick = h("input", { type: "checkbox", checked: changed, disabled: !changed }) as HTMLInputElement;
          ticks.set(p.index, tick);
          table.append(h("tr", { style: changed ? "" : "opacity: .5" }, h("td", null, tick), h("td", null, String(p.index)), h("td", { className: "ai-mono" }, p.before), h("td", { className: "ai-mono" }, p.after), h("td", { className: "ai-dim" }, p.usage.join(", "))));
        }
        tableBox.hidden = false;
        applyButton.disabled = !proposed.some((p) => p.after !== p.before);
      };

      const run = async () => {
        if (!instruction.value.trim()) { instruction.focus(); runner.idle(t("Say what to do with the strings first.")); return; }
        const strings = gather();
        if (strings.length === 0) { runner.idle(t("No strings in that scope.")); return; }
        const r = await runRecipe(ctx, runner, "strings", { instruction: instruction.value.trim(), strings: strings.map((s) => ({ index: s.index, text: s.text, usage: s.usage })) });
        if (!r) return;
        const after = new Map(r.output.strings.map((s) => [s.index, s.text]));
        proposed = strings.map((s) => ({ index: s.index, before: s.text, after: after.get(s.index) ?? s.text, usage: s.usage }));
        show();
        const n = proposed.filter((p) => p.after !== p.before).length;
        runner.idle(t("{n} of {total, plural, one {# string} other {# strings}} would change. Untick any to keep, then Apply.", { n, total: strings.length }));
      };

      root.append(
        w.group(t("Instruction"),
          instruction,
          h("div", { className: "ai-chips" }, ...PRESETS.map((p) => h("button", { type: "button", className: "ai-chip", onClick: () => { instruction.value = p.text; instruction.focus(); } }, translate(p.label)))),
          w.form([{ label: t("Scope"), field: scope }]),
          h("div", { className: "ai-btns" }, w.button(t("Rewrite"), { primary: true, onClick: () => void run() })),
        ),
        runner.el, tableBox, h("div", { className: "ai-btns" }, applyButton), ledgerLine(ctx),
      );
      return () => runner.dispose();
    },
    buttons: [{ label: t("Close") }],
  });
}
