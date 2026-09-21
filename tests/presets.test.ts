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
    expect(presetById("bound")?.locations).toContain("Stretch {n}");
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

  it("every yard and hire pad is on open ground, whatever the lanes, the bends and the players", () => {
    for (const lanes of [1, 2, 3, 4]) for (const bends of ["no", "yes"]) for (const wall of ["water", "cliff"]) for (const count of [1, 2, 4, 6, 8]) {
      const humans = Array.from({ length: count }, (_, i) => i + 1);
      const { plan, notes } = buildPreset("lanes", { lanes: String(lanes), bends, wall }, { ...ctx, humans });
      // A map with no room left says so rather than pretending; on 128 × 128 that never happens.
      expect(notes.join(" "), `${lanes} lanes, bends ${bends}, ${wall}, ${count} players`).not.toMatch(/no open ground/);
      const compiled = compileShapes(plan.shapes!, { width: 128, height: 128, terrains, rampPairs: ctx.rampPairs });
      const seen: { name: string; x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const l of plan.locations.filter((x) => /^(Yard|Pad) /.test(x.name))) {
        const where = `${l.name} with ${lanes} lanes, bends ${bends}, ${wall}, ${count} players`;
        expect(l.x0, where).toBeGreaterThanOrEqual(0); expect(l.y0, where).toBeGreaterThanOrEqual(0);
        expect(l.x1, where).toBeLessThanOrEqual(128); expect(l.y1, where).toBeLessThanOrEqual(128);
        for (let y = l.y0; y < l.y1; y++) for (let x = l.x0; x < l.x1; x++) expect(compiled.cells[y * 128 + x], `${where}: tile ${x},${y}`).toBe(2);
        for (const o of seen) expect(l.x0 >= o.x1 || l.x1 <= o.x0 || l.y0 >= o.y1 || l.y1 <= o.y0, `${where} overlaps ${o.name}`).toBe(true);
        seen.push(l);
      }
      expect(seen, `${lanes} lanes, ${count} players`).toHaveLength(count * 2);
      // Each start location stands in its player's yard.
      for (const u of plan.units) { const yard = plan.locations.find((l) => l.name === `Yard ${u.player}`)!; expect(u.x >= yard.x0 && u.x <= yard.x1 && u.y >= yard.y0 && u.y <= yard.y1, `start of ${u.player}`).toBe(true); }
    }
  });

  it("says so when a small map has no room for a yard", () => {
    const humans = [1, 2, 3, 4, 5, 6, 7, 8];
    const { notes, plan } = buildPreset("lanes", { lanes: "4", bends: "yes", laneWidth: "10" }, { ...ctx, width: 64, height: 64, humans });
    expect(notes.join(" ")).toMatch(/no open ground was left for a yard for each of the 8 players/);
    expect(plan.locations.filter((l) => l.name.startsWith("Yard "))).toHaveLength(8);
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

  it("lays a bound out: one continuous path in legs, fields of slabs back to back with a checkpoint after each, starts at the start", () => {
    const { plan } = buildPreset("bound", { legs: "3", stretches: "2", spotsPerStretch: "4", width: "4" }, { ...ctx, humans: [1, 2] });
    const names = plan.locations.map((l) => l.name);
    expect(names).toEqual(["Start", "Finish", "Spot 1", "Spot 2", "Spot 3", "Spot 4", "Spot 5", "Spot 6", "Spot 7", "Spot 8", "Checkpoint 1", "Stretch 1", "Stretch 2"]);
    const compiled = compileShapes(plan.shapes!, { width: 128, height: 128, terrains, rampPairs: [] });
    // Every spot and checkpoint sits on the path's ground; the water is elsewhere.
    for (const l of plan.locations.filter((l) => /^(Spot|Checkpoint)/.test(l.name))) expect(compiled.cells[Math.round((l.y0 + l.y1) / 2) * 128 + Math.round((l.x0 + l.x1) / 2)]).toBe(2);
    expect(compiled.cells[40 * 128 + 64]).toBe(5);
    // A slab spans the path and a tile past each edge, two tiles along the path (whichever way the path runs
    // there); the next slab starts where this one ends.
    const s1 = plan.locations.find((l) => l.name === "Spot 1")!, s2 = plan.locations.find((l) => l.name === "Spot 2")!;
    const dims = [s1.x1 - s1.x0, s1.y1 - s1.y0].sort((a, b) => a - b);
    expect(dims).toEqual([2, 4 + 2]);
    expect(s2.x0 === s1.x1 || s2.x1 === s1.x0 || s2.y0 === s1.y1 || s2.y1 === s1.y0).toBe(true);
    // The stretch covers its spots; the checkpoint lies outside the field.
    const st1 = plan.locations.find((l) => l.name === "Stretch 1")!, cp = plan.locations.find((l) => l.name === "Checkpoint 1")!;
    expect(st1.x0).toBeLessThanOrEqual(s1.x0); expect(st1.y0).toBeLessThanOrEqual(s1.y0);
    expect(cp.x0 >= st1.x1 || cp.x1 <= st1.x0 || cp.y0 >= st1.y1 || cp.y1 <= st1.y0).toBe(true);
    const st = plan.locations.find((l) => l.name === "Start")!, fi = plan.locations.find((l) => l.name === "Finish")!;
    expect(st.y0).toBeGreaterThan(fi.y0);
    expect(plan.units.map((u) => u.player)).toEqual([1, 2]);
    // Lanes: two spots side by side make a slab, numbered together.
    const laned = buildPreset("bound", { legs: "3", stretches: "1", spotsPerStretch: "3", lanes: "2" }, ctx).plan;
    const a = laned.locations.find((l) => l.name === "Spot 1")!, b = laned.locations.find((l) => l.name === "Spot 2")!, c = laned.locations.find((l) => l.name === "Spot 3")!;
    const touches = (p: typeof a, q: typeof a) => p.x0 === q.x1 || p.x1 === q.x0 || p.y0 === q.y1 || p.y1 === q.y0;
    // Spots 1 and 2 share the slab (same span along the path, side by side); spot 3 is the next slab along.
    expect((a.x0 === b.x0 && a.x1 === b.x1) || (a.y0 === b.y0 && a.y1 === b.y1)).toBe(true);
    expect(touches(a, b)).toBe(true);
    expect(touches(a, c) || touches(b, c)).toBe(true);
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
