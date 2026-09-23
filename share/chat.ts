/**
 * The shared map's chat: a *Chat* button on the map (`ui.mapButton`) while the shared map
 * is in front, with a count of the lines that came in while the chat was closed, and a
 * floating panel over the map with the conversation and a line to type in. The lines
 * live in the room on the server, in memory — whoever joins sees what was said before
 * them, and it all ends with the room. An editor older than `ui.mapButton` gets the
 * button as a status-bar cell instead.
 */
import type { MapButtonHandle, PanelHandle, PluginApi } from "@scm-js/plugin-api";
import type { RoomChatLine } from "../protocol";
import { h, styled } from "../ui";
import { personColor } from "./presence";
import { CHAT_MAX, type SharedMap } from "./shared";

const CHAT_STYLE = `
.sd.sd-chat { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; }
.sd-chat .sd-chat-lines { flex: 1; min-height: 60px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 2px 0; }
.sd-chat .sd-chat-line { line-height: 1.35; overflow-wrap: anywhere; white-space: pre-wrap; }
.sd-chat .sd-chat-who { font-weight: 600; margin-right: 6px; }
.sd-chat .sd-chat-at { color: var(--text-faint, #6b7382); font-size: 10px; margin-right: 6px; font-family: var(--font-mono, monospace); }
.sd-chat .sd-chat-empty { color: var(--text-dim, #99a2b3); font-size: 11px; }
.sd-chat .sd-chat-input { display: flex; gap: 6px; }
.sd-chat .sd-chat-input input { flex: 1; min-width: 0; }
`;

/** A button that is a map button where the editor has them, and a status cell where it does not. */
interface ChatButton { set(label: string, badge: number, active: boolean): void; remove(): void }

function chatButton(api: PluginApi, onClick: () => void): ChatButton {
  if (typeof api.ui.mapButton === "function") {
    const b: MapButtonHandle = api.ui.mapButton({ label: "Chat", title: "Chat with the people on this shared map", onClick });
    return { set: (label, badge, active) => b.set({ label, badge: badge || null, active }), remove: () => b.remove() };
  }
  const s = api.ui.statusItem({ text: "Chat", title: "Chat with the people on this shared map", onClick });
  return { set: (label, badge) => s.set({ text: badge ? `${label} (${badge})` : label }), remove: () => s.remove() };
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Chat for one shared map, from the moment it is live until `dispose`. */
export class SharedChat {
  private readonly api: PluginApi;
  private readonly shared: SharedMap;
  private button: ChatButton | null = null;
  private panel: PanelHandle | null = null;
  private lines: HTMLElement | null = null;
  private unread = 0;
  private readonly unhook: (() => void)[] = [];

  constructor(api: PluginApi, shared: SharedMap) {
    this.api = api;
    this.shared = shared;
    this.unhook.push(shared.onChat((line) => this.arrived(line)));
    const onDocument = api.events.on("document", () => this.syncButton());
    this.unhook.push(() => onDocument.dispose());
    this.syncButton();
  }

  /** The button shows only while the shared map is the one in front. */
  private syncButton() {
    const here = this.shared.documentId !== null && this.api.document.id() === this.shared.documentId;
    if (here && !this.button) {
      this.button = chatButton(this.api, () => this.toggle());
      this.paintButton();
    } else if (!here && this.button) {
      this.button.remove();
      this.button = null;
    }
  }

  private paintButton() {
    this.button?.set("Chat", this.unread, !!this.panel?.isOpen());
  }

  private arrived(line: RoomChatLine) {
    if (this.panel?.isOpen() && this.lines) {
      this.lines.querySelector(".sd-chat-empty")?.remove();
      this.lines.append(this.lineEl(line));
      this.lines.scrollTop = this.lines.scrollHeight;
      return;
    }
    if (line.from === this.shared.you?.id) return;
    this.unread++;
    this.paintButton();
    this.api.ui.toast({ kind: "info", title: `${line.name} in the chat`, detail: line.text.length > 140 ? `${line.text.slice(0, 139)}…` : line.text });
  }

  private lineEl(line: RoomChatLine): HTMLElement {
    const mine = line.from === this.shared.you?.id;
    return h("div", { className: "sd-chat-line" },
      h("span", { className: "sd-chat-at", title: new Date(line.at).toLocaleString() }, clock(line.at)),
      h("span", { className: "sd-chat-who", style: `color:${personColor({ id: line.from, name: line.name, color: line.color, owner: false })}` }, mine ? `${line.name} (you)` : line.name),
      line.text,
    );
  }

  toggle() {
    if (this.panel?.isOpen()) { this.panel.close(); return; }
    this.open();
  }

  open() {
    if (this.panel?.isOpen()) return;
    const w = this.api.ui.widgets;
    // Cleared here, not in mount: the panel's body may be filled after this returns.
    this.unread = 0;
    this.panel = this.api.ui.panel({
      title: `Chat · ${this.shared.room?.name ?? "shared map"}`,
      width: 320,
      height: 360,
      resizable: true,
      mount: (body) => {
        const root = styled(body);
        root.classList.add("sd-chat");
        const style = document.createElement("style");
        style.textContent = CHAT_STYLE;
        body.prepend(style);
        const lines = h("div", { className: "sd-chat-lines" });
        const past = this.shared.chat ?? [];
        if (!past.length) lines.append(h("div", { className: "sd-chat-empty" }, "Nothing said yet. Everyone on the shared map sees what you write here; it goes when the sharing ends."));
        for (const line of past) lines.append(this.lineEl(line));
        const input = w.text({ placeholder: "Say something to everyone here" });
        input.maxLength = CHAT_MAX;
        const send = () => {
          if (this.shared.say(input.value)) input.value = "";
          input.focus();
        };
        input.addEventListener("keydown", (e) => {
          // The editor's own keys (tools, undo) stay out of what is being typed.
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        });
        root.append(lines, h("div", { className: "sd-chat-input" }, input, w.button("Send", { onClick: send })));
        this.lines = lines;
        queueMicrotask(() => { lines.scrollTop = lines.scrollHeight; input.focus(); });
        return () => { this.lines = null; };
      },
      onClose: () => { this.panel = null; this.paintButton(); },
    });
    this.paintButton();
  }

  dispose() {
    for (const u of this.unhook) u();
    this.unhook.length = 0;
    this.panel?.close();
    this.panel = null;
    this.button?.remove();
    this.button = null;
  }
}
