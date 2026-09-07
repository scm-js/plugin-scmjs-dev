/**
 * What the plugin adds *inside* the editor's own dialogs (`api.ui.dialogSlot`): a
 * *Suggest* button in Map Properties that fills the name and description fields from the
 * map's facts; *Explain* and *Write…* in the trigger editors; *Rewrite…* in the String
 * Editor; *Set up…* in Player Settings, which asks the assistant; *Write…* in Mission
 * Briefing. Each mounts plain widgets into the dialog's footer and leaves OK to the
 * person — a suggestion fills the form, it never writes the map.
 */
import type { DialogSlotHost, Disposable } from "@scm-js/plugin-api";
import { describeError } from "../client";
import { mapFacts } from "./facts";
import { recipeOptions, type Ctx } from "./ui";

export interface SlotActions {
  /** Open the assistant with a message in its input. */
  assistant(text: string): void;
  explain(): void;
  triggers(): void;
  strings(): void;
  briefing(): void;
}

/** Puts the buttons in; the cleanup takes every one of them out again (the AI features can be turned off). */
export function installDialogSlots(ctx: Ctx, actions: SlotActions): () => void {
  const { api } = ctx;
  const w = api.ui.widgets;
  const slots: Disposable[] = [];

  slots.push(api.ui.dialogSlot("mapProperties", {
    mount(body, dlg) {
      const status = api.ui.el("span", { className: "faint" }, "");
      const button = w.button("Suggest a name", { ghost: true, title: "Ask the AI for a name and description from what is on the map; fills the fields, OK writes them", onClick: async () => {
        button.setBusy(true);
        status.replaceChildren(w.spinner({ size: "sm", label: "Asking…" }));
        try {
          const r = await ctx.client.run("describe", { facts: mapFacts(api), prompt: dlg.fields.description?.get()?.trim() ? `The current description is: ${dlg.fields.description.get()}` : undefined }, {}, recipeOptions(ctx.settings()));
          dlg.fields.name?.set(r.output.name);
          dlg.fields.description?.set(r.output.description);
          status.textContent = r.output.alternatives.length ? `Or: ${r.output.alternatives.map((a) => a.name).join(" · ")}` : "";
        } catch (err) {
          status.textContent = describeError(err);
        } finally {
          button.setBusy(false);
        }
      } });
      body.append(button, status);
    },
  }));

  const triggerSlot = (host: DialogSlotHost, body: HTMLElement) => {
    const briefing = host.payload.briefing === true || host.dialog === "missionBriefing";
    body.append(
      w.button("Explain", { ghost: true, title: "Walk through what these triggers do in play", onClick: () => { host.close(); actions.explain(); } }),
      w.button(briefing ? "Write briefing…" : "Write triggers…", { ghost: true, title: briefing ? "Write objectives and narration with the AI" : "Write a trigger script from a description", onClick: () => { host.close(); if (briefing) actions.briefing(); else actions.triggers(); } }),
      w.button("Ask", { ghost: true, title: "Ask the assistant about the triggers", onClick: () => { host.close(); actions.assistant(briefing ? "About the mission briefing: " : "About the triggers: "); } }),
    );
  };
  slots.push(api.ui.dialogSlot("triggerEditor", { mount: (body, host) => triggerSlot(host, body) }));
  // The Text Trigger Editor is the TrigEdit plugin; its dialog offers this slot (`DialogSpec.slot`).
  slots.push(api.ui.dialogSlot("trigedit.text", { mount: (body, host) => triggerSlot(host, body) }));
  slots.push(api.ui.dialogSlot("missionBriefing", { mount: (body, host) => triggerSlot(host, body) }));

  slots.push(api.ui.dialogSlot("stringEditor", {
    mount(body, host) {
      body.append(w.button("Rewrite with AI…", { ghost: true, title: "Translate, fix or retone the strings", onClick: () => { host.close(); actions.strings(); } }));
    },
  }));

  slots.push(api.ui.dialogSlot("playerSettings", {
    mount(body, host) {
      body.append(w.button("Set up with AI…", { ghost: true, title: "Tell the assistant what the players should be", onClick: () => { host.close(); actions.assistant("Set up the players and forces for: "); } }));
    },
  }));

  return () => { for (const s of slots) s.dispose(); slots.length = 0; };
}
