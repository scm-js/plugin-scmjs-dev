import { describe, expect, it } from "vitest";
import { buildReference, buildReferenceDetail, buildReferenceLayers, type ReferenceParts } from "../ai/reference";
import { paged } from "../ai/tools/common";
import { windowOf } from "../ai/tools/script";
import { afterFailedTurn, chipsFor, fitHistory, pruneImages, QUICK_PROMPTS, TRIM_TO, trimHistory, undoStillApplies } from "../ai/assistant";
import type { AgentMessage } from "../protocol";

const parts: ReferenceParts = {
  mapName: "Lost Temple",
  description: "A temple.",
  width: 128,
  height: 128,
  tileset: "Jungle",
  versionLabel: "Brood War 1.04",
  players: ["1: Human, Terran, force 1, has a start location", "2: Computer, Zerg, force 2"],
  terrains: [{ id: 1, name: "Dirt", height: 0, buildable: true }, { id: 3, name: "Water", height: 0, buildable: false }, { id: 7, name: "High Dirt", height: 1, buildable: true }],
  ramps: [{ low: "Dirt", high: "High Dirt" }],
  bridges: { ground: "Dirt", water: "Water", channel: 5 },
  doodadCategories: [{ name: "Trees", doodads: [{ id: 10, name: "Jungle Tree", width: 2, height: 2 }] }],
  units: [
    { id: 0, name: "Terran Marine", race: "T", width: 1, height: 1, building: false, flyer: false, hitPoints: 40, shields: 0, armor: 0, minerals: 50, gas: 0, buildTime: 360, weapons: "Gauss Rifle 6" },
    { id: 1, name: "Terran Ghost", customName: "Sniper", race: "T", width: 1, height: 1, building: false, flyer: false, hitPoints: 45, shields: 0, armor: 0, minerals: 25, gas: 75, buildTime: 750, weapons: "C-10 Canister Rifle 10" },
  ],
  upgrades: [{ id: 0, name: "Terran Infantry Armor" }],
  techs: [{ id: 0, name: "Stim Packs" }],
  conditions: [{ name: "Bring", args: [{ label: "Player", kind: "player" }, { label: "Unit", kind: "unit" }, { label: "Location", kind: "location" }, { label: "Comparison", kind: "comparison" }, { label: "Count", kind: "count" }] }],
  actions: [{ name: "Display Text Message", args: [{ label: "Flags", kind: "textFlags" }, { label: "Text", kind: "text" }] }],
  briefingActions: [{ name: "Mission Objectives", args: [{ label: "Text", kind: "text" }] }],
  choices: [{ kind: "comparison", labels: ["At least", "At most", "Exactly"] }, { kind: "order", labels: [] }],
  aiScripts: ["Terran Custom Level", "Zerg Custom Level"],
  sprites: [{ label: "Doodads", count: 3 }],
  hasScript: false,
};

describe("reference layers", () => {
  it("puts what every map shares first, the tileset second, the map last, and is deterministic", () => {
    const [game, tileset, map] = buildReferenceLayers(parts);
    // The game layer names nothing of this map, so it is the same bytes for every map.
    expect(game).not.toContain("Lost Temple");
    expect(game).not.toContain("Jungle");
    expect(game).not.toContain("Sniper");
    expect(game).toContain("0: Terran Marine | T | 1×1 | ground");
    expect(game).toContain("1: Terran Ghost | T | 1×1 | ground");
    expect(game).not.toContain("40/0/0");
    expect(game).toContain("## Trigger conditions: Bring");
    expect(game).toContain("## Trigger actions: Display Text Message");
    expect(game).not.toContain("Comparison: comparison");
    expect(game).toContain('Trigger("Player 1", "Force 2"){');
    expect(game).toContain("Read script_declarations once");
    expect(game).not.toContain("no trigger script");
    // The tileset layer: terrains and the categories, not the doodads.
    expect(tileset).toContain("# Reference: the Jungle tileset");
    expect(tileset).toContain("- 7: High Dirt — height 1, buildable");
    expect(tileset).toContain("Ramps the editor can fit (down south-west or south-east only): Dirt → High Dirt");
    expect(tileset).toContain("Bridges: the editor fits one over a diagonal channel of Water 5 tiles wide between Dirt banks");
    expect(buildReferenceLayers({ ...parts, tileset: "Badlands", ramps: [], bridges: null })[1]).toContain("Bridges: none the editor can place on this tileset");
    expect(tileset).toContain("Trees (1)");
    expect(tileset).not.toContain("Jungle Tree 2×2");
    expect(tileset).not.toContain("Lost Temple");
    // The map layer: identity, players, renamed units, the script.
    expect(map).toContain('# Reference: "Lost Temple" — 128 × 128 tiles, tileset Jungle, Brood War 1.04');
    expect(map).toContain("Description: A temple.");
    expect(map).toContain("Players (2):\n  1: Human, Terran, force 1, has a start location\n  2: Computer, Zerg, force 2");
    expect(map).toContain('1: Terran Ghost is called "Sniper"');
    expect(map).toContain("This map has no trigger script yet.");
    expect(buildReferenceLayers({ ...parts, hasScript: true })[2]).toContain("has a trigger script");
    expect(buildReferenceLayers(parts)).toEqual([game, tileset, map]);
    expect(buildReference(parts)).toBe([game, tileset, map].join("\n\n"));
    // A rename changes the map layer only.
    const renamed = buildReferenceLayers({ ...parts, mapName: "Lost Temple 2" });
    expect(renamed[0]).toBe(game);
    expect(renamed[1]).toBe(tileset);
    expect(renamed[2]).not.toBe(map);
  });

  it("answers a query's rows of a long table, and one section of the triggers", () => {
    const units = buildReferenceDetail(parts, "units", { query: "ghost" });
    expect(units).toContain('(1 of 2 units matching "ghost")');
    expect(units).toContain("1: Terran Ghost");
    expect(units).not.toContain("0: Terran Marine");
    expect(buildReferenceDetail(parts, "units", { query: "sniper" })).toContain("Terran Ghost"); // the map's own name for it
    expect(buildReferenceDetail(parts, "doodads", { query: "tree" })).toContain("Jungle Tree");
    expect(buildReferenceDetail(parts, "doodads", { query: "rock" })).not.toContain("Jungle Tree");
    const actions = buildReferenceDetail(parts, "triggers", { section: "actions" });
    expect(actions).toContain("## Trigger actions");
    expect(actions).not.toContain("## Trigger conditions");
    expect(actions).not.toContain("## Argument values");
    const bring = buildReferenceDetail(parts, "triggers", { query: "bring" });
    expect(bring).toContain("- Bring(");
    expect(bring).not.toContain("- Display Text Message(");
  });

  it("answers the long tables on demand", () => {
    const units = buildReferenceDetail(parts, "units");
    expect(units).toContain("0: Terran Marine | T | 1×1 | ground | 40/0/0 | 50/0 | 360 | Gauss Rifle 6");
    expect(units).toContain('1: Terran Ghost ("Sniper" here) | T');
    const doodads = buildReferenceDetail(parts, "doodads");
    expect(doodads).toContain("- Trees (1): Jungle Tree [10] 2×2");
    const triggers = buildReferenceDetail(parts, "triggers");
    expect(triggers).toContain("- Bring(Player: player, Unit: unit, Location: location, Comparison: comparison, Count: count)");
    expect(triggers).toContain("- Display Text Message(Flags: textFlags, Text: text)");
    expect(triggers).toContain("- comparison: At least, At most, Exactly");
    expect(triggers).not.toContain("- order:");
    expect(triggers).toContain("## AI scripts (Run AI Script): Terran Custom Level; Zerg Custom Level");
  });
});

describe("assistant history", () => {
  it("trims from the front on a clean user message and offers quick prompts", () => {
    const m: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      m.push({ role: "user", content: [{ type: "text", text: `q${i}` }] });
      m.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
      m.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: "ok" }] });
      m.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
    }
    const t = trimHistory(m, 10, 8);
    expect(t.length).toBeLessThanOrEqual(8);
    expect(t[0].role).toBe("user");
    expect(t[0].content[0].type).toBe("text");
    expect(trimHistory(m.slice(0, 4), 10)).toHaveLength(4);
    // Under the limit nothing moves, so the server's cache of the conversation survives; over it a whole chunk goes at once.
    const ten = m.slice(0, 10);
    expect(trimHistory(ten, 10)).toBe(ten);
    expect(QUICK_PROMPTS.length).toBeGreaterThan(3);
  });

  it("keeps the brief and whole exchanges when one instruction runs many tool rounds", () => {
    const m: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "build the whole scenario" }] }];
    for (let i = 0; i < 30; i++) {
      m.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
      m.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: "ok" }] });
    }
    const t = trimHistory(m); // 61 messages and not one clean user message after the first
    expect(t.length).toBeGreaterThan(1);
    expect(t.length).toBeLessThanOrEqual(TRIM_TO + 1);
    expect(t[0]).toBe(m[0]);
    expect(t[1].role).toBe("assistant");
    const uses = new Set(t.flatMap((x) => x.content.filter((c) => c.type === "tool_use").map((c) => (c as { id: string }).id)));
    for (const x of t) for (const c of x.content) if (c.type === "tool_result") expect(uses.has(c.toolUseId)).toBe(true);
  });

  it("fits the history to the request's size: pictures first, then whole exchanges, the brief kept", () => {
    const picture = { type: "image" as const, source: { mediaType: "image/png" as const, data: "A".repeat(400_000) } };
    const m: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "the brief" }] }];
    for (let i = 0; i < 4; i++) {
      m.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "screenshot", input: {} }] });
      m.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: [{ type: "text", text: "shot" }, picture] }] });
    }
    expect(JSON.stringify(m).length).toBeGreaterThan(1_000_000);
    const fit = fitHistory(m, 1_000_000);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(1_000_000);
    expect(fit[0]).toBe(m[0]);
    expect(fit).toHaveLength(m.length); // one picture kept was enough; no exchange had to go
    // Text alone past the cap: exchanges go from the front, the brief stays, every result keeps its call.
    const long: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "the brief" }] }];
    for (let i = 0; i < 40; i++) {
      long.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
      long.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: "x".repeat(50_000) }] });
    }
    const cut = fitHistory(long, 500_000);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(500_000);
    expect(cut[0]).toBe(long[0]);
    expect(cut[1].role).toBe("assistant");
    expect(cut.length).toBeGreaterThan(2);
    const small = long.slice(0, 3);
    expect(fitHistory(small, 500_000)).toBe(small); // under the cap nothing moves
  });

  it("keeps the tool results of a turn that failed after its edits, and drops an unanswered question", () => {
    const asked: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "q" }] }];
    expect(afterFailedTurn(asked)).toEqual([]);
    const edited: AgentMessage[] = [...asked, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "place", input: {} }] }, { role: "user", content: [{ type: "tool_result", toolUseId: "t", content: "placed" }] }];
    expect(afterFailedTurn(edited)).toBe(edited);
  });

  it("knows when a turn's Undo no longer applies", () => {
    const after = { undo: "AI: place units", undoDepth: 4 };
    expect(undoStillApplies(after, { undo: "AI: place units", undoDepth: 4 })).toBe(true);
    expect(undoStillApplies(after, { undo: "Paint terrain", undoDepth: 5 })).toBe(false); // the person edited since
    expect(undoStillApplies(after, { undo: "AI: earlier", undoDepth: 3 })).toBe(false); // something was undone since
  });

  it("pages a list and windows a long text", () => {
    const rows = Array.from({ length: 7 }, (_, i) => i);
    expect(paged(rows, {}, 3, 10)).toEqual({ count: 3, matched: 7, next: 3, items: [0, 1, 2] });
    expect(paged(rows, { offset: 3, limit: 3 }, 3, 10)).toEqual({ count: 3, matched: 7, offset: 3, next: 6, items: [3, 4, 5] });
    expect(paged(rows, { offset: 6 }, 3, 10)).toEqual({ count: 1, matched: 7, offset: 6, items: [6] });
    expect(paged(rows, { limit: 99 }, 3, 5)).toMatchObject({ count: 5, next: 5 });
    expect(windowOf("short", 0, 100)).toBe("short");
    expect(windowOf("abcdefghij", 0, 4)).toBe("10 characters in all; showing 0–4; ask again with offset=4 for the rest.\n\nabcd");
    expect(windowOf("abcdefghij", 8, 4)).toBe("10 characters in all; showing 8–10.\n\nij");
  });

  it("keeps only the newest pictures when it trims", () => {
    const img = { type: "image" as const, source: { mediaType: "image/png" as const, data: "AA" } };
    const m: AgentMessage[] = [
      { role: "user", content: [img, { type: "text", text: "look" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "shot" }, img] }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t2", content: [img] }] },
    ];
    const pruned = pruneImages(m, 1);
    expect(pruned[0].content[0]).toEqual({ type: "text", text: "(a picture that was here is no longer kept)" });
    expect((pruned[2].content[0] as { content: unknown[] }).content[1]).toEqual({ type: "text", text: "(picture no longer kept)" });
    expect((pruned[4].content[0] as { content: unknown[] }).content[0]).toEqual(img);
    expect(pruned[4]).toBe(m[4]);
    expect(pruneImages(m, 5)).toEqual(m);
  });

  it("offers chips for what the person is doing", () => {
    expect(chipsFor("terrain", 0, 0).map((c) => c.label)).toEqual(["Describe", "Check", "Terrain", "Scenario"]);
    expect(chipsFor("units", 3, 4).map((c) => c.label)).toEqual(["Describe", "Check", "Selection", "Balance", "Triggers"]);
    expect(chipsFor("locations", 0, 1).map((c) => c.label)).toContain("Locations");
  });
});

describe("referenceFor", () => {
  it("keeps the game and tileset layers per map, and rebuilds the map layer when a rename or a custom name changes it", async () => {
    const { referenceFor } = await import("../ai/reference");
    const scenario = {};
    const state = { name: "Lost Temple", customName: "" };
    const unitType = { id: 0, name: "Terran Marine", get customName() { return state.customName; }, hitPoints: 40, shields: 0, armor: 0, mineralCost: 50, gasCost: 0, buildTime: 360, weapons: [] };
    const api = {
      document: { scenario: () => scenario, info: () => ({ name: state.name, description: "", width: 64, height: 64 }) },
      tileset: { name: () => "Jungle" },
      settings: { unitTypes: () => [unitType], version: () => ({ label: "Brood War" }), players: () => [{ slot: 0, typeName: "Human", raceName: "Terran", force: 0, forceName: "" }] },
      palette: { unitSize: () => ({ width: 1, height: 1, building: false, flyer: false }), doodadCategories: () => [], spriteGroups: () => [] },
      data: { race: () => "terran" },
      names: { unit: () => state.customName || "Terran Marine", upgrades: () => [], techs: () => [] },
      triggers: { defs: { conditions: () => [], actions: () => [], choices: () => [] } },
      terrain: { types: () => [] },
      query: { startLocations: () => [] },
      commands: { has: () => false },
    } as never;
    const first = referenceFor(api)!;
    expect(first[2]).toContain('"Lost Temple"');
    expect(referenceFor(api)).toBe(first);
    state.name = "Lost Temple 2";
    const renamed = referenceFor(api)!;
    expect(renamed[0]).toBe(first[0]);
    expect(renamed[1]).toBe(first[1]);
    expect(renamed[2]).toContain('"Lost Temple 2"');
    state.customName = "Grunt";
    const custom = referenceFor(api)!;
    expect(custom[0]).toBe(first[0]);
    expect(custom[2]).toContain('0: Terran Marine is called "Grunt"');
    state.customName = "";
    expect(referenceFor(api)![2]).not.toContain("is called");
  });
});

describe("replaying a transcript", () => {
  it("groups the stored messages into turns: the ask, the work, the answer", async () => {
    const { groupTurns } = await import("../ai/assistant");
    const turns = groupTurns([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "map_info", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "{\"width\":64}" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "screenshot", input: {} }, { type: "tool_use", id: "t3", name: "nope", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t2", content: [{ type: "text", text: "Tiles." }, { type: "image", source: { mediaType: "image/png", data: "AA" } }] }, { type: "tool_result", toolUseId: "t3", content: "Error: no", isError: true }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
      { role: "assistant", content: [{ type: "text", text: "Sure." }] },
    ]);
    expect(turns.map((t) => t.user)).toEqual([["Hi"], ["Thanks"]]);
    expect(turns[0].answer).toBe("Done.");
    expect(turns[0].steps.map((s) => s.kind)).toEqual(["thinking", "narration", "call", "call", "call"]);
    const calls = turns[0].steps.filter((s) => s.kind === "call") as { name: string; result?: string; failed?: boolean; image?: unknown }[];
    expect(calls.map((c) => [c.name, c.result, !!c.failed, !!c.image])).toEqual([["map_info", "{\"width\":64}", false, false], ["screenshot", "Tiles.", false, true], ["nope", "Error: no", true, false]]);
    expect(turns[1]).toEqual({ user: ["Thanks"], steps: [], answer: "Sure." });
  });
});
