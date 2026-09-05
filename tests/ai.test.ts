import { describe, expect, it } from "vitest";
import { AccountManager, DEFAULT_SERVER_URL, memoryStore, serverOverride } from "../account";
import { QUALITY_EFFORT, recipeOptions } from "../ai/ui";
import { describeError, formatUsage, formatUsd, Ledger, ScmjsClient, ScmjsError, SseParser } from "../client";
import type { RecipeEvent, Usage } from "../protocol";

const usage: Usage = { model: "m", inputTokens: 6000, outputTokens: 1100, cacheReadTokens: 200, cacheWriteTokens: 0, costUsd: 0.18, durationMs: 14_200 };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("SseParser", () => {
  it("parses frames, joins data lines, ignores comments, and waits for split frames", () => {
    const p = new SseParser();
    expect(p.feed('data: {"a":1}\n\n: heartbeat\n\ndata: {"b":\ndata: 2}\n\ndata: {"c"')).toEqual(['{"a":1}', '{"b":\n2}']);
    expect(p.feed(':3}\n')).toEqual([]);
    expect(p.feed('\n')).toEqual(['{"c":3}']);
    expect(p.feed('event: x\r\ndata: last')).toEqual([]);
    expect(p.end()).toEqual(["last"]);
    expect(p.end()).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats money, tokens and usage", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsage(usage)).toBe("$0.18 · 14 s · 6.2k in / 1.1k out");
  });
  it("the ledger adds up and tells listeners", () => {
    const l = new Ledger();
    let calls = 0;
    const off = l.onChange(() => calls++);
    l.add(usage);
    l.add(usage);
    off();
    l.add(usage);
    expect(calls).toBe(2);
    expect(l.totals).toEqual({ calls: 3, costUsd: 0.54, inputTokens: 18600, outputTokens: 3300 });
    expect(l.summary()).toBe("Session: $0.54 over 3 calls");
  });
  it("describes AI failures with what to do, and never names a setting the plugin no longer has", () => {
    expect(describeError(new ScmjsError("rate_limited", "slow down", { retryAfterSec: 30 }))).toContain("30 seconds");
    expect(describeError(new ScmjsError("rate_limited", "slow down", { retryAfterSec: 600 }))).toContain("10 minutes");
    expect(describeError(new ScmjsError("unauthorized", "bad session."))).toContain("Account menu");
    expect(describeError(new ScmjsError("network", "Failed to fetch."))).toContain("scmjs.dev could not be reached");
    expect(describeError(new ScmjsError("recipe_disabled", ""))).toContain("turned off");
    for (const code of ["unauthorized", "network", "model_not_allowed", "budget_exceeded"] as const) expect(describeError(new ScmjsError(code, "x"))).not.toMatch(/Settings/);
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

describe("the options", () => {
  it("map the quality to an effort, leaving standard to the server's per-feature tuning", () => {
    const base = { serverUrl: DEFAULT_SERVER_URL, session: "", deviceId: "d", statusItem: true, ai: true, showThinking: true, maxRounds: 24, attachView: false, dockAssistant: false } as const;
    expect(recipeOptions({ ...base, quality: "standard" })).toEqual({ thinking: true });
    expect(recipeOptions({ ...base, quality: "quick", showThinking: false })).toEqual({ thinking: false, effort: "low" });
    expect(recipeOptions({ ...base, quality: "thorough" })).toEqual({ thinking: true, effort: "high" });
    expect(QUALITY_EFFORT.standard).toBeUndefined();
    // Never a model: the service picks it.
    expect(Object.keys(recipeOptions({ ...base, quality: "thorough" }))).not.toContain("model");
  });

  it("take the server from the ?scmjs-server= query alone, and go back to scmjs.dev on an empty or bad one", () => {
    expect(serverOverride("", "")).toBe(DEFAULT_SERVER_URL);
    expect(serverOverride("?layer=units", "http://localhost:8080")).toBe("http://localhost:8080");
    expect(serverOverride("?scmjs-server=http://localhost:8080/", "")).toBe("http://localhost:8080");
    expect(serverOverride("?scmjs-server=", "http://localhost:8080")).toBe(DEFAULT_SERVER_URL);
    expect(serverOverride("?scmjs-server=javascript:alert(1)", "")).toBe(DEFAULT_SERVER_URL);
    expect(serverOverride("?scmjs-server=not a url", "")).toBe(DEFAULT_SERVER_URL);
  });
});

function sseResponse(events: RecipeEvent[], chunk = 7): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(at, at + chunk));
      at += chunk;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("recipes over the client", () => {
  const creds = () => ({ serverUrl: "https://ai.example/", session: "sess" });

  it("streams a recipe, reporting deltas and thinking, and books the usage", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new ScmjsClient(creds, async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return sseResponse([
        { event: "start", id: "1", recipe: "explain-triggers", model: "claude-opus-5" },
        { event: "progress", elapsedMs: 100 },
        { event: "thinking", text: "hm" },
        { event: "delta", text: "Hello " },
        { event: "delta", text: "world" },
        { event: "result", output: { text: "Hello world" }, usage },
        { event: "done" },
      ]);
    });
    const deltas: string[] = [];
    let model = "";
    let thinking = "";
    const r = await client.run("explain-triggers", { text: "x" }, { onDelta: (t) => deltas.push(t), onStart: (m) => { model = m; }, onThinking: (t) => { thinking += t; } });
    expect(r.output).toEqual({ text: "Hello world" });
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(model).toBe("claude-opus-5");
    expect(thinking).toBe("hm");
    expect(client.ledger.totals.calls).toBe(1);
    expect(seen[0]!.url).toBe("https://ai.example/v1/recipes/explain-triggers");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sess");
    expect(headers.Accept).toBe("text/event-stream");
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({ protocol: 1, input: { text: "x" } });
  });

  it("reports the assistant's tool-call starts as they stream", async () => {
    const client = new ScmjsClient(creds, async () => sseResponse([
      { event: "start", id: "1", recipe: "agent", model: "m" },
      { event: "delta", text: "Looking." },
      { event: "tool_use", id: "t1", name: "list_units" },
      { event: "result", output: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "list_units", input: {} }], stopReason: "tool_use" }, usage },
      { event: "done" },
    ]));
    const started: string[] = [];
    const r = await client.run("agent", { messages: [], tools: [], facts: {} as never }, { onToolUse: (id, name) => started.push(`${id}:${name}`) });
    expect(started).toEqual(["t1:list_units"]);
    expect(r.output.stopReason).toBe("tool_use");
  });

  it("accepts a JSON answer from a server that does not stream", async () => {
    const client = new ScmjsClient(creds, async () => json({ id: "1", recipe: "describe", output: { name: "N", description: "D", alternatives: [] }, usage }));
    const r = await client.run("describe", { facts: {} as never });
    expect(r.output).toMatchObject({ name: "N" });
  });

  it("turns error bodies, error events and network failures into ScmjsErrors", async () => {
    const bodyErr = new ScmjsClient(creds, async () => new Response(JSON.stringify({ error: { code: "budget_exceeded", message: "no more" } }), { status: 402 }));
    await expect(bodyErr.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "budget_exceeded", message: "no more", status: 402 });

    const eventErr = new ScmjsClient(creds, async () => sseResponse([{ event: "start", id: "1", recipe: "describe", model: "m" }, { event: "error", error: { code: "refused", message: "declined" } }]));
    await expect(eventErr.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "refused" });

    const noResult = new ScmjsClient(creds, async () => sseResponse([{ event: "done" }]));
    await expect(noResult.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "protocol" });

    const down = new ScmjsClient(creds, async () => { throw new TypeError("Failed to fetch"); });
    await expect(down.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "network" });

    const plain401 = new ScmjsClient(creds, async () => new Response("nope", { status: 401 }));
    await expect(plain401.info()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("refuses a server speaking another protocol", async () => {
    const old = new ScmjsClient(creds, async () => json({ protocol: 2 }));
    await expect(old.info()).rejects.toMatchObject({ code: "protocol" });
  });

  it("starts the trial before the first request, sends the session after, and follows the balance", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const st = memoryStore();
    const client = new ScmjsClient(() => ({ serverUrl: st.get().serverUrl, session: st.get().session }), async (u, init) => {
      calls.push({ url: String(u), headers: init!.headers as Record<string, string>, body: String(init!.body ?? "") });
      if (String(u).endsWith("/v1/trial")) return json({ session: "sess_abc", account: { kind: "trial", role: "trial", balanceUsd: 0.5, weeklyUsd: 0, creditUsd: 0.5, providers: [] } });
      return json({ id: "1", recipe: "explain-triggers", output: { text: "x" }, usage, remaining: { balanceUsd: 0.32 } });
    });
    const account = new AccountManager(st, client);
    expect(account.kind()).toBe("guest");
    await client.run("explain-triggers", { text: "t" });
    expect(calls.map((c) => c.url)).toEqual([`${DEFAULT_SERVER_URL}/v1/trial`, `${DEFAULT_SERVER_URL}/v1/recipes/explain-triggers`]);
    expect(JSON.parse(calls[0]!.body)).toEqual({ deviceId: "device-test" });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[1]!.headers.Authorization).toBe("Bearer sess_abc");
    expect(account.kind()).toBe("trial");
    expect(account.current()?.balanceUsd).toBe(0.32);
    expect(account.summary()).toContain("$0.32 left");
    await client.run("explain-triggers", { text: "t" });
    expect(calls.filter((c) => c.url.endsWith("/v1/trial"))).toHaveLength(1);
  });

  it("turns a browser's second trial into a sign-in prompt before anything is sent to the model", async () => {
    const st = memoryStore();
    let recipes = 0;
    const client = new ScmjsClient(() => ({ serverUrl: st.get().serverUrl, session: st.get().session }), async (u) => {
      if (String(u).endsWith("/v1/trial")) return json({ error: { code: "forbidden", message: "This browser has had its free trial." } }, 403);
      recipes++;
      return json({});
    });
    new AccountManager(st, client);
    await expect(client.run("explain-triggers", { text: "t" })).rejects.toMatchObject({ code: "budget_exceeded", message: /Sign in to scmjs.dev/ });
    expect(recipes).toBe(0);
    expect(st.get().session).toBe("");
  });
});
