/**
 * Copy links: `<editor>/map/<token>` opens a copy of a stored map in whoever's editor
 * the link is opened in, signed in or not. The owner makes them in My Maps (a link to
 * one revision, or to whichever is newest) or with Account ▸ Copy Link to This Map…,
 * which saves the open map first; the person who opens one gets the Open a Copy dialog,
 * and the map opens as a new, untitled file of theirs — Save asks where it goes.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { describeError } from "./client";
import { describeMeta, uploadOpenMap, type Link } from "./maps";
import type { MapDetail, MapLinkView, MapResponse, PublicMapView } from "./protocol";
import { copyLink, copyTokenFrom } from "./share/link";
import { ago, clear, formatDate, h, styled, type Ctx } from "./ui";

const where = () => (typeof location !== "undefined" ? { protocol: location.protocol, origin: location.origin, pathname: location.pathname } : null);

/** The address a link's token makes, from the editor this is running in. */
export function linkAddress(ctx: Ctx, token: string): string {
  return copyLink(token, ctx.account.serverUrl(), where());
}

/** A read-only field with the link in it and a Copy button. */
function linkField(ctx: Ctx, address: string, say: (text: string, kind?: "ok" | "warn" | "error") => void): HTMLElement {
  const w = ctx.api.ui.widgets;
  const field = w.text({ value: address });
  field.readOnly = true;
  const copy = w.button("Copy", { onClick: async () => {
    try { await navigator.clipboard.writeText(field.value); say("The link is on the clipboard.", "ok"); }
    catch { field.select(); say("Select the link and copy it.", "warn"); }
  } });
  return h("div", { className: "sd-link" }, field, copy);
}

function which(link: MapLinkView): string {
  return link.revision === null ? "the newest save" : `revision #${link.revision}`;
}

/* ── In My Maps ───────────────────────────────────────────── */

/**
 * The picked map's links, and buttons to make one to the revision in view or to the
 * newest. `update` takes the map the server answers with after a change.
 */
export function linksSection(ctx: Ctx, map: MapDetail, revision: number, update: (r: MapResponse) => Promise<void>, say: (text: string, kind?: "ok" | "warn" | "error") => void): HTMLElement {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  const client = account.client;
  const box = h("div", { className: "sd-links" });
  for (const link of map.linkList) {
    const remove = w.button("Remove", { ghost: true, onClick: async () => {
      if (!(await api.ui.confirm(`Remove this link to ${map.name}? Anyone who has it can no longer open the map. The map stays on your account.`, { title: "Remove link", confirmLabel: "Remove", danger: true }))) return;
      try { await update(await client.deleteLink(map.id, link.token)); say("Link removed.", "ok"); }
      catch (err) { say(describeError(err), "error"); }
    } });
    box.append(h("div", { className: "sd-link-row" },
      linkField(ctx, linkAddress(ctx, link.token), say),
      h("span", { className: "sd-sub", title: `Made ${formatDate(link.createdAt)}` }, `${which(link)} · opened ${link.opens}×`),
      remove,
    ));
  }
  const make = (pin: number | null) => async () => {
    try {
      const r = await client.createLink(map.id, pin);
      await update({ map: r.map, storage: await client.storage().then((s) => s.storage) });
      try { await navigator.clipboard.writeText(linkAddress(ctx, r.link.token)); say(`Link to ${which(r.link)} made and copied.`, "ok"); }
      catch { say(`Link to ${which(r.link)} made.`, "ok"); }
    } catch (err) { say(describeError(err), "error"); }
  };
  return h("div", null,
    h("div", { className: "sd-hint" }, map.linkList.length
      ? "Anyone with one of these links can open a copy of this map in their editor, without signing in. The copy is theirs; nothing they do changes yours."
      : "No links. A link lets anyone open a copy of this map in their editor, without signing in."),
    box,
    h("div", { className: "sd-btns" },
      w.button(`Link to #${revision}`, { onClick: make(revision), title: "The link always opens this revision." }),
      w.button("Link to the newest", { onClick: make(null), title: "The link opens whichever revision is newest when it is opened." }),
    ),
  );
}

/* ── Copy Link to This Map ────────────────────────────────── */

/**
 * The open map, saved to the account and linked in one go: a new map, or a new revision
 * of the one it came from. The link stays on this revision by default — a link posted
 * somewhere should not change under the people who follow it — and can follow the
 * newest save instead.
 */
export function openCopyLinkDialog(ctx: Ctx, links: { get(): Link | null; set(link: Link | null): void }): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  return api.ui.dialog({
    title: "Copy Link to This Map",
    mount(body, dialog) {
      const root = styled(body);
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);
      const info = api.document.info();
      if (!info) { root.append(h("div", { className: "sd-hint" }, "Open a map first.")); return; }
      if (account.kind() !== "account") {
        root.append(
          h("div", { className: "sd-hint" }, "A link opens a map kept on your scmjs.dev account, so making one takes an account. The people who open it need only the link."),
          h("div", { className: "sd-btns" }, w.button("Sign in…", { primary: true, onClick: () => { dialog.close(); ctx.openAccount(); } })),
        );
        return;
      }
      const stored = links.get();
      const follow = w.checkbox("Let the link follow my later saves to this map", { value: false });
      const make = w.button("Save and make the link", { primary: true, onClick: async () => {
        make.setBusy(true);
        dialog.setBusy("Saving…");
        try {
          const { response, fileName } = await uploadOpenMap(ctx, { mapId: stored?.mapId ?? null, note: "Shared with a link", thumbnail: true }, (text) => status.busy(text));
          links.set({ mapId: response.map.id, mapName: response.map.name, fileName });
          status.busy("Making the link…");
          const { link } = await account.client.createLink(response.map.id, follow.input.checked ? null : response.map.head.number);
          clear(root);
          root.append(
            h("div", { className: "sd-hint" }, `Saved as ${response.map.name} #${response.map.head.number}. Anyone with this link can open a copy of it in their editor, without signing in:`),
            linkField(ctx, linkAddress(ctx, link.token), say),
            h("div", { className: "sd-hint" }, "Account ▸ My Maps… lists the map's links, how often each was opened, and removes them."),
            status,
          );
          try { await navigator.clipboard.writeText(linkAddress(ctx, link.token)); say("The link is on the clipboard.", "ok"); } catch { say(""); }
        } catch (err) {
          say(describeError(err), "error");
        } finally {
          make.setBusy(false);
          dialog.setBusy(false);
        }
      } });
      root.append(
        h("div", { className: "sd-hint" }, stored
          ? `The open map is saved to your account as a new revision of ${stored.mapName}, and you get a link anyone can open a copy of it with, without signing in.`
          : "The open map is saved to your account as a new map, and you get a link anyone can open a copy of it with, without signing in."),
        follow,
        h("div", { className: "sd-hint" }, "The people who open it get their own copy. Nothing they change reaches yours; to edit it together, use Share this Map… instead."),
        h("div", { className: "sd-btns" }, make),
        status,
      );
    },
    buttons: [{ label: "Close" }],
  });
}

/* ── Open a Copy ──────────────────────────────────────────── */

/** What a link opens, and a button that opens it. `given` is the token from the page's address, or null to ask for a link. */
export function openCopyDialog(ctx: Ctx, given: string | null, onOpened: (token: string) => void = () => {}): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  return api.ui.dialog({
    title: "Open a Copy",
    mount(body, dialog) {
      const root = styled(body);
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);
      const about = h("div", null);
      let found: PublicMapView | null = null;
      let looking: AbortController | null = null;
      const field = w.text({ value: given ?? "", placeholder: "Paste the link you were sent" });

      const renderAbout = () => {
        clear(about);
        const m = found;
        if (!m) return;
        const line = describeMeta(m.meta);
        about.append(h("div", { className: "sd-map sd-card" },
          h("div", { className: "sd-thumb" }, m.meta.thumbnail ? h("img", { src: m.meta.thumbnail, alt: "" }) : h("span", null, "map")),
          h("div", null,
            h("div", { className: "sd-name" }, m.name),
            m.owner ? h("div", { className: "sd-sub" }, `Shared by ${m.owner}`) : null,
            line ? h("div", { className: "sd-sub" }, line) : null,
            h("div", { className: "sd-sub", title: formatDate(m.savedAt) }, `Revision #${m.revision}, saved ${ago(m.savedAt)}`),
          ),
        ));
        if (m.description) about.append(h("div", { className: "sd-hint" }, m.description));
      };

      const lookUp = async () => {
        looking?.abort();
        found = null;
        renderAbout();
        open.disabled = true;
        const token = copyTokenFrom(field.value);
        if (!token) { say(field.value.trim() ? "That is not a map link." : ""); return; }
        const ctl = new AbortController();
        looking = ctl;
        status.busy("Looking it up…");
        try {
          found = (await account.client.linkedMap(token, ctl.signal)).map;
          renderAbout();
          open.disabled = false;
          say("");
        } catch (err) {
          if (!ctl.signal.aborted) say(describeError(err), "error");
        }
      };

      const open = w.button("Open a copy", { primary: true, onClick: async () => {
        const token = copyTokenFrom(field.value);
        if (!token) { say("That is not a map link.", "error"); return; }
        open.setBusy(true);
        try {
          status.busy("Downloading…");
          const { bytes, fileName } = await account.client.linkedFile(token);
          const opened = await api.document.open(bytes, found?.fileName ?? fileName);
          if (opened) {
            onOpened(token);
            dialog.close();
            api.ui.toast({ kind: "ok", title: `Opened a copy of ${found?.name ?? fileName}`, detail: "It is yours: File ▸ Save asks where to keep it." });
          } else say("Not opened.");
        } catch (err) { say(describeError(err), "error"); }
        finally { open.setBusy(false); }
      } });

      field.addEventListener("input", () => void lookUp());
      root.append(
        given ? h("div", null) : w.form([{ label: "Link", field }]),
        about,
        h("div", { className: "sd-hint" }, "The map opens as a new file in your editor. It is your own copy: nothing you change reaches the person who shared it."),
        h("div", { className: "sd-btns" }, open),
        status,
      );
      if (given) void lookUp();
      return () => looking?.abort();
    },
    buttons: [{ label: "Cancel" }],
  });
}
