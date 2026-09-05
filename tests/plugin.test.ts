import { describe, expect, it } from "vitest";
import { AccountManager, memoryStore } from "../account";
import { describeError, fileNameFrom, formatBytes, ScmjsClient, ScmjsError } from "../client";
import { describeMeta, metaOf } from "../maps";
import type { AccountView, MapResponse } from "../protocol";
import { ago } from "../ui";

const view = (patch: Partial<AccountView> = {}): AccountView => ({ kind: "account", name: "Zergling", role: "free", balanceUsd: 1.5, weeklyUsd: 1, creditUsd: 0.5, providers: ["discord"], ...patch });

/** A fetch that answers by route, recording every call. */
function fakeFetch(routes: Record<string, (init: RequestInit, url: URL) => Response | Promise<Response>>) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: init.method ?? "GET", path: url.pathname, headers, body: init.body });
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const route = routes[key] ?? routes[`* ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: { code: "invalid_input", message: `no route ${key}` } }), { status: 404 });
    return route(init, url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("the client", () => {
  it("sends the session as a bearer, and none for a guest", async () => {
    const { fetchImpl, calls } = fakeFetch({ "GET /v1/info": () => json({ name: "T", version: "1", caller: { kind: "anonymous", remaining: {} } }) });
    let session = "";
    const client = new ScmjsClient(() => ({ serverUrl: "https://api.example/", session }), fetchImpl);
    expect(client.base()).toBe("https://api.example");
    await client.info();
    expect(calls[0]!.headers.authorization).toBeUndefined();
    session = "sess_1";
    await client.info();
    expect(calls[1]!.headers.authorization).toBe("Bearer sess_1");
    expect(client.headers()).toEqual({ Authorization: "Bearer sess_1" });
  });

  it("turns the server's error body into a ScmjsError and a sentence", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /v1/account": () => json({ error: { code: "unauthorized", message: "That session has ended." } }, 401),
      "POST /v1/maps": () => json({ error: { code: "storage_full", message: "This map would take the account past its 250 MB of storage." } }, 402),
      "GET /v1/storage": () => new Response("<html>", { status: 502 }),
    });
    const client = new ScmjsClient(() => ({ serverUrl: "https://api.example", session: "s" }), fetchImpl);
    const e1 = await client.account().catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ScmjsError);
    expect((e1 as ScmjsError).code).toBe("unauthorized");
    expect(describeError(e1)).toBe("The session has ended: That session has ended.");
    const e2 = await client.createMap(new Uint8Array([1]), { fileName: "a.scx" }).catch((e: unknown) => e);
    expect((e2 as ScmjsError).code).toBe("storage_full");
    expect(describeError(e2)).toMatch(/past its 250 MB/);
    const e3 = await client.storage().catch((e: unknown) => e);
    expect((e3 as ScmjsError).code).toBe("protocol");
    const offline = new ScmjsClient(() => ({ serverUrl: "https://api.example", session: "" }), (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch);
    const e4 = await offline.info().catch((e: unknown) => e);
    expect((e4 as ScmjsError).code).toBe("network");
    expect(describeError(e4)).toBe("The server could not be reached: Failed to fetch");
  });

  it("uploads a map as multipart with the fields beside the file, and reads a revision's file back", async () => {
    const answer: MapResponse = { map: { id: "m1", name: "Ridge", description: "", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z", revisions: 1, head: { id: "r1", number: 1, note: "first", fileName: "Ridge.scx", sizeBytes: 3, sha256: "x", meta: {}, createdAt: "2026-09-05T00:00:00Z" }, history: [] }, storage: { usedBytes: 3, capBytes: 100, maps: 1, revisions: 1 } };
    let form: FormData | null = null;
    const { fetchImpl, calls } = fakeFetch({
      "POST /v1/maps": (init) => { form = init.body as FormData; return json(answer, 201); },
      "POST /v1/maps/m1/revisions": (init) => { form = init.body as FormData; return json(answer, 201); },
      "GET /v1/maps/m1/revisions/1/file": () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-disposition": `attachment; filename="Ridge.scx"; filename*=UTF-8''Ridge%20v%C3%A9.scx` } }),
    });
    const client = new ScmjsClient(() => ({ serverUrl: "https://api.example", session: "s" }), fetchImpl);
    const r = await client.createMap(new Uint8Array([1, 2, 3]), { fileName: "Ridge.scx", name: "Ridge", note: "first", meta: { tileset: "jungle", width: 64 } });
    expect(r.map.id).toBe("m1");
    expect(form).toBeInstanceOf(FormData);
    const f = form! as FormData;
    expect((f.get("file") as File).name).toBe("Ridge.scx");
    expect(f.get("fileName")).toBe("Ridge.scx");
    expect(f.get("name")).toBe("Ridge");
    expect(f.get("note")).toBe("first");
    expect(JSON.parse(f.get("meta") as string)).toEqual({ tileset: "jungle", width: 64 });
    expect(f.get("description")).toBeNull();
    // No content-type is set by hand: the browser writes the boundary.
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    await client.uploadRevision("m1", new Blob([new Uint8Array([9])]), { fileName: "b.scx" });
    expect((form! as FormData).get("name")).toBeNull();
    const file = await client.revisionFile("m1", 1);
    expect([...file.bytes]).toEqual([1, 2, 3]);
    expect(file.fileName).toBe("Ridge vé.scx");
  });

  it("reads file names out of Content-Disposition, and formats sizes", () => {
    expect(fileNameFrom('attachment; filename="a b.scx"')).toBe("a b.scx");
    expect(fileNameFrom("attachment; filename=plain.scm")).toBe("plain.scm");
    expect(fileNameFrom(null)).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  });
});

describe("the account manager", () => {
  const server = (state: { session: string | null; account: AccountView | null; trials: number }) => fakeFetch({
    "GET /v1/info": (init) => {
      const auth = ((init.headers ?? {}) as Record<string, string>).Authorization;
      const signedIn = auth === `Bearer ${state.session}` && state.account;
      return json({ name: "Test", version: "1", accounts: { providers: [{ id: "discord", name: "Discord" }], trial: true, trialUsd: 0.5, weeklyUsd: 1, packs: [], accountUrl: "https://api.example/account", maps: true }, caller: signedIn ? { kind: "user", remaining: {}, account: state.account } : { kind: "anonymous", remaining: {} } });
    },
    "POST /v1/trial": () => {
      if (state.trials++ > 0) return json({ error: { code: "forbidden", message: "This browser has had its trial." } }, 403);
      state.session = "sess_trial"; state.account = view({ kind: "trial", name: undefined, role: "trial", balanceUsd: 0.5, weeklyUsd: 0, creditUsd: 0.5, providers: [] });
      return json({ session: state.session, account: state.account });
    },
    "POST /v1/auth/start": () => json({ url: "https://discord.com/oauth2/authorize?state=abc" }),
    "POST /v1/auth/logout": () => { state.session = null; return json({ ok: true }); },
    "GET /v1/account": (init) => {
      const auth = ((init.headers ?? {}) as Record<string, string>).Authorization;
      if (auth !== `Bearer ${state.session}` || !state.account) return json({ error: { code: "unauthorized", message: "That session has ended." } }, 401);
      return json({ account: state.account, ledger: [{ at: "2026-09-01T00:00:00Z", kind: "weekly", usd: 1, note: "week" }] });
    },
  });

  it("starts as a guest, takes the one trial, and turns the second refusal into a sign-in prompt", async () => {
    const state = { session: null as string | null, account: null as AccountView | null, trials: 0 };
    const { fetchImpl } = server(state);
    const store = memoryStore();
    const account = new AccountManager(store, new ScmjsClient(() => ({ serverUrl: "https://api.example", session: store.get().session }), fetchImpl));
    const seen: string[] = [];
    account.onChange((s) => seen.push(s.kind));
    expect(account.kind()).toBe("guest");
    expect(account.summary()).toBe("Not signed in");
    await account.connect();
    expect(account.offers()?.maps).toBe(true);
    expect(account.state()).toMatchObject({ kind: "guest", account: null, storage: null });
    // Two callers race for the session: one trial request.
    await Promise.all([account.ensureSession(), account.ensureSession()]);
    expect(state.trials).toBe(1);
    expect(account.kind()).toBe("trial");
    expect(store.get().session).toBe("sess_trial");
    expect(account.summary()).toBe("Free trial · $0.50 left");
    expect(seen).toEqual(["guest", "trial"]);
    // A fresh browser (new store) that the server refuses hears "sign in".
    const other = memoryStore();
    const again = new AccountManager(other, new ScmjsClient(() => ({ serverUrl: "https://api.example", session: other.get().session }), fetchImpl));
    const err = await again.ensureSession().catch((e: unknown) => e);
    expect((err as ScmjsError).code).toBe("budget_exceeded");
    expect((err as ScmjsError).message).toMatch(/Sign in to scmjs.dev/);
  });

  it("signs in through the popup, refreshes, follows a balance note, and signs out", async () => {
    const state = { session: null as string | null, account: null as AccountView | null, trials: 0 };
    const { fetchImpl, calls } = server(state);
    const store = memoryStore();
    let handler: ((e: { origin: string; data: unknown }) => void) | null = null;
    const popup = { closed: false, location: { href: "" }, close() { this.closed = true; } };
    const account = new AccountManager(store, new ScmjsClient(() => ({ serverUrl: "https://api.example", session: store.get().session }), fetchImpl), {
      openPopup: () => popup,
      origin: () => "https://editor.example",
      listen: (h) => { handler = h; return () => { handler = null; }; },
    });
    await account.connect();
    const signing = account.signIn();
    await new Promise((r) => setTimeout(r, 0));
    expect(popup.location.href).toBe("https://discord.com/oauth2/authorize?state=abc");
    expect(JSON.parse(String(calls.find((c) => c.path === "/v1/auth/start")!.body))).toEqual({ provider: "discord", returnOrigin: "https://editor.example" });
    // A message from the wrong origin is ignored; the right one lands the session.
    handler!({ origin: "https://evil.example", data: { type: "scmjs-ai-auth", session: "bad", account: view() } });
    expect(store.get().session).toBe("");
    state.session = "sess_acct"; state.account = view();
    handler!({ origin: "https://api.example", data: { type: "scmjs-ai-auth", session: "sess_acct", account: view() } });
    const v = await signing;
    expect(v.name).toBe("Zergling");
    expect(account.kind()).toBe("account");
    expect(store.get().session).toBe("sess_acct");
    expect(handler).toBeNull();
    await account.refresh();
    expect(account.ledger()).toHaveLength(1);
    expect(account.summary()).toBe("Zergling · $1.50");
    account.noteBalance(1.2);
    expect(account.current()).toMatchObject({ balanceUsd: 1.2, weeklyUsd: 1, creditUsd: 0.2 });
    const service = account.service(() => {});
    expect(service.headers()).toEqual({ Authorization: "Bearer sess_acct" });
    expect(service.state().kind).toBe("account");
    expect(service.serverUrl()).toBe("https://api.example");
    await service.signOut();
    expect(account.kind()).toBe("guest");
    expect(state.session).toBeNull();
    expect(account.ledger()).toEqual([]);
  });

  it("drops a session the server no longer knows, and rejects a sign-in whose window was closed", async () => {
    const state = { session: null as string | null, account: null as AccountView | null, trials: 0 };
    const { fetchImpl } = server(state);
    const store = memoryStore({ session: "stale" });
    const popup = { closed: false, location: { href: "" }, close() { this.closed = true; } };
    const account = new AccountManager(store, new ScmjsClient(() => ({ serverUrl: "https://api.example", session: store.get().session }), fetchImpl), {
      openPopup: () => popup, origin: () => "https://editor.example", listen: () => () => {},
    });
    expect(account.kind()).toBe("trial");
    expect(await account.refresh()).toBeNull();
    expect(store.get().session).toBe("");
    expect(account.kind()).toBe("guest");
    await account.connect();
    const signing = account.signIn("discord").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    popup.close();
    const err = await signing;
    expect((err as ScmjsError).code).toBe("aborted");
  });
});

describe("what the plugin says about a map", () => {
  const info = { name: "Ridge", description: "  A ridge.  ", width: 128, height: 96, tileset: "jungle" as const, era: 4, version: 205, fileName: "Ridge.scx", modified: false };
  const slot = (typeName: string, i: number) => ({ slot: i, type: 0, typeName, race: 0, raceName: "Terran", color: null, colorHex: null, rgb: null, force: null, forceName: null });
  it("counts the seated players and the humans, and keeps the description", () => {
    const players = [slot("Human", 0), slot("Human", 1), slot("Computer", 2), slot("Rescuable", 3), slot("Neutral", 4), slot("Inactive", 5)];
    const meta = metaOf(info, { units: { total: 40 }, triggers: { count: 7 } } as never, players);
    expect(meta).toEqual({ scenarioName: "Ridge", description: "A ridge.", tileset: "jungle", width: 128, height: 96, players: 4, humanPlayers: 2, units: 40, triggers: 7 });
    expect(describeMeta(meta)).toBe("jungle · 128 × 96 · 4 players (2 human) · 7 triggers");
    expect(describeMeta({})).toBe("");
    expect(metaOf({ ...info, description: "" }, null, [])).toEqual({ scenarioName: "Ridge", tileset: "jungle", width: 128, height: 96, players: 0, humanPlayers: 0 });
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    expect(ago("2026-09-05T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-09-05T11:30:00Z", now)).toBe("30 min ago");
    expect(ago("2026-09-05T07:00:00Z", now)).toBe("5 h ago");
    expect(ago("2026-09-04T12:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-08-30T12:00:00Z", now)).toBe("6 days ago");
    expect(ago("2026-05-05T12:00:00Z", now)).toBe("4 months ago");
    expect(ago("2024-05-05T12:00:00Z", now)).toBe("2 years ago");
  });
});
