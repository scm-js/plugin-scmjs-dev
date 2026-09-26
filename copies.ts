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
import { openEmbedDialog } from "./share/embed";
import { copyLink, copyTokenFrom } from "./share/link";
import { t } from "./i18n";
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
  const copy = w.button(t("Copy"), { onClick: async () => {
    try { await navigator.clipboard.writeText(field.value); say(t("The link is on the clipboard."), "ok"); }
    catch { field.select(); say(t("Select the link and copy it."), "warn"); }
  } });
  return h("div", { className: "sd-link" }, field, copy);
}

function which(link: MapLinkView): string {
  return link.revision === null ? t("the newest save") : t("revision #{n}", { n: link.revision });
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
    const remove = w.button(t("Remove"), { ghost: true, onClick: async () => {
      if (!(await api.ui.confirm(t("Remove this link to {name}? Anyone who has it can no longer open the map. The map stays on your account.", { name: map.name }), { title: t("Remove link"), confirmLabel: t("Remove"), danger: true }))) return;
      try { await update(await client.deleteLink(map.id, link.token)); say(t("Link removed."), "ok"); }
      catch (err) { say(describeError(err), "error"); }
    } });
    const card = link.card;
    const embed = card ? w.button(t("Embed…"), { ghost: true, title: t("A picture of the map that opens this link, for a forum, a README or a website"), onClick: () => {
      openEmbedDialog(ctx, { name: map.name, copy: async () => ({ link: linkAddress(ctx, link.token), card }) });
    } }) : null;
    box.append(h("div", { className: "sd-link-row" },
      linkField(ctx, linkAddress(ctx, link.token), say),
      h("span", { className: "sd-sub", title: t("Made {date}", { date: formatDate(link.createdAt) }) }, t("{which} · opened {n}×", { which: which(link), n: link.opens })),
      embed ?? h("span", null),
      remove,
    ));
  }
  const make = (pin: number | null) => async () => {
    try {
      const r = await client.createLink(map.id, pin);
      await update({ map: r.map, storage: await client.storage().then((s) => s.storage) });
      try { await navigator.clipboard.writeText(linkAddress(ctx, r.link.token)); say(t("Link to {which} made and copied.", { which: which(r.link) }), "ok"); }
      catch { say(t("Link to {which} made.", { which: which(r.link) }), "ok"); }
    } catch (err) { say(describeError(err), "error"); }
  };
  return h("div", null,
    h("div", { className: "sd-hint" }, map.linkList.length
      ? t("Anyone with one of these links can open a copy of this map in their editor, without signing in. The copy is theirs; nothing they do changes yours.")
      : t("No links. A link lets anyone open a copy of this map in their editor, without signing in.")),
    box,
    h("div", { className: "sd-btns" },
      w.button(t("Link to #{n}", { n: revision }), { onClick: make(revision), title: t("The link always opens this revision.") }),
      w.button(t("Link to the newest"), { onClick: make(null), title: t("The link opens whichever revision is newest when it is opened.") }),
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
    title: t("Copy Link to This Map"),
    mount(body, dialog) {
      const root = styled(body);
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);
      const info = api.document.info();
      if (!info) { root.append(h("div", { className: "sd-hint" }, t("Open a map first."))); return; }
      if (account.kind() !== "account") {
        root.append(
          h("div", { className: "sd-hint" }, t("A link opens a map kept on your scmjs.dev account, so making one takes an account. The people who open it need only the link.")),
          h("div", { className: "sd-btns" }, w.button(t("Sign in…"), { primary: true, onClick: () => { dialog.close(); ctx.openAccount(); } })),
        );
        return;
      }
      const stored = links.get();
      const follow = w.checkbox(t("Let the link follow my later saves to this map"), { value: false });
      const make = w.button(t("Save and make the link"), { primary: true, onClick: async () => {
        make.setBusy(true);
        dialog.setBusy(t("Saving…"));
        try {
          const { response, fileName } = await uploadOpenMap(ctx, { mapId: stored?.mapId ?? null, note: "Shared with a link", thumbnail: true }, (text) => status.busy(text));
          links.set({ mapId: response.map.id, mapName: response.map.name, fileName });
          status.busy(t("Making the link…"));
          const { link } = await account.client.createLink(response.map.id, follow.input.checked ? null : response.map.head.number);
          clear(root);
          root.append(
            h("div", { className: "sd-hint" }, t("Saved as {name} #{n}. Anyone with this link can open a copy of it in their editor, without signing in:", { name: response.map.name, n: response.map.head.number })),
            linkField(ctx, linkAddress(ctx, link.token), say),
            h("div", { className: "sd-hint" }, t("Account ▸ My Maps… lists the map's links, how often each was opened, and removes them.")),
            status,
          );
          try { await navigator.clipboard.writeText(linkAddress(ctx, link.token)); say(t("The link is on the clipboard."), "ok"); } catch { say(""); }
        } catch (err) {
          say(describeError(err), "error");
        } finally {
          make.setBusy(false);
          dialog.setBusy(false);
        }
      } });
      root.append(
        h("div", { className: "sd-hint" }, stored
          ? t("The open map is saved to your account as a new revision of {name}, and you get a link anyone can open a copy of it with, without signing in.", { name: stored.mapName })
          : t("The open map is saved to your account as a new map, and you get a link anyone can open a copy of it with, without signing in.")),
        follow,
        h("div", { className: "sd-hint" }, t("The people who open it get their own copy. Nothing they change reaches yours; to edit it together, use Share this Map… instead.")),
        h("div", { className: "sd-btns" }, make),
        status,
      );
    },
    buttons: [{ label: t("Close") }],
  });
}

/* ── Open a Copy ──────────────────────────────────────────── */

/** What a link opens, and a button that opens it. `given` is the token from the page's address, or null to ask for a link. */
export function openCopyDialog(ctx: Ctx, given: string | null, onOpened: (token: string) => void = () => {}): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  return api.ui.dialog({
    title: t("Open a Copy"),
    mount(body, dialog) {
      const root = styled(body);
      const status = w.statusLine({ text: "" });
      const say = (text: string, kind?: "ok" | "warn" | "error") => status.set(text, kind);
      const about = h("div", null);
      let found: PublicMapView | null = null;
      let looking: AbortController | null = null;
      const field = w.text({ value: given ?? "", placeholder: t("Paste the link you were sent") });

      const renderAbout = () => {
        clear(about);
        const m = found;
        if (!m) return;
        const line = describeMeta(m.meta);
        about.append(h("div", { className: "sd-map sd-card" },
          h("div", { className: "sd-thumb" }, m.meta.thumbnail ? h("img", { src: m.meta.thumbnail, alt: "" }) : h("span", null, t("map"))),
          h("div", null,
            h("div", { className: "sd-name" }, m.name),
            m.owner ? h("div", { className: "sd-sub" }, t("Shared by {owner}", { owner: m.owner })) : null,
            line ? h("div", { className: "sd-sub" }, line) : null,
            h("div", { className: "sd-sub", title: formatDate(m.savedAt) }, t("Revision #{n}, saved {ago}", { n: m.revision, ago: ago(m.savedAt) })),
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
        if (!token) { say(field.value.trim() ? t("That is not a map link.") : ""); return; }
        const ctl = new AbortController();
        looking = ctl;
        status.busy(t("Looking it up…"));
        try {
          found = (await account.client.linkedMap(token, ctl.signal)).map;
          renderAbout();
          open.disabled = false;
          say("");
        } catch (err) {
          if (!ctl.signal.aborted) say(describeError(err), "error");
        }
      };

      const open = w.button(t("Open a copy"), { primary: true, onClick: async () => {
        const token = copyTokenFrom(field.value);
        if (!token) { say(t("That is not a map link."), "error"); return; }
        open.setBusy(true);
        try {
          status.busy(t("Downloading…"));
          const { bytes, fileName } = await account.client.linkedFile(token);
          const opened = await api.document.open(bytes, found?.fileName ?? fileName);
          if (opened) {
            onOpened(token);
            dialog.close();
            api.ui.toast({ kind: "ok", title: t("Opened a copy of {name}", { name: found?.name ?? fileName }), detail: t("It is yours: File ▸ Save asks where to keep it.") });
          } else say(t("Not opened."));
        } catch (err) { say(describeError(err), "error"); }
        finally { open.setBusy(false); }
      } });

      field.addEventListener("input", () => void lookUp());
      root.append(
        given ? h("div", null) : w.form([{ label: t("Link"), field }]),
        about,
        h("div", { className: "sd-hint" }, t("The map opens as a new file in your editor. It is your own copy: nothing you change reaches the person who shared it.")),
        h("div", { className: "sd-btns" }, open),
        status,
      );
      if (given) void lookUp();
      return () => looking?.abort();
    },
    buttons: [{ label: t("Cancel") }],
  });
}
