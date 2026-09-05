/**
 * The AI features: everything the plugin adds to the editor that talks to the model.
 * `installAi` registers the lot — the Tools ▸ AI menu, the assistant and its hotkey,
 * the context-menu items, the "AI" status cell and the buttons inside the editor's own
 * dialogs — and returns the cleanup that takes every one of them out again, which is
 * what the *Use the AI features* tick does. The account, the client and the settings
 * are the plugin's, handed in; nothing here holds a session of its own.
 *
 * `protocol.ts` (at the root) is the wire contract shared with the server; `plan.ts` /
 * `grid.ts` turn the layout language into brush strokes; `render.ts` applies a plan as
 * one undo step; `tools.ts` and `assistant.ts` are the tool-using conversation; the
 * dialogs are under `dialogs/`; `slots.ts` is what goes inside the editor's own dialogs,
 * `ums.ts` the toolkit of trigger systems and `guides.ts` the genre guides behind Make
 * Scenario and the assistant.
 */
import type { Disposable, PluginApi } from "@scm-js/plugin-api";
import type { AccountManager, SettingsStore } from "../account";
import type { ScmjsClient } from "../client";
import { openAssistant, type AssistantHandle, type AssistantState } from "./assistant";
import { openBriefing, openDescribe } from "./dialogs/describe";
import { openExplain } from "./dialogs/explain";
import { openGenerate } from "./dialogs/generate";
import { openRegion } from "./dialogs/region";
import { openReview } from "./dialogs/review";
import { openScenario } from "./dialogs/scenario";
import { openStrings } from "./dialogs/strings";
import { openTriggers } from "./dialogs/triggers";
import { openOptions } from "./options";
import { installDialogSlots } from "./slots";
import type { Ctx } from "./ui";

export interface AiDeps {
  api: PluginApi;
  store: SettingsStore;
  client: ScmjsClient;
  account: AccountManager;
  openAccount: () => void;
}

export function installAi(deps: AiDeps): () => void {
  const { api, store, client, account } = deps;
  const out: Disposable[] = [];
  const ctx: Ctx = { api, settings: () => store.get(), client, ledger: client.ledger, account, openSettings: () => openOptions(ctx, store), openAccount: deps.openAccount, presence: null };
  const assistant: AssistantState = { messages: [] };
  let assistantPanel: AssistantHandle | null = null;
  const open = () => api.document.isOpen();
  const showAssistant = () => { if (!assistantPanel?.isOpen()) assistantPanel = openAssistant(ctx, assistant); return assistantPanel; };
  const toggleAssistant = () => {
    if (assistantPanel?.isOpen()) { assistantPanel.close(); assistantPanel = null; return; }
    assistantPanel = openAssistant(ctx, assistant);
  };
  // The AI cell in the status bar: "AI" when idle, the assistant's phase while it works, a click opens the panel.
  ctx.presence = api.ui.statusItem({ text: "AI", title: "AI Assistant (Ctrl+Shift+A)", onClick: toggleAssistant });

  out.push(api.commands.register({ id: "generate", title: "AI: Generate Map", run: () => openGenerate(ctx) }));
  out.push(api.commands.register({ id: "scenario", title: "AI: Make Scenario", run: (prompt?: unknown) => openScenario(ctx, typeof prompt === "string" ? prompt : undefined) }));
  out.push(api.commands.register({ id: "assistant", title: "AI: Assistant", run: toggleAssistant }));
  out.push(api.commands.register({ id: "ask", title: "AI: Ask about this", run: (text?: unknown) => { showAssistant().ask(typeof text === "string" ? text : "", false); } }));
  out.push(api.commands.register({ id: "ai-options", title: "AI: Options", run: () => ctx.openSettings() }));

  const menu = "Tools/AI" as const;
  out.push(api.menu.add(menu, { label: "Make Scenario…", icon: "plugin", command: "scenario" }));
  out.push(api.menu.add(menu, { label: "Generate Map…", icon: "plugin", command: "generate" }));
  out.push(api.menu.add(menu, { label: "Redo Area…", icon: "plugin", enabled: open, run: () => void openRegion(ctx) }));
  out.push(api.menu.add(menu, { label: "Write Triggers…", icon: "plugin", enabled: open, run: () => openTriggers(ctx) }));
  out.push(api.menu.add(menu, { label: "Explain Triggers…", icon: "plugin", enabled: open, run: () => openExplain(ctx) }));
  out.push(api.menu.add(menu, { label: "Name and Describe…", icon: "plugin", enabled: open, run: () => openDescribe(ctx) }));
  out.push(api.menu.add(menu, { label: "Write Briefing…", icon: "plugin", enabled: open, run: () => openBriefing(ctx) }));
  out.push(api.menu.add(menu, { label: "Review Map…", icon: "plugin", enabled: open, run: () => openReview(ctx) }));
  out.push(api.menu.add(menu, { label: "Rewrite Strings…", icon: "plugin", enabled: open, run: () => openStrings(ctx) }));
  out.push(api.menu.add(menu, { label: "Assistant", shortcut: "Ctrl+Shift+A", icon: "plugin", enabled: open, separator: true, command: "assistant" }));
  out.push(api.menu.add(menu, { label: "Options…", icon: "plugin", separator: true, command: "ai-options" }));

  out.push(api.contextMenu.add("viewport", {
    label: "Redo this area with AI…",
    visible: (c) => c.markedArea !== null,
    run: (c) => void openRegion(ctx, c.markedArea),
  }));
  out.push(api.contextMenu.add("viewport", {
    label: (c) => (c.markedArea ? "Ask AI about this area…" : api.selection.units().length || api.selection.locations().length || api.selection.sprites().length || api.selection.doodads().length ? "Ask AI about the selection…" : "Ask AI about this spot…"),
    enabled: open,
    run: (c) => {
      const where = c.markedArea
        ? `the marked area, tiles ${Math.min(c.markedArea.x0, c.markedArea.x1)},${Math.min(c.markedArea.y0, c.markedArea.y1)} to ${Math.max(c.markedArea.x0, c.markedArea.x1)},${Math.max(c.markedArea.y0, c.markedArea.y1)}`
        : api.selection.units().length || api.selection.locations().length || api.selection.sprites().length || api.selection.doodads().length ? "what I have selected"
        : c.tile ? `the spot at tile ${c.tile.x},${c.tile.y}` : "here";
      showAssistant().ask(`About ${where}: `, false);
    },
  }));

  out.push(api.hotkeys.add("Ctrl+Shift+A", { command: "assistant" }));

  // The buttons inside the editor's own dialogs: Map Properties, the trigger editors, the String Editor, Player Settings, Mission Briefing.
  const removeSlots = installDialogSlots(ctx, { assistant: (text) => showAssistant().ask(text, false), explain: () => openExplain(ctx), triggers: () => openTriggers(ctx), strings: () => openStrings(ctx), briefing: () => openBriefing(ctx) });

  return () => {
    assistantPanel?.close();
    assistantPanel = null;
    removeSlots();
    for (const d of out.splice(0)) d.dispose();
    ctx.presence?.remove();
    ctx.presence = null;
  };
}
