/**
 * The two dialogs of shared maps. *Share this Map* starts sharing the open map (a signed-in
 * account is needed) and, while it is shared, shows the link, who is in, and the owner's
 * controls. *Join a Shared Map* takes a link, says what it leads to, and joins under the
 * name the person types.
 */
import type { DialogHandle } from "@scm-js/plugin-api";
import { describeError } from "../client";
import type { RoomInfo } from "../protocol";
import type { SettingsStore } from "../account";
import { clear, h, styled, type Ctx } from "../ui";
import { inviteFrom, inviteLink } from "./link";
import { doing, personColor } from "./presence";
import type { SharedMap } from "./shared";

/** The dialogs' context: the plugin's, and the settings (the name last typed to join). */
export interface ShareCtx extends Ctx {
  store: SettingsStore;
}

export interface ShareControls {
  current(): SharedMap | null;
  share(name: string): Promise<SharedMap>;
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
        const start = w.button("Start sharing", { primary: true, onClick: async () => {
          start.setBusy(true);
          status.busy("Copying the map to scmjs.dev…");
          try {
            await controls.share(name.value.trim() || "Untitled map");
            status.set("");
            render();
          } catch (err) {
            status.set(describeError(err), "error");
          } finally {
            start.setBusy(false);
          }
        } });
        box.append(
          h("div", { className: "sd-hint" }, "Anyone with the link can open this map in their own editor and change it with you, at the same time. Everyone sees the others' changes as they are made, and their pointers on the map."),
          w.form([{ label: "Name", field: name }]),
          h("div", { className: "sd-hint" }, "The map stays on scmjs.dev only while it is shared: it ends when you stop sharing, half an hour after the last person leaves, or when the server restarts. Everyone keeps the map in their editor and can save it."),
          h("div", { className: "sd-btns" }, start),
          status,
        );
      };

      const renderLive = (shared: SharedMap) => {
        clear(box);
        const room = shared.room;
        const invite = room?.invite;
        if (shared.phase === "connecting") { box.append(w.spinner({ label: "Connecting…" })); return; }
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
        const list = h("div", { className: "sd-people" });
        for (const person of shared.people.values()) {
          const me = person.id === shared.you?.id;
          const sub = [person.owner ? "shared the map" : "", me ? "you" : "", doing(shared.presence.get(person.id))].filter(Boolean).join(" · ");
          list.append(h("div", { className: "sd-person" },
            h("span", { className: "sd-swatch", style: `background:${personColor(person)}` }),
            h("div", null, h("div", null, person.name), sub ? h("div", { className: "sd-sub" }, sub) : null),
            shared.owner && !me ? w.button("Remove", { ghost: true, onClick: () => shared.kick(person.id) }) : h("span", null),
          ));
        }
        const stop = shared.owner
          ? w.button("Stop sharing", { danger: true, onClick: async () => {
            if (!(await api.ui.confirm("Stop sharing this map? Everyone is sent out of it; they keep their copy and can save it."))) return;
            shared.leave(true);
          } })
          : w.button("Leave", { onClick: () => shared.leave(false) });
        box.append(h("div", { className: "sd-k" }, `${shared.people.size} ${shared.people.size === 1 ? "person" : "people"} in the map`), list, h("div", { className: "sd-btns" }, stop), status);
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
