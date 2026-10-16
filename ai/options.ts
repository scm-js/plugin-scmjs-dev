/**
 * The AI options, as the plugin's page in Edit ▸ Preferences (under Plugins; Tools ▸ AI ▸
 * Options… opens it): the one tick that turns the AI features off, the quality (how hard
 * the model works, and so what a request costs), and the assistant's knobs under an
 * advanced fold. Every control writes as it changes, so the page needs no apply. There
 * is nothing to configure about *how* the plugin reaches the model — the service is
 * scmjs.dev's, the account is the Account dialog's — so the page opens on the balance
 * line and a button to that dialog, which is where a person who came here for the
 * sign-in wants to be. Registered whether the AI features are on or off — the tick that
 * turns them back on lives here — while the server offers the AI or takes an own key.
 *
 * The AI runs on the person's own Anthropic key unless their role pays for it (an admin),
 * so the page ends on that key: pasted, checked with the server (which asks Anthropic, at
 * no cost) and kept only once it passes. Until there is one the page shows that alone.
 */
import type { Disposable, PluginApi } from "@scm-js/plugin-api";
import type { AccountManager, Quality, SettingsStore } from "../account";
import { describeError, ScmjsError } from "../client";
import { clear, h, styled } from "./ui";
import { msg, t, translate } from "../i18n";

/** The page id `api.ui.open("preferences", { page })` takes. */
export const OPTIONS_PAGE = "plugin:scmjs-dev";

/** Open the page — Tools ▸ AI ▸ Options… and the "ai-options" command. */
export function openOptions(api: PluginApi): void {
  api.ui.open("preferences", { page: OPTIONS_PAGE });
}

export interface OptionsDeps {
  api: PluginApi;
  store: SettingsStore;
  account: AccountManager;
  openAccount: () => void;
}

/** The quality choices, worded for what they cost rather than what they are called on the server. */
export const QUALITY_CHOICES: { value: Quality; label: string }[] = [
  { value: "quick", label: msg("Quick — fastest and cheapest") },
  { value: "standard", label: msg("Standard — tuned for each feature (recommended)") },
  { value: "thorough", label: msg("Thorough — the highest setting; slower and dearer") },
];

export function registerOptionsPage(deps: OptionsDeps): Disposable {
  const { api, store, account } = deps;
  const w = api.ui.widgets;
  return api.ui.preferencesPage({
    mount(body, page) {
      const root = styled(body);
      const aiBox = h("div", null);
      const keyBox = h("div", null);
      root.append(aiBox, keyBox);
      /** The AI part's own listener, while it is mounted. */
      let offAi: (() => void) | null = null;

      /* The own key: the field and the check, or the key in use and a way to forget it. */
      const keyStatus = w.statusLine({ text: "" });
      // (Rebuilt only when what it shows changes: an account update must not empty a field being typed in.)
      let keyShown: string | null = null;
      const renderKey = () => {
        const key = store.get().anthropicKey;
        const state = `${account.keysAccepted()}:${key}`;
        if (state === keyShown) return;
        keyShown = state;
        clear(keyBox);
        if (!account.keysAccepted()) return;
        if (key) {
          keyBox.append(w.group(t("Your Anthropic key"),
            h("div", { className: "ai-btns" },
              h("span", null, t("In use: the key ending {end}.", { end: key.slice(-4) })),
              w.button(t("Forget the key"), { onClick: () => { account.forgetKey(); keyStatus.set(t("The key is forgotten.")); } }),
            ),
            h("div", { className: "ai-hint" }, t("AI requests go to Anthropic on this key and are billed to your Anthropic account. It stays in this browser; scmjs.dev passes it on with each request and keeps no copy.")),
            keyStatus,
          ));
          return;
        }
        const field = w.text({ placeholder: "sk-ant-…", password: true });
        const check = w.button(t("Check and use"), { primary: true, onClick: async () => {
          keyStatus.set(t("Checking the key with Anthropic…"));
          try {
            await account.useKey(field.value);
            keyStatus.set(t("The key works. The AI features are on."), "ok");
            keyStatus.scrollIntoView({ block: "nearest" });
          } catch (err) {
            // (A refused key, or a server that takes none, says so in its own words.)
            keyStatus.set(err instanceof ScmjsError && (err.code === "forbidden" || err.code === "invalid_input") ? err.message : describeError(err), "error");
          }
        } });
        keyBox.append(w.group(t("Your Anthropic key"),
          h("div", { className: "ai-btns" }, field, check),
          h("div", { className: "ai-hint" }, t("The AI features run on your own Anthropic API key, made at console.anthropic.com. The key is checked with Anthropic first, which costs nothing; after that it goes with each AI request and Anthropic bills the requests to your account. It stays in this browser; scmjs.dev passes it on and keeps no copy.")),
          keyStatus,
        ));
      };

      let aiShown: string | null = null;
      const renderAi = () => {
        const offered = account.aiOffered();
        const state = `${offered}:${account.ownKey()}`;
        if (state === aiShown) return;
        aiShown = state;
        offAi?.(); offAi = null;
        clear(aiBox);
        if (offered) mountAi(aiBox);
      };

      const offAccount = account.onChange(() => { renderAi(); renderKey(); });
      renderAi();
      renderKey();
      return () => { offAccount(); offAi?.(); };

      function mountAi(root: HTMLElement): void {
        const s = store.get();

        /* The account line and the way to it. */
        const balance = h("div", { className: "ai-hint" }, account.summary());
        offAi = account.onChange(() => { balance.textContent = account.summary(); });
        const accountBtn = w.button(account.signedIn() ? t("Account…") : t("Sign in…"), { primary: !account.signedIn() && !account.ownKey(), onClick: () => { page.close(); deps.openAccount(); } });

        /* The one switch. */
        const aiBox = w.checkbox(t("Use the AI features"), { value: s.ai, onChange: (v) => { store.set({ ai: v }); } });

        /* Quality. */
        const qualitySelect = w.select(QUALITY_CHOICES.map((c) => ({ value: c.value, label: translate(c.label) })), { value: s.quality, onChange: (v) => { store.set({ quality: v as Quality }); } });

        /* The assistant's knobs. */
        const thinkingBox = w.checkbox(t("Show the model's reasoning summary while it works"), { value: s.showThinking, onChange: (v) => { store.set({ showThinking: v }); } });
        const dockBox = w.checkbox(t("Dock the assistant at the right, under the Properties panel, instead of floating over the map"), { value: s.dockAssistant, onChange: (v) => { store.set({ dockAssistant: v }); } });
        const roundsField = w.number({ value: s.maxRounds, min: 1, max: 100, step: 1, onChange: (v) => { store.set({ maxRounds: Math.max(1, Math.min(100, Math.round(v || 24))) }); } });
        const usd = (v: number) => Math.max(0, Math.min(100, Math.round((Number.isFinite(v) ? v : 0) * 100) / 100));
        const ceilingField = w.number({ value: s.ceilingUsd, min: 0, max: 100, step: 0.05, onChange: (v) => { store.set({ ceilingUsd: usd(v) }); } });
        const scenarioCeilingField = w.number({ value: s.scenarioCeilingUsd, min: 0, max: 100, step: 0.25, onChange: (v) => { store.set({ scenarioCeilingUsd: usd(v) }); } });
        const attachBox = w.checkbox(t("Send a picture of the visible area with every message"), { value: s.attachView, onChange: (v) => { store.set({ attachView: v }); } });
        const followBox = w.checkbox(t("Follow the assistant's work around the map"), { value: s.followMap, onChange: (v) => { store.set({ followMap: v }); } });

        root.append(
          w.group(t("Account"),
            h("div", { className: "ai-btns" }, accountBtn, balance),
            h("div", { className: "ai-hint" }, account.ownKey()
              ? t("AI requests run on your own Anthropic key, below. The account is for the maps you store and the maps you share.")
              : t("The first AI request starts a free trial with no sign-in. Signing in keeps the balance across browsers and adds the sign-in credit; the Account dialog has the balance, the top-up and the activity.")),
          ),
          w.group(t("AI features"),
            aiBox,
            h("div", { className: "ai-hint" }, t("Off takes the Tools ▸ AI menu, the assistant and the AI buttons in the editor's dialogs away. Your account and the maps stored on it stay.")),
          ),
          w.group(t("Quality"),
            w.form([{ label: t("Quality"), field: qualitySelect }]),
            h("div", { className: "ai-hint" }, t("How hard the model works on a request, and so how long it takes and what it costs. Standard gives each feature the setting it was tuned for — laying out maps and writing triggers already work at the highest one. Changing it in the middle of an assistant conversation makes the server re-read the whole conversation once; the next message is a little dearer.")),
          ),
          w.group(t("Spending"),
            w.form([{ label: t("Per assistant message ($)"), field: ceilingField }, { label: t("Per Make Scenario run ($)"), field: scenarioCeilingField }]),
            h("div", { className: "ai-hint" }, t("A ceiling on one message with its tool rounds, and on one design or build. At the ceiling the work stops with the map as edited so far, the assistant offers to continue for as much again, and a build says which step it stopped at. 0 is no ceiling. A message usually costs $0.10–0.30 and a build $0.50–1.00; the server holds the ceiling, so the last call can run a little over it, never a whole extra one.")),
          ),
          h("details", null,
            h("summary", null, t("Assistant")),
            h("div", { className: "ai-body" },
              w.form([{ label: t("Rounds per message"), field: roundsField }]),
              attachBox,
              followBox,
              dockBox,
              thinkingBox,
              h("div", { className: "ai-hint" }, t("A round is one answer from the model followed by the tool calls it asked for; the assistant stops at the limit and offers to continue. A picture costs about as much as a page of text each time. Following moves the view to each call's spot and zooms out when the spot is larger than the view, never in; scroll or zoom yourself during a turn and it stops until the next one. The dock setting applies the next time the assistant opens.")),
            ),
          ),
        );
      }
    },
  });
}
