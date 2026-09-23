/**
 * Maps kept open: the words for how long, and the owner's list of shared maps (Account
 * dialog ▸ Shared maps, and Share this Map… when the account is at its limit) — who is
 * in each, the last edit, when it ends, and Join / Copy link / New link / how long / End.
 */
import { describeError } from "../client";
import type { KeepDays, SharedMapView } from "../protocol";
import { ago, clear, formatDate, h, shortDay, type Ctx } from "../ui";
import type { ShareControls } from "./dialogs";
import { copyLink, inviteLink } from "./link";
import { openEmbedDialog, type EmbedTarget } from "./embed";

const here = () => (typeof location !== "undefined" ? location : null);

/**
 * What an embed of a kept map can point at: a copy link to its newest revision (one that
 * follows later saves; made the first time), or the shared map's own link.
 */
export function keptEmbedTarget(ctx: Ctx, view: SharedMapView): EmbedTarget | null {
  if (view.kind !== "kept" || !view.card) return null;
  const { account } = ctx;
  return {
    name: view.name,
    edit: { link: inviteLink(view.invite, account.serverUrl(), here()), card: view.card },
    copy: async () => {
      const { map } = await account.client.map(view.id);
      let link = map.linkList.find((l) => l.revision === null) ?? null;
      if (!link) link = (await account.client.createLink(view.id, null)).link;
      if (!link.card) throw new Error("this server has no pictures for links yet.");
      return { link: copyLink(link.token, account.serverUrl(), here()), card: link.card };
    },
  };
}

/** The *Keep it open…* choices, as the select holds them. */
export type KeepChoice = "live" | "1" | "7" | "30" | "forever";

export const KEEP_CHOICES: { value: KeepChoice; label: string }[] = [
  { value: "live", label: "Until everyone leaves" },
  { value: "1", label: "For a day" },
  { value: "7", label: "For a week" },
  { value: "30", label: "For a month" },
  { value: "forever", label: "Until I end it" },
];

/** A choice as the server takes it; undefined for a map that is not kept. */
export function keepDaysOf(choice: string): KeepDays | undefined {
  if (choice === "live") return undefined;
  if (choice === "forever") return null;
  const n = Number(choice);
  return n === 1 || n === 7 || n === 30 ? n : 7;
}

export function choiceOf(keepDays: KeepDays | undefined): KeepChoice {
  if (keepDays === undefined) return "live";
  if (keepDays === null) return "forever";
  return String(keepDays) as KeepChoice;
}

/** What the choice does, in a sentence or two, for the Share dialog. */
export function keepHint(choice: string): string {
  if (choice === "live") return "The map is on scmjs.dev only while it is shared: sharing ends when you stop it, half an hour after the last person leaves, or when the server restarts. Everyone keeps the map in their editor and can save it.";
  const span = choice === "1" ? "a day" : choice === "30" ? "a month" : "a week";
  return `The map is saved to My Maps and stays open at its link, so people can come and go. Each time everyone has left, it saves a new revision. ${choice === "forever" ? "It stays open until you end it (or after a year with no edits)" : `It ends after ${span} with no edits`}, and the map stays in My Maps.`;
}

/** "Ends 3 Oct unless someone edits it" / "Until you end it" / "Until everyone leaves". */
export function endsLine(v: { keepDays?: KeepDays; endsAt?: string }): string {
  if (v.keepDays === undefined) return "Until everyone leaves";
  if (v.keepDays === null) return "Until you end it";
  return v.endsAt ? `Ends ${shortDay(v.endsAt)} unless someone edits it` : "Kept open";
}

/** The first letter lower-cased, for a line that goes on after something else (dates and names keep their capitals). */
export const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The account's shared maps with the owner's buttons. `onJoined` hears when Join put the
 * person in one (the dialog it sits in may want to close); `onChange` when the list changed.
 */
export function sharedMapsList(ctx: Ctx, controls: ShareControls, opts: { onJoined?: () => void; onChange?: (rooms: SharedMapView[]) => void } = {}): { el: HTMLElement; reload: () => Promise<void> } {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  const el = h("div", { className: "sd-shared" });
  const status = w.statusLine({ text: "" });
  let rooms: SharedMapView[] = [];
  let limit = 0;

  const render = () => {
    clear(el);
    if (!rooms.length) { el.append(h("div", { className: "sd-hint" }, "You are not sharing any maps."), status); return; }
    el.append(h("div", { className: "sd-hint" }, `${rooms.length} of ${limit} shared maps.`));
    for (const r of rooms) {
      const inIt = controls.current()?.room?.id === r.id && controls.current()?.phase !== "ended";
      const lines = [
        r.kind === "kept" ? `Kept open · ${lower(endsLine(r))}` : "Open until everyone leaves",
        r.people.length ? `In it now: ${r.people.join(", ")}` : "Nobody in it now",
        r.kind === "kept" && r.lastEditAt ? `Last edit ${ago(r.lastEditAt)}${r.lastEditBy ? ` by ${r.lastEditBy}` : ""}` : "",
      ].filter(Boolean);
      const buttons = h("div", { className: "sd-btns" });
      if (!inIt) {
        buttons.append(w.button("Join", { onClick: async () => {
          status.busy(`Joining ${r.name}…`);
          try { await controls.join(r.invite, account.current()?.name ?? "Owner"); status.set(""); opts.onJoined?.(); }
          catch (err) { status.set(describeError(err), "error"); }
        } }));
      }
      buttons.append(w.button("Copy link", { onClick: async () => {
        try { await navigator.clipboard.writeText(inviteLink(r.invite, account.serverUrl(), typeof location !== "undefined" ? location : null)); status.set("The link is on the clipboard.", "ok"); }
        catch { status.set("The clipboard is not available here.", "warn"); }
      } }));
      buttons.append(w.button("New link", { onClick: async () => {
        try { const { room } = await account.client.relinkSharedMap(r.id); replace(room); status.set("The old link no longer works. Nobody in the map was sent out.", "ok"); }
        catch (err) { status.set(describeError(err), "error"); }
      } }));
      if (r.kind === "kept") {
        const how = w.select(KEEP_CHOICES.filter((c) => c.value !== "live"), { value: choiceOf(r.keepDays), title: "How long it stays open after its last edit", onChange: async (v) => {
          try { const { room } = await account.client.keepSharedMap(r.id, keepDaysOf(v) ?? null); replace(room); status.set(endsLine(room) + ".", "ok"); }
          catch (err) { status.set(describeError(err), "error"); }
        } });
        buttons.append(how);
      }
      const target = keptEmbedTarget(ctx, r);
      if (target) buttons.append(w.button("Embed…", { title: "A picture of the map that links to it, for a forum, a README or a website", onClick: () => { openEmbedDialog(ctx, target); } }));
      buttons.append(w.button("End sharing", { danger: true, onClick: async () => {
        const text = r.kind === "kept"
          ? `End sharing “${r.name}”? Anyone in it is sent out and the link stops working. The map and its revisions stay in My Maps.`
          : `End sharing “${r.name}”? Anyone in it is sent out; they keep their copy and can save it.`;
        if (!(await api.ui.confirm(text, { title: "End sharing", confirmLabel: "End sharing", danger: true }))) return;
        try { const res = await account.client.endSharedMap(r.id); rooms = res.rooms; limit = res.limit; render(); opts.onChange?.(rooms); status.set("Sharing ended.", "ok"); }
        catch (err) { status.set(describeError(err), "error"); }
      } }));
      el.append(h("div", { className: "sd-shared-row" },
        h("div", { className: "sd-name" }, r.name, inIt ? h("span", { className: "sd-sub" }, " · you are in it") : null),
        ...lines.map((l) => h("div", { className: "sd-sub" }, l)),
        h("div", { className: "sd-sub", title: formatDate(r.createdAt) }, `Shared ${ago(r.createdAt)}`),
        buttons,
      ));
    }
    el.append(status);
  };

  const replace = (room: SharedMapView) => {
    rooms = rooms.map((r) => (r.id === room.id ? room : r));
    render();
    opts.onChange?.(rooms);
  };

  const reload = async () => {
    status.busy("Loading your shared maps…");
    if (!el.contains(status)) { clear(el); el.append(status); }
    try {
      const res = await account.client.sharedMaps();
      rooms = res.rooms;
      limit = res.limit;
      status.set("");
      render();
      opts.onChange?.(rooms);
    } catch (err) {
      clear(el);
      el.append(status);
      status.set(describeError(err), "error");
    }
  };
  void reload();
  return { el, reload };
}
