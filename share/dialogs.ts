/**
 * The two dialogs of shared maps. *Share this Map* starts sharing the open map (a signed-in
 * account is needed) and, while it is shared, shows the link, who is in, and the owner's
 * controls. *Join a Shared Map* takes a link, says what it leads to, and joins under the
 * name the person types.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { describeError, ScmjsError } from "../client";
import { t } from "../i18n";
import type { KeepDays, RoomInfo } from "../protocol";
import type { SettingsStore } from "../account";
import { clear, h, styled, type Ctx } from "../ui";
import { inviteFrom, inviteLink } from "./link";
import { doing, personColor } from "./presence";
import { openEmbedDialog } from "./embed";
import { choiceOf, endsLine, keepChoices, keepDaysOf, keepHint, keptEmbedTarget, lower, sharedMapsList } from "./kept";
import type { SharedMap } from "./shared";

/** The dialogs' context: the plugin's, and the settings (the name last typed to join). */
export interface ShareCtx extends Ctx {
  store: SettingsStore;
}

export interface ShareControls {
  current(): SharedMap | null;
  /** Share the map in front; with `keepDays` (a number, or null for until ended), kept open as a stored map. */
  share(name: string, keepDays?: KeepDays): Promise<SharedMap>;
  join(invite: string, name: string): Promise<SharedMap>;
}

const SHARE_STYLE = `
.sd .sd-people { display: flex; flex-direction: column; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-1, #14171d); }
.sd .sd-person { display: grid; grid-template-columns: 12px 1fr auto; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--border, #222); }
.sd .sd-person:last-child { border-bottom: none; }
.sd .sd-swatch { width: 12px; height: 12px; border-radius: 2px; border: 1px solid rgba(0,0,0,0.5); }
.sd .sd-person .sd-sub { color: var(--text-dim, #99a2b3); font-size: 11px; }
`;

function root(body: HTMLElement): HTMLDivElement {
  const r = styled(body);
  const style = document.createElement("style");
  style.textContent = SHARE_STYLE;
  body.prepend(style);
  return r;
}

const where = () => (typeof location !== "undefined" ? { protocol: location.protocol, origin: location.origin, pathname: location.pathname } : null);

/* ── Share this Map ───────────────────────────────────────── */

export function openShareDialog(ctx: ShareCtx, controls: ShareControls): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  let unsubscribe: (() => void) | null = null;
  return api.ui.dialog({
    title: t("Share this Map"),
    mount(body, dialog) {
      const box = root(body);
      const status = w.statusLine({ text: "" });

      const renderStart = () => {
        clear(box);
        if (!api.document.isOpen()) { box.append(w.hint(t("Open a map first."))); return; }
        if (account.kind() !== "account") {
          box.append(
            h("div", { className: "sd-hint" }, t("Sharing a map takes a scmjs.dev account. The people you share it with need only the link.")),
            h("div", { className: "sd-btns" }, w.button(t("Sign in…"), { primary: true, onClick: () => { dialog.close(); ctx.openAccount(); } })),
          );
          return;
        }
        const name = w.text({ value: api.document.info()?.name ?? "" });
        // Keeping it open needs a server that can (0.15.0, with map storage).
        const canKeep = !!account.state().offers?.keptRooms;
        const hint = h("div", { className: "sd-hint" }, keepHint("live"));
        const keep = w.select(keepChoices(), { value: "live", onChange: (v) => { hint.textContent = keepHint(v); } });
        hint.textContent = keepHint(keep.value);
        const full = h("div", null);
        const start = w.button(t("Start sharing"), { primary: true, onClick: async () => {
          start.setBusy(true);
          const keepDays = canKeep ? keepDaysOf(keep.value) : undefined;
          status.busy(keepDays === undefined ? t("Copying the map to scmjs.dev…") : t("Saving the map to My Maps…"));
          clear(full);
          try {
            await controls.share(name.value.trim() || "Untitled map", keepDays);
            status.set("");
            render();
          } catch (err) {
            status.set(describeError(err), "error");
            // At the limit: the maps being shared, each with End, so one can make way.
            if (err instanceof ScmjsError && err.code === "room_full" && /sharing/.test(err.message)) {
              full.append(w.group(t("Your shared maps"), sharedMapsList(ctx, controls, { onJoined: () => dialog.close() }).el));
            }
          } finally {
            start.setBusy(false);
          }
        } });
        box.append(
          h("div", { className: "sd-hint" }, t("Anyone with the link can open this map in their own editor and change it with you, at the same time. Everyone sees the others' changes as they are made, and their pointers on the map.")),
          w.form([{ label: t("Name"), field: name }, ...(canKeep ? [{ label: t("Keep it open"), field: keep }] : [])]),
          hint,
          h("div", { className: "sd-btns" }, start),
          status,
          full,
        );
      };

      const renderLive = (shared: SharedMap) => {
        clear(box);
        const room = shared.room;
        const invite = room?.invite;
        if (shared.phase === "connecting") { box.append(w.spinner({ label: t("Connecting…") })); return; }
        if (shared.phase === "reconnecting") {
          box.append(
            w.spinner({ label: t("Reconnecting…") }),
            h("div", { className: "sd-hint" }, t("The connection to the shared map dropped. Keep working: your changes are kept here and sent once it is back. The editor keeps trying for two minutes.")),
            h("div", { className: "sd-btns" }, w.button(t("Leave"), { onClick: () => shared.leave(false) })),
          );
          return;
        }
        if (invite) {
          const link = w.text({ value: inviteLink(invite, account.serverUrl(), where()) });
          link.readOnly = true;
          const copy = w.button(t("Copy"), { onClick: async () => {
            try { await navigator.clipboard.writeText(link.value); status.set(t("The link is on the clipboard."), "ok"); }
            catch { link.select(); status.set(t("Select the link and copy it."), "warn"); }
          } });
          box.append(
            h("div", { className: "sd-hint" }, t("Send this link to the people you want to edit with. Anyone who has it can join.")),
            h("div", { className: "sd-link" }, link, copy),
          );
          if (shared.owner) {
            box.append(h("div", { className: "sd-btns" }, w.button(t("New link"), { ghost: true, onClick: () => { shared.relink(); status.set(t("The old link no longer works. Nobody in the map was sent out."), "ok"); } })));
          }
        } else {
          box.append(h("div", { className: "sd-hint" }, room?.name ? t("You are editing “{name}” with others.", { name: room.name }) : t("You are editing a shared map with others.")));
        }
        if (shared.kept && room) {
          const line = h("div", { className: "sd-hint" }, shared.owner
            ? t("Kept open: {ends}. Each time everyone has left, it saves a new revision to your My Maps.", { ends: lower(endsLine(room)) })
            : room.owner
              ? t("Kept open: {ends}. Each time everyone has left, it saves a new revision to {owner}'s My Maps.", { ends: lower(endsLine(room)), owner: room.owner })
              : t("Kept open: {ends}. Each time everyone has left, it saves a new revision to the owner's My Maps.", { ends: lower(endsLine(room)) }));
          box.append(line);
          if (shared.owner) {
            const how = w.select(keepChoices(false), { value: choiceOf(room.keepDays), title: t("How long it stays open after its last edit"), onChange: async (v) => {
              try { await shared.keepFor(keepDaysOf(v) ?? null); status.set(`${endsLine(shared.room ?? {})}.`, "ok"); }
              catch (err) { status.set(describeError(err), "error"); }
            } });
            box.append(w.form([{ label: t("Keep it open"), field: how }]));
            const embed = w.button(t("Embed…"), { title: t("A picture of the map that links to it, for a forum, a README or a website"), onClick: async () => {
              embed.setBusy(true);
              try {
                const view = (await account.client.sharedMaps()).rooms.find((x) => x.id === room.id);
                const target = view ? keptEmbedTarget(ctx, view) : null;
                if (target) openEmbedDialog(ctx, target);
                else status.set(t("This server has no pictures for shared maps yet."), "warn");
              } catch (err) { status.set(describeError(err), "error"); }
              finally { embed.setBusy(false); }
            } });
            box.append(h("div", { className: "sd-btns" }, embed));
          }
        }
        const list = h("div", { className: "sd-people" });
        for (const person of shared.people.values()) {
          const me = person.id === shared.you?.id;
          const sub = [person.owner ? t("shared the map") : "", me ? t("you") : "", person.away ? t("connection lost, may come back") : doing(shared.presence.get(person.id))].filter(Boolean).join(" · ");
          list.append(h("div", { className: "sd-person" },
            h("span", { className: "sd-swatch", style: `background:${personColor(person)}` }),
            h("div", null, h("div", null, person.name), sub ? h("div", { className: "sd-sub" }, sub) : null),
            shared.owner && !me ? w.button(t("Remove"), { ghost: true, onClick: () => shared.kick(person.id) }) : h("span", null),
          ));
        }
        const leave = w.button(t("Leave"), { onClick: () => void shared.leave(false), title: shared.kept ? t("The map stays open for the others and at its link.") : undefined });
        const stop = shared.owner
          ? w.button(shared.kept ? t("End sharing") : t("Stop sharing"), { danger: true, onClick: async () => {
            const text = shared.kept
              ? t("End sharing this map? Everyone is sent out of it and the link stops working. The map and its revisions stay in My Maps.")
              : t("Stop sharing this map? Everyone is sent out of it; they keep their copy and can save it.");
            if (!(await api.ui.confirm(text))) return;
            void shared.leave(true);
          } })
          : null;
        const buttons = h("div", { className: "sd-btns" });
        if (!shared.owner || shared.kept) buttons.append(leave);
        if (stop) buttons.append(stop);
        box.append(h("div", { className: "sd-k" }, t("{n, plural, one {# person} other {# people}} in the map", { n: shared.people.size })), list, buttons, status);
      };

      const render = () => {
        unsubscribe?.();
        unsubscribe = null;
        const shared = controls.current();
        if (!shared || shared.phase === "ended") { renderStart(); return; }
        unsubscribe = shared.onChange(() => { if (dialog.isOpen()) render(); });
        renderLive(shared);
      };
      render();
      return () => { unsubscribe?.(); };
    },
  });
}

/* ── Join a Shared Map ────────────────────────────────────── */

export function openJoinDialog(ctx: ShareCtx, controls: ShareControls, given: string | null = null): DialogHandle {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  return api.ui.dialog({
    title: t("Join a Shared Map"),
    mount(body, dialog) {
      const box = root(body);
      const status = w.statusLine({ text: "" });
      const about = h("div", { className: "sd-hint" }, "");
      let room: RoomInfo | null = null;
      let looking: AbortController | null = null;
      const link = w.text({ value: given ?? "", placeholder: t("Paste the link you were sent") });
      const name = w.text({ value: ctx.store.get().shareName || (account.kind() === "account" ? account.current()?.name ?? "" : ""), placeholder: t("How the others see you") });

      const join = w.button(t("Join"), { primary: true, onClick: async () => {
        const invite = inviteFrom(link.value);
        if (!invite) { status.set(t("That is not a shared map's link."), "error"); return; }
        const who = name.value.trim();
        if (!who) { status.set(t("Type a name for the others to see."), "error"); name.focus(); return; }
        ctx.store.set({ shareName: who });
        join.setBusy(true);
        status.busy(t("Joining…"));
        try {
          await controls.join(invite, who);
          dialog.close();
        } catch (err) {
          status.set(describeError(err), "error");
        } finally {
          join.setBusy(false);
        }
      } });

      const lookUp = async () => {
        looking?.abort();
        room = null;
        const invite = inviteFrom(link.value);
        if (!invite) { about.textContent = link.value.trim() ? t("That is not a shared map's link.") : ""; return; }
        const ctl = new AbortController();
        looking = ctl;
        about.textContent = t("Looking it up…");
        try {
          room = (await account.client.lookupRoom(invite, ctl.signal)).room;
          about.textContent = room.owner
            ? t("“{name}”, shared by {owner} · {n} of {max} people editing now.", { name: room.name, owner: room.owner, n: room.people, max: room.maxPeople })
            : t("“{name}” · {n} of {max} people editing now.", { name: room.name, n: room.people, max: room.maxPeople });
        } catch (err) {
          if (!ctl.signal.aborted) about.textContent = describeError(err);
        }
      };
      link.addEventListener("input", () => void lookUp());

      clear(box);
      box.append(
        w.form([{ label: t("Link"), field: link }, { label: t("Your name"), field: name }]),
        about,
        h("div", { className: "sd-hint" }, t("The map opens beside the ones you have open. You edit it together with everyone in it; closing it leaves.")),
        h("div", { className: "sd-btns" }, join),
        status,
      );
      if (controls.current() && controls.current()!.phase !== "ended") status.set(t("You are in a shared map already; joining this one leaves it."), "warn");
      if (given) void lookUp();
      return () => looking?.abort();
    },
  });
}
