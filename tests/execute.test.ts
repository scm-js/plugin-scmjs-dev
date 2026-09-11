import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { executeCalls, MAP_CHANGED, STOPPED, type CallOutcome, type ToolCall } from "../ai/execute";
import { fail, type Tool } from "../ai/tools/common";
import type { Ctx } from "../ai/ui";

const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolCall => ({ type: "tool_use", id, name, input });
const tool = (name: string, run: Tool["run"], flags: Partial<Pick<Tool, "writes" | "settings">> = {}): Tool => ({ def: { name, description: "", inputSchema: {} }, writes: false, ...flags, run });

function setup(docId: () => number | null = () => 1) {
  const api = { document: { id: docId } } as unknown as PluginApi;
  const ctx = {} as Ctx;
  const written: string[] = [];
  const tools = new Map<string, Tool>([
    ["read", tool("read", () => "42")],
    ["place", tool("place", () => { written.push("place"); return { text: "placed" }; }, { writes: true })],
    ["refuse", tool("refuse", () => fail("nothing there"), { writes: true })],
    ["settings", tool("settings", () => "ok", { writes: true, settings: true })],
    ["throws", tool("throws", () => { throw new Error("boom"); }, { writes: true })],
  ]);
  const outcomes: [string, CallOutcome["kind"]][] = [];
  const hooks = { after: (c: ToolCall, _t: Tool | undefined, o: CallOutcome) => { outcomes.push([c.id, o.kind]); } };
  return { api, ctx, tools, written, outcomes, hooks };
}

describe("executeCalls", () => {
  it("answers each call in order, marks failures as errors, and counts only the writes that happened", async () => {
    const s = setup();
    const r = await executeCalls([call("a", "read"), call("b", "place"), call("c", "refuse"), call("d", "settings"), call("e", "throws"), call("f", "nope")], { ...s, signal: new AbortController().signal, turnDoc: 1 }, s.hooks);
    expect(r.results.map((x) => x.type === "tool_result" && [x.toolUseId, x.isError])).toEqual([["a", false], ["b", false], ["c", true], ["d", false], ["e", true], ["f", true]]);
    expect(r.results[2]).toMatchObject({ content: "nothing there" });
    expect(r.results[5]).toMatchObject({ content: "Error: no tool called nope" });
    expect(r.edits).toEqual(["place"]);
    expect(r.settingsWrites).toEqual(["settings"]);
    expect(r.stopped).toBe(false);
    expect(r.mapChanged).toBe(false);
    expect(s.outcomes).toEqual([["a", "done"], ["b", "done"], ["c", "failed"], ["d", "done"], ["e", "failed"], ["f", "failed"]]);
  });

  it("stops between calls: what is left is answered as not run and nothing more is written", async () => {
    const s = setup();
    const ac = new AbortController();
    s.tools.set("stopper", tool("stopper", () => { ac.abort(); return "read"; }));
    const r = await executeCalls([call("a", "stopper"), call("b", "place"), call("c", "place")], { ...s, signal: ac.signal, turnDoc: 1 }, s.hooks);
    expect(r.stopped).toBe(true);
    expect(r.results.map((x) => x.type === "tool_result" && x.content)).toEqual(["read", STOPPED, STOPPED]);
    expect(s.written).toEqual([]);
    expect(r.edits).toEqual([]);
    expect(s.outcomes.slice(1)).toEqual([["b", "skipped"], ["c", "skipped"]]);
  });

  it("refuses a call once another map is in front", async () => {
    let doc = 1;
    const s = setup(() => doc);
    s.tools.set("switch", tool("switch", () => { doc = 2; return "switched"; }));
    const r = await executeCalls([call("a", "place"), call("b", "switch"), call("c", "place")], { ...s, signal: new AbortController().signal, turnDoc: 1 }, s.hooks);
    expect(r.mapChanged).toBe(true);
    expect(s.written).toEqual(["place"]);
    expect(r.results[2]).toMatchObject({ isError: true, content: `Error: ${MAP_CHANGED}` });
    expect(s.outcomes[2]).toEqual(["c", "failed"]);
  });

  it("treats a failure in the hook before a call as that call failing, and goes on", async () => {
    const s = setup();
    const r = await executeCalls([call("a", "place"), call("b", "read")], { ...s, signal: new AbortController().signal, turnDoc: 1 }, { before: (c) => { if (c.id === "a") throw new Error("could not glide"); } });
    expect(r.results[0]).toMatchObject({ isError: true, content: "Error: could not glide" });
    expect(r.results[1]).toMatchObject({ isError: false, content: "42" });
    expect(r.edits).toEqual([]);
  });
});
