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
 * and every editor that has seen the same ops has the same map. The server refusing one of
 * our changes, or the owner ending the room, ends it here: the map stays open, and anyone
 * can save it.
 *
 * The socket dropping does not end it (on a server from 0.14.0, which hands out a resume
 * token). The changes the server has not confirmed are kept, and the socket comes back
 * with the token and the last seq seen: the ops since are replayed — this editor's own
 * confirm its oldest unconfirmed changes, anyone else's are received — and what is still
 * unconfirmed goes out again. Back too late for the server to have those ops, it hands
 * over a fresh copy instead, which opens in a new tab beside the one as it was.
 */
import type { PluginApi, Rect, SyncOp, SyncSession } from "@scm-js/plugin-api";
import type { ScmjsClient } from "../client";
import { describeError } from "../client";
import type { KeepDays, MapMeta, RoomChatLine, RoomClientMessage, RoomEndReason, RoomInfo, RoomPerson, RoomServerMessage } from "../protocol";
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

export type SharedPhase = "connecting" | "live" | "reconnecting" | "ended";

const OPEN = 1;
/** How long to keep trying to reconnect, and the longest wait between tries. */
const RECONNECT_FOR_MS = 120_000;
const RECONNECT_MAX_WAIT_MS = 30_000;
/** A ping this often; nothing heard for `QUIET_MS` means the connection is gone, whatever the browser thinks. */
const PING_MS = 20_000;
const QUIET_MS = 50_000;
const LOST = "The connection to the shared map was lost. The map is still open here; save it, or join again.";

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
  expired: "The shared map ended after going its time without an edit. The map and its revisions stay in the owner's My Maps.",
};

/** How long to keep a shared map open: a stored map, and where it goes. */
export interface KeepOptions {
  keepDays: KeepDays;
  /** The stored map this is (a new revision of it); a new map when absent. */
  mapId?: string;
  fileName?: string;
  meta?: MapMeta;
  note?: string;
  /** Base64 of the map's bigger picture, for its card. */
  picture?: string;
}

export class SharedMap {
  phase: SharedPhase = "connecting";
  room: (RoomInfo & { invite?: string; mapId?: string }) | null = null;
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
  /** Bumped when a session is let go, so what an old one still says is not taken for the new one's. */
  private generation = 0;
  private ws: SocketLike | null = null;
  private welcomed = false;
  /** Every change the session sent that the server has not confirmed, oldest first — sent or not. */
  private readonly unacked: SyncOp[] = [];
  private held: RoomServerMessage[] | null = null;
  private lastSeq = 0;
  /** Sharing: the first welcome is for a room made from this editor's own copy. */
  private sharing = false;
  private invite = "";
  private name: string | undefined;
  /** From `welcome.resume`; null from a server that cannot resume (before 0.14.0). */
  private resumeToken: string | null = null;
  private lostAt = 0;
  private tries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private readonly online = () => { if (this.phase === "reconnecting") this.retryNow(); };
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

  /** Kept open between sessions, as one of the owner's stored maps. */
  get kept(): boolean {
    return this.room?.keepDays !== undefined;
  }

  /** Changes this editor made that the server has not confirmed yet. */
  pending(): number {
    return this.session?.pending() ?? 0;
  }

  holding(): string | null {
    return this.session?.holding() ?? null;
  }

  /* ── Starting ───────────────────────────────────────────── */

  /**
   * Share the map in front under `name`. Needs a signed-in session on the client. With
   * `keep`, it is stored on the account and kept open between sessions.
   */
  static async share(deps: SharedDeps, name: string, keep?: KeepOptions): Promise<SharedMap> {
    const s = new SharedMap(deps);
    s.sharing = true;
    const session = deps.api.sync.start(s.syncOptions());
    if (!session) throw new Error("A map is being shared already, or no map is open.");
    s.session = session;
    s.documentId = session.documentId;
    // The copy is taken now, before any await: the session and the copy start together.
    const copy = session.snapshot();
    try {
      const bytes = await copy;
      if (!bytes) throw new Error("The map could not be copied.");
      const { room } = await deps.client.createRoom(name, toBase64(bytes), keep);
      s.room = room;
      s.invite = room.invite;
      await s.connect();
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
    s.invite = invite;
    s.name = name;
    try {
      await s.connect();
      return s;
    } catch (err) {
      s.end(describeError(err));
      throw err;
    }
  }

  private syncOptions() {
    const generation = this.generation;
    return {
      send: (op: SyncOp) => {
        if (generation !== this.generation) return;
        this.unacked.push(op);
        if (this.welcomed && this.phase !== "reconnecting") this.send({ type: "op", op });
      },
      onEnd: (reason: "closed" | "stopped") => {
        if (generation === this.generation && this.phase !== "ended") this.end(reason === "closed" ? "The shared map was closed in this editor." : null);
      },
      onApplied: (report: { ops: number; dropped: number; lost: number }) => {
        if (report.lost > 0) this.deps.api.ui.status(`Someone else's change came first; ${report.lost} part${report.lost === 1 ? "" : "s"} of yours no longer applied.`);
      },
    };
  }

  private hello(): RoomClientMessage {
    const session = this.deps.client.session();
    return {
      type: "hello", protocol: ROOM_PROTOCOL, invite: this.invite,
      ...(this.name ? { name: this.name } : {}), ...(session ? { session } : {}),
      ...(this.resumeToken ? { resume: { token: this.resumeToken, seq: this.lastSeq } } : {}),
    };
  }

  private openSocket(): SocketLike {
    const make = this.deps.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    return make(this.deps.client.roomSocketUrl());
  }

  /** Open the socket, say hello, and resolve once welcomed (and, joining, once the map is open). */
  private connect(): Promise<void> {
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
        ws = this.openSocket();
      } catch (err) {
        settle(err);
        return;
      }
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify(this.hello()));
      ws.onmessage = (ev) => {
        const msg = this.parse(ev.data);
        if (!msg) return;
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
        this.dropped(ws);
      };
      ws.onerror = () => { /* onclose follows and says it */ };
    });
  }

  private parse(data: unknown): RoomServerMessage | null {
    this.lastHeard = Date.now();
    try { return JSON.parse(String(data)) as RoomServerMessage; } catch { return null; }
  }

  private async welcome(msg: Extract<RoomServerMessage, { type: "welcome" }>) {
    this.you = msg.you;
    this.room = { ...(this.room ?? {}), ...msg.room };
    if (msg.room.invite) this.invite = msg.room.invite;
    this.people.clear();
    this.presence.clear();
    for (const p of msg.people) this.people.set(p.id, p);
    for (const p of msg.presence) this.presence.set(p.from, p.data as Presence);
    this.chat = msg.chat ? [...msg.chat] : null;
    this.resumeToken = msg.resume ?? null;
    if (this.sharing) {
      // The owner: the room was made from this editor's copy, so there is nothing to catch up on.
      this.sharing = false;
      this.welcomed = true;
      this.lastSeq = msg.snapshot.seq;
      for (const op of this.unacked) this.send({ type: "op", op });
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
    this.goLive();
  }

  private goLive() {
    this.phase = "live";
    this.lastHeard = Date.now();
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        if (this.phase !== "live" || !this.ws) return;
        if (Date.now() - this.lastHeard > QUIET_MS) {
          // Nothing, not even a pong: the connection is gone even if the browser has not
          // noticed. 4000 tells a server that does hear it that this was not leaving.
          const ws = this.ws;
          ws.onclose = null;
          try { ws.close(4000, "quiet"); } catch { /* gone */ }
          this.dropped(ws);
          return;
        }
        this.send({ type: "ping" });
      }, PING_MS);
    }
    this.emit();
    this.flushPresence();
  }

  /* ── Reconnecting ───────────────────────────────────────── */

  /** `ws` closed without anyone ending the room: try to come back, or end if the server cannot take us back. */
  private dropped(ws: SocketLike) {
    if (ws !== this.ws || this.phase === "ended") return;
    this.ws = null;
    if (this.phase !== "live" || !this.resumeToken || !this.session) { this.end(LOST); return; }
    this.phase = "reconnecting";
    this.lostAt = Date.now();
    this.tries = 0;
    if (this.presenceTimer) { clearTimeout(this.presenceTimer); this.presenceTimer = null; }
    if (typeof addEventListener === "function") addEventListener("online", this.online);
    this.emit();
    this.retryLater();
  }

  private retryLater() {
    const wait = Math.min(RECONNECT_MAX_WAIT_MS, 1000 * 2 ** this.tries++);
    if (Date.now() + wait - this.lostAt > RECONNECT_FOR_MS) { this.end(LOST); return; }
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.reconnect(); }, wait);
  }

  /** The browser says the network is back: try now rather than at the next turn. */
  private retryNow() {
    if (this.ws || !this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.reconnect();
  }

  private reconnect() {
    if (this.phase !== "reconnecting") return;
    let ws: SocketLike;
    try {
      ws = this.openSocket();
    } catch {
      this.retryLater();
      return;
    }
    this.ws = ws;
    let back = false;
    ws.onopen = () => ws.send(JSON.stringify(this.hello()));
    ws.onmessage = (ev) => {
      const msg = this.parse(ev.data);
      if (!msg) return;
      if (back) {
        if (this.held) this.held.push(msg);
        else this.handle(msg);
        return;
      }
      if (msg.type === "resumed") { back = true; this.resumed(msg); return; }
      if (msg.type === "welcome") {
        back = true;
        this.fresh(msg).catch((err) => this.end(`The shared map could not be opened again (${describeError(err)}). The map is still open here; save it, or join again.`));
        return;
      }
      if (msg.type === "error") this.end(msg.code === "not_found" ? "The shared map ended while you were away. The map is still open here; save it, or join again." : `${msg.message} The map is still open here; save it, or join again.`);
    };
    ws.onclose = () => {
      if (ws !== this.ws || this.phase === "ended") return;
      if (back) { this.dropped(ws); return; }
      this.ws = null;
      this.retryLater();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  /** Back in time: the same person, and what happened meanwhile. */
  private resumed(msg: Extract<RoomServerMessage, { type: "resumed" }>) {
    const session = this.session;
    if (!session) { this.end(LOST); return; }
    this.you = msg.you;
    this.room = { ...(this.room ?? {}), ...msg.room };
    if (msg.room.invite) this.invite = msg.room.invite;
    this.people.clear();
    this.presence.clear();
    for (const p of msg.people) this.people.set(p.id, p);
    for (const p of msg.presence) this.presence.set(p.from, p.data as Presence);
    for (const op of msg.ops) {
      if (op.from === msg.you.id) {
        // Ours, taken before the drop: the confirmation that never arrived.
        if (!this.unacked.length) { this.end("The shared map and this editor no longer agree on what was changed. The map is still open here; save it, or join again."); return; }
        this.unacked.shift();
        session.confirm();
      } else {
        session.receive(op.op);
      }
      this.lastSeq = op.seq;
    }
    // What the server never got goes again, in order.
    for (const op of this.unacked) this.send({ type: "op", op });
    if (this.chat !== null) {
      for (const line of newLines(this.chat, msg.chat)) this.addChat(line);
    }
    this.deps.api.ui.status("Reconnected to the shared map.");
    this.goLive();
  }

  /**
   * Back too late: the server no longer has what happened meanwhile and sent the map as
   * it is now. The map as this editor had it stays open in its tab, out of the shared
   * session; the fresh copy opens beside it.
   */
  private async fresh(msg: Extract<RoomServerMessage, { type: "welcome" }>) {
    const unsent = this.unacked.length;
    this.generation++;
    const old = this.session;
    this.session = null;
    this.unacked.length = 0;
    old?.stop();
    this.held = [];
    await this.welcome(msg);
    this.deps.api.ui.toast({
      kind: "warn", title: "Shared map opened again",
      detail: `You were away too long to catch up, so the shared map opened again in a new tab. The map as you had it is still open in its own tab${unsent ? `, with ${unsent} change${unsent === 1 ? "" : "s"} the others never got` : ""}.`,
      ttl: 0,
    });
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
        this.unacked.shift();
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
        if (who) api.ui.status(`${who.name} ${msg.reason === "removed" ? "was removed from" : msg.reason === "lost" ? "lost the connection to" : "left"} the shared map.`);
        this.emit();
        return;
      }
      case "away": {
        const who = this.people.get(msg.person);
        if (who) this.people.set(who.id, { ...who, away: true });
        this.presence.delete(msg.person);
        this.emit();
        return;
      }
      case "back":
        this.people.set(msg.person.id, msg.person);
        this.emit();
        return;
      case "presence":
        this.presence.set(msg.from, msg.data as Presence);
        this.emit(true);
        return;
      case "chat":
        this.addChat(msg.line);
        return;
      case "snapshot-please":
        void this.answerCopy(0);
        return;
      case "link":
        this.invite = msg.invite;
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

  private addChat(line: RoomChatLine) {
    const chat = this.chat ?? (this.chat = []);
    chat.push(line);
    if (chat.length > CHAT_KEEP) chat.splice(0, chat.length - CHAT_KEEP);
    for (const fn of [...this.chatListeners]) { try { fn(line); } catch (err) { console.error(err); } }
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

  /**
   * Leave — or, for the owner with `forEveryone`, end the room for everyone. The map stays
   * open. Leaving a kept map sends it as this editor has it, so the revision it writes
   * when everyone has gone is up to date.
   */
  async leave(forEveryone = false): Promise<void> {
    if (forEveryone && this.owner) { this.send({ type: "end" }); this.end(null); return; }
    const session = this.session;
    if (!this.kept || !session || this.phase !== "live") { this.end(null); return; }
    const seq = this.lastSeq;
    // Taken now, before any await: the copy is the map after op `seq`.
    try {
      const bytes = await session.snapshot();
      this.send({ type: "leave", ...(bytes ? { snapshot: { seq, map: toBase64(bytes) } } : {}) });
    } catch { /* leave without it: the server keeps the changes, only the revision lags */ }
    this.end(null);
  }

  /** Owner: how long the kept map stays open after its last edit. */
  async keepFor(keepDays: KeepDays): Promise<void> {
    if (!this.room || !this.kept) return;
    const { room } = await this.deps.client.keepSharedMap(this.room.id, keepDays);
    this.room = { ...this.room, keepDays: room.keepDays, endsAt: room.endsAt };
    this.emit();
  }

  private end(message: string | null) {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.ending = message;
    if (this.presenceTimer) { clearTimeout(this.presenceTimer); this.presenceTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (typeof removeEventListener === "function") removeEventListener("online", this.online);
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

/** The lines in `theirs` (the server's, oldest first) after the last one `ours` has. */
export function newLines(ours: RoomChatLine[], theirs: RoomChatLine[]): RoomChatLine[] {
  const last = ours.at(-1);
  if (!last) return theirs;
  const same = (l: RoomChatLine) => l.from === last.from && l.at === last.at && l.text === last.text;
  for (let i = theirs.length - 1; i >= 0; i--) if (same(theirs[i]!)) return theirs.slice(i + 1);
  return theirs.filter((l) => l.at > last.at);
}
