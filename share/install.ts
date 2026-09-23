/**
 * Shared maps in the editor: Account ▸ Share this Map… and Join a Shared Map…, a cell in
 * the status bar while a map is shared (who is in; a click opens the Share dialog), the
 * other people's pointers and views over the map, and a link opened in the browser
 * (`share/<invite>`) putting the Join dialog up at start. One shared map at a time.
 */
import type { Disposable, OverlayHandle, PluginApi, StatusItemHandle } from "@scm-js/plugin-api";
import type { AccountManager, SettingsStore } from "../account";
import type { ScmjsClient } from "../client";
import { SharedChat } from "./chat";
import { openJoinDialog, openShareDialog, type ShareControls, type ShareCtx } from "./dialogs";
import { forgetLinkOnPage, inviteOnPage } from "./link";
import { doing, drawPeople } from "./presence";
import { SharedMap, type SharedDeps } from "./shared";

export interface ShareOptions {
  api: PluginApi;
  client: ScmjsClient;
  account: AccountManager;
  store: SettingsStore;
  openAccount: () => void;
  openMaps: () => void;
  saveToCloud: () => void;
  /** For the tests: the socket to use instead of the browser's WebSocket. */
  socket?: SharedDeps["socket"];
  /** The page's path; the browser's by default. */
  pathname?: string;
}

export function installShare(opts: ShareOptions): () => void {
  const { api, client } = opts;
  const disposables: Disposable[] = [];
  let shared: SharedMap | null = null;
  let status: StatusItemHandle | null = null;
  let overlay: OverlayHandle | null = null;
  let unhook: (() => void)[] = [];
  let chat: SharedChat | null = null;
  /** The invite the page was opened with, until someone joins with it. */
  let pageInvite: string | null = null;

  const ctx: ShareCtx = { api, account: opts.account, store: opts.store, openAccount: opts.openAccount, openMaps: opts.openMaps, saveToCloud: opts.saveToCloud };
  const deps: SharedDeps = { api, client, socket: opts.socket };

  const onSharedMap = () => shared !== null && shared.documentId !== null && api.document.id() === shared.documentId;
  const others = () => (shared ? [...shared.people.values()].filter((p) => p.id !== shared!.you?.id) : []);

  const syncStatus = () => {
    if (!shared || shared.phase === "ended") { status?.remove(); status = null; return; }
    const n = shared.people.size;
    const text = shared.phase === "connecting" ? "Sharing…" : `Shared · ${n} ${n === 1 ? "person" : "people"}`;
    const lines = [...shared.people.values()].map((p) => `${p.name}${p.id === shared!.you?.id ? " (you)" : ""}${p.owner ? " · shared the map" : ""}${doing(shared!.presence.get(p.id)) ? ` · ${doing(shared!.presence.get(p.id))}` : ""}`);
    const spec = { text, title: `${shared.room?.name ?? "Shared map"}\n${lines.join("\n")}\nClick to see the link and who is in.`, busy: shared.phase === "connecting", onClick: () => { openShareDialog(ctx, controls); } };
    if (status) status.set(spec);
    else status = api.ui.statusItem(spec);
  };

  /** Where this person is, for the others: the pointer (from the overlay), the view, the layer, the dialog on top. */
  const tell = () => {
    if (!shared) return;
    const dialogs = api.ui.openDialogs().filter((d) => d !== "pluginDialog");
    shared.setPresence({ view: api.view.visible(), layer: api.selection.layer(), dialog: dialogs.at(-1) ?? null });
  };

  const attach = (s: SharedMap) => {
    shared = s;
    // The chat once the map is live, and only from a server that has one (welcome.chat).
    const syncChat = () => { if (!chat && s.phase === "live" && s.chat !== null) chat = new SharedChat(api, s); };
    unhook.push(s.onChange(() => {
      syncStatus();
      syncChat();
      if (s.phase === "ended") detach(s);
    }));
    syncChat();
    unhook.push(s.onPresence(() => overlay?.redraw()));
    overlay = api.ui.overlay({
      name: "People on the shared map",
      above: "everything",
      // Only over the shared map: with several open, the others' pointers mean nothing on the rest.
      draw: (c, view) => { if (shared && onSharedMap()) drawPeople(c, view, others(), shared.presence); },
      onHover: (p) => { shared?.setPresence(p && p.inMap && onSharedMap() ? { px: p.px, py: p.py } : { px: null, py: null }); },
    });
    for (const event of ["view", "layer", "dialogs"] as const) {
      const d = api.events.on(event, tell);
      unhook.push(() => d.dispose());
    }
    tell();
    syncStatus();
  };

  const detach = (s: SharedMap) => {
    if (shared !== s) return;
    for (const u of unhook) u();
    unhook = [];
    chat?.dispose();
    chat = null;
    overlay?.remove();
    overlay = null;
    shared = null;
    syncStatus();
    if (s.ending) api.ui.toast({ kind: "warn", title: "Shared editing ended", detail: s.ending, ttl: 0 });
  };

  const controls: ShareControls = {
    current: () => shared,
    share: async (name) => {
      if (shared && shared.phase !== "ended") return shared;
      const s = await SharedMap.share(deps, name);
      attach(s);
      return s;
    },
    join: async (invite, name) => {
      shared?.leave(false);
      const s = await SharedMap.join(deps, invite, name);
      if (invite === pageInvite) pageInvite = null;
      attach(s);
      api.ui.toast({ kind: "ok", title: `Joined “${s.room?.name ?? "the shared map"}”`, detail: `${s.people.size} ${s.people.size === 1 ? "person" : "people"} editing it.` });
      return s;
    },
  };

  disposables.push(api.commands.register({ id: "share", title: "Share this Map…", enabled: () => api.document.isOpen() || !!shared, run: () => { openShareDialog(ctx, controls); } }));
  disposables.push(api.commands.register({ id: "join", title: "Join a Shared Map…", run: () => { openJoinDialog(ctx, controls, pageInvite); } }));
  disposables.push(api.menu.add("Account", { label: "Share this Map…", icon: "plugin", command: "share", separator: true }));
  disposables.push(api.menu.add("Account", { label: "Join a Shared Map…", icon: "plugin", command: "join" }));

  // Opened from a link: the invite comes off the address (a reload must not join twice) and the Join dialog goes up.
  // A `share/<invite>` path goes back to the editor's own, so a reload opens the editor and not the link again.
  const pathname = opts.pathname ?? (typeof location !== "undefined" ? location.pathname : "/");
  // The invite is kept until it is used, so closing the dialog does not lose it: Join a Shared Map… offers it again.
  pageInvite = inviteOnPage(pathname);
  if (pageInvite) {
    forgetLinkOnPage();
    openJoinDialog(ctx, controls, pageInvite);
  }

  return () => {
    shared?.leave(false);
    for (const d of disposables) d.dispose();
  };
}
