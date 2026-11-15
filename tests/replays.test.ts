import { describe, expect, it } from "vitest";
import { AccountManager, memoryStore } from "../account";
import { ScmjsClient } from "../client";
import { momentOnPage, readMoment } from "../moment";
import type { AccountView, PublicReplayView, ReplayResponse, ReplayView } from "../protocol";
import { factsLine, formatLength, handToViewer, openAsDropped, playersLine, replaysService, sha256Hex } from "../replays";
import type { Ctx } from "../ui";

const FACTS: PublicReplayView = {
  token: "Qy2kqoBd5UCkc13EmPIFTajs", fileName: "legacy_cp949.rep", sizeBytes: 154392, note: "", uploadedAt: "2026-11-07T07:35:02.124Z",
  mapName: "투혼 1.3", mapWidth: 128, mapHeight: 128,
  players: [{ name: "Question", race: "protoss", team: 1, color: "#0c48cc" }, { name: "Drywater", race: "terran", team: 2, color: "#703014" }],
  matchup: "PvT", frames: 14482, durationSec: 608, gameType: 2, gameTypeName: "Melee", title: "441", playedAt: "2013-01-12T17:25:06.000Z", format: "legacy",
};

describe("replays", () => {
  it("say who played, how long and when", () => {
    expect(playersLine(FACTS)).toBe("Question (P) vs Drywater (T)");
    expect(playersLine({ players: [{ name: "A", race: "zerg", team: 0, color: "#000000" }, { name: "B", race: null, team: 0, color: "#000000" }, { name: "C", race: "terran", team: 0, color: "#000000" }] })).toBe("A (Z) vs B (?) vs C (T)");
    expect(playersLine({ players: [{ name: "A", race: "zerg", team: 1, color: "" }, { name: "B", race: "zerg", team: 1, color: "" }, { name: "C", race: "terran", team: 2, color: "" }] })).toBe("A (Z) & B (Z) vs C (T)");
    expect(formatLength(608)).toBe("10:08");
    expect(formatLength(3909)).toBe("1:05:09");
    expect(factsLine(FACTS)).toMatch(/^PvT · 10:08 · Melee · played .*2013$/);
  });

  it("upload as one multipart request, and a link is looked up without the session", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const answer: ReplayResponse = { replay: { ...FACTS, id: "r1", sha256: "x", links: [] }, storage: { usedBytes: 1, capBytes: 2, maps: 0, revisions: 0, replays: 1 } };
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(input), init });
      return new Response(JSON.stringify(String(input).includes("/replay-links/") ? { replay: FACTS } : answer), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new ScmjsClient(() => ({ serverUrl: "https://api.example", session: "sess_1" }), fetchImpl);
    await client.uploadReplay(new Uint8Array([1, 2, 3]), { fileName: "game.rep", note: "gg", link: true });
    const form = sent[0]!.init.body as FormData;
    expect(sent[0]!.url).toBe("https://api.example/v1/replays");
    expect((form.get("file") as File).name).toBe("game.rep");
    expect(form.get("fileName")).toBe("game.rep");
    expect(form.get("note")).toBe("gg");
    expect(form.get("link")).toBe("1");
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sess_1");
    const found = await client.linkedReplay(FACTS.token);
    expect(found.replay.matchup).toBe("PvT");
    expect(sent[1]!.url).toBe(`https://api.example/v1/replay-links/${FACTS.token}`);
    expect(sent[1]!.init.headers).toBeUndefined();
  });

  it("wait for the replay viewer, and say when there is none", async () => {
    let has = false;
    const ctx = { api: { commands: { has: (id: string) => has && id === "aftermath.open-replay" } } } as unknown as Ctx;
    expect(await openAsDropped(ctx, new Uint8Array([1]), "game.rep", 0)).toBe("no-viewer");
    has = true;
    // No DataTransfer outside a browser: the replay cannot be dropped.
    expect(await openAsDropped(ctx, new Uint8Array([1]), "game.rep", 0)).toBe("no-drop");
  });

  it("hand the viewer the replay with its link and moment, or drop it on a viewer from before", async () => {
    const opened: { file: File; from: unknown }[] = [];
    let service: object | null = { open: async (file: File, from: unknown) => { opened.push({ file, from }); } };
    const ctx = { api: { commands: { has: () => true }, services: { get: () => service } } } as unknown as Ctx;
    expect(await handToViewer(ctx, new Uint8Array([1, 2]), "game.rep", { link: "https://scmjs.dev/replay/abc", at: 402 }, 0)).toBe("opened");
    expect(opened[0]!.file.name).toBe("game.rep");
    expect(opened[0]!.file.size).toBe(2);
    expect(opened[0]!.from).toEqual({ link: "https://scmjs.dev/replay/abc", at: 402 });
    // An Aftermath without the service: the drop, which cannot be made outside a browser.
    service = null;
    expect(await handToViewer(ctx, new Uint8Array([1]), "game.rep", { at: 402 }, 0)).toBe("no-drop");
  });
});

describe("a replay link's moment", () => {
  it("reads m:ss, h:mm:ss and bare seconds, and ignores anything else", () => {
    expect(readMoment("6:42")).toBe(402);
    expect(readMoment("0:05")).toBe(5);
    expect(readMoment("62:00")).toBe(3720);
    expect(readMoment("1:02:03")).toBe(3723);
    expect(readMoment("402")).toBe(402);
    expect(readMoment("12.5")).toBe(12.5);
    expect(readMoment(" 6:42 ")).toBe(402);
    for (const bad of ["", "6:4", "6:60", "1:60:00", "-5", "6m42s", "1:2:3:4", "abc", ":42", "6:42:"]) expect(readMoment(bad), bad).toBeNull();
    expect(readMoment(null)).toBeNull();
    expect(momentOnPage("?t=6%3A42&scmjs-server=x")).toBe(402);
    expect(momentOnPage("?t=6:42&play=1")).toBe(402);
    expect(momentOnPage("?t=soon")).toBeNull();
    expect(momentOnPage("")).toBeNull();
  });
});

describe("the replay viewer's Share (scmjs-dev.replays)", () => {
  const BYTES = new Uint8Array([7, 7, 7, 1, 2, 3]);
  const account = (patch: Partial<AccountView> = {}): AccountView => ({ kind: "account", name: "Zergling", role: "free", balanceUsd: 0, weeklyUsd: 0, creditUsd: 0, providers: ["discord"], ...patch });
  const STORAGE = { usedBytes: 1, capBytes: 2, maps: 0, revisions: 0, replays: 1 };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

  /** A server keeping `kept`; every call recorded. */
  function server(kept: ReplayView[], replays = true) {
    const calls: string[] = [];
    let session: string | null = null;
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const key = `${init.method ?? "GET"} ${url.pathname}`;
      calls.push(key);
      const signedIn = session !== null && ((init.headers ?? {}) as Record<string, string>).Authorization === `Bearer ${session}`;
      if (key === "GET /v1/info") return json({ name: "Test", version: "1", accounts: { providers: [{ id: "discord", name: "Discord" }, { id: "google", name: "Google" }], trial: false, trialUsd: 0, signupUsd: 0, weeklyUsd: 0, packs: [], accountUrl: "", maps: true, replays }, caller: signedIn ? { kind: "user", remaining: {}, account: account() } : { kind: "anonymous", remaining: {} } });
      if (key === "POST /v1/auth/start") return json({ url: "https://discord.com/oauth2/authorize" });
      if (key === "GET /v1/account") return json({ account: account(), ledger: [] });
      if (key === "GET /v1/replays") return json({ replays: kept, storage: STORAGE });
      if (key === "POST /v1/replays") {
        const r: ReplayView = { ...FACTS, id: "new", sha256: "", links: [{ token: "NewTokenNewToken1234", replayId: "new", opens: 0, createdAt: "" }] };
        kept.unshift(r);
        return json({ replay: r, storage: STORAGE, link: r.links[0] }, 201);
      }
      const made = /^POST \/v1\/replays\/([^/]+)\/links$/.exec(key);
      if (made) {
        const r = kept.find((x) => x.id === made[1])!;
        r.links.push({ token: "MadeTokenMadeToken12", replayId: r.id, opens: 0, createdAt: "" });
        return json({ link: r.links[0], replay: r }, 201);
      }
      return json({ error: { code: "not_found", message: `no route ${key}` } }, 404);
    }) as typeof fetch;
    return { calls, fetchImpl, signIn: (s: string) => { session = s; } };
  }

  function setUp(kept: ReplayView[], opts: { session?: string; replays?: boolean } = {}) {
    const srv = server(kept, opts.replays);
    if (opts.session) srv.signIn(opts.session);
    const store = memoryStore({ session: opts.session ?? "" });
    let handler: ((e: { origin: string; data: unknown }) => void) | null = null;
    const popups: string[] = [];
    const manager = new AccountManager(store, new ScmjsClient(() => ({ serverUrl: "https://api.scmjs.dev", session: store.get().session }), srv.fetchImpl), {
      openPopup: (name) => { popups.push(name); return { closed: false, location: { href: "" }, close() { this.closed = true; } }; },
      origin: () => "https://scmjs.dev", listen: (h) => { handler = h; return () => { handler = null; }; },
    });
    const ctx = { api: {}, account: manager } as unknown as Ctx;
    const finishSignIn = () => { srv.signIn("sess_new"); handler!({ origin: "https://api.scmjs.dev", data: { type: "scmjs-ai-auth", session: "sess_new", account: account() } }); };
    return { ...srv, manager, service: replaysService(ctx), popups, finishSignIn };
  }

  it("signed out: says so with the ways to sign in; one press signs in, keeps the replay and gives its link", async () => {
    const kept: ReplayView[] = [];
    const s = setUp(kept);
    const changes: number[] = [];
    s.service.onChange(() => changes.push(1));
    expect(await s.service.status({ bytes: BYTES, fileName: "game.rep" })).toEqual({ state: "signed-out", providers: [{ id: "discord", name: "Discord" }, { id: "google", name: "Google" }] });
    const linking = s.service.link({ bytes: BYTES, fileName: "game.rep" }, "google");
    // The sign-in window opened on the press, before anything was awaited.
    expect(s.popups).toEqual(["scmjs-signin"]);
    await new Promise((r) => setTimeout(r, 0));
    s.finishSignIn();
    expect(await linking).toBe("https://scmjs.dev/replay/NewTokenNewToken1234");
    expect(s.calls.filter((c) => c === "POST /v1/replays")).toHaveLength(1);
    // Told of the sign-in, once, and not of every answer that moved the storage line.
    expect(changes).toEqual([1]);
    await s.service.status({ bytes: BYTES, fileName: "game.rep" });
    expect(changes).toEqual([1]);
  });

  it("signed in and not kept: keeps it once; asked again, it is kept and the same link comes back without a second upload", async () => {
    const kept: ReplayView[] = [];
    const s = setUp(kept, { session: "sess_1" });
    await s.manager.connect();
    expect(await s.service.status({ bytes: BYTES, fileName: "game.rep" })).toEqual({ state: "not-kept" });
    expect(await s.service.link({ bytes: BYTES, fileName: "game.rep" })).toBe("https://scmjs.dev/replay/NewTokenNewToken1234");
    // The server knows it by its hash now.
    kept[0]!.sha256 = await sha256Hex(BYTES);
    expect(await s.service.status({ bytes: BYTES, fileName: "game.rep" })).toEqual({ state: "kept", link: "https://scmjs.dev/replay/NewTokenNewToken1234" });
    expect(await s.service.link({ bytes: BYTES, fileName: "game.rep" })).toBe("https://scmjs.dev/replay/NewTokenNewToken1234");
    expect(s.calls.filter((c) => c === "POST /v1/replays")).toHaveLength(1);
    expect(s.popups).toEqual([]);
  });

  it("kept without a link: makes the link and sends nothing", async () => {
    const kept: ReplayView[] = [{ ...FACTS, id: "r9", sha256: await sha256Hex(BYTES), links: [] }];
    const s = setUp(kept, { session: "sess_1" });
    await s.manager.connect();
    expect(await s.service.status({ bytes: BYTES, fileName: "game.rep" })).toEqual({ state: "kept", link: null });
    expect(await s.service.link({ bytes: BYTES, fileName: "game.rep" })).toBe("https://scmjs.dev/replay/MadeTokenMadeToken12");
    expect(s.calls).toContain("POST /v1/replays/r9/links");
    expect(s.calls).not.toContain("POST /v1/replays");
  });

  it("a server that keeps no replays, or cannot be reached, is said in words", async () => {
    const s = setUp([], { replays: false });
    expect(await s.service.status({ bytes: BYTES, fileName: "game.rep" })).toEqual({ state: "unavailable", reason: "This server keeps no replays." });
    const down = replaysService({ api: {}, account: new AccountManager(memoryStore(), new ScmjsClient(() => ({ serverUrl: "https://api.scmjs.dev", session: "" }), (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch)) } as unknown as Ctx);
    const said = await down.status({ bytes: BYTES, fileName: "game.rep" });
    expect(said.state).toBe("unavailable");
    expect((said as { reason: string }).reason).toMatch(/could not be reached/);
  });
});
