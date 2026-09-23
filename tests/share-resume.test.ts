import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApi, SyncOp, SyncSession, SyncStartOptions } from "@scm-js/plugin-api";
import type { ScmjsClient } from "../client";
import type { RoomChatLine, RoomClientMessage, RoomPerson, RoomServerMessage } from "../protocol";
import { newLines, SharedMap, type SocketLike } from "../share/shared";

/** A socket the test plays the server for. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: RoomClientMessage[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data) as RoomClientMessage); }
  close(code = 1000) { this.closedWith = code; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  hear(m: RoomServerMessage) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "" }); }
  ops() { return this.sent.filter((m) => m.type === "op").map((m) => (m as { op: { n: number } }).op.n); }
}

/** A sync session that records what it is told, and lets the test make local changes. */
function fakeEditor() {
  const sessions: { opts: SyncStartOptions; received: unknown[]; confirmed: number; stopped: boolean; id: number }[] = [];
  let docs = 0;
  const toasts: { title: string; detail?: string }[] = [];
  const api = {
    sync: {
      start(opts: SyncStartOptions): SyncSession | null {
        if (sessions.some((s) => !s.stopped)) return null;
        const rec = { opts, received: [] as unknown[], confirmed: 0, stopped: false, id: docs };
        sessions.push(rec);
        return {
          documentId: rec.id,
          receive: (op: unknown) => { rec.received.push(op); return true; },
          confirm: () => { rec.confirmed++; },
          pending: () => 0,
          waiting: () => 0,
          snapshot: async () => new Uint8Array([1]),
          holding: () => null,
          stop: () => { rec.stopped = true; opts.onEnd?.("stopped"); },
        } as SyncSession;
      },
    },
    document: { open: async () => { docs++; return true; } },
    ui: { status: () => {}, toast: (t: { title: string; detail?: string }) => { toasts.push(t); } },
  } as unknown as PluginApi;
  const edit = (n: number) => sessions.at(-1)!.opts.send({ kind: "edit", n } as unknown as SyncOp);
  return { api, sessions, toasts, edit, docs: () => docs };
}

const ME: RoomPerson = { id: "me", name: "Bo", color: 1, owner: false };
const ANN: RoomPerson = { id: "ann", name: "Ann", color: 0, owner: true };
const ROOM = { id: "r", name: "Ridge", owner: "Ann", people: 2, maxPeople: 8, createdAt: "2026-09-23T00:00:00Z" };
const line = (text: string, at: string): RoomChatLine => ({ from: "ann", name: "Ann", color: 0, text, at });

function welcome(over: Partial<Extract<RoomServerMessage, { type: "welcome" }>> = {}): RoomServerMessage {
  return { type: "welcome", protocol: 1, you: ME, room: ROOM, people: [ANN, ME], snapshot: { seq: 0, map: "AA==" }, ops: [], presence: [], chat: [], resume: "tok", ...over };
}

async function joined(over: Partial<Extract<RoomServerMessage, { type: "welcome" }>> = {}) {
  const editor = fakeEditor();
  const sockets: FakeSocket[] = [];
  const client = { session: () => "", roomSocketUrl: () => "ws://x/v1/rooms/socket" } as unknown as ScmjsClient;
  const joining = SharedMap.join({ api: editor.api, client, socket: () => { const s = new FakeSocket(); sockets.push(s); return s; } }, "inv", "Bo");
  sockets[0]!.open();
  sockets[0]!.hear(welcome(over));
  const shared = await joining;
  return { shared, sockets, ...editor };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a shared map whose connection drops", () => {
  it("reconnects as the same person, takes its own replayed changes as confirmations, and sends the rest again", async () => {
    const { shared, sockets, sessions, edit } = await joined();
    expect(shared.phase).toBe("live");
    const s0 = sockets[0]!;
    s0.hear({ type: "op", seq: 1, from: "ann", op: { n: 100 } });
    edit(1);
    edit(2); // reaches the server (seq 4 below), but its ack is lost with the connection
    edit(3); // never reaches it
    s0.hear({ type: "ack", seq: 2 }); // for 1
    expect(s0.ops()).toEqual([1, 2, 3]);

    s0.drop();
    expect(shared.phase).toBe("reconnecting");
    edit(4); // made while away: kept, not sent anywhere
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    const s1 = sockets[1]!;
    s1.open();
    expect(s1.sent[0]).toMatchObject({ type: "hello", invite: "inv", resume: { token: "tok", seq: 2 } });
    s1.hear({
      type: "resumed", you: ME, room: ROOM, people: [ANN, ME], presence: [], chat: [],
      ops: [{ seq: 3, from: "ann", op: { n: 101 } }, { seq: 4, from: "me", op: { n: 1 } }, { seq: 5, from: "ann", op: { n: 102 } }],
    });
    expect(shared.phase).toBe("live");
    const session = sessions[0]!;
    // 1 confirmed by its ack, 2 by its place in the replay; the others' ops received in order.
    expect(session.confirmed).toBe(2);
    expect(session.received).toEqual([{ n: 100 }, { n: 101 }, { n: 102 }]);
    // 3 and 4 never got there: sent again, in order.
    expect(s1.ops()).toEqual([3, 4]);
    s1.hear({ type: "ack", seq: 6 });
    s1.hear({ type: "ack", seq: 7 });
    expect(session.confirmed).toBe(4);
  });

  it("tries again with longer waits, catches up on the chat, and gives up after two minutes", async () => {
    const { shared, sockets } = await joined({ chat: [line("hi", "2026-09-23T10:00:00Z")] });
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]!.drop(); // refused at the door: try again, later
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    const s = sockets[2]!;
    s.open();
    const heard: string[] = [];
    shared.onChat((l) => heard.push(l.text));
    s.hear({ type: "resumed", you: ME, room: ROOM, people: [ANN, { ...ME }], presence: [], ops: [], chat: [line("hi", "2026-09-23T10:00:00Z"), line("where did you go", "2026-09-23T10:00:30Z")] });
    expect(heard).toEqual(["where did you go"]);
    expect(shared.chat!.map((l) => l.text)).toEqual(["hi", "where did you go"]);

    // Now away for good.
    s.drop();
    for (let i = 0; i < 20 && shared.phase !== "ended"; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      sockets.at(-1)!.drop();
    }
    expect(shared.phase).toBe("ended");
    expect(shared.ending).toMatch(/connection to the shared map was lost/);
    expect(sockets.length).toBeLessThanOrEqual(10);
  });

  it("opens a fresh copy in a new tab when the server can no longer replay, keeping the old tab out of the session", async () => {
    const { shared, sockets, sessions, toasts, edit, docs } = await joined();
    edit(1);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1000);
    const s1 = sockets[1]!;
    s1.open();
    s1.hear(welcome({ snapshot: { seq: 40, map: "AA==" }, ops: [{ seq: 41, from: "ann", op: { n: 7 } }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.phase).toBe("live");
    expect(docs()).toBe(2);
    expect(sessions[0]!.stopped).toBe(true);
    expect(sessions[1]!.stopped).toBe(false);
    expect(sessions[1]!.received).toEqual([{ n: 7 }]);
    expect(shared.documentId).toBe(2);
    expect(toasts.at(-1)!.detail).toMatch(/new tab.*1 change the others never got/);
    // The old change is not sent into the fresh copy.
    expect(s1.ops()).toEqual([]);
    edit(2);
    expect(s1.ops()).toEqual([2]);
  });

  it("ends when the room is gone, and at once on a server that cannot resume", async () => {
    const a = await joined();
    a.sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1000);
    a.sockets[1]!.open();
    a.sockets[1]!.hear({ type: "error", code: "not_found", message: "This shared map has ended, or the link has changed." });
    expect(a.shared.phase).toBe("ended");
    expect(a.shared.ending).toMatch(/ended while you were away/);

    const b = await joined({ resume: undefined });
    b.sockets[0]!.drop();
    expect(b.shared.phase).toBe("ended");
  });

  it("notices a connection that went quiet, and marks others away and back", async () => {
    const { shared, sockets } = await joined();
    const s0 = sockets[0]!;
    s0.hear({ type: "away", person: "ann" });
    expect(shared.people.get("ann")!.away).toBe(true);
    s0.hear({ type: "back", person: ANN });
    expect(shared.people.get("ann")!.away).toBeUndefined();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(s0.sent.filter((m) => m.type === "ping")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(shared.phase).toBe("reconnecting");
    expect(s0.closedWith).toBe(4000);
  });
});

describe("leaving a map kept open", () => {
  it("sends the map as this editor has it, so the revision it writes is up to date", async () => {
    const { shared, sockets } = await joined({ room: { ...ROOM, keepDays: 7, endsAt: "2026-09-30T00:00:00Z" } });
    expect(shared.kept).toBe(true);
    sockets[0]!.hear({ type: "op", seq: 3, from: "ann", op: { n: 1 } });
    await shared.leave();
    const leave = sockets[0]!.sent.find((m) => m.type === "leave") as Extract<RoomClientMessage, { type: "leave" }>;
    expect(leave.snapshot).toEqual({ seq: 3, map: "AQ==" });
    expect(shared.phase).toBe("ended");
    expect(sockets[0]!.closedWith).toBe(1000);
  });

  it("just closes a map that is not kept", async () => {
    const { shared, sockets } = await joined();
    await shared.leave();
    expect(sockets[0]!.sent.some((m) => m.type === "leave")).toBe(false);
    expect(sockets[0]!.closedWith).toBe(1000);
  });
});

describe("chat lines missed", () => {
  it("are the ones after the last line this editor has", () => {
    const a = line("a", "t1"), b = line("b", "t2"), c = line("c", "t3");
    expect(newLines([a, b], [a, b, c])).toEqual([c]);
    expect(newLines([], [a])).toEqual([a]);
    expect(newLines([a, b], [b, c])).toEqual([c]);
    expect(newLines([a], [line("x", "t2"), c])).toEqual([line("x", "t2"), c]);
  });
});

describe("how long a kept map is open, in words", () => {
  it("keeps the date's capitals when the line goes on after something else", async () => {
    const { endsLine, lower } = await import("../share/kept");
    const line = endsLine({ keepDays: 7, endsAt: "2026-09-30T12:00:00Z" });
    expect(line.startsWith("Ends ")).toBe(true);
    expect(lower(line).startsWith("ends ")).toBe(true);
    expect(lower(line).slice(5)).toBe(line.slice(5));
    expect(lower(endsLine({ keepDays: null }))).toBe("until you end it");
  });
});
