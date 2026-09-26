/**
 * Tools ▸ AI ▸ Name and Describe… and Write Briefing…: text from the map's facts.
 * The first offers three name/description pairs and writes the picked one into the
 * scenario's properties; the second writes a mission briefing — the objectives into
 * a Mission Objectives action, each narration line into a Text Message — as one
 * briefing trigger for every player.
 */
import { t } from "../../i18n";
import type { BriefingOutput, DescribeOutput } from "../../protocol";
import { mapFacts } from "../facts";
import { h, ledgerLine, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";

export function openDescribe(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;

  api.ui.dialog({
    title: t("Name and Describe"),
    size: "md",
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const info = api.document.info();
      const promptField = textarea({ placeholder: t("Tone, length, language — or leave it to the facts. (\"short and grim\", \"in German\", \"mention the gold expansion\")"), rows: 2 });
      const list = h("div", { className: "ai-list" });
      const current = h("div", { className: "ai-hint" }, t("Now: \"{name}\" — {description}", { name: info?.name ?? "", description: info?.description || t("(no description)") }));
      let picked: { name: string; description: string } | null = null;
      const applyButton = w.button(t("Use this"), { primary: true, disabled: true, onClick: () => {
        if (!picked) return;
        const p = picked;
        api.document.update(t("AI: name and description"), (tx) => { tx.properties({ name: p.name, description: p.description }); });
        current.textContent = t("Now: \"{name}\" — {description}", { name: p.name, description: p.description });
        runner.idle(t("Written into Scenario ▸ Map Properties. It is not an undo step; write the old one back the same way if you change your mind."));
      } });

      const show = (out: DescribeOutput) => {
        list.replaceChildren();
        picked = null;
        applyButton.disabled = true;
        const options = [{ name: out.name, description: out.description }, ...out.alternatives];
        const rows: HTMLElement[] = [];
        options.forEach((o) => {
          const row = h("div", { className: "ai-item", onClick: () => { picked = o; applyButton.disabled = false; rows.forEach((r) => r.classList.toggle("is-picked", r === row)); } },
            h("div", { className: "ai-grow" }, h("div", { className: "ai-gold" }, o.name), h("div", { className: "ai-dim" }, o.description)));
          rows.push(row);
          list.append(row);
        });
      };

      root.append(
        current,
        promptField,
        h("div", { className: "ai-btns" }, w.button(t("Suggest"), { primary: true, onClick: async () => {
          const r = await runRecipe(ctx, runner, "describe", { facts: mapFacts(api), prompt: promptField.value.trim() || undefined });
          if (r) show(r.output);
        } })),
        runner.el, list, h("div", { className: "ai-btns" }, applyButton), ledgerLine(ctx),
      );
      return () => runner.dispose();
    },
    buttons: [{ label: t("Close") }],
  });
}

export function openBriefing(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;

  api.ui.dialog({
    title: t("Write Briefing"),
    size: "md",
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const promptField = textarea({ placeholder: t("Who is speaking, what is at stake, how long — or leave it to the triggers and the map. (\"a terse Terran commander\", \"three lines\", \"in Spanish\")"), rows: 2 });
      const objectives = textarea({ rows: 4, placeholder: t("Objectives, one per line.") });
      const lines = textarea({ rows: 8, placeholder: t("The narration, one message per line.") });
      const seconds = w.number({ value: 8, min: 1, max: 60 });
      const replace = w.checkbox(t("Replace the map's existing briefing"), { value: true });
      const writeButton = w.button(t("Write into the map"), { primary: true, disabled: true, onClick: () => {
        const obj = objectives.value.split("\n").map((s) => s.trim()).filter(Boolean);
        const msgs = lines.value.split("\n").map((s) => s.trim()).filter(Boolean);
        if (obj.length === 0 && msgs.length === 0) return;
        const actions = api.names.actions(true);
        const typeOf = (label: string, fallback: number) => actions.find((a) => a.label.toLowerCase() === label)?.value ?? fallback;
        const objectivesType = typeOf("mission objectives", 4);
        const messageType = typeOf("text message", 3);
        const ms = Math.max(1, Number(seconds.value) || 8) * 1000;
        const r = api.document.update(t("AI: mission briefing"), (tx) => {
          const trig = api.triggers.newTrigger([0, 1, 2, 3, 4, 5, 6, 7]);
          trig.actions = [];
          if (obj.length) {
            const a = api.triggers.newAction(objectivesType, true);
            a.text = tx.strings.intern(obj.join("\n"));
            trig.actions.push(a);
          }
          for (const m of msgs) {
            const a = api.triggers.newAction(messageType, true);
            a.text = tx.strings.intern(m);
            a.time = ms;
            trig.actions.push(a);
          }
          if (replace.input.checked) tx.briefing.set([trig]);
          else tx.briefing.add(trig);
        });
        runner.idle(r.changed ? t("Written: {objectives, plural, one {# objective} other {# objectives}} and {messages, plural, one {# message} other {# messages}} in one briefing trigger for all players. Triggers ▸ Mission Briefing shows it.", { objectives: obj.length, messages: msgs.length }) : t("Nothing changed."));
      } });

      const show = (out: BriefingOutput) => {
        objectives.value = out.objectives.join("\n");
        lines.value = out.lines.join("\n");
        writeButton.disabled = false;
      };

      root.append(
        promptField,
        h("div", { className: "ai-btns" }, w.button(t("Write"), { primary: true, onClick: async () => {
          const r = await runRecipe(ctx, runner, "briefing", { facts: mapFacts(api), prompt: promptField.value.trim() || undefined });
          if (r) show(r.output);
        } })),
        runner.el,
        w.group(t("Objectives"), objectives),
        w.group(t("Narration"), lines, w.form([{ label: t("Seconds each"), field: seconds }]), replace),
        h("div", { className: "ai-btns" }, writeButton),
        ledgerLine(ctx),
      );
      return () => runner.dispose();
    },
    buttons: [{ label: t("Close") }],
  });
}
