import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { followBox, footprintEmpty, footprintOf } from "../ai/intent";
import { GUIDES, guideById, guideFor, guideIndex } from "../ai/guides";
import { layoutPrompt, paramsToText, textToParams } from "../ai/dialogs/scenario";
import type { UmsDesign } from "../protocol";

const api = { document: { info: () => ({ width: 64, height: 48 }) } } as unknown as PluginApi;

describe("tool-call footprints", () => {
  it("boxes the layout calls: shapes by their geometry and origin, ramps and bridges round their tile, a preset as the map", () => {
    expect(footprintOf(api, "layout_preset", { preset: "corner-camps" }).rects).toEqual([{ x0: 0, y0: 0, x1: 64, y1: 48 }]);
    expect(footprintOf(api, "place_ramp", { x: 2, y: 30, side: "sw" }).rects).toEqual([{ x0: 0, y0: 26, x1: 7, y1: 35 }]);
    expect(footprintOf(api, "place_bridge", { x: "a", y: 3 }).rects).toEqual([]);
    const shapes = footprintOf(api, "paint_shapes", { originX: 10, originY: 5, shapes: [
      { op: "rect", x: 0, y: 0, w: 4, h: 3, terrain: 1 },
      { op: "ellipse", cx: 10, cy: 10, rx: 2, ry: 1 },
      { op: "stroke", points: [[20, 0], [20, 12]], width: 3 },
      { op: "ramp", x: 2, y: 2, side: "se" },
    ] });
    expect(shapes.rects).toEqual([{ x0: 8, y0: 3, x1: 33, y1: 20 }]); // the ramp box (-2 → 8) wins the left edge, the stroke (20 + 2 + 1 → 33) the right
    expect(footprintOf(api, "paint_shapes", { shapes: [{ op: "rect", x: 1, y: 1, w: 2, h: 2 }, { op: "ground", terrain: 3 }] }).rects).toEqual([{ x0: 0, y0: 0, x1: 64, y1: 48 }]);
    expect(footprintOf(api, "paint_shapes", { shapes: [{ op: "polygon" }] }).rects).toEqual([]);
    expect(footprintOf(api, "paint_shapes", { shapes: "no" }).rects).toEqual([]);
  });

  it("says where the view should go to watch a call, and when there is nowhere", () => {
    const scn = { units: [{ x: 100, y: 200 }], locations: [{ left: 64, top: 64, right: 128, bottom: 96 }] };
    const withMap = { document: { info: () => ({ width: 64, height: 48 }), scenario: () => scn } } as unknown as PluginApi;
    expect(followBox(withMap, { rects: [], units: [], locations: [] })).toBeNull();
    expect(followBox(withMap, { rects: [{ x0: 0, y0: 0, x1: 64, y1: 48 }], units: [], locations: [] })).toBeNull(); // the whole map: nowhere to go
    expect(followBox(withMap, { rects: [{ x0: 0, y0: 0, x1: 64, y1: 10 }], units: [], locations: [] })).toEqual({ x0: 0, y0: 0, x1: 64, y1: 10 });
    expect(followBox(withMap, { rects: [{ x0: 2, y0: 2, x1: 4, y1: 4 }], units: [0], locations: [0, 9] })).toEqual({ x0: 2, y0: 2, x1: 5, y1: 8 });
    expect(followBox(withMap, { rects: [], units: [7], locations: [] })).toBeNull(); // no such unit
    expect(followBox({ document: { info: () => null } } as unknown as PluginApi, { rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }], units: [], locations: [] })).toBeNull();
  });

  it("reads rects, tiles and indices out of a call's arguments", () => {
    expect(footprintOf(api, "paint_terrain", { x0: -3, y0: 2, x1: 10, y1: 99, terrain: 1 }).rects).toEqual([{ x0: 0, y0: 2, x1: 10, y1: 48 }]);
    expect(footprintOf(api, "place_units", { units: [{ unit: "m", player: 1, x: 3, y: 4 }, { x: 99, y: 0 }] }).rects).toEqual([{ x0: 3, y0: 4, x1: 4, y1: 5 }]);
    expect(footprintOf(api, "remove_units", { indices: [4, "7", -1] }).units).toEqual([4, 7]);
    const move = footprintOf(api, "move_units", { moves: [{ index: 2, x: 1, y: 1 }] });
    expect(move.units).toEqual([2]);
    expect(move.rects).toEqual([{ x0: 1, y0: 1, x1: 2, y1: 2 }]);
    expect(footprintOf(api, "edit_location", { index: 5, x0: 0, y0: 0, x1: 4, y1: 4 })).toEqual({ rects: [{ x0: 0, y0: 0, x1: 4, y1: 4 }], units: [], locations: [5] });
    expect(footprintOf(api, "screenshot", {}).rects).toEqual([{ x0: 0, y0: 0, x1: 64, y1: 48 }]);
    expect(footprintOf(api, "terrain_at", {}).rects).toEqual([]);
    expect(footprintOf(api, "go_to", { unit: 3 }).units).toEqual([3]);
    expect(footprintOf(api, "go_to", { x: 5, y: 6 }).rects).toEqual([{ x0: 5, y0: 6, x1: 6, y1: 7 }]);
    expect(footprintOf(api, "place_base", { x: 10, y: 10, player: 1 }).rects).toEqual([{ x0: 3, y0: 5, x1: 21, y1: 18 }]);
    expect(footprintOf(api, "place_base", { x: 2, y: 44 }).rects).toEqual([{ x0: 0, y0: 39, x1: 13, y1: 48 }]);
    expect(footprintEmpty(footprintOf(api, "place_base", { player: 2 }))).toBe(true);
  });

  it("answers nothing for calls with no place on the map", () => {
    expect(footprintEmpty(footprintOf(api, "list_units", {}))).toBe(true);
    expect(footprintEmpty(footprintOf(api, "set_players", { players: [] }))).toBe(true);
    expect(footprintEmpty(footprintOf({ document: { info: () => null } } as unknown as PluginApi, "paint_terrain", { x0: 0, y0: 0, x1: 1, y1: 1 }))).toBe(true);
  });
});

describe("genre guides", () => {
  it("cover the genres and pick one from a prompt", () => {
    expect(GUIDES.map((g) => g.id)).toEqual(["basics", "madness", "defense", "rpg", "bound", "diplomacy", "arena", "survival"]);
    for (const g of GUIDES) { expect(g.text.length).toBeGreaterThan(800); expect(g.text).toMatch(/^# /); }
    expect(guideFor("make me a madness map with zerglings")?.id).toBe("madness");
    expect(guideFor("An RPG about a marine")?.id).toBe("rpg");
    expect(guideFor("two-lane tower defense")?.id).toBe("defense");
    expect(guideFor("a cat and mouse map")?.id).toBe("survival");
    expect(guideFor("a nice melee map with four bases")).toBeNull();
    expect(guideById("RPG maps")?.id).toBe("rpg");
    expect(guideById("nothing")).toBeNull();
    expect(guideIndex()).toContain("madness: Madness maps");
  });

  it("name only toolkit kinds in their system lists", () => {
    const kinds = new Set(["hyper", "spawn", "kill-to-cash", "income", "last-standing", "defeat-when-lost", "victory-on-kills", "countdown", "objectives", "message", "lives", "waves", "shop", "heal", "respawn", "leaderboard", "teleport", "kill-zone", "alliance", "auto-attack", "give", "stages", "obstacles", "checkpoints", "bound"]);
    for (const g of GUIDES) for (const m of g.text.matchAll(/`([a-z-]+)`/g)) if (!/[A-Z]/.test(m[1]) && !["owner", "each", "computer", "limit", "attack", "unit", "location", "players", "perUnit", "scorePerKill", "deliver", "lives", "onEnd", "count", "with", "status", "kind", "groups", "every", "spots"].includes(m[1])) expect(kinds.has(m[1]), `${g.id}: ${m[1]}`).toBe(true);
  });
});

describe("the scenario workflow's helpers", () => {
  it("turns a design into a layout prompt and edits parameters as text", () => {
    const design: UmsDesign = {
      name: "X", description: "", genre: "madness", premise: "", layoutBrief: "Four corner bases.", objectives: "", briefing: [], notes: [],
      players: [{ slot: 1, type: "human", race: "userSelect", force: 1, role: "" }, { slot: 5, type: "computer", race: "zerg", force: 2, role: "" }],
      forces: [], locations: [{ name: "Spawn 1", purpose: "player 1's spawn" }], systems: [],
    };
    const prompt = layoutPrompt(design);
    expect(prompt).toContain("Four corner bases.");
    expect(prompt).toContain("- Spawn 1: player 1's spawn");
    expect(prompt).toContain("1 human player (player 1)");
    // Over the cap: the purposes go first, then the brief's tail — never the location names or the rule.
    const long = { ...design, layoutBrief: "B".repeat(600), locations: Array.from({ length: 20 }, (_, i) => ({ name: `Spot ${i + 1}`, purpose: "P".repeat(80) })) };
    const trimmed = layoutPrompt(long, 1500);
    expect(trimmed.length).toBeLessThanOrEqual(1500);
    expect(trimmed).toContain("- Spot 20");
    expect(trimmed).not.toContain("PPPP");
    expect(trimmed).toContain("1 human player");
    expect(layoutPrompt(long, 900)).toContain("…");
    expect(layoutPrompt(long).length).toBeLessThan(4000);
    expect(paramsToText([{ key: "a", value: "1" }, { key: "b", value: "x, y" }])).toBe("a=1; b=x, y");
    expect(textToParams(" a = 1 ;b=x, y; flag")).toEqual([{ key: "a", value: "1" }, { key: "b", value: "x, y" }, { key: "flag", value: "" }]);
  });
});
