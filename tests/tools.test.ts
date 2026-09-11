import { describe, expect, it } from "vitest";
import type { PluginApi } from "@scm-js/plugin-api";
import { byName, capResult, colorIndexOf, describeCall, nameCandidates, noSuchName, ownerName, ownerOf, slotOf, summarizeResult } from "../ai/tools/common";
import { readShapes, SHAPE_OPS } from "../ai/tools/layout";
import { shapesRect } from "../ai/shapes";
import { paintableDiamonds } from "../ai/tools/terrain";
import { usedTriggerState } from "../ai/tools/ums";

describe("usedTriggerState", () => {
  it("names the counters and switches the map's triggers read or write", () => {
    const api = {
      consts: { triggers: { condition: { Deaths: 15, Switch: 11 }, action: { SetDeaths: 45, SetSwitch: 13, Wait: 4 } } },
      triggers: {
        list: () => [
          { conditions: [{ type: 15, unitId: 190, resource: 0 }, { type: 11, unitId: 0, resource: 11 }], actions: [{ type: 45, unitId: 191, target: 0 }, { type: 4, unitId: 0, target: 0 }] },
          { conditions: [{ type: 15, unitId: 190, resource: 0 }], actions: [{ type: 13, unitId: 0, target: 254 }] },
        ],
      },
      names: { unit: (id: number) => ({ 190: "Cave (Unused)", 191: "Cantina (Unused)" } as Record<number, string>)[id] ?? `unit ${id}`, switch: (i: number) => `Switch ${i + 1}` },
    } as unknown as PluginApi;
    expect(usedTriggerState(api)).toEqual({ dcUnits: ["Cave (Unused)", "Cantina (Unused)"], switches: ["Switch 12", "Switch 255"] });
    expect(usedTriggerState({ ...api, triggers: { list: () => [] } } as unknown as PluginApi)).toEqual({ dcUnits: [], switches: [] });
  });
});

describe("tool helpers", () => {
  it("maps 1-based tool players to 0-based owners and back", () => {
    expect(ownerOf(1)).toBe(0);
    expect(ownerOf(8)).toBe(7);
    expect(ownerOf(12)).toBe(11);
    expect(ownerOf("neutral")).toBe(11);
    expect(ownerOf(undefined, 3)).toBe(3);
    expect(ownerName(0)).toBe("Player 1");
    expect(ownerName(11)).toBe("Neutral");
    expect(slotOf(1)).toBe(0);
    expect(slotOf("default")).toBe("default");
    expect(slotOf(13)).toBeNull();
    expect(slotOf(undefined)).toBeNull();
  });

  it("matches names loosely: exact, unique prefix, substring, or an id", () => {
    const items = [{ value: 0, label: "Terran Marine" }, { value: 1, label: "Terran Ghost" }, { value: 7, label: "Terran SCV" }, { value: 37, label: "Zerg Zergling" }];
    expect(byName(items, "terran marine")?.value).toBe(0);
    expect(byName(items, "Zerg Z")?.value).toBe(37);
    expect(byName(items, "ghost")?.value).toBe(1);
    expect(byName(items, "7")?.value).toBe(7);
    expect(byName(items, "Terran")).toBeNull(); // several, none of them plainly it
    expect(nameCandidates(items, "Terran")).toEqual(["Terran Marine", "Terran Ghost", "Terran SCV"]);
    const units = [{ value: 38, label: "Zerg Hydralisk" }, { value: 135, label: "Zerg Hydralisk Den" }, { value: 39, label: "Hunter Killer (Hydralisk)" }, { value: 5, label: "Terran Siege Tank (Tank Mode)" }, { value: 30, label: "Terran Siege Tank (Siege Mode)" }, { value: 28, label: "Edmund Duke (Tank Mode)" }];
    expect(byName(units, "hydralisk")?.value).toBe(38); // the plain form beats the Den and the hero
    expect(byName(units, "siege tank")?.value).toBe(5); // the shorter of the two forms
    expect(byName(units, "tank mode")).toBeNull();
    expect(noSuchName("unit", "tank mode", units)).toEqual({ error: 'No unit is called "tank mode". Did you mean "Terran Siege Tank (Tank Mode)", "Edmund Duke (Tank Mode)"?' });
    expect(byName(items, "")).toBeNull();
    expect(byName(items, "protoss")).toBeNull();
  });

  it("reads colours by name or index", () => {
    expect(colorIndexOf("Red")).toBe(0);
    expect(colorIndexOf("teal")).toBe(2);
    expect(colorIndexOf(5)).toBe(5);
    expect(colorIndexOf("9")).toBe(9);
    expect(colorIndexOf("mauve")).toBeNull();
  });

  it("caps results and describes calls for the transcript", () => {
    expect(capResult("short")).toBe("short");
    expect(capResult("x".repeat(20), 10)).toContain("… cut: 10 more characters");
    const call = describeCall("place_units", { units: [1, 2], name: "a very long name that goes on and on and on and on", n: 3, o: { a: 1 } });
    expect(call.startsWith('place_units(units=[2], name="a very long name')).toBe(true);
    expect(call.endsWith('…", n=3, o={…})')).toBe(true);
    expect(summarizeResult("Placed 3.\nmore")).toBe("Placed 3.");
    expect(summarizeResult({ image: { mediaType: "image/png", data: "AA" } })).toBe("(picture)");
  });
});

describe("paint_shapes input", () => {
  it("reads the op from op, or from the names a caller reaches for instead", () => {
    expect(readShapes([{ op: "rect", x: 1, y: 2, w: 3, h: 4, terrain: 5 }])).toEqual([{ op: "rect", x: 1, y: 2, w: 3, h: 4, terrain: 5 }]);
    expect(readShapes([{ type: "stroke", width: 8, terrain: 5 }])).toEqual([{ op: "stroke", type: "stroke", width: 8, terrain: 5 }]);
    expect(readShapes([{ kind: "bridge", x: 64, y: 63 }])).toMatchObject([{ op: "bridge" }]);
    expect(readShapes([{ shape: "ground", terrain: 2 }])).toMatchObject([{ op: "ground" }]);
  });

  it("says which shape lacks an op and what the ops are", () => {
    expect(readShapes([])).toBe("No shapes were given.");
    expect(readShapes(undefined)).toBe("No shapes were given.");
    const missing = readShapes([{ op: "rect", terrain: 1 }, { x: 1, y: 1, terrain: 1 }]);
    expect(missing).toContain("Shape 2 names no op");
    expect(missing).toContain(SHAPE_OPS.join(", "));
    expect(readShapes([{ op: "river", terrain: 5 }])).toContain('Shape 1 has an op "river"');
  });
});

describe("paint_shapes clear", () => {
  it("clears only the rectangle the shapes touch, the whole map for ground or border", () => {
    expect(shapesRect([{ op: "rect", terrain: 1, x: 10, y: 20, w: 5, h: 6 }], 128, 128)).toEqual({ x0: 10, y0: 20, x1: 15, y1: 26 });
    expect(shapesRect([{ op: "stroke", terrain: 1, points: [[10, 10], [30, 12]], width: 6 }], 128, 128)).toEqual({ x0: 7, y0: 7, x1: 34, y1: 16 });
    expect(shapesRect([{ op: "diamond", terrain: 1, cx: 3, cy: 3, rx: 5, ry: 5 }], 128, 128)).toEqual({ x0: 0, y0: 0, x1: 9, y1: 9 });
    expect(shapesRect([{ op: "rect", terrain: 1, x: 10, y: 20, w: 5, h: 6 }, { op: "ground", terrain: 2 }], 96, 64)).toEqual({ x0: 0, y0: 0, x1: 96, y1: 64 });
    expect(shapesRect([], 96, 64)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });
});

describe("paint_terrain's diamonds", () => {
  // The editor's diamondsIn is inclusive of the far edges: what a 128 × 128 map answers for a rect.
  const api = {
    document: { info: () => ({ width: 128, height: 128 }) },
    terrain: {
      diamondsIn: (r: { x0: number; y0: number; x1: number; y1: number }) => {
        const out: { x: number; y: number }[] = [];
        for (let y = r.y0; y <= Math.min(128, r.y1); y++) for (let x = Math.ceil(r.x0 / 2); x <= Math.min(64, Math.floor(r.x1 / 2)); x++) if ((x + y) % 2 === 0) out.push({ x, y });
        return out;
      },
    },
  } as unknown as PluginApi;

  it("leaves out the far edge, so a rect that stops at a river does not paint the river's first row", () => {
    const grass = paintableDiamonds(api, { x0: 0, y0: 55, x1: 128, y1: 60 });
    expect(grass.every((d) => d.y < 60)).toBe(true);
    expect(grass.some((d) => d.y === 59)).toBe(true);
    // The lattice column at x = 128 / 2 is the far edge of the map, so it stays; a rect ending at 64 drops column 32.
    expect(grass.some((d) => d.x === 64)).toBe(true);
    expect(paintableDiamonds(api, { x0: 0, y0: 0, x1: 64, y1: 8 }).some((d) => d.x === 32)).toBe(false);
  });

  it("keeps the map's own edge, which has nothing beyond it", () => {
    const bottom = paintableDiamonds(api, { x0: 0, y0: 120, x1: 128, y1: 128 });
    expect(bottom.some((d) => d.y === 128)).toBe(true);
  });
});

describe("the transcript's step lines", () => {
  const ctx = {} as never;
  it("falls back to the name as words with the arguments that matter", async () => {
    const { describeStep, reportStep } = await import("../ai/tools/common");
    expect(describeStep(undefined, "list_locations", {}, ctx)).toBe("List locations");
    expect(describeStep(undefined, "terrain_at", { x0: 0, y0: 0, x1: 32, y1: 32, cellSize: 4 }, ctx)).toBe("Terrain at: 0,0–32,32, cell size 4");
    expect(describeStep(undefined, "unit_type", { unit: "Terran Marine" }, ctx)).toBe("Unit type: Terran Marine");
    expect(describeStep({ describe: () => "Own words" }, "x", {}, ctx)).toBe("Own words");
    expect(describeStep({ describe: () => { throw new Error("no"); } }, "x_y", {}, ctx)).toBe("X y");
  });
  it("reports a result by its shape, or by the tool's own words", async () => {
    const { reportStep } = await import("../ai/tools/common");
    expect(reportStep(undefined, JSON.stringify({ chokes: [1, 2, 3], deadEnds: [1, 2], width: 64 }))).toBe("3 chokes, 2 dead ends, width 64");
    expect(reportStep(undefined, JSON.stringify([1, 2]))).toBe("2 items");
    expect(reportStep(undefined, "Removed 3 units.\nmore")).toBe("Removed 3 units.");
    expect(reportStep(undefined, { image: { mediaType: "image/png", data: "AA" } })).toBe("picture");
    expect(reportStep({ report: () => "3 placed" }, "{}")).toBe("3 placed");
  });
  it("phrases the writing tools in the map's words", async () => {
    const { tools } = await import("../ai/tools");
    const by = new Map(tools().map((t) => [t.def.name, t]));
    const d = (name: string, input: Record<string, unknown>) => by.get(name)!.describe!(input, ctx);
    expect(d("place_units", { units: [{ unit: "Terran Marine", player: 1, x: 12, y: 7 }, { unit: "Terran Marine", player: 1, x: 13, y: 7 }, { unit: "Siege Tank", player: 1, x: 14, y: 8 }] })).toBe("Place Terran Marine ×2, Siege Tank for Player 1 near 12,7");
    expect(d("remove_units", { indices: [3, 7, 9, 11] })).toBe("Remove 4 units #3, #7, #9 +1");
    expect(d("update_units", { indices: [1], hitPoints: 50, invincible: true })).toBe("Set hit points, invincible on 1 unit");
    expect(d("add_location", { name: "Spawn 1", x0: 4, y0: 4, x1: 8, y1: 8 })).toBe('Add location "Spawn 1" at 4,4–8,8');
    expect(d("set_fog", { x0: 0, y0: 0, x1: 64, y1: 64, players: [1, 2], mode: "clear" })).toBe("Clear 0,0–64,64 for players 1, 2");
    expect(d("paint_shapes", { shapes: [{ op: "plateau" }, { op: "lane" }, { op: "lane" }] })).toBe("Paint 3 shapes: plateau, lane ×2");
    expect(d("reachable", { fromLocation: "Spawn 1", toLocation: "Goal" })).toBe("Can units walk from Spawn 1 to Goal?");
    expect(d("reachable", { fromX: 1, fromY: 2, toX: 3, toY: 4, ignoreBridges: true })).toBe("Can units walk from 1,2 to 3,4 without the bridges?");
    expect(d("set_players", { players: [{ player: 1, type: "Human", race: "Terran" }, { player: 2, type: "Computer" }] })).toBe("Set players 1, 2: type, race");
    expect(d("add_triggers_text", { text: "Trigger(\"Player 1\"){\n}\n\nTrigger(\"Player 2\"){\n}" })).toBe("Add 2 triggers from text");
    expect(d("list_units", { owner: 1, name: "Start" })).toBe("List Player 1's units named \"Start\"");
    expect(d("screenshot", {})).toBe("Screenshot of the whole map");
    expect(d("select", { units: [1, 2], x0: 0, y0: 0, x1: 4, y1: 4 })).toBe("Select 2 units, the area 0,0–4,4");
    const r = (name: string, result: string) => by.get(name)!.report!(result);
    expect(r("place_units", JSON.stringify({ placed: [1, 2], refused: [] }))).toBe("2 placed");
    expect(r("place_units", JSON.stringify({ placed: [], refused: ["Marine at 1,1: cliff"] }))).toBe("nothing placed: Marine at 1,1: cliff");
    expect(r("paint_terrain", JSON.stringify({ changed: true, tiles: 40, isom: 12, paintedOver: { Dirt: 30 }, notes: [] }))).toBe("40 tiles; over Dirt ×30");
    expect(r("reachable", JSON.stringify({ reachable: true, tilesReachedFromStart: 900 }))).toBe("yes, 900 tiles reached");
    expect(r("scenario_rules", JSON.stringify({ problems: ["none"], fixed: [] }))).toBe("no problems");
    expect(r("validate", JSON.stringify([]))).toBe("clean");
    expect(r("screenshot", "Tiles 0,0 to 40,30 at 8 px per tile: x = px / 8.")).toBe("8 px per tile");
  });
});
