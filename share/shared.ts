/**
 * One shared map, from this editor's side: the room's WebSocket on one end, the editor's
 * sync session (`api.sync`) on the other.
 *
 * Sharing: the sync session starts and the map is copied in the same tick (so no change
 * falls between the copy and the session), the copy opens a room on the server, and the
 * socket joins it as the owner; changes made while that is under way wait in an outbox.
 * Joining: the socket joins with the invite, the copy the server hands over opens as a new
 * map, the session starts on it, and the changes since the copy are applied in order;
 * anything the server says meanwhile waits too.
 *
 * Then the server's `op`s go to `session.receive`, its `ack`s to `session.confirm`, and
 * the session's changes go out as `op`s. Nothing here resolves anything — the editor does,
 * and every editor that has seen the same ops has the same map. The socket dropping, the
 * server refusing one of our changes, or the owner ending the room all end it here: the
 * map stays open, and anyone can save it.
 */
import type { PluginApi, Rect, SyncOp, SyncSession } from "@scm-js/plugin-api";
import type { ScmjsClient } from "../client";
import { describeError } from "../client";
import type { RoomChatLine, RoomClientMessage, RoomEndReason, RoomInfo, RoomPerson, RoomServerMessage } from "../protocol";
import { ROOM_PROTOCOL } from "../protocol";

/** What a person tells the room about themselves; relayed as it is. */
export interface Presence {
  /** The pointer in map pixels, or null off the map. */
  px: number | null;
  py: number | null;
  /** The tiles on their screen. */
  view: Rect | null;
  layer: string;
  /** The dialog they have open, by id, or null. */
  dialog: string | null;
}

/** The part of a WebSocket this uses, so the tests can hand in a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SharedDeps {
  api: PluginApi;
  client: ScmjsClient;
  socket?: (url: string) => SocketLike;
  /** Milliseconds between presence messages at most. */
  presenceMs?: number;
}

/** The server's limit on a chat line, and how many lines this editor keeps. */
export const CHAT_MAX = 500;
const CHAT_KEEP = 200;

export type SharedPhase = "connecting" | "live" | "ended";

const OPEN = 1;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const ENDINGS: Record<RoomEndReason, string> = {
  owner: "The person who shared the map ended the session.",
  removed: "You were removed from the shared map.",
  idle: "The shared map closed after nobody used it for a while.",
  server: "The server restarted, which ends every shared map.",
};

export class SharedMap {
  phase: SharedPhase = "connecting";
  room: (RoomInfo & { invite?: string }) | null = null;
  you: RoomPerson | null = null;
  readonly people = new Map<string, RoomPerson>();
  readonly presence = new Map<string, Presence>();
  /** Why it ended, in a sentence; null while it runs. */
  ending: string | null = null;
  /** The shared map's document id, once there is one. */
  documentId: number | null = null;
  /** The room's chat, oldest first; null when the server has none (one before ai-server 0.13.0). */
  chat: RoomChatLine[] | null = null;

  private session: SyncSession | null = null;
  private ws: SocketLike | null = null;
  private welcomed = false;
  private readonly outbox: SyncOp[] = [];
  private held: RoomServerMessage[] | null = null;
  private lastSeq = 0;
  private listeners = new Set<() => void>();
  private presenceListeners = new Set<() => void>();
  private chatListeners = new Set<(line: RoomChatLine) => void>();
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceSent = 0;
  private mine: Presence = { px: null, py: null, view: null, layer: "", dialog: null };
  private readonly deps: SharedDeps;

  private constructor(deps: SharedDeps) {
    this.deps = deps;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Someone moved their pointer or view, or opened a dialog: what the overlay redraws on. */
  onPresence(fn: () => void): () => void {
    this.presenceListeners.add(fn);
    return () => this.presenceListeners.delete(fn);
  }

  /** A chat line arrived — anyone's, this editor's own included (the server sends it back). */
  onChat(fn: (line: RoomChatLine) => void): () => void {
    this.chatListeners.add(fn);
    return () => this.chatListeners.delete(fn);
  }

  /** Send a line to the room's chat; false when there is no chat or nothing to say. */
  say(text: string): boolean {
    const t = text.trim();
    if (!t || this.chat === null || this.phase !== "live") return false;
    this.send({ type: "chat", text: t.slice(0, CHAT_MAX) });
    return true;
  }

  private emit(presenceOnly = false) {
    for (const fn of [...(presenceOnly ? this.presenceListeners : new Set([...this.listeners, ...this.presenceListeners]))]) {
      try { fn(); } catch (err) { console.error(err); }
    }
  }

  get owner(): boolean {
    return this.you?.owner === true;
  }

  /** Changes this editor made that the server has not confirmed yet. */
  pending(): number {
    return this.session?.pending() ?? 0;
  }

  holding(): string | null {
    return this.session?.holding() ?? null;
  }

  /* ── Starting ───────────────────────────────────────────── */

  /** Share the map in front under `name`. Needs a signed-in session on the client. */
  static async share(deps: SharedDeps, name: string): Promise<SharedMap> {
    const s = new SharedMap(deps);
    const session = deps.api.sync.start(s.syncOptions());
    if (!session) throw new Error("A map is being shared already, or no map is open.");
    s.session = session;
    s.documentId = session.documentId;
    // The copy is taken now, before any await: the session and the copy start together.
    const copy = session.snapshot();
    try {
      const bytes = await copy;
      if (!bytes) throw new Error("The map could not be copied.");
      const { room } = await deps.client.createRoom(name, toBase64(bytes));
      s.room = room;
      await s.connect(room.invite, deps.client.session());
      return s;
    } catch (err) {
      s.end(describeError(err));
      throw err;
    }
  }

  /** Join the room behind `invite` as `name`, opening its map beside the ones open. */
  static async join(deps: SharedDeps, invite: string, name: string): Promise<SharedMap> {
    const s = new SharedMap(deps);
    s.held = [];
    try {
      await s.connect(invite, deps.client.session(), name);
      return s;
    } catch (err) {
      s.end(describeError(err));
      throw err;
    }
  }

  private syncOptions() {
    return {
      send: (op: SyncOp) => {
        if (this.welcomed) this.send({ type: "op", op });
        else this.outbox.push(op);
      },
      onEnd: (reason: "closed" | "stopped") => {
        if (this.phase !== "ended") this.end(reason === "closed" ? "The shared map was closed in this editor." : null);
      },
      onApplied: (report: { ops: number; dropped: number; lost: number }) => {
        if (report.lost > 0) this.deps.api.ui.status(`Someone else's change came first; ${report.lost} part${report.lost === 1 ? "" : "s"} of yours no longer applied.`);
      },
    };
  }

  /** Open the socket, say hello, and resolve once welcomed (and, joining, once the map is open). */
  private connect(invite: string, session: string, name?: string): Promise<void> {
    const make = this.deps.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      let ws: SocketLike;
      try {
        ws = make(this.deps.client.roomSocketUrl());
      } catch (err) {
        settle(err);
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        const hello: RoomClientMessage = { type: "hello", protocol: ROOM_PROTOCOL, invite, ...(name ? { name } : {}), ...(session ? { session } : {}) };
        ws.send(JSON.stringify(hello));
      };
      ws.onmessage = (ev) => {
        let msg: RoomServerMessage;
        try { msg = JSON.parse(String(ev.data)) as RoomServerMessage; } catch { return; }
        if (msg.type === "welcome") {
          this.welcome(msg).then(() => settle(), (err) => settle(err));
          return;
        }
        if (!this.welcomed && msg.type === "error") { settle(new Error(msg.message)); return; }
        if (this.held) { this.held.push(msg); return; }
        this.handle(msg);
      };
      ws.onclose = (ev) => {
        if (!settled) settle(new Error(ev.reason === "origin" ? "The server does not take shared maps from this page." : "Could not reach the shared map."));
        if (this.phase !== "ended") this.end("The connection to the shared map was lost. The map is still open here; save it, or join again.");
      };
      ws.onerror = () => { /* onclose follows and says it */ };
    });
  }

  private async welcome(msg: Extract<RoomServerMessage, { type: "welcome" }>) {
    this.you = msg.you;
    this.room = { ...(this.room ?? {}), ...msg.room };
    for (const p of msg.people) this.people.set(p.id, p);
    for (const p of msg.presence) this.presence.set(p.from, p.data as Presence);
    this.chat = msg.chat ? [...msg.chat] : null;
    if (this.session) {
      // The owner: the room was made from this editor's copy, so there is nothing to catch up on.
      this.welcomed = true;
      this.lastSeq = msg.snapshot.seq;
      for (const op of this.outbox.splice(0)) this.send({ type: "op", op });
    } else {
      const bytes = fromBase64(msg.snapshot.map);
      const opened = await this.deps.api.document.open(bytes, `${msg.room.name || "Shared map"}.scx`, { into: "new" });
      if (!opened) throw new Error("The shared map could not be opened.");
      const session = this.deps.api.sync.start(this.syncOptions());
      if (!session) throw new Error("Another map is being shared from this editor already.");
      this.session = session;
      this.documentId = session.documentId;
      this.welcomed = true;
      this.lastSeq = msg.snapshot.seq;
      for (const op of msg.ops) {
        session.receive(op.op);
        this.lastSeq = op.seq;
      }
      const held = this.held ?? [];
      this.held = null;
      for (const m of held) this.handle(m);
    }
    this.phase = "live";
    this.emit();
    this.flushPresence();
  }

  /* ── Messages ───────────────────────────────────────────── */

  private send(msg: RoomClientMessage) {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  private handle(msg: RoomServerMessage) {
    const { api } = this.deps;
    switch (msg.type) {
      case "op":
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
        this.session?.receive(msg.op);
        return;
      case "ack":
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
        this.session?.confirm();
        return;
      case "joined":
        this.people.set(msg.person.id, msg.person);
        api.ui.toast({ kind: "info", title: `${msg.person.name} joined the shared map` });
        this.emit();
        return;
      case "left": {
        const who = this.people.get(msg.person);
        this.people.delete(msg.person);
        this.presence.delete(msg.person);
        if (who) api.ui.status(`${who.name} ${msg.reason === "removed" ? "was removed from" : "left"} the shared map.`);
        this.emit();
        return;
      }
      case "presence":
        this.presence.set(msg.from, msg.data as Presence);
        this.emit(true);
        return;
      case "chat": {
        const chat = this.chat ?? (this.chat = []);
        chat.push(msg.line);
        if (chat.length > CHAT_KEEP) chat.splice(0, chat.length - CHAT_KEEP);
        for (const fn of [...this.chatListeners]) { try { fn(msg.line); } catch (err) { console.error(err); } }
        return;
      }
      case "snapshot-please":
        void this.answerCopy(0);
        return;
      case "link":
        if (this.room) this.room = { ...this.room, invite: msg.invite };
        this.emit();
        return;
      case "ended":
        this.end(ENDINGS[msg.reason] ?? "The shared map ended.");
        return;
      case "error":
        if (msg.about === "op") {
          this.end(`A change could not be shared (${msg.message}), so this copy no longer matches everyone else's. The map is still open here; save it, or join again.`);
        } else {
          api.ui.status(msg.message);
        }
        return;
      default:
        return;
    }
  }

  /** The server wants a fresh copy of the map for people joining. Only a quiet moment gives one that matches a point in its order. */
  private async answerCopy(tries: number) {
    const session = this.session;
    if (!session || this.phase !== "live") return;
    const seq = this.lastSeq;
    const copy = session.snapshot();
    const bytes = await copy;
    if (bytes) { this.send({ type: "snapshot", seq, map: toBase64(bytes) }); return; }
    if (tries < 20) setTimeout(() => void this.answerCopy(tries + 1), 1500);
  }

  /* ── Presence ───────────────────────────────────────────── */

  /** Say where this person is; sent at most every `presenceMs`, the last word always. */
  setPresence(patch: Partial<Presence>) {
    this.mine = { ...this.mine, ...patch };
    this.flushPresence();
  }

  private flushPresence() {
    if (this.phase !== "live" || this.presenceTimer) return;
    const gap = this.deps.presenceMs ?? 80;
    const wait = Math.max(0, this.presenceSent + gap - Date.now());
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.presenceSent = Date.now();
      this.send({ type: "presence", data: this.mine });
    }, wait);
  }

  /* ── The owner's controls, and leaving ──────────────────── */

  kick(personId: string) { this.send({ type: "kick", person: personId }); }
  relink() { this.send({ type: "relink" }); }

  /** Leave — or, for the owner with `forEveryone`, end the room for everyone. The map stays open. */
  leave(forEveryone = false) {
    if (forEveryone && this.owner) this.send({ type: "end" });
    this.end(null);
  }

  private end(message: string | null) {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.ending = message;
    if (this.presenceTimer) { clearTimeout(this.presenceTimer); this.presenceTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try { ws.close(1000); } catch { /* already closed */ }
    }
    const session = this.session;
    this.session = null;
    session?.stop();
    this.emit();
    this.listeners.clear();
    this.presenceListeners.clear();
  }
}
