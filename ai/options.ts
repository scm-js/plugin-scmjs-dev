/**
 * The AI options and their dialog, Tools ▸ AI ▸ Options…: the one tick that turns the
 * AI features off, the quality (how hard the model works, and so what a request costs),
 * and the assistant's knobs under an advanced fold. There is nothing to configure about
 * *how* the plugin reaches the model — the service is scmjs.dev's, the account is the
 * Account dialog's — so the dialog opens on the balance line and a button to that
 * dialog, which is where a person who came here for the sign-in wants to be.
 */
import type { Quality, SettingsStore } from "../account";
import { h, styled, type Ctx } from "./ui";

/** The quality choices, worded for what they cost rather than what they are called on the server. */
export const QUALITY_CHOICES: { value: Quality; label: string }[] = [
  { value: "quick", label: "Quick — fastest and cheapest" },
  { value: "standard", label: "Standard — tuned for each feature (recommended)" },
  { value: "thorough", label: "Thorough — the highest setting; slower and dearer" },
];

export function openOptions(ctx: Ctx, store: SettingsStore) {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  api.ui.dialog({
    title: "AI Options",
    size: "md",
    mount(body, dialog) {
      const root = styled(body);
      const s = store.get();

      /* The account line and the way to it. */
      const balance = h("div", { className: "ai-hint" }, account.summary());
      const offAccount = account.onChange(() => { balance.textContent = account.summary(); });
      const accountBtn = w.button(account.signedIn() ? "Account…" : "Sign in…", { primary: !account.signedIn(), onClick: () => { dialog.close(); ctx.openAccount(); } });

      /* The one switch. */
      const aiBox = w.checkbox("Use the AI features", { value: s.ai, onChange: (v) => { store.set({ ai: v }); } });

      /* Quality. */
      const qualitySelect = w.select(QUALITY_CHOICES, { value: s.quality, onChange: (v) => { store.set({ quality: v as Quality }); } });

      /* The assistant's knobs. */
      const thinkingBox = w.checkbox("Show the model's reasoning summary while it works", { value: s.showThinking, onChange: (v) => { store.set({ showThinking: v }); } });
      const dockBox = w.checkbox("Dock the assistant at the right, under the Properties panel, instead of floating over the map", { value: s.dockAssistant, onChange: (v) => { store.set({ dockAssistant: v }); } });
      const roundsField = w.number({ value: s.maxRounds, min: 1, max: 100, step: 1, onChange: (v) => { store.set({ maxRounds: Math.max(1, Math.min(100, Math.round(v || 24))) }); } });
      const usd = (v: number) => Math.max(0, Math.min(100, Math.round((Number.isFinite(v) ? v : 0) * 100) / 100));
      const ceilingField = w.number({ value: s.ceilingUsd, min: 0, max: 100, step: 0.05, onChange: (v) => { store.set({ ceilingUsd: usd(v) }); } });
      const scenarioCeilingField = w.number({ value: s.scenarioCeilingUsd, min: 0, max: 100, step: 0.25, onChange: (v) => { store.set({ scenarioCeilingUsd: usd(v) }); } });
      const attachBox = w.checkbox("Send a picture of the visible area with every message", { value: s.attachView, onChange: (v) => { store.set({ attachView: v }); } });
      const followBox = w.checkbox("Follow the assistant's work around the map", { value: s.followMap, onChange: (v) => { store.set({ followMap: v }); } });

      root.append(
        w.group("Account",
          h("div", { className: "ai-btns" }, accountBtn, balance),
          h("div", { className: "ai-hint" }, "The first AI request starts a free trial with no sign-in. Signing in keeps the balance across browsers and adds the sign-in credit; the Account dialog has the balance, the top-up and the activity."),
        ),
        w.group("AI features",
          aiBox,
          h("div", { className: "ai-hint" }, "Off takes the Tools ▸ AI menu, the assistant and the AI buttons in the editor's dialogs away. Your account and the maps stored on it stay."),
        ),
        w.group("Quality",
          w.form([{ label: "Quality", field: qualitySelect }]),
          h("div", { className: "ai-hint" }, "How hard the model works on a request, and so how long it takes and what it costs. Standard gives each feature the setting it was tuned for — laying out maps and writing triggers already work at the highest one. Changing it in the middle of an assistant conversation makes the server re-read the whole conversation once; the next message is a little dearer."),
        ),
        w.group("Spending",
          w.form([{ label: "Per assistant message ($)", field: ceilingField }, { label: "Per Make Scenario run ($)", field: scenarioCeilingField }]),
          h("div", { className: "ai-hint" }, "A ceiling on one message with its tool rounds, and on one design or build. At the ceiling the work stops with the map as edited so far, the assistant offers to continue for as much again, and a build says which step it stopped at. 0 is no ceiling. A message usually costs $0.10–0.30 and a build $0.50–1.00; the server holds the ceiling, so the last call can run a little over it, never a whole extra one."),
        ),
        h("details", null,
          h("summary", null, "Assistant"),
          h("div", { className: "ai-body" },
            w.form([{ label: "Rounds per message", field: roundsField }]),
            attachBox,
            followBox,
            dockBox,
            thinkingBox,
            h("div", { className: "ai-hint" }, "A round is one answer from the model followed by the tool calls it asked for; the assistant stops at the limit and offers to continue. A picture costs about as much as a page of text each time. Following moves the view to each call's spot and zooms out when the spot is larger than the view, never in; scroll or zoom yourself during a turn and it stops until the next one. The dock setting applies the next time the assistant opens."),
          ),
        ),
      );

      return () => { offAccount(); };
    },
    buttons: [{ label: "Close", primary: true }],
  });
}
