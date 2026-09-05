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
      const attachBox = w.checkbox("Send a picture of the visible area with every message", { value: s.attachView, onChange: (v) => { store.set({ attachView: v }); } });

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
        h("details", null,
          h("summary", null, "Assistant"),
          h("div", { className: "ai-body" },
            w.form([{ label: "Rounds per message", field: roundsField }]),
            attachBox,
            dockBox,
            thinkingBox,
            h("div", { className: "ai-hint" }, "A round is one answer from the model followed by the tool calls it asked for; the assistant stops at the limit and offers to continue. A picture costs about as much as a page of text each time. The dock setting applies the next time the assistant opens."),
          ),
        ),
      );

      return () => { offAccount(); };
    },
    buttons: [{ label: "Close", primary: true }],
  });
}
