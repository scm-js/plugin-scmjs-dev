/**
 * The two dialogs of shared maps. *Share this Map* starts sharing the open map (a signed-in
 * account is needed) and, while it is shared, shows the link, who is in, and the owner's
 * controls. *Join a Shared Map* takes a link, says what it leads to, and joins under the
 * name the person types.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { describeError, ScmjsError } from "../client";
import type { KeepDays, RoomInfo } from "../protocol";
import type { SettingsStore } from "../account";
import { clear, h, styled, type Ctx } from "../ui";
import { inviteFrom, inviteLink } from "./link";
import { doing, personColor } from "./presence";
import { choiceOf, endsLine, KEEP_CHOICES, keepDaysOf, keepHint, sharedMapsList } from "./kept";
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
    title: "Share this Map",
    mount(body, dialog) {
      const box = root(body);
      const status = w.statusLine({ text: "" });

      const renderStart = () => {
        clear(box);
        if (!api.document.isOpen()) { box.append(w.hint("Open a map first.")); return; }
        if (account.kind() !== "account") {
          box.append(
            h("div", { className: "sd-hint" }, "Sharing a map takes a scmjs.dev account. The people you share it with need only the link."),
            h("div", { className: "sd-btns" }, w.button("Sign in…", { primary: true, onClick: () => { dialog.close(); ctx.openAccount(); } })),
          );
          return;
        }
        const name = w.text({ value: api.document.info()?.name ?? "" });
        // Keeping it open needs a server that can (0.15.0, with map storage).
        const canKeep = !!account.state().offers?.keptRooms;
        const hint = h("div", { className: "sd-hint" }, keepHint("live"));
        const keep = w.select(KEEP_CHOICES, { value: canKeep ? "7" : "live", onChange: (v) => { hint.textContent = keepHint(v); } });
        hint.textContent = keepHint(keep.value);
        const full = h("div", null);
        const start = w.button("Start sharing", { primary: true, onClick: async () => {
          start.setBusy(true);
          const keepDays = canKeep ? keepDaysOf(keep.value) : undefined;
          status.busy(keepDays === undefined ? "Copying the map to scmjs.dev…" : "Saving the map to My Maps…");
          clear(full);
          try {
            await controls.share(name.value.trim() || "Untitled map", keepDays);
            status.set("");
            render();
          } catch (err) {
            status.set(describeError(err), "error");
            // At the limit: the maps being shared, each with End, so one can make way.
            if (err instanceof ScmjsError && err.code === "room_full" && /sharing/.test(err.message)) {
              full.append(w.group("Your shared maps", sharedMapsList(ctx, controls, { onJoined: () => dialog.close() }).el));
            }
          } finally {
            start.setBusy(false);
          }
        } });
        box.append(
          h("div", { className: "sd-hint" }, "Anyone with the link can open this map in their own editor and change it with you, at the same time. Everyone sees the others' changes as they are made, and their pointers on the map."),
          w.form([{ label: "Name", field: name }, ...(canKeep ? [{ label: "Keep it open", field: keep }] : [])]),
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
        if (shared.phase === "connecting") { box.append(w.spinner({ label: "Connecting…" })); return; }
        if (shared.phase === "reconnecting") {
          box.append(
            w.spinner({ label: "Reconnecting…" }),
            h("div", { className: "sd-hint" }, "The connection to the shared map dropped. Keep working: your changes are kept here and sent once it is back. The editor keeps trying for two minutes."),
            h("div", { className: "sd-btns" }, w.button("Leave", { onClick: () => shared.leave(false) })),
          );
          return;
        }
        if (invite) {
          const link = w.text({ value: inviteLink(invite, account.serverUrl(), where()) });
          link.readOnly = true;
          const copy = w.button("Copy", { onClick: async () => {
            try { await navigator.clipboard.writeText(link.value); status.set("The link is on the clipboard.", "ok"); }
            catch { link.select(); status.set("Select the link and copy it.", "warn"); }
          } });
          box.append(
            h("div", { className: "sd-hint" }, "Send this link to the people you want to edit with. Anyone who has it can join."),
            h("div", { className: "sd-link" }, link, copy),
          );
          if (shared.owner) {
            box.append(h("div", { className: "sd-btns" }, w.button("New link", { ghost: true, onClick: () => { shared.relink(); status.set("The old link no longer works. Nobody in the map was sent out.", "ok"); } })));
          }
        } else {
          box.append(h("div", { className: "sd-hint" }, `You are editing “${room?.name ?? "a shared map"}” with others.`));
        }
        if (shared.kept && room) {
          const line = h("div", { className: "sd-hint" }, `Kept open: ${endsLine(room).toLowerCase()}. Each time everyone has left, it saves a new revision to ${shared.owner ? "your" : `${room.owner ?? "the owner"}'s`} My Maps.`);
          box.append(line);
          if (shared.owner) {
            const how = w.select(KEEP_CHOICES.filter((c) => c.value !== "live"), { value: choiceOf(room.keepDays), title: "How long it stays open after its last edit", onChange: async (v) => {
              try { await shared.keepFor(keepDaysOf(v) ?? null); status.set(`${endsLine(shared.room ?? {})}.`, "ok"); }
              catch (err) { status.set(describeError(err), "error"); }
            } });
            box.append(w.form([{ label: "Keep it open", field: how }]));
          }
        }
        const list = h("div", { className: "sd-people" });
        for (const person of shared.people.values()) {
          const me = person.id === shared.you?.id;
          const sub = [person.owner ? "shared the map" : "", me ? "you" : "", person.away ? "connection lost, may come back" : doing(shared.presence.get(person.id))].filter(Boolean).join(" · ");
          list.append(h("div", { className: "sd-person" },
            h("span", { className: "sd-swatch", style: `background:${personColor(person)}` }),
            h("div", null, h("div", null, person.name), sub ? h("div", { className: "sd-sub" }, sub) : null),
            shared.owner && !me ? w.button("Remove", { ghost: true, onClick: () => shared.kick(person.id) }) : h("span", null),
          ));
        }
        const leave = w.button("Leave", { onClick: () => void shared.leave(false), title: shared.kept ? "The map stays open for the others and at its link." : undefined });
        const stop = shared.owner
          ? w.button(shared.kept ? "End sharing" : "Stop sharing", { danger: true, onClick: async () => {
            const text = shared.kept
              ? "End sharing this map? Everyone is sent out of it and the link stops working. The map and its revisions stay in My Maps."
              : "Stop sharing this map? Everyone is sent out of it; they keep their copy and can save it.";
            if (!(await api.ui.confirm(text))) return;
            void shared.leave(true);
          } })
          : null;
        const buttons = h("div", { className: "sd-btns" });
        if (!shared.owner || shared.kept) buttons.append(leave);
        if (stop) buttons.append(stop);
        box.append(h("div", { className: "sd-k" }, `${shared.people.size} ${shared.people.size === 1 ? "person" : "people"} in the map`), list, buttons, status);
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
    title: "Join a Shared Map",
    mount(body, dialog) {
      const box = root(body);
      const status = w.statusLine({ text: "" });
      const about = h("div", { className: "sd-hint" }, "");
      let room: RoomInfo | null = null;
      let looking: AbortController | null = null;
      const link = w.text({ value: given ?? "", placeholder: "Paste the link you were sent" });
      const name = w.text({ value: ctx.store.get().shareName || (account.kind() === "account" ? account.current()?.name ?? "" : ""), placeholder: "How the others see you" });

      const join = w.button("Join", { primary: true, onClick: async () => {
        const invite = inviteFrom(link.value);
        if (!invite) { status.set("That is not a shared map's link.", "error"); return; }
        const who = name.value.trim();
        if (!who) { status.set("Type a name for the others to see.", "error"); name.focus(); return; }
        ctx.store.set({ shareName: who });
        join.setBusy(true);
        status.busy("Joining…");
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
        if (!invite) { about.textContent = link.value.trim() ? "That is not a shared map's link." : ""; return; }
        const ctl = new AbortController();
        looking = ctl;
        about.textContent = "Looking it up…";
        try {
          room = (await account.client.lookupRoom(invite, ctl.signal)).room;
          about.textContent = `“${room.name}”${room.owner ? `, shared by ${room.owner}` : ""} · ${room.people} of ${room.maxPeople} people editing now.`;
        } catch (err) {
          if (!ctl.signal.aborted) about.textContent = describeError(err);
        }
      };
      link.addEventListener("input", () => void lookUp());

      clear(box);
      box.append(
        w.form([{ label: "Link", field: link }, { label: "Your name", field: name }]),
        about,
        h("div", { className: "sd-hint" }, "The map opens beside the ones you have open. You edit it together with everyone in it; closing it leaves."),
        h("div", { className: "sd-btns" }, join),
        status,
      );
      if (controls.current() && controls.current()!.phase !== "ended") status.set("You are in a shared map already; joining this one leaves it.", "warn");
      if (given) void lookUp();
      return () => looking?.abort();
    },
  });
}
