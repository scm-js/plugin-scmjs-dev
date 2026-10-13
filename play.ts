/**
 * Tools ▸ Test Map in Browser: the open map, played on the site's play page
 * (`scmjs.dev/play/`), which runs StarCraft's own game in a browser tab from the copy of
 * the game the person has given the site. The editor's own Test Map writes the map where
 * the installed game lists it; this needs no installed game running.
 *
 * The play page is another program on the same origin, so the map is handed to it by
 * message and never stored or sent anywhere:
 *
 *   ← `{ type: "scmjs.play.ready" }`                       the play page, each time it loads
 *   → `{ type: "scmjs.play", map, name, useMapSettings }`  the map as Save would write it
 *   ← `{ type: "scmjs.play.started" }` / `{ type: "scmjs.play.error", message }`
 *
 * "Ready" comes again when the play page starts over (a first visit takes the game's files
 * and reloads), and the map is handed over again each time, for as long as that tab is
 * open. Testing again sends the new map to the same tab.
 *
 * Only where there is a play page to hand to: the editor at scmjs.dev, or a stand-in for
 * the site on one's own machine. The desktop app and an editor hosted elsewhere have no
 * such page on their origin and do not get the menu item.
 */
import type { Disposable, PluginApi } from "@scm-js/plugin-api";
import { msg, t } from "./i18n";

/** The window's name: one tab for testing, found again by the next test. */
const TAB = "scmjs-play";

/** The play page of the origin this editor is served from, or null where there is none. */
export function playAddress(at: { origin: string; hostname: string; pathname: string }): string | null {
  if (at.origin === "https://scmjs.dev") return "https://scmjs.dev/play/";
  // A stand-in for the site on this machine serves the editor under /editor/ and the play page beside it.
  if (/^(localhost|127\.0\.0\.1)$/.test(at.hostname) && at.pathname.startsWith("/editor/")) return `${at.origin}/play/`;
  return null;
}

export function installPlay(api: PluginApi): Disposable {
  const address = typeof location === "undefined" ? null : playAddress(location);
  if (!address) return { dispose() {} };
  const origin = new URL(address).origin;
  let tab: Window | null = null;
  /** What the tab is given whenever it says it is ready. */
  let map: { bytes: Uint8Array; name: string } | null = null;
  let ready = false;
  const hand = () => {
    if (!tab || tab.closed || !map || !ready) return;
    // (A copy: the bytes stay here for the next time the tab asks.)
    tab.postMessage({ type: "scmjs.play", map: map.bytes.slice(), name: map.name, useMapSettings: true }, origin);
  };
  const heard = (e: MessageEvent) => {
    if (e.origin !== origin || !tab || e.source !== tab) return;
    const m = e.data as { type?: unknown; message?: unknown } | null;
    if (!m || typeof m.type !== "string") return;
    if (m.type === "scmjs.play.ready") { ready = true; hand(); }
    else if (m.type === "scmjs.play.started") api.ui.status(t("The map is running on the play page."));
    else if (m.type === "scmjs.play.error") api.ui.status(t("The play page could not start the map: {message}", { message: String(m.message ?? "") }));
  };
  window.addEventListener("message", heard);

  const command = api.commands.register({
    id: "play",
    title: msg("Test Map in Browser"),
    enabled: () => api.document.isOpen(),
    run: async () => {
      // The tab is opened before anything is awaited: a browser lets a click open a tab, not what follows it later.
      const reuse = tab !== null && !tab.closed;
      if (!reuse) { ready = false; tab = window.open(address, TAB); }
      if (!tab) { api.ui.status(t("The browser did not let the play page open. Allow pop-ups for this site and try again.")); return; }
      const file = await api.document.export({ format: "scx" });
      if (!file) return;
      map = { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
      if (reuse) tab.focus();
      hand();
    },
  });
  const item = api.menu.add("Tools", { label: msg("Test Map in Browser"), icon: "plugin", after: "Test Map Settings…", command: "play" });
  return { dispose() { window.removeEventListener("message", heard); command.dispose(); item.dispose(); } };
}
