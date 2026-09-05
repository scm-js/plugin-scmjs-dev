/**
 * scmjs.dev — a plugin for the scmJS map editor (https://github.com/jeany55/scm-js).
 *
 * Your scmjs.dev account, in the editor:
 *
 * - **Account** menu (top level, before Help): Sign in…, Account…, My Maps…, Save to
 *   scmjs.dev…, Sign out. The two map items are under File as well, beside Open Recent
 *   and Save As.
 * - A cell in the **status bar**: "Sign in to scmjs.dev" as a guest, your name and
 *   balance once signed in. A click opens the Account dialog.
 * - The **Account dialog** (`dialogs.ts`): status, balance and when it refills, storage
 *   used, the ledger, top-up, the site's account page, sign out, and the settings.
 * - **Map storage** (`maps.ts`): maps kept on the account with numbered revisions and
 *   notes, opened back into the editor.
 * - The **`scmjs-dev.account` service** (`contract.d.ts`): the sign-in held out to
 *   other plugins through `api.services`, so the AI plugin follows this one instead of
 *   keeping a session of its own. Off with the tick in the Account dialog's settings.
 *
 * Everything reaches one server, `https://api.scmjs.dev` unless the settings say
 * otherwise (the same ai-server the AI plugin talks to: https://github.com/scm-js/ai-server).
 * `client.ts` is its typed client, `account.ts` the session and the state, `protocol.ts`
 * the wire shapes copied from the server. Every menu item that reaches the network carries
 * the plugin's mark.
 */
import type { Disposable, PluginApi, StatusItemHandle } from "@scm-js/plugin-api";
import { AccountManager, settingsStore } from "./account";
import { formatUsd, ScmjsClient } from "./client";
import { openAccountDialog } from "./dialogs";
import { openMapsDialog, openSaveDialog, type Link } from "./maps";
import type { Ctx } from "./ui";

export const SERVICE_NAME = "account";
export const CONTRACT_VERSION = 1;

export function activate(api: PluginApi) {
  const store = settingsStore(api);
  const client = new ScmjsClient(() => ({ serverUrl: store.get().serverUrl, session: store.get().session }));
  const account = new AccountManager(store, client);

  /** The stored map the open document is linked to, for the session; cleared when another file opens. */
  let link: Link | null = null;
  const links = { get: () => link, set: (l: Link | null) => { link = l; } };
  api.events.on("document", (e) => {
    if (e.reason === "open" && link && link.fileName !== e.fileName) link = null;
    if (e.reason === "new" || e.reason === "close") link = null;
  });

  const ctx: Ctx = {
    api,
    account,
    openAccount: () => { openAccountDialog(ctx); },
    openMaps: () => { openMapsDialog(ctx, links); },
    saveToCloud: () => { openSaveDialog(ctx, links); },
  };

  /* Commands: the menu items, the status bar and other plugins all reach the same ones. */
  api.commands.register({ id: "account", title: "scmjs.dev Account…", run: ctx.openAccount });
  api.commands.register({ id: "sign-in", title: "Sign in to scmjs.dev…", run: async () => {
    if (account.kind() === "account") { ctx.openAccount(); return; }
    try {
      if (!account.offers()) await account.connect();
      const providers = account.offers()?.providers ?? [];
      if (providers.length === 1) { await account.signIn(providers[0]!.id); api.ui.toast({ kind: "ok", title: `Signed in to scmjs.dev as ${account.current()?.name ?? "you"}` }); }
      else ctx.openAccount();
    } catch (err) {
      // A closed popup is not news; anything else is said in the dialog, which has the details.
      if ((err as { code?: string }).code !== "aborted") ctx.openAccount();
    }
  } });
  api.commands.register({ id: "sign-out", title: "Sign out of scmjs.dev", enabled: () => account.kind() !== "guest", run: async () => {
    await account.signOut();
    api.ui.toast({ kind: "info", title: "Signed out of scmjs.dev" });
  } });
  api.commands.register({ id: "maps", title: "My Maps on scmjs.dev…", run: ctx.openMaps });
  api.commands.register({ id: "save", title: "Save to scmjs.dev…", enabled: () => api.document.isOpen(), run: ctx.saveToCloud });

  /* The Account menu, and the two map items under File too. */
  api.menu.add("Account", { label: "Sign in to scmjs.dev…", icon: "plugin", command: "sign-in", enabled: () => account.kind() !== "account" });
  api.menu.add("Account", { label: "Account…", icon: "plugin", command: "account" });
  api.menu.add("Account", { label: "My Maps…", icon: "plugin", command: "maps", separator: true });
  api.menu.add("Account", { label: "Save to scmjs.dev…", icon: "plugin", command: "save" });
  api.menu.add("Account", { label: "Sign out", icon: "plugin", command: "sign-out", separator: true, enabled: () => account.kind() !== "guest" });
  api.menu.add("File", { label: "Open from scmjs.dev…", icon: "plugin", after: "Open Recent", command: "maps" });
  api.menu.add("File", { label: "Save to scmjs.dev…", icon: "plugin", after: "Save Copy As…", command: "save" });

  /* The status bar cell. */
  let status: StatusItemHandle | null = null;
  const statusText = () => {
    switch (account.kind()) {
      case "guest": return "Sign in to scmjs.dev";
      case "trial": { const v = account.current(); return v ? `scmjs.dev trial · ${formatUsd(v.balanceUsd)}` : "scmjs.dev trial"; }
      default: { const v = account.current(); return v ? `${v.name ?? "scmjs.dev"}${v.unlimited ? "" : ` · ${formatUsd(v.balanceUsd)}`}` : "scmjs.dev"; }
    }
  };
  const statusTitle = () => {
    const s = account.state();
    if (s.kind === "guest") return "Not signed in to scmjs.dev. Click to sign in.";
    const v = s.account;
    const lines = [account.summary()];
    if (v?.resetsAt) lines.push(`Refills ${new Date(v.resetsAt).toLocaleDateString()}`);
    if (s.storage) lines.push(`${Math.round(s.storage.usedBytes / 1048576)} MB of ${Math.round(s.storage.capBytes / 1048576)} MB of map storage used`);
    lines.push("Click for your account.");
    return lines.join("\n");
  };
  const syncStatus = () => {
    if (!store.get().statusItem) { status?.remove(); status = null; return; }
    const spec = { text: statusText(), title: statusTitle(), onClick: () => { if (account.kind() === "guest") void api.commands.run("sign-in"); else ctx.openAccount(); } };
    if (status) status.set(spec); else status = api.ui.statusItem(spec);
  };
  syncStatus();
  account.onChange(syncStatus);

  /* The service for other plugins, provided while the tick says so. */
  let provided: Disposable | null = null;
  const syncService = () => {
    const want = store.get().share;
    if (want && !provided) provided = api.services.provide(SERVICE_NAME, account.service(ctx.openAccount), { version: CONTRACT_VERSION });
    else if (!want && provided) { provided.dispose(); provided = null; }
  };
  syncService();
  // The settings ticks live in the dialog; check them after every change of state and on a timer-free path: the store's set.
  const set = store.set;
  store.set = (patch) => { set(patch); syncService(); syncStatus(); };

  /* What the server says about the session, once at activation; a failure is quiet — the dialog will say. */
  void account.connect().then(() => (account.session() ? account.refresh() : null)).catch(() => {});

  return () => { status?.remove(); provided?.dispose(); };
}
