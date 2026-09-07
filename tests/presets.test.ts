import { describe, expect, it } from "vitest";
import { buildPreset, presetById, presetLocationNames, presetSpecs, presetsText, PresetError, terrainRoles, type PresetContext } from "../ai/presets";
import { compileShapes } from "../ai/shapes";
import type { TerrainVocab } from "../protocol";

const terrains: TerrainVocab[] = [
  { id: 5, name: "Water", height: 0, buildable: false },
  { id: 2, name: "Dirt", height: 0, buildable: true },
  { id: 8, name: "Jungle", height: 0, buildable: true },
  { id: 11, name: "Ruins", height: 0, buildable: false },
  { id: 3, name: "High Dirt", height: 1, buildable: true },
  { id: 10, name: "High Jungle", height: 1, buildable: true },
];
const ctx: PresetContext = { width: 128, height: 128, terrains, rampPairs: [{ low: 2, high: 3 }], bridgePair: null, humans: [1, 2, 3, 4] };

describe("layout presets", () => {
  it("lists a catalogue with parameters and the locations each makes", () => {
    const specs = presetSpecs();
    expect(specs.map((s) => s.id)).toEqual(["corner-camps", "lanes", "arena", "bound", "town-regions"]);
    expect(presetById("lanes")?.locations).toContain("Goal");
    expect(presetById("nothing")).toBeNull();
    expect(presetsText()).toContain("corner-camps:");
    expect(presetLocationNames(presetById("corner-camps")!, [1, 2], 2)).toEqual(["Base 1", "Base 2", "Spawn 1", "Spawn 2", "Beacon 1", "Beacon 2", "Arena", "Centre"]);
  });

  it("picks terrains by role: plain ground, water, the ramp pair's high ground, a dressing", () => {
    expect(terrainRoles(ctx)).toEqual({ ground: 2, water: 5, high: 3, dress: 11 });
    expect(terrainRoles({ terrains: terrains.filter((t) => t.id !== 5), rampPairs: [] })).toMatchObject({ water: null, high: 3 });
  });

  it("lays corner camps out: one plateau per human with a south-facing ramp, an arena, the named locations, a start each", () => {
    const { plan, notes } = buildPreset("corner-camps", { between: "water" }, ctx);
    const plateaus = plan.shapes!.filter((s) => s.op === "plateau");
    expect(plateaus).toHaveLength(4);
    expect(plateaus.map((s) => s.ramps![0])).toEqual(["se", "sw", "se", "sw"]);
    expect(plan.shapes![0]).toEqual({ op: "ground", terrain: 5 });
    expect(plan.locations.map((l) => l.name)).toEqual(expect.arrayContaining(["Base 1", "Spawn 4", "Beacon 2", "Arena", "Centre"]));
    expect(plan.units.filter((u) => u.unit === "Start Location").map((u) => u.player)).toEqual([1, 2, 3, 4]);
    expect(notes[0]).toContain("4 camps");
    // Every location lies on the map, and the spawn of camp 1 lies inside its base.
    for (const l of plan.locations) { expect(l.x0).toBeGreaterThanOrEqual(0); expect(l.x1).toBeLessThanOrEqual(128); expect(l.y1).toBeLessThanOrEqual(128); }
    const base = plan.locations.find((l) => l.name === "Base 1")!, spawn = plan.locations.find((l) => l.name === "Spawn 1")!;
    expect(spawn.x0).toBeGreaterThanOrEqual(base.x0); expect(spawn.x1).toBeLessThanOrEqual(base.x1); expect(spawn.y1).toBeLessThanOrEqual(base.y1);
    // It compiles: four ramp sites with the pair.
    const compiled = compileShapes(plan.shapes!, { width: 128, height: 128, terrains, rampPairs: ctx.rampPairs });
    expect(compiled.ramps).toHaveLength(4);
    expect(compiled.findings).toEqual([]);
  });

  it("decorates by terrain name when the tileset has such categories", () => {
    const { plan } = buildPreset("corner-camps", {}, { ...ctx, doodadCategories: ["Jungle", "Water", "Cliff", "High Jungle"] });
    expect(plan.doodads.map((d) => [d.category, d.terrains![0]])).toEqual([["Water", 5]]);
    const dirtWorld = buildPreset("corner-camps", {}, { ...ctx, doodadCategories: ["Dirt", "Water", "Ruins"] });
    expect(dirtWorld.plan.doodads.map((d) => d.category)).toEqual(["Dirt", "Water", "Ruins"]);
    expect(buildPreset("corner-camps", {}, ctx).plan.doodads).toEqual([]);
  });

  it("takes fewer camps than humans and the other fills", () => {
    const { plan } = buildPreset("corner-camps", { camps: "2", between: "open", roads: "no", hall: "Terran Command Center" }, ctx);
    expect(plan.shapes!.filter((s) => s.op === "plateau")).toHaveLength(2);
    expect(plan.units.filter((u) => u.unit === "Terran Command Center").map((u) => u.player)).toEqual([1, 2]);
    expect(plan.shapes!.filter((s) => s.op === "stroke")).toHaveLength(0);
    expect(plan.shapes![0]).toEqual({ op: "ground", terrain: 2 });
  });

  it("lays lanes out: a lane per number from a north spawn to the south goal, yards and pads per human", () => {
    const { plan } = buildPreset("lanes", { lanes: "2", wall: "water" }, ctx);
    const lanes = plan.shapes!.filter((s) => s.op === "lane");
    expect(lanes).toHaveLength(2);
    expect(lanes[0].wall).toBe(5);
    expect(lanes[0].points![0][1]).toBeLessThan(0);
    expect(plan.locations.map((l) => l.name)).toEqual(expect.arrayContaining(["Spawn 1", "Spawn 2", "Lane 2 Mid", "Goal", "Yard 1", "Pad 4"]));
    const goal = plan.locations.find((l) => l.name === "Goal")!;
    expect(goal.y0).toBeGreaterThan(100);
    expect(plan.units).toHaveLength(4);
    const compiled = compileShapes(plan.shapes!, { width: 128, height: 128, terrains, rampPairs: ctx.rampPairs });
    // The lane is continuous: ground all the way down its first leg.
    const lx = lanes[0].points![0][0];
    for (let y = 0; y < 100; y++) expect([2, 11]).toContain(compiled.cells[y * 128 + lx]);
  });

  it("lays an arena out: a walled floor, a spawn per player inside, a lobby with the start outside", () => {
    const { plan } = buildPreset("arena", { size: "48", wall: "water" }, ctx);
    const names = plan.locations.map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(["Arena", "Centre", "Spawn 1", "Spawn 4", "Lobby 1", "Lobby 4"]));
    const arena = plan.locations.find((l) => l.name === "Arena")!, spawn = plan.locations.find((l) => l.name === "Spawn 1")!, lobby = plan.locations.find((l) => l.name === "Lobby 1")!;
    expect(spawn.x0).toBeGreaterThanOrEqual(arena.x0); expect(spawn.x1).toBeLessThanOrEqual(arena.x1);
    expect(lobby.x1).toBeLessThan(arena.x0);
    expect(plan.units).toHaveLength(4);
    const compiled = compileShapes(plan.shapes!, { width: 128, height: 128, terrains, rampPairs: ctx.rampPairs });
    // Water all round the floor: west of the arena at its middle row is water, the floor itself is the dressing.
    expect(compiled.cells[64 * 128 + (arena.x0 - 3)]).toBe(5);
    expect(compiled.cells[64 * 128 + 64]).toBe(11);
    expect(buildPreset("arena", { sides: "2" }, { ...ctx, humans: [1, 2] }).plan.locations.filter((l) => l.name.startsWith("Spawn"))).toHaveLength(2);
  });

  it("lays a bound out: one continuous path in legs, checkpoints and spots along it, starts at the start", () => {
    const { plan } = buildPreset("bound", { legs: "3", checkpoints: "2", spots: "6", width: "4" }, { ...ctx, humans: [1, 2] });
    const names = plan.locations.map((l) => l.name);
    expect(names).toEqual(["Start", "Finish", "Checkpoint 1", "Checkpoint 2", "Spot 1", "Spot 2", "Spot 3", "Spot 4", "Spot 5", "Spot 6"]);
    const compiled = compileShapes(plan.shapes!, { width: 128, height: 128, terrains, rampPairs: [] });
    // Every spot and checkpoint sits on the path's ground; the water is elsewhere.
    for (const l of plan.locations.filter((l) => /^(Spot|Checkpoint)/.test(l.name))) expect(compiled.cells[Math.round((l.y0 + l.y1) / 2) * 128 + Math.round((l.x0 + l.x1) / 2)]).toBe(2);
    // A spot spans the path and a tile past each edge: on a horizontal leg, taller than the path and three wide.
    const spot = plan.locations.find((l) => l.name === "Spot 1")!;
    expect(spot.y1 - spot.y0).toBe(4 + 2);
    expect(spot.x1 - spot.x0).toBe(3);
    expect(compiled.cells[40 * 128 + 64]).toBe(5);
    const st = plan.locations.find((l) => l.name === "Start")!, fi = plan.locations.find((l) => l.name === "Finish")!;
    expect(st.y0).toBeGreaterThan(fi.y0);
    expect(plan.units.map((u) => u.player)).toEqual([1, 2]);
  });

  it("lays a town and regions out: a chain of islands from the town's corner to the boss room, gates and paths named", () => {
    const { plan } = buildPreset("town-regions", { regions: "2" }, { ...ctx, humans: [1, 2] });
    const names = plan.locations.map((l) => l.name);
    expect(names).toEqual(["Town", "Shop", "Heal", "Region 1", "Gate 1", "Path 1", "Region 2", "Gate 2", "Path 2", "Boss Room", "Path 3"]);
    const town = plan.locations.find((l) => l.name === "Town")!, bossRoom = plan.locations.find((l) => l.name === "Boss Room")!;
    expect(town.x0).toBeLessThan(bossRoom.x0); expect(town.y0).toBeGreaterThan(bossRoom.y0);
    const compiled = compileShapes(plan.shapes!, { width: 128, height: 128, terrains, rampPairs: [] });
    // The town's centre and the shop are ground; the region's middle is dressing; the sea between is water.
    const shop = plan.locations.find((l) => l.name === "Shop")!;
    expect(compiled.cells[shop.y0 * 128 + shop.x0]).toBe(2);
    const r1 = plan.locations.find((l) => l.name === "Region 1")!;
    expect(compiled.cells[Math.round((r1.y0 + r1.y1) / 2) * 128 + Math.round((r1.x0 + r1.x1) / 2)]).toBe(11);
    expect(compiled.cells[4 * 128 + 4]).toBe(5);
    expect(buildPreset("town-regions", { boss: "no", regions: "1", town: "ne" }, ctx).plan.locations.map((l) => l.name)).toEqual(["Town", "Shop", "Heal", "Region 1", "Gate 1", "Path 1"]);
  });

  it("names bad parameters and unknown presets", () => {
    expect(() => buildPreset("lanes", { lanes: "many", wall: "fire", extra: "1" }, ctx)).toThrow(PresetError);
    try { buildPreset("lanes", { lanes: "many", wall: "fire", extra: "1" }, ctx); } catch (err) {
      const problems = (err as PresetError).problems;
      expect(problems.some((p) => p.includes('"lanes"'))).toBe(true);
      expect(problems.some((p) => p.includes('"wall"'))).toBe(true);
      expect(problems.some((p) => p.includes('"extra"'))).toBe(true);
    }
    expect(() => buildPreset("castle", {}, ctx)).toThrow(/no layout preset/);
  });
});
